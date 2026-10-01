import { Router, Response } from 'express';
import { pool } from './db';
import { requireAuth, AuthedRequest, esAdminReq, quienReq } from './auth';
import { asistenciaPersonas } from './agente-horarios/asistencia-personas';
import { inicioSemana } from './agente-horarios/horario-deducido';
import { enTransaccion, registrarPaso, cierreQueToca, textoSemanaCerrada } from './incidencias';

/**
 * CIERRE DE SEMANA PARA PRENÓMINA (01/10/2026).
 *
 * El número de asistencia se RECALCULA cada vez que se pide: el horario sale del
 * historial de checadas, llegan marcas tarde de los relojes y las incidencias se
 * pueden capturar días después. Bien para trabajar, mal para pagar: la semana
 * que se mandó a nómina no se podía volver a ver tal cual, y contabilidad no
 * tenía contra qué auditar.
 *
 * Cerrar una semana:
 *   1. exige que no quede nada POR CALIFICAR en ella (lo pendiente no se paga a
 *      ciegas: o se califica o se rechaza antes);
 *   2. guarda la FOTO: el cálculo completo de esa semana, tal como salió;
 *   3. pasa sus incidencias calificadas a CERRADA, y
 *   4. bloquea la semana: capturar, calificar o quitar algo en ella responde 409.
 *
 * Reabrir exige motivo y NO borra la foto: deja quién, cuándo y por qué, y las
 * incidencias vuelven a calificada (la bitácora guarda que estuvieron cerradas).
 *
 * La semana es la de nómina: de jueves a miércoles (DIA_INICIO_SEMANA).
 * Tabla: db/incidencias-flujo.sql.
 */
export const cierresRouter = Router();
cierresRouter.use(requireAuth);

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const aFecha = (v: any): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').slice(0, 10);

/** Hoy en México, 'yyyy-MM-dd' (el servidor puede estar en UTC). */
function hoyMx(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
}

function masDias(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

const mapCierre = (r: any, conFoto = false) => ({
  id: r.id,
  sucursalId: r.sucursal_id,
  desde: aFecha(r.desde),
  hasta: aFecha(r.hasta),
  cerradoPor: r.cerrado_por || '',
  cerradoEn: r.cerrado_en,
  resumen: r.resumen || null,
  reabiertoPor: r.reabierto_por || '',
  reabiertoEn: r.reabierto_en || null,
  motivoReapertura: r.motivo_reapertura || '',
  vigente: !r.reabierto_en,
  ...(conFoto ? { foto: r.foto } : {}),
});

function fallo(res: Response, e: any, msg: string) {
  if (e?.status) return res.status(e.status).json({ error: e.message });
  if (e?.code === '42P01') {
    return res.status(503).json({ error: 'Falta aplicar la migración del cierre de semana (npm run migrate).' });
  }
  console.error('[cierres]', e);
  return res.status(500).json({ error: msg });
}

const rechazo = (status: number, message: string) => Object.assign(new Error(message), { status });

/** GET /checador/cierres?sucursalId — los cierres de la plaza, el más nuevo primero (sin la foto). */
cierresRouter.get('/', async (req: AuthedRequest, res: Response) => {
  try {
    const { sucursalId } = req.query as any;
    if (!sucursalId) return res.status(400).json({ error: 'Falta sucursalId.' });
    const { rows } = await pool.query(
      `SELECT id, sucursal_id, desde, hasta, cerrado_por, cerrado_en, resumen,
              reabierto_por, reabierto_en, motivo_reapertura
         FROM asistencia_cierres WHERE sucursal_id = $1 ORDER BY desde DESC, cerrado_en DESC LIMIT 60`,
      [sucursalId]);
    res.json(rows.map((r) => mapCierre(r)));
  } catch (e) { fallo(res, e, 'No se pudieron leer los cierres.'); }
});

/** GET /checador/cierres/estado?sucursalId&desde&hasta — las semanas CERRADAS que toca el periodo. */
cierresRouter.get('/estado', async (req: AuthedRequest, res: Response) => {
  try {
    const { sucursalId, desde, hasta } = req.query as any;
    if (!sucursalId || !RE_FECHA.test(String(desde)) || !RE_FECHA.test(String(hasta))) {
      return res.status(400).json({ error: 'Faltan sucursalId, desde y hasta (yyyy-MM-dd).' });
    }
    const { rows } = await pool.query(
      `SELECT id, sucursal_id, desde, hasta, cerrado_por, cerrado_en, resumen,
              reabierto_por, reabierto_en, motivo_reapertura
         FROM asistencia_cierres
        WHERE sucursal_id = $1 AND reabierto_en IS NULL AND desde <= $3::date AND hasta >= $2::date
        ORDER BY desde`,
      [sucursalId, desde, hasta]);
    res.json(rows.map((r) => mapCierre(r)));
  } catch (e: any) {
    if (e?.code === '42P01') return res.json([]);   // sin migrar: nada cerrado
    fallo(res, e, 'No se pudo leer el estado de la semana.');
  }
});

/** GET /checador/cierres/:id — un cierre CON su foto (para descargarla o auditarla). */
cierresRouter.get('/:id', async (req: AuthedRequest, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT * FROM asistencia_cierres WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Ese cierre no existe.' });
    res.json(mapCierre(rows[0], true));
  } catch (e) { fallo(res, e, 'No se pudo leer el cierre.'); }
});

