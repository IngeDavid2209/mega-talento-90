import { Router, Request, Response } from 'express';
import { requireAuth, AuthedRequest, esAdminReq, quienReq } from '../auth';
import { detectar } from './detector';
import {
  guardarBorradores, reconciliarBorradores, listarAlertas, decidirAlerta,
  asegurarCodigo, justificarPorCodigo, agruparAlertas, decidirGrupo,
} from './persistencia';
import { getJefe, listarJefes, upsertJefe } from './jefes';
import { notificarJefe } from './notificador';
import { estadoCorredor, correrUnaVez } from './corredor';
import { asistenciaPersonas } from './asistencia-personas';
import { bancoHorasExtra, hoyMexico, crearAjuste, anularAjuste } from './horas-extra';
import { presenciaAhora } from './presencia';
import { equipoAhora } from './equipo';
import { crucesEntrePlazas } from './cruces-plazas';
import { pool } from '../db';

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
/**
 * GET /checador/agente/cruces?desde&hasta
 *
 * Quien checo en la plaza de OTRO. A diferencia de /asistencia, esta mira
 * TODAS las plazas a la vez: el cruce solo existe comparando una contra otra,
 * y no se puede ver desde una sola —de hecho por codigo no se ve nunca, porque
 * los codigos se repiten entre plazas y la marca entra como si fuera del
 * homonimo de alla—. La regla y el porque estan en cruces-plazas.ts.
 */
agenteHorariosRouter.get('/cruces', async (req: Request, res: Response) => {
  try {
    const { desde, hasta } = req.query as any;
    if (!desde || !hasta) return res.status(400).json({ error: 'Faltan desde y hasta.' });
    if (!RE_FECHA.test(String(desde)) || !RE_FECHA.test(String(hasta))) {
      return res.status(400).json({ error: 'Las fechas deben venir como yyyy-MM-dd.' });
    }
    if (String(hasta) < String(desde)) {
      return res.status(400).json({ error: 'hasta no puede ser anterior a desde.' });
    }
    res.json(await crucesEntrePlazas({ desde: String(desde), hasta: String(hasta) }));
  } catch (e) {
    fallo(res, e, 'No se pudieron calcular los cruces entre plazas.');
  }
});
agenteHorariosRouter.get('/asistencia', async (req: Request, res: Response) => {
  try {
    const { sucursalId, desde, hasta, soloPromotoras } = req.query as any;
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
      // `?soloPromotoras=1` devuelve la asistencia de las PROMOTORAS de esa
      // plaza en vez de la del personal de planta. Es la misma regla con el
      // filtro invertido, no otro cálculo.
      soloPromotoras: soloPromotoras === '1' || soloPromotoras === 'true',
    }));
  } catch (e) {
    fallo(res, e, 'No se pudo calcular la asistencia.');
  }
});

/**
 * GET /checador/agente/horas-extra?sucursalId[&hasta][&codigo]
 * El banco de horas extra de la plaza (o de una persona): ganadas, usadas y
 * saldo, desde HORAS_EXTRA_DESDE hasta `hasta` (hoy si no viene).
 */
agenteHorariosRouter.get('/horas-extra', async (req: Request, res: Response) => {
  try {
    const { sucursalId, codigo } = req.query as any;
    const hasta = String((req.query as any).hasta || hoyMexico());
    if (!sucursalId) return res.status(400).json({ error: 'Falta sucursalId.' });
    if (!RE_FECHA.test(hasta)) return res.status(400).json({ error: 'hasta debe venir como yyyy-MM-dd.' });
    res.json(await bancoHorasExtra(String(sucursalId), hasta, codigo ? String(codigo).trim() : undefined));
  } catch (e) {
    fallo(res, e, 'No se pudieron calcular las horas extra.');
  }
});

/**
 * POST /checador/agente/horas-extra/ajuste { sucursalId, codigo, minutos, motivo, fecha? }
 * Saldo inicial o corrección del banco de una persona (minutos con signo).
 * Solo administradores: mueve lo que se le paga o se le descuenta a alguien.
 */
agenteHorariosRouter.post('/horas-extra/ajuste', async (req: AuthedRequest, res: Response) => {
  try {
    if (!esAdminReq(req)) return res.status(403).json({ error: 'Solo servicios al personal puede ajustar el saldo de horas extra.' });
    const { sucursalId, codigo } = req.body || {};
    const minutos = Math.round(Number(req.body?.minutos));
    const motivo = String(req.body?.motivo ?? '').trim();
    const fecha = String(req.body?.fecha || hoyMexico());
    if (!sucursalId || !codigo) return res.status(400).json({ error: 'Faltan sucursalId y codigo.' });
    if (!Number.isFinite(minutos) || minutos === 0 || Math.abs(minutos) > 100000) {
      return res.status(400).json({ error: 'Indica cuántas horas suma o resta (distinto de cero).' });
    }
    if (motivo.length < 5) return res.status(400).json({ error: 'Escribe el motivo del ajuste (por ejemplo, "saldo que traía al 23 de septiembre").' });
    if (!RE_FECHA.test(fecha)) return res.status(400).json({ error: 'La fecha debe venir como yyyy-MM-dd.' });
    res.json(await crearAjuste({ sucursalId: String(sucursalId), codigo: String(codigo).trim(), minutos, motivo, fecha, quien: quienReq(req) }));
  } catch (e) {
    fallo(res, e, 'No se pudo guardar el ajuste.');
  }
});

