import { Router, Response } from 'express';
import type { PoolClient } from 'pg';
import { pool } from './db';
import { requireAuth, AuthedRequest, esAdminReq, quienReq } from './auth';

/**
 * INCIDENCIAS DE PERSONAL: vacaciones, permisos, incapacidades, faltas
 * injustificadas, amonestaciones… por un día o por un periodo.
 *
 * El catálogo vive AQUÍ y no en texto libre porque el cálculo de asistencia
 * decide por el TIPO si un día deja de contar como falta (`excusaFalta`). Con
 * texto libre, "vacasiones" escrito a mano no excusaba nada y "permiso sin
 * goce" excusaba lo mismo que "con goce" solo porque dice "permiso".
 *
 *   excusaFalta = true  → la persona NO tenía que estar: el día sin marcas deja
 *                         de ser falta (se pinta con el código de la incidencia).
 *   excusaFalta = false → queda registrada y se ve en el tablero, pero no cambia
 *                         el cálculo (una amonestación no borra un retardo).
 *
 * `falta_injustificada` es la excepción al revés: RH confirma que SÍ es falta.
 * No cambia el número (ya era falta), pero la saca de "por revisar".
 *
 * ══ EL FLUJO (01/10/2026) ══════════════════════════════════════════
 *
 * Antes guardar ERA aprobar, y borrar no dejaba rastro. Ahora cada incidencia
 * tiene estado, y cada paso queda en la bitácora con quién y cuándo:
 *
 *   capturada ─calificar─▶ calificada ─cierre de semana─▶ cerrada ─auditar─▶ auditada
 *       └─rechazar─▶ rechazada        (capturada/calificada) ─anular─▶ anulada
 *
 *   · El encargado ENTREGA (capturada): todavía no mueve el número.
 *   · Servicios al personal CALIFICA o RECHAZA. Solo lo calificado cuenta.
 *   · El cierre de semana (cierres.ts) la pasa a CERRADA y bloquea la semana.
 *   · Contabilidad AUDITA lo cerrado; no puede auditar lo que ella calificó.
 *
 * Un administrador que captura desde el portal es servicios al personal: su
 * captura entra ya calificada (con su nombre en `calificado_por`, para que la
 * auditoría vea que fue autocalificada). Con `entregar: true` la deja en
 * capturada para que la califique otra persona.
 *
 * Tablas: db/incidencias.sql y db/incidencias-flujo.sql.
 */
export interface TipoIncidencia {
  tipo: string;
  etiqueta: string;
  /** Código de 2-3 letras que cabe en la celda del reporte. */
  codigo: string;
  excusaFalta: boolean;
}

