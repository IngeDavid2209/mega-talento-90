import { Router, Request, Response } from 'express';
import { requireAuth, AuthedRequest } from '../auth';
import { detectar } from './detector';
import { guardarBorradores, reconciliarBorradores, listarAlertas, decidirAlerta } from './persistencia';
import { getJefe, listarJefes, upsertJefe } from './jefes';
import { notificarJefe } from './notificador';

/**
 * Router del AGENTE DE HORARIOS. Se monta en /checador/agente.
 *   POST /checador/agente/analizar  → corre la detección y crea borradores.
 *   GET  /checador/agente/alertas   → lista los borradores (RH los VE, solo lectura).
 *
 * Mismo estilo que checador.ts: requireAuth, mapeo snake_case→camelCase, fallo().
 * El agente SOLO deja borradores 'sugerida_ia'; RH aprueba/rechaza aparte (handoff).
 */
export const agenteHorariosRouter = Router();
agenteHorariosRouter.use(requireAuth);

function fallo(res: Response, e: any, msg: string) {
  console.error('[agente-horarios]', msg, e);
  return res.status(500).json({ error: msg });
}

const mapAlerta = (r: any) => ({
  id: r.id,
  sucursalId: r.sucursal_id,
  empleadoCodigo: r.empleado_codigo,
  empleadoNombre: r.empleado_nombre || '',
  fecha: r.fecha,
  regla: r.regla,
  severidad: r.severidad,
  detalle: r.detalle || '',
  evidencia: r.evidencia || {},
  justificacionSugerida: r.justificacion_sugerida || '',
  estado: r.estado,
  origen: r.origen,
  decididoPor: r.decidido_por || null,
  decididoEn: r.decidido_en || null,
  analizadoEn: r.analizado_en,
});

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * POST /checador/agente/analizar
 * body: { sucursalId, desde, hasta }  (fechas 'yyyy-MM-dd')
 * Corre la detección sobre las checadas de esa sucursal/rango, guarda borradores
 * y devuelve el resumen + cuántos borradores creó/actualizó.
 */
agenteHorariosRouter.post('/analizar', async (req: Request, res: Response) => {
  try {
    const { sucursalId, desde, hasta } = req.body || {};
    if (!sucursalId || !desde || !hasta) {
      return res.status(400).json({ error: 'Faltan sucursalId, desde y hasta.' });
    }
    if (!RE_FECHA.test(desde) || !RE_FECHA.test(hasta)) {
      return res.status(400).json({ error: 'desde y hasta deben ser fechas yyyy-MM-dd.' });
    }
    if (hasta < desde) {
      return res.status(400).json({ error: 'hasta no puede ser anterior a desde.' });
    }

    const { borradores, resumen } = await detectar({ sucursalId, desde, hasta });
    const persistencia = await guardarBorradores(borradores);
    // Limpia borradores 'sugerida_ia' del rango que ya no se detectan (sin tocar
    // los que RH ya decidió).
    const eliminadas = await reconciliarBorradores(sucursalId, desde, hasta, borradores);

    // ── HANDOFF (Fase 1): el agente ya dejó los borradores 'sugerida_ia'. AQUÍ PARA.
    //    No se notifica a nadie ni se aprueba nada: eso es del humano / fase posterior.
    return res.json({ resumen, borradores: { ...persistencia, eliminadas } });
  } catch (e) {
    fallo(res, e, 'No se pudo correr el análisis de asistencia.');
  }
});

/**
 * GET /checador/agente/alertas?sucursalId=&desde=&hasta=&estado=&codigo=
 * Lista los borradores/alertas para que RH los revise. Solo lectura.
 */
agenteHorariosRouter.get('/alertas', async (req: Request, res: Response) => {
  try {
    const { sucursalId, desde, hasta, estado, codigo } = req.query as any;
    if (!sucursalId) return res.status(400).json({ error: 'Falta sucursalId.' });
    const rows = await listarAlertas({
      sucursalId, desde, hasta, estado,
      empleadoCodigo: codigo,
    });
    res.json(rows.map(mapAlerta));
  } catch (e) {
    fallo(res, e, 'No se pudieron leer las alertas.');
  }
});

/**
 * PUT /checador/agente/alertas/:id  — RH resuelve una alerta.
 * body: { estado: 'aprobada'|'rechazada'|'descartada', justificacion? }
 * Registra quién (del JWT) y cuándo. Es el lado HUMANO del handoff.
 */
agenteHorariosRouter.put('/alertas/:id', async (req: AuthedRequest, res: Response) => {
  try {
    const { estado, justificacion } = req.body || {};
    if (!['aprobada', 'rechazada', 'descartada'].includes(estado)) {
      return res.status(400).json({ error: 'estado debe ser aprobada, rechazada o descartada.' });
    }
    const quien = req.usuario?.email || req.usuario?.sub || 'rh';
    const row = await decidirAlerta(req.params.id, estado, quien, justificacion);
    if (!row) return res.status(404).json({ error: 'Alerta no encontrada.' });

    // Al APROBAR se avisa al jefe de la sucursal (best-effort; no rompe la
    // respuesta si falla). Este es el puente a BOT-RH (fase de notificación).
    let aviso: { enviado: boolean; motivo?: string } | undefined;
    if (estado === 'aprobada') {
      try {
        const jefe = await getJefe(row.sucursal_id);
        if (!jefe || jefe.activo === false) {
          aviso = { enviado: false, motivo: 'la sucursal no tiene jefe registrado' };
        } else {
          aviso = await notificarJefe({
            empleadoNombre: row.empleado_nombre || row.empleado_codigo,
            sucursalId: row.sucursal_id, fecha: row.fecha,
            regla: row.regla, detalle: row.detalle || '',
          }, jefe);
        }
      } catch (e: any) {
        aviso = { enviado: false, motivo: e?.message || 'error al notificar' };
      }
    }
    res.json({ ...mapAlerta(row), aviso });
  } catch (e) {
    fallo(res, e, 'No se pudo actualizar la alerta.');
  }
});

/** GET /checador/agente/jefes[?sucursalId=]  — jefe(s) responsables por sucursal. */
agenteHorariosRouter.get('/jefes', async (req: Request, res: Response) => {
  try {
    const { sucursalId } = req.query as any;
    if (sucursalId) { const j = await getJefe(sucursalId); return res.json(j ? [j] : []); }
    res.json(await listarJefes());
  } catch (e) { fallo(res, e, 'No se pudieron leer los jefes.'); }
});

/** PUT /checador/agente/jefes  — alta/edición del jefe de una sucursal. */
agenteHorariosRouter.put('/jefes', async (req: Request, res: Response) => {
  try {
    const { sucursalId, nombre, telefono, activo } = req.body || {};
    if (!sucursalId) return res.status(400).json({ error: 'Falta sucursalId.' });
    res.json(await upsertJefe({ sucursalId, nombre, telefono, activo }));
  } catch (e) { fallo(res, e, 'No se pudo guardar el jefe.'); }
});
