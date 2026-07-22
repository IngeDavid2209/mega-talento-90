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

// Leer un candidato (lo usan /solicitud/:id y /evaluar-*).
candidatosRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT * FROM candidatos WHERE id=$1 LIMIT 1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'No encontrado.' });
    return res.json(mapCandidato(rows[0]));
  } catch (e) { return fallo(res, e, 'Error al leer candidato.'); }
});

// Actualizar (parcial). Público: lo usan /solicitud y /evaluar-* para escribir.
// marcarActividad=false para acciones del candidato (no cuenta como seguimiento de RH).
candidatosRouter.patch('/:id', async (req: Request, res: Response) => {
  try {
    const d = req.body || {};
    const marcar = req.query.marcarActividad !== 'false' && d.__marcarActividad !== false;
    delete d.__marcarActividad;
    const esp = columnasEspejo(d);
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
        req.params.id, JSON.stringify(d), esp.nombre_completo, esp.telefono, esp.ciudad_sucursal,
        esp.puesto_interes, esp.portal_status, esp.fuente, esp.cv_url, esp.cv_url_reverso,
        esp.cv_formato, esp.licencia_url, esp.solicitud_electronica, esp.rubrica_aptitudes,
        esp.aptitudes_eval, marcar
      ]
    );
    if (!rows.length) return res.status(404).json({ error: 'No encontrado.' });
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

// Soft-delete.
candidatosRouter.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    await pool.query('UPDATE candidatos SET deleted_at=now() WHERE id=$1', [req.params.id]);
    return res.json({ ok: true });
  } catch (e) { return fallo(res, e, 'Error al eliminar candidato.'); }
});

// Cierre de seguimiento (soft-delete con motivo).
candidatosRouter.post('/:id/cierre-seguimiento', requireAuth, async (req: Request, res: Response) => {
  try {
    await pool.query(
      `UPDATE candidatos SET deleted_at=now(),
         portal_data = coalesce(portal_data,'{}'::jsonb) || '{"motivoBorrado":"cierre_seguimiento"}'::jsonb
       WHERE id=$1`,
      [req.params.id]
    );
    return res.json({ ok: true });
  } catch (e) { return fallo(res, e, 'Error al cerrar seguimiento.'); }
});

// Restaurar de papelera.
candidatosRouter.post('/:id/restaurar', requireAuth, async (req: Request, res: Response) => {
  try {
    await pool.query('UPDATE candidatos SET deleted_at=NULL WHERE id=$1', [req.params.id]);
    return res.json({ ok: true });
  } catch (e) { return fallo(res, e, 'Error al restaurar candidato.'); }
});

// Borrado físico (definitivo, desde la papelera).
candidatosRouter.delete('/:id/definitivo', requireAuth, async (req: Request, res: Response) => {
  try {
    await pool.query('DELETE FROM candidatos WHERE id=$1', [req.params.id]);
    return res.json({ ok: true });
  } catch (e) { return fallo(res, e, 'Error al eliminar definitivamente.'); }
});