export const TIPOS_INCIDENCIA: TipoIncidencia[] = [
  { tipo: 'vacaciones',          etiqueta: 'Vacaciones',                 codigo: 'VAC', excusaFalta: true },
  { tipo: 'permiso_sin_goce',    etiqueta: 'Permiso sin goce de sueldo', codigo: 'PSG', excusaFalta: true },
  { tipo: 'permiso_con_goce',    etiqueta: 'Permiso con goce de sueldo', codigo: 'PCG', excusaFalta: true },
  { tipo: 'falta_injustificada', etiqueta: 'Falta injustificada',        codigo: 'FI',  excusaFalta: false },
  { tipo: 'incapacidad',         etiqueta: 'Incapacidad',                codigo: 'INC', excusaFalta: true },
  { tipo: 'paternidad',          etiqueta: 'Paternidad',                 codigo: 'PAT', excusaFalta: true },
  { tipo: 'maternidad',          etiqueta: 'Maternidad',                 codigo: 'MAT', excusaFalta: true },
  { tipo: 'riesgo_trabajo',      etiqueta: 'Riesgo de trabajo',          codigo: 'RT',  excusaFalta: true },
  { tipo: 'amonestacion',        etiqueta: 'Amonestación',               codigo: 'AMO', excusaFalta: false },
  { tipo: 'semana_reducida',     etiqueta: 'Semana reducida',            codigo: 'SR',  excusaFalta: true },
  // Usó horas que tenía a favor: justifica el día y sus minutos SE SUMAN a las
  // horas trabajadas de ese día (29/09/2026). Lleva `minutos` obligatorio.
  { tipo: 'horas_extra',         etiqueta: 'Uso de horas extra',         codigo: 'HE',  excusaFalta: true },
  // "Otros" JUSTIFICA desde el 29/09/2026: el portal exige escribir el motivo, y
  // RH lo usa para lo que no tiene tipo propio (una junta, un trámite).
  { tipo: 'otros',               etiqueta: 'Otros',                      codigo: 'OTR', excusaFalta: true },
  // HORARIO DISTINTO (30/09/2026): ese día entró en otro horario (le cambiaron
  // la entrada, cubrió otro turno). NO justifica: su retardo de ESE día se mide
  // contra la hora nueva, que va en `minutos` (minuto del día: 600 = 10:00).
  // Es de UN solo día; su horario de siempre no cambia. Desde el 01/10/2026
  // exige motivo y quién lo autorizó: en sus dos primeros días se usó 63 veces,
  // 40 de ellas corriendo la entrada una hora o más, sin decir por qué.
  { tipo: 'horario_distinto',    etiqueta: 'Horario distinto',           codigo: 'HD',  excusaFalta: false },
  // DESAYUNO Y COMIDA DISTINTOS (08/10/2026): igual que "Horario distinto", pero
  // para la pausa. Ese día RH autorizó otro tiempo de desayuno o de comida
  // (`minutos`), y el exceso se mide contra ese. De un solo día, con motivo y
  // quién lo autorizó. No justifica: si se pasó también del nuevo, se ve.
  { tipo: 'desayuno_distinto',   etiqueta: 'Desayuno distinto',          codigo: 'DD',  excusaFalta: false },
  { tipo: 'comida_distinta',     etiqueta: 'Comida distinta',            codigo: 'CD',  excusaFalta: false },
  // CAMBIO DE DÍA DE DESCANSO (08/10/2026): ese día es su descanso de la semana,
  // y su descanso habitual de ESA semana pasa a ser día de trabajo (si no
  // viene, es falta). De un solo día. No "justifica": cambia qué día le toca.
  { tipo: 'cambio_descanso',     etiqueta: 'Cambio de día de descanso',  codigo: 'DES', excusaFalta: false },
  // DESCANSO (13/10/2026): ese día (o esos días) es descanso, SIN mover su
  // descanso habitual: para quien le tocan dos descansos en la semana, o para
  // quitarle a unas vacaciones el día que de todos modos descansaba. Manda
  // sobre las vacaciones u otra incidencia de esos días.
  { tipo: 'descanso',            etiqueta: 'Descanso',                   codigo: 'DSC', excusaFalta: true },
];

/** Tipos de UN solo día que ajustan cómo se mide ese día, sin justificarlo. */
export const TIPOS_DE_AJUSTE = new Set(['horario_distinto', 'desayuno_distinto', 'comida_distinta', 'cambio_descanso']);

const POR_TIPO = new Map(TIPOS_INCIDENCIA.map((t) => [t.tipo, t]));
export const tipoIncidencia = (tipo: string) => POR_TIPO.get(tipo);

export type EstadoIncidencia = 'capturada' | 'calificada' | 'rechazada' | 'cerrada' | 'auditada' | 'anulada';

/** Los estados que SÍ cambian el cálculo de asistencia. */
export const ESTADOS_VIGENTES: EstadoIncidencia[] = ['calificada', 'cerrada', 'auditada'];

/**
 * Las banderas que la auditoría necesita ver sin abrir cada renglón. No
 * bloquean nada: dicen dónde mirar.
 */