/**
 * POST /checador/cierres  body: { sucursalId, desde }
 * `desde` es el jueves que abre la semana de nómina; la semana va de ahí al miércoles.
 */
cierresRouter.post('/', async (req: AuthedRequest, res: Response) => {
  try {
    if (!esAdminReq(req)) return res.status(403).json({ error: 'Cerrar la semana es de servicios al personal.' });
    const { sucursalId, desde } = req.body || {};
    if (!sucursalId || !RE_FECHA.test(String(desde))) {
      return res.status(400).json({ error: 'Faltan sucursalId y desde (yyyy-MM-dd).' });
    }
    if (inicioSemana(desde) !== desde) {
      return res.status(400).json({ error: 'La semana de nómina empieza en jueves: elige el jueves que la abre.' });
    }
    const hasta = masDias(desde, 6);
    // Se cierra lo que ya pasó: una semana en curso todavía va a cambiar.
    if (hasta >= hoyMx()) {
      return res.status(409).json({ error: `La semana termina el miércoles ${hasta}: se puede cerrar a partir del día siguiente.` });
    }

    const ya = await cierreQueToca(sucursalId, desde, hasta);
    if (ya) return res.status(409).json({ error: textoSemanaCerrada(ya) });

    const { rows: [pend] } = await pool.query(
      `SELECT count(*)::int AS n FROM asistencia_incidencias
        WHERE sucursal_id = $1 AND estado = 'capturada' AND desde <= $3::date AND hasta >= $2::date`,
      [sucursalId, desde, hasta]);
    if (pend.n > 0) {
      return res.status(409).json({
        error: `Hay ${pend.n} incidencia${pend.n === 1 ? '' : 's'} por calificar en esta semana. Califícalas o recházalas antes de cerrar.`,
      });
    }

    // La foto se toma FUERA de la transacción (es el cálculo pesado); si entre
    // la foto y el cierre alguien captura algo, la transacción lo detecta abajo.
    const foto = await asistenciaPersonas({ sucursalId, desde, hasta });
    const quien = quienReq(req);

    const cierre = await enTransaccion(async (c) => {
      // Ya dentro de la transacción: nadie entregó algo entre la foto y aquí.
      const { rows: [p2] } = await c.query(
        `SELECT count(*)::int AS n FROM asistencia_incidencias
          WHERE sucursal_id = $1 AND estado = 'capturada' AND desde <= $3::date AND hasta >= $2::date`,
        [sucursalId, desde, hasta]);
      if (p2.n > 0) throw rechazo(409, 'Entró una incidencia por calificar mientras se cerraba. Revísala y vuelve a cerrar.');

      const { rows: incs } = await c.query(
        `UPDATE asistencia_incidencias SET estado = 'cerrada'
          WHERE sucursal_id = $1 AND estado = 'calificada' AND desde <= $3::date AND hasta >= $2::date
          RETURNING *`,
        [sucursalId, desde, hasta]);
      for (const fila of incs) {
        await registrarPaso(c, {
          fila, accion: 'cerrada', antes: 'calificada', quien,
          detalle: `Cierre de la semana del ${desde} al ${hasta}.`,
        });
      }
      const r = foto.resumen as any;
      const resumen = {
        personas: r?.personas ?? foto.personas.length,
        usables: r?.usables ?? null,
        faltas: r?.faltas ?? null,
        retardoRealMin: r?.retardoRealMin ?? null,
        horasTrabajadas: r?.horasTrabajadas ?? null,
        incidencias: incs.length,
      };
      try {
        const { rows: [fila] } = await c.query(
          `INSERT INTO asistencia_cierres (sucursal_id, desde, hasta, cerrado_por, resumen, foto)
           VALUES ($1, $2::date, $3::date, $4, $5, $6) RETURNING *`,
          [sucursalId, desde, hasta, quien, JSON.stringify(resumen), JSON.stringify(foto)]);
        return fila;
      } catch (e: any) {
        if (e?.code === '23505') throw rechazo(409, 'Alguien más acaba de cerrar esta semana.');
        throw e;
      }
    });
    res.json(mapCierre(cierre));
  } catch (e) { fallo(res, e, 'No se pudo cerrar la semana.'); }
});

