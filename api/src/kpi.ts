import { Router, Request, Response } from 'express';
import { pool } from './db';
import { requireAuth, AuthedRequest } from './auth';
// Qué cuenta como postulación y qué es una conversación del bot a medias. Se
// importa en vez de repetirse: dos listas del mismo dato con criterios distintos
// es la forma más segura de que una de las dos mienta.
import { ES_POSTULACION, NO_ES_SPAM } from './candidatos';

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

/**
 * ── LOS DÍAS SE CUENTAN EN HORA DE MÉXICO, NO EN UTC ────────────────────
 *
 * El Postgres de Railway corre en `Etc/UTC`, así que `creado_en::date` parte el
 * día a las 18:00 hora de México. Medido el 30/07/2026 sobre la tabla `mensajes`:
 * 1,998 de 8,251 registros (24%) caían en un día distinto al real. En un tablero
 * que responde "¿a cuánta gente se contactó HOY?", eso es un cuarto del trabajo
 * de la tarde apareciendo como del día siguiente.
 *
 * `dia()` convierte un timestamptz al día calendario mexicano y `hoy()` da la
 * fecha de hoy con el mismo criterio. Se usan en TODA consulta que agrupe o
 * filtre por fecha; si se mezclan las dos formas, los totales no cuadran entre
 * bloques del mismo tablero.
 */