export type BanderaIncidencia =
  | 'corrimiento_60'   // Horario distinto que corre la entrada 60 min o más
  | 'hd_frecuente'     // 3 o más Horario distinto de la misma persona en 30 días
  | 'autocalificada'   // la calificó la misma persona que la capturó
  | 'sin_nota'         // no dice nada que la respalde (folio, motivo…)
  | 'retroactiva';     // se capturó más de 7 días después de pasar

/** Desde cuántos minutos un Horario distinto se marca para revisar. */
export const HD_CORRIMIENTO_ALERTA_MIN = 60;
/** Cuántos Horario distinto en 30 días hacen a alguien "frecuente". */
export const HD_FRECUENTE_30D = 3;

export interface Incidencia {
  id: string;
  sucursalId: string;
  empleadoCodigo: string;
  tipo: string;
  desde: string;
  hasta: string;
  nota: string;
  /** "Uso de horas extra": minutos usados por día. "Horario distinto": su entrada de ese día. */
  minutos: number | null;
  creadoPor: string;
  creadoEn: string;
  estado: EstadoIncidencia;
  autorizo: string;
  /** Solo "Horario distinto": su entrada de siempre (minuto del día). */
  horarioBaseMin: number | null;
  calificadoPor: string;
  calificadoEn: string | null;
  motivoRechazo: string;
  auditadoPor: string;
  auditadoEn: string | null;
  notaAuditoria: string;
  anuladoPor: string;
  anuladoEn: string | null;
  motivoAnulacion: string;
  banderas: BanderaIncidencia[];
}

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
/** Un dedazo en el año (2062) no debe escribir un periodo de 36 años. */
const TOPE_DIAS = 366;

const aFecha = (v: any): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').slice(0, 10);

function banderasDe(r: any): BanderaIncidencia[] {
  const b: BanderaIncidencia[] = [];
  if (r.tipo === 'horario_distinto') {
    if (r.minutos != null && r.horario_base_min != null
        && Number(r.minutos) - Number(r.horario_base_min) >= HD_CORRIMIENTO_ALERTA_MIN) b.push('corrimiento_60');
    if (r.hd_30d != null && Number(r.hd_30d) >= HD_FRECUENTE_30D) b.push('hd_frecuente');
  }
  if (r.calificado_por && r.creado_por && r.calificado_por === r.creado_por) b.push('autocalificada');
  // El Horario distinto lleva su nota armada sola; "sin nota" es para lo demás.
  // Los ajustes de horario y de pausa llevan su motivo y quién lo autorizó aparte.
  if (!['horario_distinto', 'desayuno_distinto', 'comida_distinta'].includes(r.tipo) && !String(r.nota || '').trim()) b.push('sin_nota');
  if (r.creado_en && r.hasta) {
    const hasta = aFecha(r.hasta);
    const creado = new Date(r.creado_en).getTime();
    if (creado - Date.parse(`${hasta}T23:59:59-06:00`) > 7 * 86400000) b.push('retroactiva');
  }
  return b;
}

const mapIncidencia = (r: any): Incidencia => ({
  id: r.id,
  sucursalId: r.sucursal_id,
  empleadoCodigo: String(r.empleado_codigo).trim(),
  tipo: r.tipo,
  desde: aFecha(r.desde),
  hasta: aFecha(r.hasta),
  nota: r.nota || '',
  minutos: r.minutos == null ? null : Number(r.minutos),
  creadoPor: r.creado_por || '',
  creadoEn: r.creado_en,
  // Antes de la migración del flujo no hay columna: todo lo guardado contaba.
  estado: (r.estado || 'calificada') as EstadoIncidencia,
  autorizo: r.autorizo || '',
  horarioBaseMin: r.horario_base_min == null ? null : Number(r.horario_base_min),
  calificadoPor: r.calificado_por || '',
  calificadoEn: r.calificado_en || null,
  motivoRechazo: r.motivo_rechazo || '',
  auditadoPor: r.auditado_por || '',
  auditadoEn: r.auditado_en || null,
  notaAuditoria: r.nota_auditoria || '',
  anuladoPor: r.anulado_por || '',
  anuladoEn: r.anulado_en || null,
  motivoAnulacion: r.motivo_anulacion || '',
  banderas: banderasDe(r),
});

