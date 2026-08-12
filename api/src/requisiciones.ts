import { Router, Request, Response } from 'express';
import { pool } from './db';
import { requireAuth, AuthedRequest } from './auth';

/**
 * =====================================================================
 * REQUISICIONES DE PERSONAL
 * =====================================================================
 *
 * La petición formal de una sucursal: "necesito a alguien para este puesto".
 * Antes viajaba por WhatsApp, así que no había forma de contestar cuántas
 * están esperando, desde cuándo, ni cuáles ya se cubrieron.
 *
 * ── DOS REGLAS QUE VIENEN DEL RESTO DEL SISTEMA ─────────────────────
 *
 * 1. LOS DÍAS SE CUENTAN EN HORA DE MÉXICO. El Postgres corre en UTC y parte
 *    el día a las 18:00 hora local; una requisición capturada el lunes a las
 *    7 de la noche aparecería como del martes y "para hoy" quedaría mal desde
 *    el primer minuto. Ver el mismo criterio en kpi.ts.
 *
 * 2. LA URGENCIA SE DERIVA DE LA FECHA, NO SE GUARDA COMO BANDERA. Un chip
 *    rojo permanente se vuelve paisaje en una semana; "vencida hace 3 días"
 *    no. Por eso el API devuelve `diasParaFecha` calculado y la pantalla solo
 *    lo pinta.
 */
export const requisicionesRouter = Router();

const TZ = 'America/Mexico_City';
const hoy = () => `((now() AT TIME ZONE '${TZ}')::date)`;

const ESTADOS = ['pendiente', 'autorizada', 'rechazada', 'cubierta', 'cancelada'] as const;
const MOTIVOS = ['nuevo', 'reemplazo', 'temporal', 'otro'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fallo(res: Response, e: any, msg: string) {
  console.error('[requisiciones]', msg, e);
  return res.status(500).json({ error: msg });
}

/** Quién está haciendo la operación, para dejar rastro de quién decidió qué. */
function quien(req: AuthedRequest): string {
  const u = req.usuario as any;
  return u?.nombre || u?.email || 'RH';
}

const SELECT_BASE = `
  SELECT r.id, r.folio, r.puesto, r.puesto_id AS "puestoId", r.sucursal_id AS "sucursalId",
         r.area, r.vacantes, r.motivo, r.reemplaza_a AS "reemplazaA",
         to_char(r.fecha_requerida, 'YYYY-MM-DD') AS "fechaRequerida",
         r.justificacion, r.archivo_url AS "archivoUrl", r.archivo_nombre AS "archivoNombre",
         r.solicita, r.estado, r.resuelta_por AS "resueltaPor", r.resuelta_en AS "resueltaEn",
         r.nota_resolucion AS "notaResolucion",
         r.cubierta_por AS "cubiertaPor", r.cubierta_en AS "cubiertaEn",
         c.nombre_completo AS "cubiertaNombre",
         r.creado_por AS "creadoPor", r.creado_en AS "creadoEn",
         -- Días que lleva esperando y días que faltan para la fecha pedida.
         -- Negativo en "diasParaFecha" = ya se pasó.
         (${hoy()} - (r.creado_en AT TIME ZONE '${TZ}')::date)::int AS "diasEsperando",
         CASE WHEN r.fecha_requerida IS NULL THEN NULL
              ELSE (r.fecha_requerida - ${hoy()})::int END AS "diasParaFecha"
    FROM requisiciones r
    LEFT JOIN candidatos c ON c.id = r.cubierta_por`;

/**
 * GET /requisiciones?estado=pendiente&sucursalId=...
 *
 * Orden: primero lo que urge. Pendientes arriba, y dentro de ellas la fecha
 * requerida más próxima (las vencidas primero). Una bandeja ordenada por fecha
 * de captura entierra lo urgente debajo de lo que se capturó después.
 */
/**
 * ══ LA LIGA QUE SE LE MANDA A LOS ENCARGADOS ══ (12/08/2026)
 *
 * POST /requisiciones/publica — SIN SESIÓN, a propósito.
 *
 * Los encargados de sucursal no tienen usuario del portal ni lo van a tener:
 * piden personal por WhatsApp, y esa petición se queda en un chat donde nadie
 * puede contestar cuántas hay abiertas ni desde cuándo. Con una liga que
 * pueden abrir desde el celular, la petición entra al sistema desde el minuto
 * uno y RH la ve junto con las demás.
 *
 * Va declarada ANTES del `requisicionesRouter.use(requireAuth)` de más abajo:
 * en Express el orden manda, y todo lo que se registra después de ese `use`
 * queda protegido. Es la única ruta pública del módulo.
 *
 * ── Qué se cuida por ser pública ────────────────────────────────────
 *
 * · Entra siempre como `pendiente`: nadie de fuera puede autorizar nada, y RH
 *   sigue siendo quien decide. Lo que llega es una PETICIÓN, no una vacante.
 * · Solo se aceptan los campos del formulario. El estado, el folio, quién la
 *   resolvió y a quién se contrató no se leen del cuerpo aunque los manden.
 * · Los textos se recortan: un campo libre sin tope es una invitación a que
 *   alguien pegue un libro dentro de la base.
 * · Se guarda de dónde vino (`creado_por = 'liga pública'`) para que RH sepa
 *   que la capturó la sucursal y no alguien de Capital Humano.
 */
requisicionesRouter.post('/publica', async (req: Request, res: Response) => {
  const b = req.body || {};
  const t = (v: any, max: number) => String(v ?? '').trim().slice(0, max);

  const puesto = t(b.puesto, 120);
  const solicita = t(b.solicita, 80);
  const sucursalId = t(b.sucursalId, 60);

  if (!puesto) return res.status(400).json({ error: 'Falta el puesto que se necesita.' });
  if (!solicita) return res.status(400).json({ error: 'Falta tu nombre para saber quién lo pide.' });
  if (!sucursalId) return res.status(400).json({ error: 'Falta la sucursal.' });

  const vacantes = Math.min(Math.max(parseInt(String(b.vacantes || '1'), 10) || 1, 1), 99);
  const motivo = MOTIVOS.includes(String(b.motivo) as any) ? String(b.motivo) : 'nuevo';
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(b.fechaRequerida || '')) ? String(b.fechaRequerida) : null;

  try {
    const { rows } = await pool.query(
      `INSERT INTO requisiciones
         (puesto, sucursal_id, area, vacantes, motivo, reemplaza_a, fecha_requerida,
          justificacion, solicita, estado, creado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pendiente','liga pública')
       RETURNING id, folio`,
      [puesto, sucursalId, t(b.area, 80) || null, vacantes, motivo,
       t(b.reemplazaA, 120) || null, fecha, t(b.justificacion, 1000) || null, solicita]
    );
    // Se devuelve el folio: es el acuse que el encargado puede citar por
    // WhatsApp cuando pregunte "¿ya vieron mi solicitud?".
    return res.json({ ok: true, folio: rows[0].folio });
  } catch (e) {
    console.error('[requisiciones] no se pudo guardar la petición pública:', e);
    return res.status(500).json({ error: 'No se pudo enviar la solicitud. Intenta de nuevo.' });
  }
});