/** POST /checador/agente/horas-extra/ajuste/:id/anular { motivo } — no se borra, se anula. */
agenteHorariosRouter.post('/horas-extra/ajuste/:id/anular', async (req: AuthedRequest, res: Response) => {
  try {
    if (!esAdminReq(req)) return res.status(403).json({ error: 'Solo servicios al personal puede quitar un ajuste de horas extra.' });
    const motivo = String(req.body?.motivo ?? '').trim();
    if (motivo.length < 5) return res.status(400).json({ error: 'Escribe por qué se quita el ajuste.' });
    const ok = await anularAjuste(String(req.params.id), motivo, quienReq(req));
    if (!ok) return res.status(404).json({ error: 'Ese ajuste ya no existe o ya estaba anulado.' });
    res.json({ ok: true });
  } catch (e) {
    fallo(res, e, 'No se pudo quitar el ajuste.');
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
 * GET /checador/agente/presencia
 * Quién está en cada plaza AHORA. Es lo que alimenta el mapa en vivo.
 * Sin parámetros: mira las doce plazas a la vez, como la vista de cruces.
 */
agenteHorariosRouter.get('/presencia', async (_req: Request, res: Response) => {
  try {
    res.json(await presenciaAhora());
  } catch (e) {
    fallo(res, e, 'No se pudo leer quién está en cada plaza.');
  }
});

/**
 * GET /checador/agente/equipo
 * "Ubicación de mi equipo": quién está en cada RELOJ ahora, y si está
 * trabajando o comiendo. SOLO ADMINISTRADORES, y se valida aquí: esconder el
 * botón en el portal no impide llamar a la ruta. La base guarda el rol en dos
 * escrituras (`admin` y `Administrador`), así que se compara por prefijo.
 */
agenteHorariosRouter.get('/equipo', async (req: AuthedRequest, res: Response) => {
  const rol = String(req.usuario?.rol || '').toLowerCase();
  if (!rol.startsWith('admin')) return res.status(403).json({ error: 'Solo administradores.' });
  try {
    // ?fresco=1 justo después de justificar: sin la caché de 5 min.
    res.json(await equipoAhora(String((req.query as any).fresco || '') === '1'));
  } catch (e) {
    fallo(res, e, 'No se pudo leer la ubicación del equipo.');
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

// ══ EL HORARIO DE CADA PERSONA (06/10/2026) ═════════════════════════
//
// RH le pone su horario a una persona, o el mismo a varias de un jalón (un
// departamento entero), y luego lo ajusta persona por persona. Se guarda en
// `horarios_confirmados`, que es la tabla que el cálculo ya obedece: ver
// HorarioAsignado en asistencia-personas.ts.

const RE_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const aMin = (h: string) => { const [a, b] = h.split(':').map(Number); return a * 60 + b; };

/** Hasta cuántos horarios distintos se le ponen a una persona (mañana, tarde, …). */
const MAX_HORARIOS = 4;

/**
 * Los horarios que llegan: `horarios: [{entrada, salida, comidaMin}, …]` (varios,
 * 15/10/2026) o, como antes, `entrada`/`salida`/`comidaMin` sueltos (uno).
 */
function horariosDelCuerpo(b: any): Array<{ entrada: string; salida: string; comidaMin: number }> {
  const lista = Array.isArray(b.horarios) && b.horarios.length ? b.horarios : [b];
  return lista.map((h: any) => ({
    entrada: String(h?.entrada || ''), salida: String(h?.salida || ''), comidaMin: Number(h?.comidaMin),
  }));
}

/** Valida lo que llega; devuelve el error en palabras de RH, o null si está bien. */
function errorDeHorario(b: any): string | null {
  const horarios = horariosDelCuerpo(b);
  if (horarios.length > MAX_HORARIOS) return `Se le pueden poner hasta ${MAX_HORARIOS} horarios.`;
  for (const [i, h] of horarios.entries()) {
    const cual = horarios.length > 1 ? ` (horario ${i + 1})` : '';
    if (!RE_HORA.test(h.entrada) || !RE_HORA.test(h.salida)) {
      return `La entrada y la salida deben venir como HH:MM (por ejemplo 08:00 y 18:00)${cual}.`;
    }
    if (aMin(h.salida) <= aMin(h.entrada)) return `La salida tiene que ser después de la entrada${cual}.`;
    if (!Number.isInteger(h.comidaMin) || h.comidaMin < 0 || h.comidaMin > 180) return `La comida va de 0 a 180 minutos${cual}.`;
    if (aMin(h.salida) - aMin(h.entrada) - h.comidaMin < 60) return `Con esa comida no le queda ni una hora de trabajo: revisa las horas${cual}.`;
  }
  // Cada día se elige el horario por su ENTRADA: dos con la misma no se distinguen.
  if (new Set(horarios.map((h) => h.entrada)).size !== horarios.length) {
    return 'Dos horarios no pueden empezar a la misma hora: cada día se reconoce cuál trabajó por su hora de entrada.';
  }
  if (b.sabado) {
    if (!RE_HORA.test(String(b.sabadoEntrada || '')) || !RE_HORA.test(String(b.sabadoSalida || ''))) {
      return 'El sábado necesita su hora de entrada y de salida.';
    }
    if (aMin(b.sabadoSalida) <= aMin(b.sabadoEntrada)) return 'La salida del sábado tiene que ser después de su entrada.';
  }
  return null;
}

/**
 * PUT /checador/agente/horario-asignado
 * body: { sucursalId, codigos: string[], entrada, salida, comidaMin, sabado, sabadoEntrada?, sabadoSalida? }
 *   o, con varios horarios: { …, horarios: [{ entrada, salida, comidaMin }, …], sabado, … }
 */
agenteHorariosRouter.put('/horario-asignado', async (req: AuthedRequest, res: Response) => {
  const b = req.body || {};
  const sucursalId = String(b.sucursalId || '').trim();
  const codigos: string[] = Array.isArray(b.codigos)
    ? [...new Set<string>(b.codigos.map((c: any) => String(c).trim()).filter(Boolean))] : [];
  if (!sucursalId || !codigos.length) return res.status(400).json({ error: 'Faltan la sucursal y a quién se le pone el horario.' });
  if (codigos.length > 500) return res.status(400).json({ error: 'Son demasiadas personas de una vez.' });
  const err = errorDeHorario(b);
  if (err) return res.status(400).json({ error: err });

  const quien = req.usuario?.email || req.usuario?.sub || 'RH';
  const sabado = !!b.sabado;
  // Ver db/horario-asignado.sql: `turnos` lleva todas las entradas y la salida y
  // la comida son las del primero; `horarios` solo se llena cuando son varios.
  const horarios = horariosDelCuerpo(b);
  const [primero] = horarios;
  try {
    const { rowCount } = await pool.query(
      `INSERT INTO horarios_confirmados
         (sucursal_id, empleado_codigo, turnos, salida, comida_min, sabado, sabado_entrada, sabado_salida,
          horarios, nota, confirmado_por)
       SELECT $1, c, $3::text[], $4, $5, $6, $7, $8, $9::jsonb, 'Horario asignado desde el portal', $10
         FROM unnest($2::text[]) AS c
       ON CONFLICT (sucursal_id, empleado_codigo) DO UPDATE
         SET turnos = EXCLUDED.turnos, salida = EXCLUDED.salida, comida_min = EXCLUDED.comida_min,
             sabado = EXCLUDED.sabado, sabado_entrada = EXCLUDED.sabado_entrada,
             sabado_salida = EXCLUDED.sabado_salida, horarios = EXCLUDED.horarios, nota = EXCLUDED.nota,
             confirmado_por = EXCLUDED.confirmado_por, actualizado_en = now()`,
      [sucursalId, codigos, horarios.map((h) => h.entrada), primero.salida, primero.comidaMin, sabado,
       sabado ? b.sabadoEntrada : null, sabado ? b.sabadoSalida : null,
       horarios.length > 1 ? JSON.stringify(horarios) : null, quien]);
    res.json({ ok: true, guardados: rowCount });
  } catch (e) { fallo(res, e, 'No se pudo guardar el horario.'); }
});

/**
 * POST /checador/agente/horario-asignado/quitar   body: { sucursalId, codigos: string[] }
 * La persona vuelve a medirse con el horario deducido de sus checadas.
 * (POST y no DELETE: un DELETE con cuerpo no lo pasan todos los proxies.)
 */
agenteHorariosRouter.post('/horario-asignado/quitar', async (req: AuthedRequest, res: Response) => {
  const b = req.body || {};
  const sucursalId = String(b.sucursalId || '').trim();
  const codigos: string[] = Array.isArray(b.codigos) ? b.codigos.map((c: any) => String(c).trim()).filter(Boolean) : [];
  if (!sucursalId || !codigos.length) return res.status(400).json({ error: 'Faltan la sucursal y a quién se le quita el horario.' });
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM horarios_confirmados WHERE sucursal_id = $1 AND empleado_codigo = ANY($2::text[])`,
      [sucursalId, codigos]);
    res.json({ ok: true, quitados: rowCount });
  } catch (e) { fallo(res, e, 'No se pudo quitar el horario.'); }
});
