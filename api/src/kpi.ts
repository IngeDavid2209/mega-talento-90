import { Router, Request, Response } from 'express';
import { pool } from './db';
import { requireAuth, AuthedRequest } from './auth';

/**
 * =====================================================================
 * KPI "CONCENTRADO DE CANDIDATOS" — el tablero operativo de RH
 * =====================================================================
 *
 * Responde las preguntas que pidió Capital Humano:
 *   · ¿A cuánta gente se contactó hoy? ¿Cuántos respondieron?
 *   · ¿Cuántas entrevistas se hicieron?
 *   · ¿En cuántos días se cubre una vacante? ¿Cuántas se cubrieron en 7 y en 15?
 *   · ¿Cuántos de los entrevistados terminan contratados?
 *   · ¿Quién lleva demasiados días atorado en el proceso?
 *
 * ── DOS REGLAS DE HONESTIDAD ────────────────────────────────────────
 *
 * 1. UN CERO NO ES LO MISMO QUE "NO SE PUEDE MEDIR". En un tablero, un cero se
 *    lee como "no se trabajó". Por eso cada bloque que todavía no tiene datos
 *    devuelve `medible: false` con el motivo, y la respuesta trae `avisos[]` para
 *    que la pantalla lo diga con palabras en vez de pintar un 0 engañoso.
 *
 * 2. LOS CONTACTOS SE SUMAN DE DOS FUENTES, SIN MEZCLARLAS. El bot deja rastro
 *    solo (tabla `mensajes`); lo que RH hace por teléfono o WhatsApp personal se
 *    registra a mano (`candidatos_eventos`). Se reportan por separado y sumados:
 *    contar solo el bot subestima el trabajo de RH; contar solo lo manual tira a
 *    la basura cientos de contactos reales.
 *
 * OJO con el historial: `candidatos_transiciones` estuvo roto desde su creación
 * (24/07/2026) y se arregló el 29/07/2026 — antes de esa fecha NO existe registro
 * de cuándo entró cada candidato a su etapa, así que los tiempos por etapa y la
 * cobertura solo pueden medirse hacia adelante. No es un hueco de este código:
 * el dato no existe y no se puede inventar.
 */
export const kpiRouter = Router();
kpiRouter.use(requireAuth);

function fallo(res: Response, e: any, msg: string) {
  console.error('[kpi]', msg, e);
  return res.status(500).json({ error: msg });
}

// Etapas que significan que el candidato YA SALIÓ del proceso.
const FUERA_DEL_PROCESO = ['contratado', 'rechazado'];

// Tipos de evento válidos (lo que RH puede registrar).
const TIPOS = ['contacto', 'entrevista', 'contratacion', 'nota'] as const;
const CANALES = ['llamada', 'whatsapp', 'presencial', 'bot', 'portal'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// =====================================================================
// BITÁCORA: registrar y consultar lo que se le ha hecho a un candidato
// =====================================================================

/**
 * POST /kpi/eventos — registra un contacto, una entrevista o una nota.
 * Body: { candidatoId, tipo, canal?, nota?, ocurridoEn? }
 *
 * `ocurridoEn` es opcional a propósito: RH a veces registra al final del día lo
 * que hizo en la mañana, y fechar todo "ahora" ensuciaría el conteo por día.
 */
kpiRouter.post('/eventos', async (req: AuthedRequest, res: Response) => {
  const b = req.body || {};
  const id = String(b.candidatoId || '').trim();
  const tipo = String(b.tipo || '').trim();
  const canal = b.canal ? String(b.canal).trim() : null;

  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'candidatoId inválido.' });
  if (!TIPOS.includes(tipo as any)) return res.status(400).json({ error: `tipo debe ser: ${TIPOS.join(' | ')}` });
  if (canal && !CANALES.includes(canal as any)) return res.status(400).json({ error: `canal debe ser: ${CANALES.join(' | ')}` });

  try {
    const existe = await pool.query('SELECT 1 FROM candidatos WHERE id=$1', [id]);
    if (!existe.rows.length) return res.status(404).json({ error: 'Candidato no encontrado.' });

    const { rows } = await pool.query(
      `INSERT INTO candidatos_eventos (candidato_id, tipo, canal, nota, por, ocurrido_en)
       VALUES ($1::uuid, $2, $3, $4, $5, coalesce($6::timestamptz, now()))
       RETURNING id, tipo, canal, nota, por, ocurrido_en`,
      [id, tipo, canal, b.nota ? String(b.nota).slice(0, 1000) : null,
       (req.usuario as any)?.nombre || (req.usuario as any)?.usuario || 'RH',
       b.ocurridoEn || null]
    );
    // Registrar actividad de RH: este candidato dejó de estar "sin seguimiento".
    await pool.query('UPDATE candidatos SET ultima_actividad = now() WHERE id=$1::uuid', [id]);
    return res.json(rows[0]);
  } catch (e) { return fallo(res, e, 'No se pudo registrar el evento.'); }
});