// ── De aquí en adelante, todo exige sesión de RH ──────────────────────
requisicionesRouter.use(requireAuth);

requisicionesRouter.get('/', async (req: Request, res: Response) => {
  const estado = String(req.query.estado || '').trim();
  const sucursalId = String(req.query.sucursalId || '').trim();
  const cond: string[] = [];
  const params: any[] = [];
  if (ESTADOS.includes(estado as any)) { params.push(estado); cond.push(`r.estado = $${params.length}`); }
  if (estado === 'abiertas') cond.push(`r.estado IN ('pendiente','autorizada')`);
  if (sucursalId) { params.push(sucursalId); cond.push(`r.sucursal_id = $${params.length}`); }

  try {
    const { rows } = await pool.query(
      `${SELECT_BASE}
       ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
       ORDER BY (r.estado = 'pendiente') DESC,
                r.fecha_requerida ASC NULLS LAST,
                r.creado_en DESC`,
      params
    );
    return res.json(rows);
  } catch (e) { return fallo(res, e, 'No se pudieron listar las requisiciones.'); }
});

/**
 * GET /requisiciones/resumen — lo que el dashboard necesita en un solo golpe.
 * Distingue "para hoy" de "vencida": no es lo mismo llegar tarde que ir tarde.
 */
requisicionesRouter.get('/resumen', async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         count(*) FILTER (WHERE estado = 'pendiente')::int AS pendientes,
         count(*) FILTER (WHERE estado = 'autorizada')::int AS autorizadas,
         count(*) FILTER (WHERE estado IN ('pendiente','autorizada')
                            AND fecha_requerida = ${hoy()})::int AS "paraHoy",
         count(*) FILTER (WHERE estado IN ('pendiente','autorizada')
                            AND fecha_requerida < ${hoy()})::int AS vencidas,
         coalesce(sum(vacantes) FILTER (WHERE estado IN ('pendiente','autorizada')), 0)::int AS "personasPedidas",
         count(*) FILTER (WHERE estado = 'cubierta'
                            AND cubierta_en > now() - interval '30 days')::int AS "cubiertas30d"
       FROM requisiciones`
    );
    const { rows: urgentes } = await pool.query(
      `${SELECT_BASE}
        WHERE r.estado IN ('pendiente','autorizada')
          AND (r.fecha_requerida IS NULL OR r.fecha_requerida <= ${hoy()} + 2)
        ORDER BY r.fecha_requerida ASC NULLS LAST, r.creado_en ASC
        LIMIT 6`
    );
    return res.json({ ...rows[0], urgentes });
  } catch (e) { return fallo(res, e, 'No se pudo calcular el resumen de requisiciones.'); }
});

/** POST /requisiciones — captura una nueva. */
requisicionesRouter.post('/', async (req: AuthedRequest, res: Response) => {
  const b = req.body || {};
  const puesto = String(b.puesto || '').trim();
  if (!puesto) return res.status(400).json({ error: 'Falta el puesto que se solicita.' });

  const motivo = MOTIVOS.includes(String(b.motivo) as any) ? String(b.motivo) : 'nuevo';
  const vacantes = Math.min(Math.max(parseInt(String(b.vacantes || '1'), 10) || 1, 1), 99);
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(b.fechaRequerida || '')) ? String(b.fechaRequerida) : null;
  const puestoId = UUID_RE.test(String(b.puestoId || '')) ? String(b.puestoId) : null;

  try {
    const { rows } = await pool.query(
      `INSERT INTO requisiciones
         (puesto, puesto_id, sucursal_id, area, vacantes, motivo, reemplaza_a,
          fecha_requerida, justificacion, archivo_url, archivo_nombre, solicita, creado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10,$11,$12,$13)
       RETURNING id`,
      [puesto, puestoId, b.sucursalId || null, b.area || null, vacantes, motivo,
       b.reemplazaA || null, fecha, b.justificacion || null,
       b.archivoUrl || null, b.archivoNombre || null, b.solicita || null, quien(req)]
    );
    const { rows: creada } = await pool.query(`${SELECT_BASE} WHERE r.id = $1`, [rows[0].id]);
    return res.json(creada[0]);
  } catch (e) { return fallo(res, e, 'No se pudo guardar la requisición.'); }
});

/**
 * PATCH /requisiciones/:id — cambia el estado o corrige datos.
 * Body: { estado?, notaResolucion?, cubiertaPor?, ...campos editables }
 */
requisicionesRouter.patch('/:id', async (req: AuthedRequest, res: Response) => {
  const id = String(req.params.id || '');
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'No encontrada.' });
  const b = req.body || {};

  const sets: string[] = [];
  const params: any[] = [id];
  const set = (col: string, valor: any) => { params.push(valor); sets.push(`${col} = $${params.length}`); };

  if (b.estado !== undefined) {
    if (!ESTADOS.includes(String(b.estado) as any)) {
      return res.status(400).json({ error: `estado debe ser: ${ESTADOS.join(' | ')}` });
    }
    set('estado', b.estado);
    // Quién resolvió y cuándo se sella solo al salir de 'pendiente': es el dato
    // que permite medir cuánto tarda RH en contestar una requisición.
    if (b.estado !== 'pendiente') {
      set('resuelta_por', quien(req));
      sets.push('resuelta_en = now()');
    }
    if (b.estado === 'cubierta') sets.push('cubierta_en = coalesce(cubierta_en, now())');
  }
  if (b.cubiertaPor !== undefined) {
    set('cubierta_por', UUID_RE.test(String(b.cubiertaPor || '')) ? b.cubiertaPor : null);
  }
  if (b.notaResolucion !== undefined) set('nota_resolucion', b.notaResolucion || null);
  if (b.puesto !== undefined) set('puesto', String(b.puesto).trim());
  if (b.sucursalId !== undefined) set('sucursal_id', b.sucursalId || null);
  if (b.area !== undefined) set('area', b.area || null);
  if (b.vacantes !== undefined) set('vacantes', Math.min(Math.max(parseInt(String(b.vacantes), 10) || 1, 1), 99));
  if (b.motivo !== undefined) set('motivo', MOTIVOS.includes(String(b.motivo) as any) ? b.motivo : 'otro');
  if (b.reemplazaA !== undefined) set('reemplaza_a', b.reemplazaA || null);
  if (b.justificacion !== undefined) set('justificacion', b.justificacion || null);
  if (b.solicita !== undefined) set('solicita', b.solicita || null);
  if (b.archivoUrl !== undefined) { set('archivo_url', b.archivoUrl || null); set('archivo_nombre', b.archivoNombre || null); }
  if (b.fechaRequerida !== undefined) {
    set('fecha_requerida', /^\d{4}-\d{2}-\d{2}$/.test(String(b.fechaRequerida || '')) ? b.fechaRequerida : null);
  }

  if (!sets.length) return res.status(400).json({ error: 'No hay nada que actualizar.' });

  try {
    const r = await pool.query(`UPDATE requisiciones SET ${sets.join(', ')} WHERE id = $1`, params);
    if (!r.rowCount) return res.status(404).json({ error: 'No encontrada.' });
    const { rows } = await pool.query(`${SELECT_BASE} WHERE r.id = $1`, [id]);
    return res.json(rows[0]);
  } catch (e) { return fallo(res, e, 'No se pudo actualizar la requisición.'); }
});

/** DELETE /requisiciones/:id — solo para capturas equivocadas. */
requisicionesRouter.delete('/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id || '');
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'No encontrada.' });
  try {
    const r = await pool.query('DELETE FROM requisiciones WHERE id = $1', [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'No encontrada.' });
    return res.json({ ok: true });
  } catch (e) { return fallo(res, e, 'No se pudo borrar la requisición.'); }
});