/**
 * Las incidencias que TOCAN el rango (no solo las que empiezan en él): unas
 * vacaciones del 28 al 5 tienen que verse si se está mirando del 1 al 7.
 *
 * Por omisión trae SOLO las vigentes (calificada, cerrada, auditada): esta es la
 * única puerta por la que el cálculo de asistencia lee incidencias, así que lo
 * capturado sin calificar, lo rechazado y lo anulado no mueven el número.
 *
 * Si la tabla todavía no existe (migración sin aplicar) no es un error: no hay
 * incidencias, y la asistencia sigue saliendo como antes. Si falta la columna
 * `estado` (migración del flujo sin aplicar), todo lo guardado cuenta, como antes.
 */
export async function incidenciasEnRango(
  sucursalId: string, desde: string, hasta: string, codigo?: string,
  estados: EstadoIncidencia[] = ESTADOS_VIGENTES,
): Promise<Incidencia[]> {
  const params: any[] = [sucursalId, desde, hasta];
  let filtro = '';
  if (codigo) { params.push(codigo); filtro += ` AND i.empleado_codigo = $${params.length}`; }
  const base = `FROM asistencia_incidencias i
        WHERE i.sucursal_id = $1 AND i.desde <= $3::date AND i.hasta >= $2::date${filtro}`;
  try {
    const { rows } = await pool.query(
      `SELECT i.*,
              CASE WHEN i.tipo = 'horario_distinto' THEN (
                SELECT count(*) FROM asistencia_incidencias j
                 WHERE j.sucursal_id = i.sucursal_id AND j.empleado_codigo = i.empleado_codigo
                   AND j.tipo = 'horario_distinto' AND j.estado NOT IN ('anulada', 'rechazada')
                   AND j.desde BETWEEN i.desde - 29 AND i.desde) END AS hd_30d
         ${base} AND i.estado = ANY($${params.length + 1})
        ORDER BY i.desde, i.creado_en`,
      [...params, estados]);
    return rows.map(mapIncidencia);
  } catch (e: any) {
    if (e?.code === '42P01') return [];   // undefined_table
    if (e?.code === '42703') {            // undefined_column: flujo sin migrar
      const { rows } = await pool.query(`SELECT i.* ${base} ORDER BY i.desde, i.creado_en`, params);
      return rows.map(mapIncidencia);
    }
    throw e;
  }
}

// ══ SEMANA CERRADA ═════════════════════════════════════════════════
//
// Vive aquí y no en cierres.ts porque cierres.ts importa el cálculo de
// asistencia, y el cálculo importa este archivo: así no se muerden la cola.

export interface CierreVigente {
  id: string; sucursalId: string; desde: string; hasta: string;
  cerradoPor: string; cerradoEn: string;
}

/** El primer cierre VIGENTE de la plaza que toca el rango, o null. */
export async function cierreQueToca(
  sucursalId: string, desde: string, hasta: string, db: { query: PoolClient['query'] } = pool,
): Promise<CierreVigente | null> {
  try {
    const { rows } = await db.query(
      `SELECT id, sucursal_id, desde, hasta, cerrado_por, cerrado_en FROM asistencia_cierres
        WHERE sucursal_id = $1 AND reabierto_en IS NULL AND desde <= $3::date AND hasta >= $2::date
        ORDER BY desde LIMIT 1`,
      [sucursalId, desde, hasta]);
    const r = rows[0];
    return r ? {
      id: r.id, sucursalId: r.sucursal_id, desde: aFecha(r.desde), hasta: aFecha(r.hasta),
      cerradoPor: r.cerrado_por || '', cerradoEn: r.cerrado_en,
    } : null;
  } catch (e: any) {
    if (e?.code === '42P01') return null;   // sin la tabla de cierres no hay nada cerrado
    throw e;
  }
}

const fechaCorta = (iso: string) => { const [a, m, d] = iso.split('-'); return `${d}/${m}/${a}`; };

