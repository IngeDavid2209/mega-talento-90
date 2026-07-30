import { Router, Request, Response } from 'express';
import { requireAuth, AuthedRequest } from '../auth';
import { detectar } from './detector';
import {
  guardarBorradores, reconciliarBorradores, listarAlertas, decidirAlerta,
  asegurarCodigo, justificarPorCodigo, agruparAlertas, decidirGrupo,
} from './persistencia';
import { getJefe, listarJefes, upsertJefe } from './jefes';
import { notificarJefe } from './notificador';
import { estadoCorredor, correrUnaVez } from './corredor';
import { asistenciaPersonas } from './asistencia-personas';

/** Umbral de ex-trabajador, el mismo que usa el corredor (ver corredor.ts). */
const DIAS_EX = Math.max(0, parseInt(process.env.AGENTE_DIAS_EX || '21', 10) || 21);

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
  codigo: r.codigo || '',
  justificacionJefe: r.justificacion_jefe || '',
  respondidoPor: r.respondido_por || null,
  respondidoEn: r.respondido_en || null,
});

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /checador/agente/asistencia?sucursalId&desde&hasta
 *
 * La asistencia de cada persona con las reglas del horario deducido: su horario
 * sale de SUS propias checadas, el retardo se acumula contra la bolsa semanal de
 * 15 min y solo cuenta el excedente, un día de UNA sola marca no genera retardo,
 * y una falta es un día laboral DE ESA PERSONA sin marcas.
 *
 * Existe porque la pantalla de Asistencia calculaba esto EN EL NAVEGADOR contra
 * el horario configurado de la sucursal, que está mal en casi todas las plazas:
 * Ana #105 salía con 251 minutos de retardo en un solo día y Antonio #50 con 207
 * minutos y cero horas trabajadas (había checado una vez, así que no se sabía ni
 * si esa marca era su entrada). Cada persona viene con `usable` y `marcas`: el
 * número existe, pero no siempre se puede usar.
 */
agenteHorariosRouter.get('/asistencia', async (req: Request, res: Response) => {
  try {
    const { sucursalId, desde, hasta } = req.query as any;
    if (!sucursalId || !desde || !hasta) {
      return res.status(400).json({ error: 'Faltan sucursalId, desde y hasta.' });
    }
    if (!RE_FECHA.test(String(desde)) || !RE_FECHA.test(String(hasta))) {
      return res.status(400).json({ error: 'Las fechas deben venir como yyyy-MM-dd.' });
    }
    if (String(hasta) < String(desde)) {
      return res.status(400).json({ error: 'hasta no puede ser anterior a desde.' });
    }
    res.json(await asistenciaPersonas({
      sucursalId: String(sucursalId), desde: String(desde), hasta: String(hasta),
    }));
  } catch (e) {
    fallo(res, e, 'No se pudo calcular la asistencia.');
  }
});

/**
 * GET /checador/agente/estado
 * Qué revisó el agente por su cuenta y cuándo. Es lo que permite que la pantalla
 * MUESTRE resultados en vez de pedir que alguien apriete un botón: el corredor
 * (corredor.ts) ya analizó todas las sucursales sin que nadie se lo pidiera.
 */
agenteHorariosRouter.get('/estado', async (_req: Request, res: Response) => {
  try {
    res.json(await estadoCorredor());
  } catch (e) {
    fallo(res, e, 'No se pudo leer el estado del agente.');
  }
});

/**
 * POST /checador/agente/revisar-ahora
 * body: { sucursalId? }  — adelanta la revisión automática sin esperar el ciclo.
 * No es el modo normal de operar: el agente revisa solo. Esto sirve para cuando
 * alguien acaba de descargar un reloj y no quiere esperar los 30 minutos.
 * `forzar` ignora la huella, así que re-analiza aunque los datos no hayan cambiado.
 */
agenteHorariosRouter.post('/revisar-ahora', async (req: Request, res: Response) => {
  try {
    const { sucursalId } = req.body || {};
    const r = await correrUnaVez({ forzar: true, sucursalId: sucursalId || undefined });
    if (!r.ok) return res.status(409).json({ error: `No se pudo revisar: ${r.motivo}.` });
    res.json(r);
  } catch (e) {
    fallo(res, e, 'No se pudo correr la revisión.');
  }
});

/**
 * POST /checador/agente/analizar
 * body: { sucursalId, desde, hasta, incluirExTrabajadores? }  (fechas 'yyyy-MM-dd')
 *
 * Análisis MANUAL de un rango arbitrario. El automático usa una ventana rodante
 * de los últimos días; esto es para revisar historia profunda a propósito
 * (después de recuperar meses de un reloj, por ejemplo).
 *
 * Por omisión NO le sigue marcando faltas a quien ya dejó de venir; con
 * `incluirExTrabajadores: true` se analiza a todos (útil para una auditoría
 * retroactiva, ruidoso para la operación diaria).
 */
