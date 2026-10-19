import { Router, Response } from 'express';
import { pool } from './db';
import { requireAuth, AuthedRequest } from './auth';

/**
 * SALUD DEL BOT DE RECLUTAMIENTO (19/10/2026) — montado en /bot.
 *
 * Dos problemas pasaron días sin que nadie se enterara: el bloqueo de WhatsApp
 * por pago (04–08/10, 176 personas sin respuesta) y los ciclos en que el bot
 * repetía la misma pregunta (41 "No" al familiar en un mes). La auditoría que
 * los encontró se hizo a mano; aquí se hace sola, cada vez que RH abre la
 * sección "Salud del bot", y el menú muestra cuántas personas esperan ayuda.
 *
 * Lee las tablas que escribe el bot (misma base): `mensajes`, `candidatos`
 * (portal_data.atorado lo pone BOT-RH/src/freno-ciclos.js) y `bot_estado`.
 */
export const botSaludRouter = Router();
botSaludRouter.use(requireAuth);

function fallo(res: Response, e: any, msg: string) {
  console.error('[bot-salud]', msg, e);
  return res.status(500).json({ error: msg });
}

/** El tablero completo (se exporta para poder probarlo sin servidor). */
export async function saludBot() {
    const envios = await pool.query(`SELECT valor, actualizado_en FROM bot_estado WHERE clave = 'envios_whatsapp'`)
      .then((r) => r.rows[0]?.valor ?? null).catch(() => null);

    // Mensajes del bot repetidos SEGUIDOS a la misma persona (el síntoma del ciclo).
    const { rows: [rep] } = await pool.query(`
      WITH o AS (
        SELECT telefono, creado_en, texto,
               lag(texto) OVER (PARTITION BY telefono ORDER BY creado_en) AS prev
          FROM mensajes WHERE direccion = 'out' AND creado_en > now() - interval '7 days')
      SELECT count(*) FILTER (WHERE creado_en > now() - interval '24 hours')::int AS dia,
             count(*)::int AS semana,
             count(DISTINCT telefono) FILTER (WHERE creado_en > now() - interval '24 hours')::int AS personas_dia
        FROM o WHERE texto = prev`);
    const { rows: repetidas } = await pool.query(`
      WITH o AS (
        SELECT telefono, texto, lag(texto) OVER (PARTITION BY telefono ORDER BY creado_en) AS prev
          FROM mensajes WHERE direccion = 'out' AND creado_en > now() - interval '7 days')
      SELECT left(regexp_replace(texto, '\\s+', ' ', 'g'), 120) AS texto, count(*)::int AS veces,
             count(DISTINCT telefono)::int AS personas
        FROM o WHERE texto = prev GROUP BY 1 ORDER BY 2 DESC LIMIT 8`);

    // Quien escribió y el bot NO le contestó (más de 10 min, últimas 24 h).
    const { rows: [sinResp] } = await pool.query(`
      WITH ult AS (
        SELECT DISTINCT ON (telefono) telefono, direccion, creado_en
          FROM mensajes WHERE creado_en > now() - interval '24 hours'
         ORDER BY telefono, creado_en DESC)
      SELECT count(*)::int AS n FROM ult
       WHERE direccion = 'in' AND creado_en < now() - interval '10 minutes'`);

    const { rows: [act] } = await pool.query(`
      SELECT count(*) FILTER (WHERE direccion = 'in')::int AS entran,
             count(*) FILTER (WHERE direccion = 'out')::int AS salen,
             count(DISTINCT telefono)::int AS personas
        FROM mensajes WHERE creado_en > now() - interval '24 hours'`);

    const { rows: atorados } = await pool.query(`
      SELECT c.id, c.telefono, coalesce(nullif(c.nombre_completo, ''), '(sin nombre)') AS nombre, c.estado,
             c.puesto_interes AS puesto, c.portal_data -> 'atorado' AS atorado
        FROM candidatos c
       WHERE c.portal_data ? 'atorado' AND c.deleted_at IS NULL
         AND coalesce((c.portal_data -> 'atorado' ->> 'atendido')::boolean, false) = false
       ORDER BY c.portal_data -> 'atorado' ->> 'en' DESC
       LIMIT 100`);

    const ciclosDia = rep?.dia ?? 0;
    return {
      envios,
      actividad: act,
      ciclos: { dia: ciclosDia, semana: rep?.semana ?? 0, personasDia: rep?.personas_dia ?? 0, repetidas },
      sinRespuesta: sinResp?.n ?? 0,
      atorados: atorados.map((a: any) => ({
        id: a.id, telefono: a.telefono, nombre: a.nombre, estado: a.estado, puesto: a.puesto,
        en: a.atorado?.en ?? null, motivo: a.atorado?.motivo ?? '', pregunta: a.atorado?.pregunta ?? '',
        ultimaRespuesta: a.atorado?.ultimaRespuesta ?? '',
      })),
      // Lo que debe encender el aviso del menú.
      alerta: !!(envios && envios.bloqueado) || atorados.length > 0 || ciclosDia >= 10 || (sinResp?.n ?? 0) > 0,
    };
}

/** GET /bot/salud — el tablero. */
botSaludRouter.get('/salud', async (_req: AuthedRequest, res: Response) => {
  try { res.json(await saludBot()); } catch (e) { fallo(res, e, 'No se pudo revisar la salud del bot.'); }
});

/** POST /bot/atorados/:telefono/atendido — RH ya le escribió. */
botSaludRouter.post('/atorados/:telefono/atendido', async (req: AuthedRequest, res: Response) => {
  try {
    const quien = req.usuario?.email || 'RH';
    const { rowCount } = await pool.query(
      `UPDATE candidatos
          SET portal_data = jsonb_set(portal_data, '{atorado}',
                (portal_data -> 'atorado') || jsonb_build_object('atendido', true, 'atendidoPor', $2::text, 'atendidoEn', now()))
        WHERE telefono = $1 AND portal_data ? 'atorado'`,
      [String(req.params.telefono), quien]);
    if (!rowCount) return res.status(404).json({ error: 'No encontré a esa persona en la bandeja.' });
    res.json({ ok: true });
  } catch (e) { fallo(res, e, 'No se pudo marcar como atendido.'); }
});