export function textoSemanaCerrada(c: CierreVigente): string {
  return `La semana del ${fechaCorta(c.desde)} al ${fechaCorta(c.hasta)} ya se cerró para prenómina` +
    `${c.cerradoPor ? ` (la cerró ${c.cerradoPor})` : ''}. Para cambiarla hay que reabrirla.`;
}

// ══ BITÁCORA ═══════════════════════════════════════════════════════

export async function registrarPaso(
  db: { query: PoolClient['query'] },
  p: { fila: any; accion: string; antes: string | null; quien: string; detalle?: string },
) {
  await db.query(
    `INSERT INTO asistencia_incidencias_bitacora
       (incidencia_id, accion, estado_antes, estado_despues, quien, detalle, fila)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [p.fila.id, p.accion, p.antes, p.fila.estado, p.quien, p.detalle || null, JSON.stringify(p.fila)]);
}

/** Corre `fn` dentro de una transacción. */
export async function enTransaccion<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** Error con código HTTP, para responder 4xx desde dentro de una transacción. */
class Rechazo extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}

export const incidenciasRouter = Router();
incidenciasRouter.use(requireAuth);

function responderError(res: Response, e: any, msg: string, etiqueta: string) {
  if (e instanceof Rechazo) return res.status(e.status).json({ error: e.message });
  console.error(`[incidencias] ${etiqueta}`, e);
  return res.status(500).json({ error: msg });
}

/** GET /checador/incidencias/tipos — el catálogo, para que el front no lo copie a mano. */
incidenciasRouter.get('/tipos', (_req, res) => { res.json(TIPOS_INCIDENCIA); });

const TODOS_LOS_ESTADOS: EstadoIncidencia[] = ['capturada', 'calificada', 'rechazada', 'cerrada', 'auditada', 'anulada'];

/**
 * GET /checador/incidencias?sucursalId&desde&hasta[&codigo][&estados=a,b]
 * Sin `estados` trae todas MENOS las anuladas (la bandeja y la ficha); con
 * `estados=todas` trae también las anuladas (la auditoría).
 */
incidenciasRouter.get('/', async (req: AuthedRequest, res: Response) => {
  try {
    const { sucursalId, desde, hasta, codigo, estados } = req.query as any;
    if (!sucursalId || !RE_FECHA.test(String(desde)) || !RE_FECHA.test(String(hasta))) {
      return res.status(400).json({ error: 'Faltan sucursalId, desde y hasta (yyyy-MM-dd).' });
    }
    let lista: EstadoIncidencia[] = TODOS_LOS_ESTADOS.filter((e) => e !== 'anulada');
    if (estados === 'todas') lista = TODOS_LOS_ESTADOS;
    else if (estados) lista = String(estados).split(',').filter((e): e is EstadoIncidencia =>
      (TODOS_LOS_ESTADOS as string[]).includes(e));
    res.json(await incidenciasEnRango(sucursalId, desde, hasta, codigo || undefined, lista));
  } catch (e) {
    responderError(res, e, 'No se pudieron leer las incidencias.', 'leer');
  }
});

/** GET /checador/incidencias/:id/bitacora — cada paso de una incidencia. */
incidenciasRouter.get('/:id/bitacora', async (req: AuthedRequest, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT accion, estado_antes, estado_despues, quien, cuando, detalle
         FROM asistencia_incidencias_bitacora WHERE incidencia_id = $1 ORDER BY cuando, id`,
      [req.params.id]);
    res.json(rows.map((r) => ({
      accion: r.accion, estadoAntes: r.estado_antes, estadoDespues: r.estado_despues,
      quien: r.quien || '', cuando: r.cuando, detalle: r.detalle || '',
    })));
  } catch (e) {
    responderError(res, e, 'No se pudo leer la bitácora.', 'bitacora');
  }
});