/** POST /checador/cierres/:id/reabrir  body: { motivo } */
cierresRouter.post('/:id/reabrir', async (req: AuthedRequest, res: Response) => {
  try {
    if (!esAdminReq(req)) return res.status(403).json({ error: 'Reabrir la semana es de servicios al personal.' });
    const motivo = String(req.body?.motivo ?? '').trim();
    if (!motivo) return res.status(400).json({ error: 'Escribe por qué se reabre la semana: queda en el registro.' });
    const quien = quienReq(req);

    const cierre = await enTransaccion(async (c) => {
      const { rows: [act] } = await c.query(
        `UPDATE asistencia_cierres SET reabierto_por = $2, reabierto_en = now(), motivo_reapertura = $3
          WHERE id = $1 AND reabierto_en IS NULL RETURNING *`,
        [req.params.id, quien, motivo]);
      if (!act) throw rechazo(409, 'Esa semana ya no está cerrada.');
      const desde = aFecha(act.desde), hasta = aFecha(act.hasta);
      // Las que tocan OTRA semana que siga cerrada se quedan cerradas.
      const { rows: incs } = await c.query(
        `SELECT * FROM asistencia_incidencias i
          WHERE i.sucursal_id = $1 AND i.estado IN ('cerrada', 'auditada')
            AND i.desde <= $3::date AND i.hasta >= $2::date
            AND NOT EXISTS (SELECT 1 FROM asistencia_cierres k
                             WHERE k.sucursal_id = i.sucursal_id AND k.reabierto_en IS NULL
                               AND k.desde <= i.hasta AND k.hasta >= i.desde)
          FOR UPDATE`,
        [act.sucursal_id, desde, hasta]);
      for (const antes of incs) {
        const { rows: [fila] } = await c.query(
          `UPDATE asistencia_incidencias SET estado = 'calificada' WHERE id = $1 RETURNING *`, [antes.id]);
        await registrarPaso(c, {
          fila, accion: 'reabierta', antes: antes.estado, quien,
          detalle: `Se reabrió la semana del ${desde} al ${hasta}: ${motivo}`,
        });
      }
      return act;
    });
    res.json(mapCierre(cierre));
  } catch (e) { fallo(res, e, 'No se pudo reabrir la semana.'); }
});