agenteHorariosRouter.post('/analizar', async (req: Request, res: Response) => {
  try {
    const { sucursalId, desde, hasta, incluirExTrabajadores } = req.body || {};
    if (!sucursalId || !desde || !hasta) {
      return res.status(400).json({ error: 'Faltan sucursalId, desde y hasta.' });
    }
    if (!RE_FECHA.test(desde) || !RE_FECHA.test(hasta)) {
      return res.status(400).json({ error: 'desde y hasta deben ser fechas yyyy-MM-dd.' });
    }
    if (hasta < desde) {
      return res.status(400).json({ error: 'hasta no puede ser anterior a desde.' });
    }

    const { borradores, resumen } = await detectar({
      sucursalId, desde, hasta,
      excluirSilenciososDias: incluirExTrabajadores ? null : DIAS_EX,
    });
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
 * GET /checador/agente/alertas/agrupadas?sucursalId=&desde=&hasta=&estado=
 *
 * La misma cola, agrupada por regla + sucursal + persona. Existe porque al
 * 30/07/2026 había **2,510 borradores esperando y CERO decididos**: pedir 2,510
 * decisiones una por una garantiza que no se tome ninguna. Y no hacen falta —
 * las dos reglas que quedan activas no describen 2,510 problemas distintos:
 * `checada_duplicada` es del LECTOR (decisión por sucursal) y
 * `entrada_sin_salida` es de la rutina de una PERSONA (decisión por persona).
 */
agenteHorariosRouter.get('/alertas/agrupadas', async (req: Request, res: Response) => {
  try {
    const { sucursalId, desde, hasta, estado, nivel } = req.query as any;
    res.json(await agruparAlertas({
      sucursalId, desde, hasta, estado,
      nivel: nivel === 'sucursal' ? 'sucursal' : 'persona',
    }));
  } catch (e) {
    fallo(res, e, 'No se pudo agrupar la cola de alertas.');
  }
});

/**
 * PUT /checador/agente/alertas/grupo — decide un GRUPO completo.
 * body: { regla, sucursalId, empleadoCodigo?, desde?, hasta?, estado, justificacion? }
 *
 * `estado` solo admite 'rechazada' o 'descartada'. Aprobar en bloque NO se
 * permite a propósito: aprobar dispara el aviso por WhatsApp al jefe, así que un
 * grupo de 400 mandaría 400 mensajes a una persona real. Aprobar sigue siendo de
 * una en una, donde se ve a quién se le avisa.
 */
agenteHorariosRouter.put('/alertas/grupo', async (req: AuthedRequest, res: Response) => {
  try {
    const { regla, sucursalId, empleadoCodigo, desde, hasta, estado, justificacion } = req.body || {};
    if (!regla || !sucursalId) {
      return res.status(400).json({ error: 'Faltan regla y sucursalId.' });
    }
    if (!['rechazada', 'descartada'].includes(estado)) {
      return res.status(400).json({
        error: 'En bloque solo se puede rechazar o descartar. Aprobar es de una en una, porque avisa al jefe por WhatsApp.',
      });
    }
    const quien = req.usuario?.email || req.usuario?.sub || 'rh';
    const r = await decidirGrupo({
      regla, sucursalId, empleadoCodigo, desde, hasta, estado,
      decididoPor: quien, justificacion,
    });
    res.json(r);
  } catch (e) {
    fallo(res, e, 'No se pudo decidir el grupo.');
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
          const codigo = await asegurarCodigo(row.id);
          aviso = await notificarJefe({
            empleadoNombre: row.empleado_nombre || row.empleado_codigo,
            sucursalId: row.sucursal_id, fecha: row.fecha,
            regla: row.regla, detalle: row.detalle || '', codigo,
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

/**
 * Router de CALLBACK (Fase 2b): lo llama el BOT-RH cuando un jefe responde su
 * justificación por WhatsApp. NO usa JWT (el bot no tiene sesión); se protege
 * con el secreto compartido `AVISO_ASISTENCIA_SECRET` (header x-aviso-secret).
 * Se monta en /checador/agente/callback.
 */
export const agenteCallbackRouter = Router();

agenteCallbackRouter.post('/justificar', async (req: Request, res: Response) => {
  const secret = process.env.AVISO_ASISTENCIA_SECRET || '';
  if (secret && String(req.headers['x-aviso-secret'] || '') !== secret) {
    return res.status(401).json({ error: 'No autorizado.' });
  }
  try {
    const { codigo, justificacion, quien } = req.body || {};
    if (!codigo || !String(justificacion || '').trim()) {
      return res.status(400).json({ error: 'Faltan codigo y justificacion.' });
    }
    const row = await justificarPorCodigo(String(codigo), String(justificacion).trim(), String(quien || 'jefe'));
    if (!row) return res.status(404).json({ ok: false, error: 'Código no encontrado.' });
    res.json({
      ok: true,
      alerta: {
        empleado: row.empleado_nombre || row.empleado_codigo,
        sucursal: row.sucursal_id, fecha: row.fecha, regla: row.regla,
      },
    });
  } catch (e) { fallo(res, e, 'No se pudo guardar la justificación.'); }
});