/**
 * POST /checador/incidencias
 * body: { sucursalId, empleadoCodigo, tipo, desde, hasta?, nota?, minutos?, autorizo?, entregar? }
 * `hasta` vacío = un solo día.
 * "Horario distinto" además: { motivo, autorizo, horarioBase } obligatorios.
 */
incidenciasRouter.post('/', async (req: AuthedRequest, res: Response) => {
  try {
    const { sucursalId, empleadoCodigo, tipo, desde } = req.body || {};
    let nota = String(req.body?.nota ?? '').trim();
    const autorizo = String(req.body?.autorizo ?? '').trim();
    // Uso de horas extra: cuántos minutos por día (entre 1 min y 12 h).
    let minutos: number | null = null;
    let horarioBase: number | null = null;
    if (tipo === 'horas_extra') {
      minutos = Math.round(Number(req.body?.minutos));
      if (!Number.isFinite(minutos) || minutos < 1 || minutos > 720) {
        return res.status(400).json({ error: 'Indica cuántas horas extra usó (entre 1 minuto y 12 horas).' });
      }
    }
    if (tipo === 'horario_distinto') {
      minutos = Math.round(Number(req.body?.minutos));
      if (!Number.isFinite(minutos) || minutos < 0 || minutos > 1439) {
        return res.status(400).json({ error: 'Falta la hora de entrada de ese día.' });
      }
      if ((req.body?.hasta || desde) !== desde) {
        return res.status(400).json({ error: 'El horario distinto es de un solo día.' });
      }
      const motivo = String(req.body?.motivo ?? '').trim();
      if (!motivo) return res.status(400).json({ error: 'Escribe por qué ese día entró en otro horario.' });
      if (!autorizo) return res.status(400).json({ error: 'Escribe quién autorizó el cambio de horario.' });
      if (req.body?.horarioBase != null && req.body?.horarioBase !== '') {
        horarioBase = Math.round(Number(req.body.horarioBase));
        if (!Number.isFinite(horarioBase) || horarioBase < 0 || horarioBase > 1439) horarioBase = null;
      }
      // El motivo va primero; los hechos del reloj (que arma la pantalla) detrás.
      nota = nota ? `${motivo} — ${nota}` : motivo;
    }
    // Desayuno o comida distintos: cuántos minutos tuvo autorizados ese día.
    if (tipo === 'desayuno_distinto' || tipo === 'comida_distinta') {
      const cual = tipo === 'desayuno_distinto' ? 'desayuno' : 'comida';
      minutos = Math.round(Number(req.body?.minutos));
      if (!Number.isFinite(minutos) || minutos < 0 || minutos > 240) {
        return res.status(400).json({ error: `Indica cuántos minutos de ${cual} tuvo autorizados (de 0 a 240).` });
      }
      if ((req.body?.hasta || desde) !== desde) {
        return res.status(400).json({ error: cual === 'desayuno' ? 'El desayuno distinto es de un solo día.' : 'La comida distinta es de un solo día.' });
      }
      const motivo = String(req.body?.motivo ?? '').trim();
      if (!motivo) return res.status(400).json({ error: `Escribe por qué ese día tuvo otro tiempo de ${cual}.` });
      if (!autorizo) return res.status(400).json({ error: 'Escribe quién lo autorizó.' });
      nota = nota ? `${motivo} — ${nota}` : motivo;
    }
    if (tipo === 'cambio_descanso' && (req.body?.hasta || desde) !== desde) {
      return res.status(400).json({ error: 'El cambio de descanso es de un solo día: elige el día que descansa.' });
    }
    if (tipo === 'otros' && !nota) {
      return res.status(400).json({ error: 'Con "Otros" hay que escribir el motivo.' });
    }
    const hasta = req.body?.hasta || desde;
    if (!sucursalId || !empleadoCodigo || !tipo || !desde) {
      return res.status(400).json({ error: 'Faltan sucursalId, empleadoCodigo, tipo o desde.' });
    }
    if (!tipoIncidencia(String(tipo))) {
      return res.status(400).json({ error: `Tipo de incidencia desconocido: ${tipo}.` });
    }
    if (!RE_FECHA.test(String(desde)) || !RE_FECHA.test(String(hasta))) {
      return res.status(400).json({ error: 'Las fechas deben venir como yyyy-MM-dd.' });
    }
    if (String(hasta) < String(desde)) {
      return res.status(400).json({ error: 'La fecha final no puede ser anterior a la inicial.' });
    }
    const dias = Math.round(
      (Date.parse(`${hasta}T12:00:00Z`) - Date.parse(`${desde}T12:00:00Z`)) / 86400000) + 1;
    if (dias > TOPE_DIAS) {
      return res.status(400).json({ error: `El periodo son ${dias} días y el tope es ${TOPE_DIAS}. Revisa las fechas.` });
    }

    const quien = quienReq(req);
    // Servicios al personal (admin) califica al capturar, salvo que la entregue
    // a propósito para que la vea otra persona. Los demás solo entregan.
    const directa = esAdminReq(req) && req.body?.entregar !== true;
    const estado: EstadoIncidencia = directa ? 'calificada' : 'capturada';

    const fila = await enTransaccion(async (c) => {
      const cerrado = await cierreQueToca(sucursalId, desde, hasta, c);
      if (cerrado) throw new Rechazo(409, textoSemanaCerrada(cerrado));
      const { rows } = await c.query(
        `INSERT INTO asistencia_incidencias
           (sucursal_id, empleado_codigo, tipo, desde, hasta, nota, creado_por, minutos,
            estado, autorizo, horario_base_min, calificado_por, calificado_en)
         VALUES ($1, $2, $3, $4::date, $5::date, NULLIF($6, ''), $7, $8,
                 $9, NULLIF($10, ''), $11, $12, CASE WHEN $12::text IS NULL THEN NULL ELSE now() END)
         RETURNING *`,
        [sucursalId, String(empleadoCodigo).trim(), tipo, desde, hasta, nota, quien, minutos,
         estado, autorizo, horarioBase, directa ? quien : null]);
      await registrarPaso(c, {
        fila: rows[0], accion: 'creada', antes: null, quien,
        detalle: directa ? 'Capturada y calificada por servicios al personal.' : 'Entregada para calificar.',
      });
      return rows[0];
    });
    res.json(mapIncidencia(fila));
  } catch (e) {
    responderError(res, e, 'No se pudo guardar la incidencia.', 'crear');
  }
});

