import { Router, Request, Response } from 'express';
import { pool } from './db';
import { requireAuth } from './auth';

/**
 * Router de candidatos. Estrategia de migración desde Firestore:
 *  - El objeto completo del portal se guarda en `portal_data` (JSONB), así el
 *    front conserva su forma EXACTA (nombre, cvUrl, solicitudElectronica, notas…).
 *  - Se replican en columnas los campos que se consultan/filtran
 *    (nombre_completo, telefono, ciudad_sucursal, puesto_interes, portal_status,
 *    cv_url…, deleted_at, ultima_actividad) para poder buscar/ordenar en SQL.
 *  - Convive con las columnas del bot sin pisarlas (estado, semaforo, documentos).
 *
 * Rutas públicas (sin token, para los formularios /unete y /solicitud):
 *   POST /candidatos            crear
 *   GET  /candidatos/duplicado  anti-duplicado por teléfono
 *   GET  /candidatos/:id        leer uno
 *   PATCH /candidatos/:id       actualizar (solicitud/evaluación públicas)
 * Rutas protegidas (RH): listar, papelera, borrar, restaurar, cierre.
 */
export const candidatosRouter = Router();

/**
 * `candidatos.id` es UUID. Si llega cualquier otra cosa, Postgres lanza
 * "invalid input syntax for type uuid" y el endpoint respondía 500 — por eso
 * todo lo que no fuera UUID se atajaba antes de tocar la base.
 *
 * Casos reales: una liga copiada con un espacio al final, una liga cortada, y
 * —el más común con diferencia— un id VIEJO de Firestore de 20 caracteres.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * EL ID VIEJO DE FIRESTORE TAMBIÉN ES UN ID VÁLIDO (03/08/2026).
 *
 * Hasta hoy este archivo daba 404 a todo lo que no fuera un UUID, incluidos los
 * ids de Firestore que quedaron guardados en `portal_candidate_id`. Y no son un
 * caso raro: son **249 de los 334 candidatos vivos**, tres de cada cuatro.
 *
 * El efecto se veía desde afuera: Capital Humano manda la liga de la evaluación,
 * el candidato la abre y le sale "No encontramos tu evaluación". En los logs del
 * 03/08 aparecen tres personas reales chocando contra esto —una de ellas seis
 * veces seguidas—, cada intento un 404 con el id viejo en la URL.
 *
 * La liga la arma quien la arma (el bot guarda el id viejo, el portal el UUID) y
 * ninguno de los dos se va a poner de acuerdo con el otro a tiempo. Traducir el
 * id aquí arregla las ligas de los dos lados a la vez, y el índice para buscarlo
 * (idx_candidatos_portal_id) ya existía.
 *
 * Lo que sigue siendo 404: un id que no es ni UUID ni existe como id viejo. Un
 * id que no puede existir es un "no encontrado", no un error del servidor — las
 * pantallas públicas traducen el 404 a "solicita un enlace nuevo", que es
 * accionable, y cualquier otro error a "revisa tu conexión", que manda al
 * candidato a buscar el problema donde no está.
 */
async function idValido(req: Request, res: Response): Promise<string | null> {
  const id = String(req.params.id || '').trim();
  if (UUID_RE.test(id)) return id;

  if (id) {
    try {
      // Si hubiera más de una fila con el mismo id viejo (el bot y el portal
      // llegaron a duplicar a la misma persona), se toma la más reciente: es la
      // que la liga recién enviada pretende abrir.
      const { rows } = await pool.query(
        `SELECT id FROM candidatos
          WHERE portal_candidate_id = $1 AND deleted_at IS NULL
          ORDER BY creado_en DESC LIMIT 1`,
        [id]
      );
      if (rows.length) return rows[0].id as string;
    } catch (e) {
      console.error('[candidatos] no se pudo resolver el id viejo:', (e as any)?.message);
    }
  }

  console.warn(`[candidatos] id no encontrado: "${req.params.id}" (${req.method} ${req.originalUrl})`);
  res.status(404).json({ error: 'No encontrado.' });
  return null;
}