const TZ = 'America/Mexico_City';
const dia = (col: string) => `((${col} AT TIME ZONE '${TZ}')::date)`;
const hoy = () => `((now() AT TIME ZONE '${TZ}')::date)`;

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
// LA LUZ VERDE, DESDE EL PORTAL
// =====================================================================
//
// El bot dictamina y deja al candidato esperando una decisión de RH: aprobar o
// descartar. Esa decisión ya se podía tomar por WhatsApp o en el panel del bot…
// y ahí estaba el problema: **RH trabaja en el portal**. Al 01/08/2026 había 28
// candidatos dictaminados y CERO decisiones tomadas — no por falta de ganas, sino
// porque la única puerta para decidir estaba en otra herramienta, con otro token.
// Un botón que vive donde nadie lo ve es un botón que no existe.
//
// Este endpoint es el puente: el navegador llama aquí con su sesión normal (JWT)
// y el servidor reenvía la decisión al bot con el `x-panel-token`. El token del
// bot NUNCA baja al navegador; vive solo en la variable BOT_PANEL_TOKEN del API.
//
// El efecto es idéntico al del botón de WhatsApp (mismo endpoint del bot): se le
// avisa al candidato si fue aprobado, se registra quién decidió y cuándo, y el
// candidato sale de la cola.
kpiRouter.post('/decidir', async (req: AuthedRequest, res: Response) => {
  const b = req.body || {};
  const id = String(b.candidatoId || '').trim();
  const decision = String(b.decision || '').trim().toLowerCase();

  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'candidatoId inválido.' });
  if (decision !== 'aprobado' && decision !== 'descartado') {
    return res.status(400).json({ error: "decision debe ser 'aprobado' o 'descartado'." });
  }

  const BOT = String(process.env.BOT_RH_URL || '').replace(/\/+$/, '');
  const TOKEN = String(process.env.BOT_PANEL_TOKEN || '');
  if (!BOT || !TOKEN) {
    return res.status(503).json({
      error: 'Falta configurar la conexión con el bot (BOT_RH_URL / BOT_PANEL_TOKEN).',
    });
  }

  try {
    const { rows } = await pool.query(
      'SELECT telefono, nombre_completo FROM candidatos WHERE id=$1::uuid',
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Candidato no encontrado.' });

    const quien = (req.usuario as any)?.nombre || (req.usuario as any)?.email || 'RH';
    const r = await fetch(`${BOT}/api/decidir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-panel-token': TOKEN },
      body: JSON.stringify({
        telefono: rows[0].telefono,
        decision,
        por: quien,
        nota: b.nota ? String(b.nota).slice(0, 500) : undefined,
      }),
    });
    const cuerpo = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('[kpi] el bot rechazó la decisión:', r.status, cuerpo);
      return res.status(502).json({ error: (cuerpo as any).error || 'El bot no pudo registrar la decisión.' });
    }

    // Queda también en la bitácora: el KPI necesita saber CUÁNDO se decidió.
    await pool.query(
      `INSERT INTO candidatos_eventos (candidato_id, tipo, canal, nota, por)
       VALUES ($1::uuid, 'nota', 'portal', $2, $3)`,
      [id, `Decisión de RH: ${decision}${b.nota ? ' · ' + String(b.nota).slice(0, 200) : ''}`, quien]
    );
    return res.json({ ok: true, decision, ...(cuerpo as any) });
  } catch (e) { return fallo(res, e, 'No se pudo registrar la decisión.'); }
});

// =====================================================================
// FUERA DE LUGAR: quién está en una fase adelantada sin cumplir lo mínimo
// =====================================================================
//
// El 30/07/2026, revisando a mano, salieron 20 candidatos en fases posteriores a
// Filtro Inicial que no debían estar ahí: sin CV, con el registro del bot a
// medias, pidiendo un puesto cerrado, y uno con conflicto de interés declarado.
// La causa era el autoavance del cuestionario (ya corregido en el front), pero
// los que ya subieron siguen arriba, y esto tiene que poder revisarse SIN que
// nadie corra un script.
//
// ── Dos reglas para que la lista sirva ──
//
// 1. "SIN DICTAMEN" NO ES UNA FALLA. Los candidatos que entraron antes de que
//    existiera el análisis automático no están mal: están sin evaluar. Se cuentan
//    aparte (`sinEvaluar`) porque mezclarlos convertía 20 avisos útiles en 89
//    líneas de ruido — y una alerta con ruido se ignora.
//
// 2. EL PUESTO SE REVISA A LA LIGERA, A PROPÓSITO. Se marca solo cuando el texto
//    del candidato no comparte NINGUNA palabra con las vacantes abiertas. Es
//    preferible dejar pasar un caso dudoso que llenar la lista de falsas alarmas
//    ("Cajero (a) o Anaquelista" es un puesto válido escrito a su manera).
// =====================================================================

const FASES_ADELANTADAS = ['entrevista_rh', 'aptitudes', 'psicometria', 'contratado'];

const normPalabra = (s: string) => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').trim();

/** Palabras de 4+ letras: las que de verdad identifican un puesto. */
function palabrasDe(texto: string): string[] {
  return normPalabra(texto).split(/\s+/).filter(w => w.length >= 4);
}

/** ¿El texto del candidato se parece a ALGUNA vacante abierta? (a la ligera) */
function pareceVacanteAbierta(texto: string, vacantes: string[]): boolean {
  const mias = palabrasDe(texto);
  if (!mias.length) return true; // sin texto no acusamos
  return vacantes.some(v => palabrasDe(v).some(w =>
    mias.some(m => m.startsWith(w.slice(0, 5)) || w.startsWith(m.slice(0, 5)))
  ));
}

kpiRouter.get('/fuera-de-lugar', async (_req: Request, res: Response) => {
  try {
    const vac = await pool.query(
      `SELECT nombre FROM puestos WHERE activo IS DISTINCT FROM false`
    );
    const vacantes: string[] = vac.rows.map((r: any) => r.nombre);

    const { rows } = await pool.query(
      `SELECT id, nombre_completo AS nombre, puesto_interes AS puesto,
              portal_status AS etapa, estado AS "estadoBot",
              cv_url, documentos, portal_data,
              round((EXTRACT(EPOCH FROM (now() - creado_en)) / 86400)::numeric, 1) AS dias
         FROM candidatos
        WHERE deleted_at IS NULL AND portal_status = ANY($1::text[])
        ORDER BY nombre_completo`,
      [FASES_ADELANTADAS]
    );

    const casos: any[] = [];
    let sinEvaluar = 0;

    for (const c of rows) {
      const pd = (c.portal_data && typeof c.portal_data === 'object') ? c.portal_data : {};
      const docs = Array.isArray(c.documentos) ? c.documentos : [];
      const tieneCv = !!(String(c.cv_url || '').trim() || pd.cvUrl
        || docs.some((d: any) => d && d.slot === 'cv'));
      const d = pd.dictamen || null;
      const motivos: string[] = [];

      if (!tieneCv) motivos.push('No tiene CV en el expediente.');

      const eb = String(c.estadoBot || '');
      if (eb.startsWith('esperando_')) {
        motivos.push(`Su registro quedó incompleto: falta ${eb.replace('esperando_', '').replace(/_/g, ' ')}.`);
      }

      // Banderas graves de política (familiar en la empresa, prueba no apta).
      // `sin_cv` se omite porque ya se reporta arriba con sus propias palabras.
      for (const r of ((d?.reglas || []) as any[]).filter(x => x?.gravedad === 'alta' && x?.codigo !== 'sin_cv')) {
        motivos.push(r.texto || `Bandera grave: ${r.codigo}`);
      }

      if (d?.recomendacion === 'descartar' && d?.cv_leido) {
        motivos.push(`El análisis del CV recomienda descartar (${d.puntaje}/100).`);
      }

      if (c.puesto && !pareceVacanteAbierta(c.puesto, vacantes)) {
        motivos.push(`Pide "${c.puesto}" y no hay una vacante abierta que corresponda.`);
      }

      if (/prueba|borrar|^test/i.test(String(c.nombre || ''))) {
        motivos.push('Parece un registro de PRUEBA.');
      }

      if (!motivos.length) { if (!d) sinEvaluar++; continue; }
      casos.push({
        id: c.id, nombre: c.nombre, puesto: c.puesto, etapa: c.etapa,
        dias: Number(c.dias), motivos,
        dictamen: d ? { recomendacion: d.recomendacion, puntaje: d.puntaje, nivel: d.nivel } : null,
      });
    }

    return res.json({
      total: rows.length,
      conProblema: casos.length,
      sinEvaluar,
      casos,
      nota: sinEvaluar
        ? `${sinEvaluar} candidato(s) en fases adelantadas todavía no tienen análisis del CV. No es una falla: nadie los ha evaluado.`
        : null,
    });
  } catch (e) { return fallo(res, e, 'No se pudo revisar quién está fuera de lugar.'); }
});

// =====================================================================
// NOVEDADES DEL DÍA — "¿qué pasó hoy?"
// =====================================================================
//
// Lo que pidió Capital Humano para el dashboard: el resumen de lo nuevo que se
// genera al día — quién se postuló y quién cambió de fase.
//
// ── POR QUÉ NO ES OTRO BLOQUE DE CIFRAS ─────────────────────────────
//
// El panel ya tiene indicadores de sobra; lo que no tenía es la respuesta a
// "¿qué pasó desde ayer?". Por eso esto devuelve NOMBRES, no totales: un "3
// postulados hoy" obliga a ir a buscarlos a otra pantalla, y esa fricción es la
// razón por la que la gente nueva se queda dos días sin que nadie la toque.
//
// El día se corta en hora de México (ver `dia()` arriba). Se puede pedir otro
// día con ?dia=YYYY-MM-DD: los lunes hay que poder mirar el sábado.
kpiRouter.get('/novedades', async (req: Request, res: Response) => {
  const pedido = String(req.query.dia || '').match(/^\d{4}-\d{2}-\d{2}$/) ? String(req.query.dia) : null;

  try {
    const D: string = pedido || (await pool.query(`SELECT to_char(${hoy()}, 'YYYY-MM-DD') AS d`)).rows[0].d;
    const hoyReal: string = (await pool.query(`SELECT to_char(${hoy()}, 'YYYY-MM-DD') AS d`)).rows[0].d;
    const hora = (col: string) => `to_char(${col} AT TIME ZONE '${TZ}', 'HH24:MI')`;

    // ── Quién se postuló ─────────────────────────────────────────────
    //
    // Con el MISMO criterio que el resto de la plataforma (ES_POSTULACION). Sin
    // él, este bloque listaba todo lo creado en el día: el 04/08 mostró 23
    // "postulados" de los que 6 no tenían CV y tres se llamaban "(sin nombre)"
    // —conversaciones del bot a medias— y de paso la misma persona dos veces,
    // porque el bot y el portal le abren un registro cada uno. Lo que RH leía
    // como "hoy se postularon 23" eran 17 postulaciones y 6 charlas empezadas.
    const postulados = await pool.query(
      `SELECT id, nombre_completo AS nombre, coalesce(puesto_interes,'') AS puesto,
              coalesce(ciudad_sucursal,'') AS ciudad,
              coalesce(nullif(origen,''), nullif(fuente,''), 'portal') AS origen,
              ${hora('creado_en')} AS hora
         FROM candidatos
        WHERE deleted_at IS NULL AND ${dia('creado_en')} = $1::date
          AND ${ES_POSTULACION} AND ${NO_ES_SPAM}
        ORDER BY creado_en DESC`,
      [D]
    );

    // Las conversaciones que el bot abrió ese día y que NO llegaron a
    // postulación. No se listan con nombre —no hay nada que revisar todavía—
    // pero se cuentan: esconderlas del todo haría parecer que el bot no trabajó.
    const conversaciones = await pool.query(
      `SELECT count(*)::int AS n
         FROM candidatos
        WHERE deleted_at IS NULL AND ${dia('creado_en')} = $1::date
          AND NOT ${ES_POSTULACION}`,
      [D]
    );

    // ── Quién cambió de fase ─────────────────────────────────────────
    // etapa_origen NULL = venía del bot sin etapa fijada; el resto del sistema
    // lo lee como Filtro Inicial y aquí se hace igual, para no inventar un
    // "(ninguna) → Entrevista RH" que nadie sabe interpretar.
    const fases = await pool.query(
      `SELECT t.id, t.candidato_id AS "candidatoId", c.nombre_completo AS nombre,
              coalesce(t.etapa_origen, 'filtro_inicial') AS de, t.etapa_destino AS a,
              ${hora('t.cambiado_en')} AS hora
         FROM candidatos_transiciones t
         JOIN candidatos c ON c.id = t.candidato_id AND c.deleted_at IS NULL
        WHERE ${dia('t.cambiado_en')} = $1::date
        ORDER BY t.cambiado_en DESC`,
      [D]
    );

    // ── Qué registró RH (llamadas, entrevistas, notas) ───────────────
    const eventos = await pool.query(
      `SELECT e.id, e.candidato_id AS "candidatoId", c.nombre_completo AS nombre,
              e.tipo, e.canal, e.nota, e.por, ${hora('e.ocurrido_en')} AS hora
         FROM candidatos_eventos e
         JOIN candidatos c ON c.id = e.candidato_id AND c.deleted_at IS NULL
        WHERE ${dia('e.ocurrido_en')} = $1::date
        ORDER BY e.ocurrido_en DESC LIMIT 60`,
      [D]
    );

    // ── Qué hizo el bot ──────────────────────────────────────────────
    const bot = await pool.query(
      `SELECT count(DISTINCT telefono) FILTER (WHERE direccion='in')::int  AS escribieron,
              count(DISTINCT telefono) FILTER (WHERE direccion='out')::int AS "seLesEscribio",
              count(*)::int AS mensajes
         FROM mensajes WHERE ${dia('creado_en')} = $1::date`,
      [D]
    );

    // ── Qué pidieron las sucursales ──────────────────────────────────
    // La tabla nació después del resto; si el deploy del API va adelantado a la
    // migración, este bloque no puede tumbar todo el panel del día.
    let requisiciones: any[] = [];
    try {
      const r = await pool.query(
        `SELECT id, folio, puesto, sucursal_id AS "sucursalId", vacantes, estado,
                ${hora('creado_en')} AS hora
           FROM requisiciones
          WHERE ${dia('creado_en')} = $1::date
          ORDER BY creado_en DESC`,
        [D]
      );
      requisiciones = r.rows;
    } catch (e) {
      console.warn('[kpi] novedades: no se pudieron leer las requisiciones del día:', (e as any)?.message);
    }

    const resumen = {
      postulados: postulados.rowCount || 0,
      fases: fases.rowCount || 0,
      eventos: eventos.rowCount || 0,
      requisiciones: requisiciones.length,
    };

    return res.json({
      dia: D,
      esHoy: D === hoyReal,
      resumen,
      // Suma de lo que de verdad es "algo que pasó". Los mensajes del bot no
      // entran: el bot escribe todos los días y siempre daría "hubo novedades".
      total: resumen.postulados + resumen.fases + resumen.eventos + resumen.requisiciones,
      postulados: postulados.rows,
      fases: fases.rows,
      eventos: eventos.rows,
      requisiciones,
      bot: { ...bot.rows[0], conversaciones: conversaciones.rows[0].n },
    });
  } catch (e) { return fallo(res, e, 'No se pudieron leer las novedades del día.'); }
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
      // Se devuelven como TEXTO 'YYYY-MM-DD' a propósito: si salen como `date`,
      // el driver los convierte a Date de JS en la zona del proceso y al llegar
      // al navegador ya son "2026-07-30T00:00:00.000Z" — el front concatenaba
      // 'T12:00:00' a eso y toda la gráfica mostraba "Invalid Date".
      `SELECT to_char(coalesce($1::date, ${hoy()} - ($3::int - 1)), 'YYYY-MM-DD') AS desde,
              to_char(coalesce($2::date, ${hoy()}), 'YYYY-MM-DD') AS hasta`,
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
         SELECT ${dia('creado_en')} AS dia, count(*) AS n
           FROM candidatos WHERE deleted_at IS NULL AND ${NO_ES_SPAM}
            AND ${dia('creado_en')} BETWEEN $1 AND $2 GROUP BY 1
       ),
       bot_out AS (
         SELECT ${dia('creado_en')} AS dia, telefono
           FROM mensajes WHERE direccion='out' AND ${dia('creado_en')} BETWEEN $1 AND $2
          GROUP BY 1,2
       ),
       bot_in AS (
         SELECT ${dia('creado_en')} AS dia, count(DISTINCT telefono) AS n
           FROM mensajes WHERE direccion='in' AND ${dia('creado_en')} BETWEEN $1 AND $2
          GROUP BY 1
       ),
       rh AS (
         SELECT ${dia('ocurrido_en')} AS dia, candidato_id
           FROM candidatos_eventos
          WHERE tipo='contacto' AND coalesce(canal,'') <> 'bot'
            AND ${dia('ocurrido_en')} BETWEEN $1 AND $2
          GROUP BY 1,2
       ),
       -- Para deduplicar contra el bot se compara por teléfono. Si el candidato
       -- no tiene teléfono capturado NO se puede cruzar, así que se le da una
       -- llave propia con su id: sin esto, todas las personas sin teléfono se
       -- fundían en una sola fila y el día reportaba un contacto donde hubo diez.
       rh_tel AS (
         SELECT r.dia,
                coalesce(nullif(right(regexp_replace(coalesce(c.telefono,''), '[^0-9]', '', 'g'), 10), ''),
                         'sin-tel:' || r.candidato_id::text) AS tel
           FROM rh r JOIN candidatos c ON c.id = r.candidato_id
       ),
       unicos AS (
         SELECT dia, coalesce(nullif(right(regexp_replace(telefono,'[^0-9]','','g'), 10), ''),
                              'sin-tel-bot:' || telefono) AS tel FROM bot_out
         UNION
         SELECT dia, tel FROM rh_tel
       ),
       ent AS (
         SELECT ${dia('ocurrido_en')} AS dia, count(*) AS n
           FROM candidatos_eventos WHERE tipo='entrevista'
            AND ${dia('ocurrido_en')} BETWEEN $1 AND $2 GROUP BY 1
       ),
       contrat AS (
         SELECT ${dia('cambiado_en')} AS dia, count(DISTINCT candidato_id) AS n
           FROM candidatos_transiciones WHERE etapa_destino='contratado'
            AND ${dia('cambiado_en')} BETWEEN $1 AND $2 GROUP BY 1
       )
       SELECT to_char(d.dia, 'YYYY-MM-DD') AS dia,
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
         FROM candidatos WHERE deleted_at IS NULL AND ${NO_ES_SPAM}
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
      // etapa_origen NULL = el candidato entró por el bot y RH lo movió sin que
      // nadie le hubiera fijado etapa nunca. Ese caso ES Filtro Inicial: el resto
      // del sistema lo lee así (el embudo hace el mismo coalesce). Filtrarlo por
      // NULL tiraba a la basura la transición más común del proceso —el 30/07/2026
      // eran 5 de las 6 transiciones registradas— y dejaba la primera etapa, donde
      // están 200 de 298 candidatos, sin ningún tiempo medido.
      `SELECT coalesce(etapa_origen, 'filtro_inicial') AS etapa, count(*)::int AS n,
              round(avg(horas_en_origen)::numeric, 1) AS "promHoras",
              round(min(horas_en_origen)::numeric, 1) AS "minHoras",
              round(max(horas_en_origen)::numeric, 1) AS "maxHoras"
         FROM candidatos_transiciones
        WHERE horas_en_origen IS NOT NULL
        GROUP BY 1 ORDER BY n DESC`
    );

    // ── 6. Conversión entrevistados -> contratados ───────────────────
    const conv = await pool.query(
      `SELECT
        (SELECT count(DISTINCT candidato_id)::int FROM candidatos_eventos
          WHERE tipo='entrevista' AND ${dia('ocurrido_en')} BETWEEN $1 AND $2) AS entrevistados,
        (SELECT count(DISTINCT candidato_id)::int FROM candidatos_transiciones
          WHERE etapa_destino='contratado' AND ${dia('cambiado_en')} BETWEEN $1 AND $2) AS contratados`,
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

// ─────────────────────────────────────────────────────────────────────
// POST /kpi/agrupar — unir las variantes de escritura de puesto y ciudad
//
// `puesto` y `ciudad` son texto libre: los contesta el candidato por WhatsApp,
// no un menú. Por eso el tablero venía mostrando "Jefatura de recursos
// humanos" (24) y "Jefatura de Recursos Humanos" (21) como dos puestos, "Aux
// de chofer" y "Auxiliar de chofer" como dos, y "RH", "Rh", "Jefe de RH",
// "Capital Humano" y "Líder de recursos humanos" cada uno con su renglón.
//
// La normalización que ya había aquí (normalizacion.model.ts) solo une lo que
// coincide EXACTO con el catálogo; todo lo demás se queda como se escribió.
//
// Este endpoint reenvía al BOT, que ya sabe hacerlo: conoce los alias de cada
// sucursal ("Padre Hidalgo" es Santa Ana Pacueco), resuelve texto libre contra
// el catálogo real de vacantes, y lo que no cae en ninguna regla lo agrupa con
// IA UNA sola vez y lo deja guardado.
//
// Se reenvía en vez de reimplementarlo en TypeScript a propósito: dos copias
// de esta lógica serían dos fuentes de verdad, que es exactamente lo que ya
// costó caro cuando los puestos vivían a la vez en Firestore y en Postgres.
// Mismo patrón que /kpi/decidir: el token del bot nunca baja al navegador.
// ─────────────────────────────────────────────────────────────────────
kpiRouter.post('/agrupar', async (req: Request, res: Response) => {
  const b = (req.body || {}) as any;
  const tipo = String(b.tipo || '').trim();
  const valores = Array.isArray(b.valores) ? b.valores.map((v: any) => String(v || '')) : null;

  if (tipo !== 'puesto' && tipo !== 'zona') {
    return res.status(400).json({ error: "tipo debe ser 'puesto' o 'zona'." });
  }
  if (!valores) return res.status(400).json({ error: 'valores debe ser un arreglo.' });

  const BOT = String(process.env.BOT_RH_URL || '').replace(/\/+$/, '');
  const TOKEN = String(process.env.BOT_PANEL_TOKEN || '');
  // Sin bot configurado NO se rompe la pantalla: se devuelve un mapa vacío y
  // el front se queda con las etiquetas tal como se capturaron. Es peor un
  // tablero caído que uno sin agrupar.
  if (!BOT || !TOKEN) {
    return res.json({ mapa: {}, invalidos: [], vacantes: [], pendientes: valores.length, sin_bot: true });
  }

  try {
    const r = await fetch(`${BOT}/admin/agrupar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-panel-token': TOKEN },
      body: JSON.stringify({ tipo, valores, aprender: b.aprender === true }),
    });
    const cuerpo: any = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('[kpi/agrupar] el bot respondió', r.status, cuerpo);
      return res.json({ mapa: {}, invalidos: [], vacantes: [], pendientes: valores.length, error_bot: cuerpo?.error || r.status });
    }
    return res.json({ mapa: cuerpo.mapa || {}, invalidos: cuerpo.invalidos || [], vacantes: cuerpo.vacantes || [], pendientes: cuerpo.pendientes ?? 0 });
  } catch (e: any) {
    console.error('[kpi/agrupar] no se pudo hablar con el bot:', e?.message);
    return res.json({ mapa: {}, invalidos: [], vacantes: [], pendientes: valores.length, error_bot: 'sin conexión con el bot' });
  }
});