/**
 * Los pasos sobre una incidencia ya guardada. Cada uno dice de qué estados
 * puede salir, si exige motivo y quién lo puede dar.
 */
type Accion = 'calificar' | 'rechazar' | 'anular' | 'auditar';

const PASOS: Record<Accion, { desde: EstadoIncidencia[]; hacia: EstadoIncidencia; motivo: boolean; registro: string }> = {
  calificar: { desde: ['capturada'],               hacia: 'calificada', motivo: false, registro: 'calificada' },
  rechazar:  { desde: ['capturada'],               hacia: 'rechazada',  motivo: true,  registro: 'rechazada' },
  anular:    { desde: ['capturada', 'calificada'], hacia: 'anulada',    motivo: true,  registro: 'anulada' },
  auditar:   { desde: ['cerrada'],                 hacia: 'auditada',   motivo: false, registro: 'auditada' },
};

const NOMBRE_ESTADO: Record<EstadoIncidencia, string> = {
  capturada: 'por calificar', calificada: 'calificada', rechazada: 'rechazada',
  cerrada: 'cerrada en prenómina', auditada: 'auditada', anulada: 'anulada',
};

async function darPaso(req: AuthedRequest, id: string, accion: Accion, motivo: string) {
  const paso = PASOS[accion];
  const quien = quienReq(req);
  if (paso.motivo && !motivo) {
    throw new Rechazo(400, accion === 'rechazar' ? 'Escribe por qué se rechaza.' : 'Escribe por qué se quita.');
  }
  return enTransaccion(async (c) => {
    const { rows: [actual] } = await c.query('SELECT * FROM asistencia_incidencias WHERE id = $1 FOR UPDATE', [id]);
    if (!actual) throw new Rechazo(404, 'Esa incidencia ya no existe.');
    const estado = (actual.estado || 'calificada') as EstadoIncidencia;
    if (!paso.desde.includes(estado)) {
      throw new Rechazo(409, `No se puede ${accion}: la incidencia está ${NOMBRE_ESTADO[estado]}.`);
    }

    // Quién puede dar cada paso. Hoy "servicios al personal" y "contabilidad"
    // son administradores; cuando existan sus roles, se cambia aquí.
    const esAdmin = esAdminReq(req);
    const esSuya = actual.creado_por === quien;
    if (accion === 'anular' && !esAdmin && !(esSuya && estado === 'capturada')) {
      throw new Rechazo(403, 'Solo servicios al personal puede quitar una incidencia ya calificada.');
    }
    if ((accion === 'calificar' || accion === 'rechazar') && !esAdmin) {
      throw new Rechazo(403, 'Calificar o rechazar es de servicios al personal.');
    }
    if (accion === 'auditar') {
      if (!esAdmin) throw new Rechazo(403, 'Auditar es de contabilidad.');
      // Quien calificó o capturó no se audita a sí mismo.
      if (actual.calificado_por === quien || esSuya) {
        throw new Rechazo(409, 'No puedes auditar una incidencia que tú capturaste o calificaste: la tiene que ver otra persona.');
      }
    }

    if (accion !== 'auditar') {
      const cerrado = await cierreQueToca(actual.sucursal_id, aFecha(actual.desde), aFecha(actual.hasta), c);
      if (cerrado) throw new Rechazo(409, textoSemanaCerrada(cerrado));
    }

    // $1 id, $2 estado nuevo, $3 quién, $4 motivo (solo en los pasos que lo usan:
    // un parámetro que la consulta no menciona hace fallar a Postgres).
    const sets: Record<Accion, string> = {
      calificar: 'calificado_por = $3, calificado_en = now()',
      rechazar:  'calificado_por = $3, calificado_en = now(), motivo_rechazo = $4',
      anular:    'anulado_por = $3, anulado_en = now(), motivo_anulacion = $4',
      auditar:   'auditado_por = $3, auditado_en = now(), nota_auditoria = NULLIF($4, \'\')',
    };
    const params = accion === 'calificar' ? [id, paso.hacia, quien] : [id, paso.hacia, quien, motivo];
    const { rows: [fila] } = await c.query(
      `UPDATE asistencia_incidencias SET estado = $2, ${sets[accion]} WHERE id = $1 RETURNING *`, params);
    await registrarPaso(c, { fila, accion: paso.registro, antes: estado, quien, detalle: motivo || undefined });
    return fila;
  });
}

/** POST /checador/incidencias/:id/{calificar|rechazar|anular|auditar}  body: { motivo? } */
incidenciasRouter.post('/:id/:accion', async (req: AuthedRequest, res: Response) => {
  const accion = req.params.accion as Accion;
  if (!(accion in PASOS)) return res.status(404).json({ error: 'Paso desconocido.' });
  try {
    const fila = await darPaso(req, req.params.id, accion, String(req.body?.motivo ?? '').trim());
    res.json(mapIncidencia(fila));
  } catch (e) {
    responderError(res, e, 'No se pudo guardar el cambio.', accion);
  }
});

/**
 * DELETE /checador/incidencias/:id?motivo=…
 * Ya no borra: ANULA. La fila se queda (y su bitácora) para que la auditoría
 * vea qué se quitó, quién y por qué.
 */
incidenciasRouter.delete('/:id', async (req: AuthedRequest, res: Response) => {
  try {
    const fila = await darPaso(req, req.params.id, 'anular', String((req.query as any).motivo ?? '').trim());
    res.json(mapIncidencia(fila));
  } catch (e) {
    responderError(res, e, 'No se pudo quitar la incidencia.', 'anular');
  }
});