// Deriva de la columna `documentos` (jsonb que llena el bot de WhatsApp) los
// archivos que el candidato mandó por WhatsApp, en la forma `documentosBot` que
// ya consume el front (busca por campo `tipo` = casillero del expediente). OJO:
// el bot etiqueta el casillero en `slot` (con `tipo` como alias), así que aquí
// lo normalizamos a `tipo`. Sin esto, los CV/INE/etc. que llegan por WhatsApp
// (viven en `documentos`, con `cv_url` vacío) se veían como "Sin CV" / casillero
// vacío, aunque el candidato sí los mandó.
function documentosBotDesde(documentos: any) {
  if (!Array.isArray(documentos)) return [];
  return documentos
    .filter((d) => d && typeof d === 'object' && d.url)
    .map((d) => ({
      tipo: d.slot || d.tipo || null,
      nombre: d.filename || d.nombre || null,
      url: d.url,
      mimeType: d.mime_type || d.mimeType || null,
      origen: d.origen || 'whatsapp-bot',
      recibidoEn: d.recibido_en || d.recibidoEn || null,
    }));
}

// ---- mapeo fila DB → objeto del portal (camelCase, forma del front) ----
function mapCandidato(r: any) {
  const base = (r.portal_data && typeof r.portal_data === 'object') ? r.portal_data : {};
  const out: any = { ...base, id: r.id };
  // Las columnas mandan sobre lo que haya en el JSON (fuente de verdad para búsquedas).
  if (r.nombre_completo != null) out.nombre = r.nombre_completo;
  if (r.telefono != null) out.telefono = r.telefono;
  if (r.ciudad_sucursal != null) out.ciudad = r.ciudad_sucursal;
  if (r.puesto_interes != null) out.puesto = r.puesto_interes;
  if (r.portal_status != null) out.status = r.portal_status;
  if (r.fuente != null) out.fuente = r.fuente;
  // Archivos recibidos por WhatsApp (bot) → los expone para el expediente.
  const docsBot = documentosBotDesde(r.documentos);
  if (docsBot.length) out.documentosBot = docsBot;
  // CV: la columna cv_url (formulario web) manda; si está vacía, usa el CV que
  // el candidato mandó por WhatsApp (documentos[].slot='cv').
  if (r.cv_url != null) out.cvUrl = r.cv_url;
  else {
    const cv = docsBot.find((d) => d.tipo === 'cv');
    if (cv) out.cvUrl = cv.url;
  }
  if (r.cv_url_reverso != null) out.cvUrlReverso = r.cv_url_reverso;
  if (r.cv_formato != null) out.cvFormato = r.cv_formato;
  if (r.licencia_url != null) out.licenciaUrl = r.licencia_url;
  if (r.familiar_en_empresa != null) out.familiarEnEmpresa = r.familiar_en_empresa;
  if (r.estado != null) out.estadoBot = r.estado;  // estado del bot (p.ej. 'esperando_cv') para el chip de CV
  if (r.solicitud_electronica != null) out.solicitudElectronica = r.solicitud_electronica;
  if (r.rubrica_aptitudes != null) out.rubricaAptitudes = r.rubrica_aptitudes;
  if (r.aptitudes_eval != null) out.aptitudesEval = r.aptitudes_eval;
  if (r.origen != null) out.origen = r.origen;
  out.createdAt = base.createdAt ?? r.creado_en;
  out.ultimaActividad = r.ultima_actividad ?? base.ultimaActividad ?? null;
  out.deletedAt = r.deleted_at ?? null;
  return out;
}

// Extrae de un objeto camelCase del portal los valores para las columnas espejo.
function columnasEspejo(d: any) {
  return {
    nombre_completo: d.nombre ?? null,
    telefono: d.telefono != null ? String(d.telefono) : null,
    ciudad_sucursal: d.ciudad ?? null,
    puesto_interes: d.puesto ?? null,
    portal_status: d.status ?? null,
    fuente: d.fuente ?? null,
    cv_url: d.cvUrl ?? null,
    cv_url_reverso: d.cvUrlReverso ?? null,
    cv_formato: d.cvFormato ?? null,
    licencia_url: d.licenciaUrl ?? null,
    solicitud_electronica: d.solicitudElectronica ?? null,
    rubrica_aptitudes: d.rubricaAptitudes ?? null,
    aptitudes_eval: d.aptitudesEval ?? null,
    origen: d.origen ?? null
  };
}