/** GET /kpi/eventos/:candidatoId — la bitácora de un candidato (lo más nuevo primero). */
kpiRouter.get('/eventos/:candidatoId', async (req: Request, res: Response) => {
  const id = String(req.params.candidatoId || '').trim();
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'No encontrado.' });
  try {
    const { rows } = await pool.query(
      `SELECT id, tipo, canal, nota, por, ocurrido_en AS "ocurridoEn"
         FROM candidatos_eventos WHERE candidato_id = $1::uuid
        ORDER BY ocurrido_en DESC LIMIT 200`,
      [id]
    );
    return res.json(rows);
  } catch (e) { return fallo(res, e, 'No se pudo leer la bitácora.'); }
});

/** DELETE /kpi/eventos/:id — borrar un registro mal capturado. */
kpiRouter.delete('/eventos/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id || '').trim();
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'No encontrado.' });
  try {
    const r = await pool.query('DELETE FROM candidatos_eventos WHERE id=$1::uuid', [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'No encontrado.' });
    return res.json({ ok: true });
  } catch (e) { return fallo(res, e, 'No se pudo borrar el evento.'); }
});

// =====================================================================
// EL TABLERO
// =====================================================================

/**
 * GET /kpi/concentrado?dias=7  (o ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD)
 *
 * Todo en una sola respuesta para que la pantalla no haga seis llamadas.
 */
