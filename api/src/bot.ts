import { Router, Response } from 'express';
import { pool } from './db';
import { requireAuth, AuthedRequest } from './auth';

/**
 * Puente servidor-a-servidor con el bot de reclutamiento (BOT-RH).
 *
 * Antes el navegador llamaba DIRECTO a cuatro endpoints del bot, y por eso esos
 * endpoints no podían pedir contraseña: cualquiera con la URL podía leer la
 * conversación completa de un candidato, o hacer que el bot mandara plantillas
 * pagadas de WhatsApp a cualquier número. Ahora el navegador habla con esta API
 * (con sesión) y la API habla con el bot con la llave BOT_PANEL_TOKEN, que nunca
 * baja al navegador. Es el mismo patrón que ya usaba /kpi/decidir.
 *
 * Fase RH (migración a la Suite), [RH.0.6].
 *
 * Ojo con los códigos de respuesta: el interceptor del front cierra la sesión ante
 * cualquier 401/403, así que la única ruta pública de aquí (evaluacion-completa,
 * que abre un gerente sin sesión) nunca contesta 401/403.
 */
export const botRouter = Router();

/** Id de candidato: UUID de Postgres o el id viejo de Firestore (20 caracteres). */
const ID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9]{20})$/i;

function conexionBot(): { url: string; token: string } | null {
  const url = String(process.env.BOT_RH_URL || '').replace(/\/+$/, '');
  const token = String(process.env.BOT_PANEL_TOKEN || '');
  return url && token ? { url, token } : null;
}

/** Llama al bot con la llave. Devuelve el status y el JSON tal como los contestó. */
async function llamarBot(metodo: 'GET' | 'POST', ruta: string, cuerpo?: unknown): Promise<{ status: number; data: any }> {
  const bot = conexionBot();
  if (!bot) return { status: 503, data: { error: 'Falta configurar la conexión con el bot (BOT_RH_URL / BOT_PANEL_TOKEN).' } };
  const r = await fetch(`${bot.url}${ruta}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', 'x-panel-token': bot.token },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(20000),
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

/** Reenvía la respuesta del bot; si el bot falló, 502 (nunca 401/403 hacia el navegador). */
function responder(res: Response, r: { status: number; data: any }) {
  if (r.status >= 200 && r.status < 300) return res.status(r.status).json(r.data);
  if (r.status === 503) return res.status(503).json(r.data);
  console.error('[bot] respuesta del bot:', r.status, r.data);
  return res.status(502).json({ error: (r.data && r.data.error) || `El bot contestó ${r.status}` });
}

function idDe(v: unknown): string | null {
  const id = String(v ?? '').trim();
  return ID_RE.test(id) ? id : null;
}

/**
 * Para el alta desde el formulario público /unete: la API, y ya no el navegador,
 * le pide al bot que invite al candidato por WhatsApp. Mejor esfuerzo: nunca lanza,
 * la postulación ya quedó guardada aunque el aviso falle.
 */
export async function invitarCandidatoAlBot(candidateId: string): Promise<void> {
  try {
    const r = await llamarBot('POST', '/api/nueva-solicitud', { candidateId });
    if (r.status >= 300) console.error('[bot] no se pudo invitar al candidato', candidateId, r.status, r.data);
  } catch (e) {
    console.error('[bot] error al invitar al candidato', candidateId, (e as any)?.message);
  }
}

// ── Con sesión de RH ───────────────────────────────────────────────────────────

/** "Conectar con el bot": el bot le escribe al candidato desde el número oficial. */
botRouter.post('/invitar', requireAuth, async (req: AuthedRequest, res: Response) => {
  const candidateId = idDe(req.body?.candidateId);
  if (!candidateId) return res.status(400).json({ error: 'candidateId inválido.' });
  try {
    return responder(res, await llamarBot('POST', '/api/nueva-solicitud', { candidateId }));
  } catch (e) {
    console.error('[bot] invitar', (e as any)?.message);
    return res.status(502).json({ error: 'Sin conexión con el bot.' });
  }
});

/** "Pedir documentos por WhatsApp". */
botRouter.post('/pedir-documentos', requireAuth, async (req: AuthedRequest, res: Response) => {
  const candidateId = idDe(req.body?.candidateId);
  if (!candidateId) return res.status(400).json({ error: 'candidateId inválido.' });
  const documentos = Array.isArray(req.body?.documentos) ? req.body.documentos.slice(0, 30) : undefined;
  try {
    return responder(res, await llamarBot('POST', '/api/pedir-documentos', { candidateId, documentos }));
  } catch (e) {
    console.error('[bot] pedir-documentos', (e as any)?.message);
    return res.status(502).json({ error: 'Sin conexión con el bot.' });
  }
});

/** Historial de la conversación del bot con un candidato (expediente). */
botRouter.get('/conversacion', requireAuth, async (req: AuthedRequest, res: Response) => {
  const candidateId = idDe(req.query.candidateId);
  if (!candidateId) return res.status(400).json({ error: 'candidateId inválido.' });
  try {
    return responder(res, await llamarBot('GET', `/api/conversacion?candidateId=${encodeURIComponent(candidateId)}`));
  } catch (e) {
    console.error('[bot] conversacion', (e as any)?.message);
    return res.status(502).json({ error: 'Sin conexión con el bot.' });
  }
});

// ── Pública (la abre el gerente que evalúa, sin sesión) ────────────────────────

/**
 * Avisa a RH que un gerente terminó la evaluación de aptitudes. Pública porque la
 * página /evaluar-aptitudes/:id no tiene sesión, pero sólo avisa de una evaluación
 * que REALMENTE quedó guardada: así nadie puede disparar avisos a RH con un id suelto.
 */
botRouter.post('/evaluacion-completa', async (req: AuthedRequest, res: Response) => {
  const candidateId = idDe(req.body?.candidateId);
  if (!candidateId) return res.status(400).json({ error: 'candidateId inválido.' });
  try {
    const { rows } = await pool.query(
      `SELECT id FROM candidatos
        WHERE (id::text = $1 OR portal_candidate_id = $1)
          AND deleted_at IS NULL AND aptitudes_eval IS NOT NULL
        LIMIT 1`,
      [candidateId]
    );
    if (!rows.length) return res.status(404).json({ error: 'No hay una evaluación guardada para ese candidato.' });
    return responder(res, await llamarBot('POST', '/api/evaluacion-completa', {
      candidateId,
      puntajeTexto: req.body?.puntajeTexto ? String(req.body.puntajeTexto).slice(0, 200) : undefined,
      resultado: req.body?.resultado ? String(req.body.resultado).slice(0, 200) : undefined,
    }));
  } catch (e) {
    console.error('[bot] evaluacion-completa', (e as any)?.message);
    return res.status(502).json({ error: 'Sin conexión con el bot.' });
  }
});