const soloDigitos = (s: string) => (s || '').replace(/\D/g, '');
function fallo(res: Response, e: any, msg: string) {
  console.error('[candidatos]', msg, e);
  return res.status(500).json({ error: msg });
}

// ===================== PÚBLICAS =====================

// Normaliza un nombre para comparar: minúsculas, sin acentos ni signos.
const normNombre = (s: any) =>
  String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quita acentos
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// ¿El que se postula (a) es la misma persona que el registro existente (b)?
// Sirve para NO bloquear cuando un teléfono es compartido (familia) o el registro
// viejo está incompleto. Es duplicado si los nombres son iguales, uno contiene al
// otro, o comparten ≥2 palabras (>2 letras).
//  - Sin nombre del que se postula (cliente viejo): conservador → sí bloquea (como antes).
//  - Registro existente sin nombre: no se puede confirmar → NO bloquea.
function mismoNombre(a: any, b: any): boolean {
  const na = normNombre(a), nb = normNombre(b);
  if (!na) return true;
  if (!nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const setA = new Set(na.split(' ').filter((w) => w.length > 2));
  const comunes = nb.split(' ').filter((w) => w.length > 2 && setA.has(w)).length;
  return comunes >= 2;
}

// Anti-duplicado (lo usa /unete sin sesión). Bloquea SOLO si el teléfono coincide
// con un candidato ACTIVO (no en papelera) Y el nombre coincide. Así los números
// compartidos/familiares y los registros borrados dejan de bloquear postulaciones
// legítimas (antes bastaba el teléfono → falsos "ya estás postulado").
candidatosRouter.get('/duplicado', async (req: Request, res: Response) => {
  try {
    const tel = soloDigitos(String(req.query.telefono || ''));
    if (tel.length < 10) return res.json(null);
    const nombre = String(req.query.nombre || '');
    const { rows } = await pool.query(
      `SELECT * FROM candidatos
       WHERE deleted_at IS NULL
         AND regexp_replace(coalesce(telefono,''), '[^0-9]', '', 'g') = $1
       ORDER BY creado_en DESC`,
      [tel]
    );
    const match = rows.find((r) => mismoNombre(nombre, r.nombre_completo));
    if (!match) return res.json(null);
    return res.json({ ...mapCandidato(match), estaEnPapelera: false });
  } catch (e) { return fallo(res, e, 'Error al verificar duplicado.'); }
});

// Crear candidato (formulario público /unete).
candidatosRouter.post('/', async (req: Request, res: Response) => {
  try {
    const d = req.body || {};

    // ── Filtro de CV (servidor): el formulario /unete ya exige CV del lado
    // cliente, pero el endpoint es público. Rechazamos altas web sin CV para que
    // no entren postulaciones vacías (spam).
    //
    // El único que puede saltarse el CV es el bot de WhatsApp (su CV no viaja en
    // cvUrl, queda en la columna `documentos`), y SOLO si prueba su identidad con
    // el secreto compartido `BOT_SHARED_SECRET` (header x-bot-secret). Antes se
    // confiaba en el campo `origen`/`fuente`, que cualquiera podía falsificar.
    const secreto = process.env.BOT_SHARED_SECRET || '';
    const esBot = !!secreto && req.get('x-bot-secret') === secreto;
    const tieneCv = !!(d.cvUrl && String(d.cvUrl).trim()) || !!(d.cvUrlReverso && String(d.cvUrlReverso).trim());
    if (!esBot && !tieneCv) {
      return res.status(400).json({ error: 'Es obligatorio adjuntar tu CV para postularte.' });
    }

    const esp = columnasEspejo(d);
    const { rows } = await pool.query(
      `INSERT INTO candidatos
        (telefono, estado, semaforo, nombre_completo, ciudad_sucursal, puesto_interes,
         portal_status, fuente, cv_url, cv_url_reverso, cv_formato, licencia_url,
         solicitud_electronica, rubrica_aptitudes, aptitudes_eval, origen,
         portal_data, documentos, documentos_solicitados, creado_en, ultima_interaccion)
       VALUES ($1,'portal','verde',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'{}'::jsonb,'{}'::jsonb,now(),now())
       RETURNING *`,
      [
        esp.telefono, esp.nombre_completo, esp.ciudad_sucursal, esp.puesto_interes,
        esp.portal_status || d.status || 'filtro_inicial', esp.fuente, esp.cv_url, esp.cv_url_reverso,
        esp.cv_formato, esp.licencia_url, esp.solicitud_electronica, esp.rubrica_aptitudes,
        esp.aptitudes_eval, esp.origen, JSON.stringify(d)
      ]
    );
    return res.json(mapCandidato(rows[0]));
  } catch (e) { return fallo(res, e, 'Error al crear candidato.'); }
});

// KPI de fases: tiempo promedio (horas) que los candidatos pasan en cada etapa,
// a partir del historial de transiciones. (Antes de '/:id' para no ser capturada.)
candidatosRouter.get('/kpi-fases', requireAuth, async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT etapa_origen AS etapa,
              count(*)::int AS n,
              round(avg(horas_en_origen)::numeric, 1) AS avg_horas,
              round(min(horas_en_origen)::numeric, 1) AS min_horas,
              round(max(horas_en_origen)::numeric, 1) AS max_horas
       FROM candidatos_transiciones
       WHERE etapa_origen IS NOT NULL AND horas_en_origen IS NOT NULL
       GROUP BY etapa_origen`
    );
    const fases = rows.map(r => ({
      etapa: r.etapa,
      n: r.n,
      avgHoras: Number(r.avg_horas) || 0,
      minHoras: Number(r.min_horas) || 0,
      maxHoras: Number(r.max_horas) || 0
    }));
    const total = fases.reduce((s, f) => s + f.n, 0);
    return res.json({ fases, total });
  } catch (e) {
    console.warn('[candidatos] kpi-fases (¿falta la tabla candidatos_transiciones?):', e);
    return res.json({ fases: [], total: 0 });
  }
});

// Leer un candidato (lo usan /solicitud/:id y /evaluar-*).
candidatosRouter.get('/:id', async (req: Request, res: Response) => {
  const id = await idValido(req, res);
  if (!id) return;
  try {
    const { rows } = await pool.query('SELECT * FROM candidatos WHERE id=$1 LIMIT 1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'No encontrado.' });
    return res.json(mapCandidato(rows[0]));
  } catch (e) { return fallo(res, e, 'Error al leer candidato.'); }
});

// Actualizar (parcial). Público: lo usan /solicitud y /evaluar-* para escribir.
// marcarActividad=false para acciones del candidato (no cuenta como seguimiento de RH).
candidatosRouter.patch('/:id', async (req: Request, res: Response) => {
  const idPatch = await idValido(req, res);
  if (!idPatch) return;
  try {
    const d = req.body || {};
    const marcar = req.query.marcarActividad !== 'false' && d.__marcarActividad !== false;
    delete d.__marcarActividad;
    const esp = columnasEspejo(d);
    // Estado actual ANTES de actualizar, para detectar un cambio de fase.
    const prev = await pool.query('SELECT portal_status FROM candidatos WHERE id=$1', [idPatch]);
    const estadoPrevio: string | null = prev.rows[0]?.portal_status ?? null;
    const { rows } = await pool.query(
      `UPDATE candidatos SET
         portal_data = coalesce(portal_data,'{}'::jsonb) || $2::jsonb,
         nombre_completo = coalesce($3, nombre_completo),
         telefono        = coalesce($4, telefono),
         ciudad_sucursal = coalesce($5, ciudad_sucursal),
         puesto_interes  = coalesce($6, puesto_interes),
         portal_status   = coalesce($7, portal_status),
         fuente          = coalesce($8, fuente),
         cv_url          = coalesce($9, cv_url),
         cv_url_reverso  = coalesce($10, cv_url_reverso),
         cv_formato      = coalesce($11, cv_formato),
         licencia_url    = coalesce($12, licencia_url),
         solicitud_electronica = coalesce($13, solicitud_electronica),
         rubrica_aptitudes     = coalesce($14, rubrica_aptitudes),
         aptitudes_eval        = coalesce($15, aptitudes_eval),
         ultima_actividad = CASE WHEN $16 THEN now() ELSE ultima_actividad END
       WHERE id=$1 RETURNING *`,
      [
        idPatch, JSON.stringify(d), esp.nombre_completo, esp.telefono, esp.ciudad_sucursal,
        esp.puesto_interes, esp.portal_status, esp.fuente, esp.cv_url, esp.cv_url_reverso,
        esp.cv_formato, esp.licencia_url, esp.solicitud_electronica, esp.rubrica_aptitudes,
        esp.aptitudes_eval, marcar
      ]
    );
    if (!rows.length) return res.status(404).json({ error: 'No encontrado.' });

    // Registrar la transición de fase si el estado cambió. horas_en_origen = tiempo
    // que estuvo en la etapa que deja (desde la última transición o el alta).
    //
    // OJO con los CASTEOS `$1::uuid`: son obligatorios. Sin ellos Postgres infiere
    // el tipo del parámetro por la PRIMERA comparación y luego falla al usarlo
    // contra candidatos.id con «operator does not exist: uuid = text». Ese error
    // caía en el catch de abajo como una advertencia y la tabla llevaba 5 días
    // vacía sin que nadie lo notara (detectado el 29/07/2026). Si vuelve a
    // aparecer en el log, el KPI de tiempos se queda ciego: no es un aviso menor.
    if (esp.portal_status && esp.portal_status !== estadoPrevio) {
      try {
        await pool.query(
          `INSERT INTO candidatos_transiciones (candidato_id, etapa_origen, etapa_destino, horas_en_origen)
           SELECT $1::uuid, $2, $3,
             EXTRACT(EPOCH FROM (now() - coalesce(
               (SELECT max(t.cambiado_en) FROM candidatos_transiciones t WHERE t.candidato_id = $1::uuid),
               (SELECT c.creado_en FROM candidatos c WHERE c.id = $1::uuid),
               now()
             ))) / 3600`,
          // Si nunca tuvo etapa (entró por el bot y RH lo mueve por primera vez),
          // la etapa que DEJA es Filtro Inicial: así lo lee el portal y así lo
          // cuenta el embudo. Guardar NULL hacía que esa transición —la más
          // común— no apareciera en el tiempo por etapa. Ver kpi.ts.
          [idPatch, estadoPrevio || 'filtro_inicial', esp.portal_status]
        );
      } catch (err) {
        console.error('[candidatos] NO se registró la transición de fase (el KPI de tiempos se queda sin dato):', err);
      }
    }

    return res.json(mapCandidato(rows[0]));
  } catch (e) { return fallo(res, e, 'Error al actualizar candidato.'); }
});

// ===================== PROTEGIDAS (RH) =====================

// Listar vivos.
candidatosRouter.get('/', requireAuth, async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT * FROM candidatos WHERE deleted_at IS NULL ORDER BY creado_en DESC');
    return res.json(rows.map(mapCandidato));
  } catch (e) { return fallo(res, e, 'Error al listar candidatos.'); }
});

// Papelera (borrados).
candidatosRouter.get('/papelera/borrados', requireAuth, async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT * FROM candidatos WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC');
    return res.json(rows.map(mapCandidato));
  } catch (e) { return fallo(res, e, 'Error al listar papelera.'); }
});

/**
 * FUSIONAR DOS REGISTROS DE LA MISMA PERSONA
 * POST /candidatos/:id/fusionar   body: { absorberId }
 *
 * Al 03/08/2026 había 15 personas con dos registros, y el patrón siempre era el
 * mismo: uno lo abre el bot de WhatsApp y otro el formulario del portal, a veces
 * en el MISMO MINUTO. No es que la gente se postule dos veces —es que hay dos
 * sistemas escribiendo en la misma tabla y solo uno pasa por el anti-duplicado.
 *
 * Lo que ya existía era "conservar este", que manda los otros a la papelera. El
 * problema es que cada registro trae lo que el otro no: el del bot tiene los
 * documentos que llegaron por WhatsApp y su estado de conversación; el del
 * portal tiene el CV, la fuente y la solicitud. Quedarse con uno tira la mitad
 * del expediente de una persona real.
 *
 * ── DOS REGLAS ──────────────────────────────────────────────────────
 *
 * 1. SOLO SE RELLENAN HUECOS. Ningún dato del registro que se conserva se pisa;
 *    del absorbido se toma únicamente lo que en el otro está vacío. Así fusionar
 *    nunca puede empeorar el expediente que ya estabas viendo.
 *
 * 2. LA FECHA DE ALTA ES LA MÁS VIEJA DE LAS DOS. Es el día en que la persona
 *    se postuló de verdad; quedarse con la del registro más nuevo borraría los
 *    días que lleva esperando y haría ver la cobertura mejor de lo que es.
 *
 * El absorbido va a la papelera (soft-delete), no se destruye: si la fusión se
 * hizo mal, se restaura. Y se le hereda su `portal_candidate_id` al que queda si
 * este no tenía, para que las ligas viejas que andan circulando sigan abriendo.
 */
candidatosRouter.post('/:id/fusionar', requireAuth, async (req: Request, res: Response) => {
  const conservarId = await idValido(req, res);
  if (!conservarId) return;

  const absorberRaw = String((req.body || {}).absorberId || '').trim();
  if (!absorberRaw) return res.status(400).json({ error: 'Falta absorberId.' });

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');

    // El id a absorber puede venir como UUID o como id viejo de Firestore.
    const abs = await cliente.query(
      `SELECT * FROM candidatos
        WHERE (id::text = $1 OR portal_candidate_id = $1) AND deleted_at IS NULL
        LIMIT 1`,
      [absorberRaw]
    );
    if (!abs.rows.length) { await cliente.query('ROLLBACK'); return res.status(404).json({ error: 'El registro a absorber no existe.' }); }

    const b = abs.rows[0];
    if (b.id === conservarId) { await cliente.query('ROLLBACK'); return res.status(400).json({ error: 'No se puede fusionar un registro consigo mismo.' }); }

    const cons = await cliente.query('SELECT * FROM candidatos WHERE id=$1 AND deleted_at IS NULL', [conservarId]);
    if (!cons.rows.length) { await cliente.query('ROLLBACK'); return res.status(404).json({ error: 'El registro a conservar no existe.' }); }
    const a = cons.rows[0];

    // Columnas donde "vacío" es null o cadena vacía: se rellenan desde el otro.
    const HUECOS = [
      'nombre_completo', 'telefono', 'ciudad_sucursal', 'puesto_interes',
      'cv_url', 'cv_url_reverso', 'cv_formato', 'licencia_url',
      'familiar_en_empresa', 'fuente', 'origen', 'estado', 'portal_status',
      'portal_candidate_id', 'solicitud_electronica', 'rubrica_aptitudes', 'aptitudes_eval',
    ];
    // $1 es SIEMPRE el id del que se conserva; de $2 en adelante van los valores
    // que se rellenan. No se mete ningún parámetro que la consulta no use:
    // Postgres no puede inferir el tipo de un parámetro huérfano y aborta con
    // "could not determine data type of parameter".
    const sets: string[] = [];
    const vals: any[] = [conservarId];
    let n = 2;
    const rellenados: string[] = [];
    for (const col of HUECOS) {
      const actual = (a as any)[col];
      const otro = (b as any)[col];
      const vacio = actual === null || actual === undefined || actual === '';
      if (vacio && otro !== null && otro !== undefined && otro !== '') {
        sets.push(`${col} = $${n++}`);
        vals.push(otro);
        rellenados.push(col);
      }
    }

    // El JSON del portal: lo del absorbido primero para que lo del conservado
    // gane en cualquier llave repetida (el operador || de jsonb deja al de la
    // derecha encima).
    sets.push(`portal_data = coalesce($${n++}::jsonb, '{}'::jsonb) || coalesce(portal_data, '{}'::jsonb)`);
    vals.push(b.portal_data ? JSON.stringify(b.portal_data) : null);

    // Documentos del bot: se concatenan los dos arreglos. El duplicado exacto
    // por URL se limpia abajo, en SQL, para no dejar el mismo archivo dos veces.
    sets.push(`documentos = (
      SELECT coalesce(jsonb_agg(DISTINCT d), '[]'::jsonb) FROM (
        SELECT jsonb_array_elements(
                 CASE WHEN jsonb_typeof(documentos)='array' THEN documentos ELSE '[]'::jsonb END) AS d
          FROM candidatos WHERE id = $1
        UNION
        SELECT jsonb_array_elements(
                 CASE WHEN jsonb_typeof($${n}::jsonb)='array' THEN $${n}::jsonb ELSE '[]'::jsonb END) AS d
      ) t)`);
    vals.push(b.documentos ? JSON.stringify(b.documentos) : null);
    n++;

    // La fecha de alta más vieja y la última actividad más reciente.
    sets.push(`creado_en = LEAST(creado_en, $${n++}::timestamptz)`);
    vals.push(b.creado_en);
    sets.push(`ultima_actividad = GREATEST(coalesce(ultima_actividad, to_timestamp(0)), coalesce($${n++}::timestamptz, to_timestamp(0)))`);
    vals.push(b.ultima_actividad);

    await cliente.query(`UPDATE candidatos SET ${sets.join(', ')} WHERE id = $1`, vals);

    // La bitácora y el historial de etapas del absorbido pasan al que queda:
    // son hechos que le ocurrieron a la persona, no al registro.
    await cliente.query('UPDATE candidatos_eventos SET candidato_id=$1 WHERE candidato_id=$2', [conservarId, b.id]);
    await cliente.query('UPDATE candidatos_transiciones SET candidato_id=$1 WHERE candidato_id=$2', [conservarId, b.id]);

    // El absorbido a la papelera, marcado, para poder deshacer.
    await cliente.query(
      `UPDATE candidatos
          SET deleted_at = now(),
              portal_data = coalesce(portal_data,'{}'::jsonb)
                            || jsonb_build_object('motivoBorrado', 'fusionado', 'fusionadoCon', $2::text)
        WHERE id = $1`,
      [b.id, conservarId]
    );

    await cliente.query(
      `INSERT INTO candidatos_eventos (candidato_id, tipo, canal, nota, por)
       VALUES ($1::uuid, 'nota', 'portal', $2, $3)`,
      [conservarId,
       `Se fusionó el registro duplicado de ${b.nombre_completo || 'sin nombre'} (alta ${b.creado_en?.toISOString?.().slice(0, 10) || '?'}).` +
       (rellenados.length ? ` Datos recuperados: ${rellenados.join(', ')}.` : ' No tenía datos que el otro no tuviera.'),
       (req as any).usuario?.nombre || (req as any).usuario?.email || 'RH']
    );

    await cliente.query('COMMIT');
    const final = await pool.query('SELECT * FROM candidatos WHERE id=$1', [conservarId]);
    return res.json({ ok: true, rellenados, candidato: mapCandidato(final.rows[0]) });
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    return fallo(res, e, 'No se pudo fusionar.');
  } finally {
    cliente.release();
  }
});

// Soft-delete.
candidatosRouter.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  const id = await idValido(req, res);
  if (!id) return;
  try {
    await pool.query('UPDATE candidatos SET deleted_at=now() WHERE id=$1', [id]);
    return res.json({ ok: true });
  } catch (e) { return fallo(res, e, 'Error al eliminar candidato.'); }
});

// Cierre de seguimiento (soft-delete con motivo).
candidatosRouter.post('/:id/cierre-seguimiento', requireAuth, async (req: Request, res: Response) => {
  const id = await idValido(req, res);
  if (!id) return;
  try {
    await pool.query(
      `UPDATE candidatos SET deleted_at=now(),
         portal_data = coalesce(portal_data,'{}'::jsonb) || '{"motivoBorrado":"cierre_seguimiento"}'::jsonb
       WHERE id=$1`,
      [id]
    );
    return res.json({ ok: true });
  } catch (e) { return fallo(res, e, 'Error al cerrar seguimiento.'); }
});

// Restaurar de papelera.
candidatosRouter.post('/:id/restaurar', requireAuth, async (req: Request, res: Response) => {
  const id = await idValido(req, res);
  if (!id) return;
  try {
    await pool.query('UPDATE candidatos SET deleted_at=NULL WHERE id=$1', [id]);
    return res.json({ ok: true });
  } catch (e) { return fallo(res, e, 'Error al restaurar candidato.'); }
});

// Borrado físico (definitivo, desde la papelera).
candidatosRouter.delete('/:id/definitivo', requireAuth, async (req: Request, res: Response) => {
  const id = await idValido(req, res);
  if (!id) return;
  try {
    await pool.query('DELETE FROM candidatos WHERE id=$1', [id]);
    return res.json({ ok: true });
  } catch (e) { return fallo(res, e, 'Error al eliminar definitivamente.'); }
});