kpiRouter.get('/concentrado', async (req: Request, res: Response) => {
  const dias = Math.min(Math.max(parseInt(String(req.query.dias || '7'), 10) || 7, 1), 180);
  const hasta = String(req.query.hasta || '').match(/^\d{4}-\d{2}-\d{2}$/)
    ? String(req.query.hasta) : null;
  const desde = String(req.query.desde || '').match(/^\d{4}-\d{2}-\d{2}$/)
    ? String(req.query.desde) : null;

  try {
    const rango = await pool.query(
      `SELECT coalesce($1::date, current_date - ($3::int - 1)) AS desde,
              coalesce($2::date, current_date) AS hasta`,
      [desde, hasta, dias]
    );
    const D = rango.rows[0].desde, H = rango.rows[0].hasta;

    // ── 1. Serie por día ─────────────────────────────────────────────
    // Contactados del BOT = personas distintas a las que les salió un mensaje.
    // Contactados por RH  = personas distintas con evento 'contacto' manual.
    // No se suman a ciegas: una persona puede aparecer en las dos (el bot le
    // escribió Y Leslie le llamó). `contactados` cuenta personas únicas de ambas.
    const serie = await pool.query(
      `WITH dias AS (SELECT generate_series($1::date, $2::date, '1 day')::date AS dia),
       post AS (
         SELECT creado_en::date AS dia, count(*) AS n
           FROM candidatos WHERE deleted_at IS NULL
            AND creado_en::date BETWEEN $1 AND $2 GROUP BY 1
       ),
       bot_out AS (
         SELECT creado_en::date AS dia, telefono
           FROM mensajes WHERE direccion='out' AND creado_en::date BETWEEN $1 AND $2
          GROUP BY 1,2
       ),
       bot_in AS (
         SELECT creado_en::date AS dia, count(DISTINCT telefono) AS n
           FROM mensajes WHERE direccion='in' AND creado_en::date BETWEEN $1 AND $2
          GROUP BY 1
       ),
       rh AS (
         SELECT ocurrido_en::date AS dia, candidato_id
           FROM candidatos_eventos
          WHERE tipo='contacto' AND coalesce(canal,'') <> 'bot'
            AND ocurrido_en::date BETWEEN $1 AND $2
          GROUP BY 1,2
       ),
       rh_tel AS (
         SELECT r.dia, regexp_replace(coalesce(c.telefono,''), '[^0-9]', '', 'g') AS tel
           FROM rh r JOIN candidatos c ON c.id = r.candidato_id
       ),
       unicos AS (
         SELECT dia, right(regexp_replace(telefono,'[^0-9]','','g'), 10) AS tel FROM bot_out
         UNION
         SELECT dia, right(tel, 10) FROM rh_tel
       ),
       ent AS (
         SELECT ocurrido_en::date AS dia, count(*) AS n
           FROM candidatos_eventos WHERE tipo='entrevista'
            AND ocurrido_en::date BETWEEN $1 AND $2 GROUP BY 1
       ),
       contrat AS (
         SELECT cambiado_en::date AS dia, count(DISTINCT candidato_id) AS n
           FROM candidatos_transiciones WHERE etapa_destino='contratado'
            AND cambiado_en::date BETWEEN $1 AND $2 GROUP BY 1
       )
       SELECT d.dia,
              coalesce(p.n, 0)::int  AS postulaciones,
              (SELECT count(*) FROM bot_out b WHERE b.dia = d.dia)::int AS "contactadosBot",
              (SELECT count(*) FROM rh r WHERE r.dia = d.dia)::int      AS "contactadosRH",
              (SELECT count(*) FROM unicos u WHERE u.dia = d.dia)::int  AS contactados,
              coalesce(bi.n, 0)::int AS respondieron,
              coalesce(e.n, 0)::int  AS entrevistas,
              coalesce(k.n, 0)::int  AS contrataciones
         FROM dias d
         LEFT JOIN post p     ON p.dia = d.dia
         LEFT JOIN bot_in bi  ON bi.dia = d.dia
         LEFT JOIN ent e      ON e.dia = d.dia
         LEFT JOIN contrat k  ON k.dia = d.dia
        ORDER BY d.dia`,
      [D, H]
    );

    // ── 2. Embudo actual ─────────────────────────────────────────────
    // portal_status NULL = candidato que entró por el bot y RH no ha movido; el
    // portal lo muestra en Filtro Inicial, así que aquí se cuenta igual.
    const embudo = await pool.query(
      `SELECT coalesce(nullif(portal_status,''), 'filtro_inicial') AS etapa,
              count(*)::int AS n
         FROM candidatos WHERE deleted_at IS NULL
        GROUP BY 1 ORDER BY n DESC`
    );

    // ── 3. Cobertura: ¿en cuántos días se cubre una vacante? ──────────
    // Se mide de la POSTULACIÓN a la CONTRATACIÓN (time-to-fill), como se acordó.
    const cobertura = await pool.query(
      `WITH contratados AS (
         SELECT c.id, c.nombre_completo AS nombre, c.puesto_interes AS puesto,
                c.creado_en, min(t.cambiado_en) AS contratado_en
           FROM candidatos c
           JOIN candidatos_transiciones t
             ON t.candidato_id = c.id AND t.etapa_destino = 'contratado'
          WHERE c.deleted_at IS NULL
          GROUP BY c.id, c.nombre_completo, c.puesto_interes, c.creado_en
       )
       SELECT id, nombre, puesto, creado_en AS "postuloEn", contratado_en AS "contratadoEn",
              round((EXTRACT(EPOCH FROM (contratado_en - creado_en)) / 86400)::numeric, 1) AS dias
         FROM contratados ORDER BY contratado_en DESC`
    );
    // Contratados SIN fecha de contratación (etapa puesta antes del arreglo del
    // historial): existen, pero su tiempo no es calculable. Se reportan aparte
    // para no inflar ni ensuciar la mediana.
    const contratadosSinFecha = await pool.query(
      `SELECT count(*)::int AS n FROM candidatos c
        WHERE c.deleted_at IS NULL AND c.portal_status = 'contratado'
          AND NOT EXISTS (
            SELECT 1 FROM candidatos_transiciones t
             WHERE t.candidato_id = c.id AND t.etapa_destino='contratado')`
    );

    const diasCobertura = cobertura.rows.map((r: any) => Number(r.dias)).filter((n) => Number.isFinite(n));
    const mediana = (xs: number[]) => {
      if (!xs.length) return null;
      const s = [...xs].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10;
    };

    // ── 4. En proceso: quién va dentro de la meta y quién ya se pasó ──
    const enProceso = await pool.query(
      `SELECT c.id, c.nombre_completo AS nombre, c.puesto_interes AS puesto,
              coalesce(nullif(c.portal_status,''), 'filtro_inicial') AS etapa,
              round((EXTRACT(EPOCH FROM (now() - c.creado_en)) / 86400)::numeric, 1) AS dias,
              (SELECT max(e.ocurrido_en) FROM candidatos_eventos e
                WHERE e.candidato_id = c.id AND e.tipo='contacto') AS "ultimoContacto"
         FROM candidatos c
        WHERE c.deleted_at IS NULL
          AND coalesce(nullif(c.portal_status,''), 'filtro_inicial') <> ALL($1::text[])
        ORDER BY dias DESC`,
      [FUERA_DEL_PROCESO]
    );
    const enProc = enProceso.rows.map((r: any) => ({ ...r, dias: Number(r.dias) }));
    const bucket = (max: number | null, min = 0) =>
      enProc.filter((r) => r.dias >= min && (max === null || r.dias <= max)).length;

    // ── 5. Tiempo real por etapa (del historial de transiciones) ─────
    const porEtapa = await pool.query(
      `SELECT etapa_origen AS etapa, count(*)::int AS n,
              round(avg(horas_en_origen)::numeric, 1) AS "promHoras",
              round(min(horas_en_origen)::numeric, 1) AS "minHoras",
              round(max(horas_en_origen)::numeric, 1) AS "maxHoras"
         FROM candidatos_transiciones
        WHERE etapa_origen IS NOT NULL AND horas_en_origen IS NOT NULL
        GROUP BY 1 ORDER BY n DESC`
    );

    // ── 6. Conversión entrevistados -> contratados ───────────────────
    const conv = await pool.query(
      `SELECT
        (SELECT count(DISTINCT candidato_id)::int FROM candidatos_eventos
          WHERE tipo='entrevista' AND ocurrido_en::date BETWEEN $1 AND $2) AS entrevistados,
        (SELECT count(DISTINCT candidato_id)::int FROM candidatos_transiciones
          WHERE etapa_destino='contratado' AND cambiado_en::date BETWEEN $1 AND $2) AS contratados`,
      [D, H]
    );

    // ── 7. Avisos: por qué un número puede estar en cero ─────────────
    const avisos: string[] = [];
    const totalTransiciones = await pool.query('SELECT count(*)::int AS n FROM candidatos_transiciones');
    if (!totalTransiciones.rows[0].n) {
      avisos.push('El historial de etapas no tiene movimientos todavía: los tiempos por etapa y la cobertura empiezan a medirse cuando RH mueva candidatos entre etapas.');
    }
    if (!cobertura.rows.length) {
      avisos.push('Nadie ha sido marcado como Contratado, así que la cobertura en 7/15 días aún no tiene base. Se mide en automático en cuanto RH mueva a alguien a la etapa Contratados.');
    }
    if (contratadosSinFecha.rows[0].n) {
      avisos.push(`${contratadosSinFecha.rows[0].n} candidato(s) están en Contratados pero sin fecha registrada (se movieron antes de que el historial funcionara): no cuentan en el promedio de días.`);
    }
    const entrevistasTotal = serie.rows.reduce((a: number, r: any) => a + r.entrevistas, 0);
    if (!entrevistasTotal) {
      avisos.push('No hay entrevistas registradas en el rango. Se cuentan desde la ficha del candidato con el botón "Registrar entrevista".');
    }
    const contactosRH = serie.rows.reduce((a: number, r: any) => a + r.contactadosRH, 0);
    if (!contactosRH) {
      avisos.push('Todos los contactos del rango son del bot. Las llamadas y los WhatsApp personales de RH se suman cuando se registran en la ficha del candidato.');
    }

    const totales = serie.rows.reduce((a: any, r: any) => ({
      postulaciones: a.postulaciones + r.postulaciones,
      contactados: a.contactados + r.contactados,
      contactadosBot: a.contactadosBot + r.contactadosBot,
      contactadosRH: a.contactadosRH + r.contactadosRH,
      respondieron: a.respondieron + r.respondieron,
      entrevistas: a.entrevistas + r.entrevistas,
      contrataciones: a.contrataciones + r.contrataciones,
    }), { postulaciones: 0, contactados: 0, contactadosBot: 0, contactadosRH: 0, respondieron: 0, entrevistas: 0, contrataciones: 0 });

    const nDias = serie.rows.length || 1;

    return res.json({
      rango: { desde: D, hasta: H, dias: nDias },
      porDia: serie.rows,
      totales: {
        ...totales,
        promedioContactadosPorDia: Math.round((totales.contactados / nDias) * 10) / 10,
        promedioPostulacionesPorDia: Math.round((totales.postulaciones / nDias) * 10) / 10,
        tasaRespuesta: totales.contactados ? Math.round((totales.respondieron / totales.contactados) * 100) : null,
      },
      embudo: embudo.rows,
      cobertura: {
        medible: diasCobertura.length > 0,
        contratados: diasCobertura.length,
        sinFecha: contratadosSinFecha.rows[0].n,
        medianaDias: mediana(diasCobertura),
        en7: diasCobertura.filter((d) => d <= 7).length,
        en15: diasCobertura.filter((d) => d > 7 && d <= 15).length,
        masDe15: diasCobertura.filter((d) => d > 15).length,
        detalle: cobertura.rows,
      },
      enProceso: {
        total: enProc.length,
        dentroDe7: bucket(7),
        entre7y15: enProc.filter((r) => r.dias > 7 && r.dias <= 15).length,
        masDe15: enProc.filter((r) => r.dias > 15).length,
        // Los 15 más atorados: es la lista accionable de la pantalla.
        atorados: enProc.slice(0, 15),
      },
      tiempoPorEtapa: porEtapa.rows,
      conversion: {
        entrevistados: conv.rows[0].entrevistados,
        contratados: conv.rows[0].contratados,
        tasa: conv.rows[0].entrevistados
          ? Math.round((conv.rows[0].contratados / conv.rows[0].entrevistados) * 100)
          : null,
      },
      avisos,
    });
  } catch (e) { return fallo(res, e, 'No se pudo calcular el concentrado.'); }
});
