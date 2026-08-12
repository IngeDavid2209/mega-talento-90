import { Router, Request, Response } from 'express';
import { pool } from './db';
import { requireAuth } from './auth';

/**
 * =====================================================================
 * ENCUESTAS DE ONBOARDING · el envío automático
 * =====================================================================
 *
 * Capital Humano tiene cinco encuestas de nuevo ingreso en Google Forms (día
 * 3, 7, 15, 30 y 90) y pidió que se manden solas conforme cada quien cumple
 * días. Aquí vive el reloj: quién entró cuándo, a quién le toca hoy, y qué ya
 * se mandó. El envío en sí lo hace el bot (`POST /api/encuesta-onboarding`),
 * que es el único que habla con WhatsApp.
 *
 * ── CUATRO REGLAS ───────────────────────────────────────────────────
 *
 * 1. NO SE MANDA DOS VECES. El envío queda escrito en el candidato
 *    (`portal_data.encuestas.<día>.enviadaEn`) ANTES de responder, y la
 *    consulta excluye lo ya mandado. Si el corredor se repite —Railway
 *    reinicia el servicio, alguien aprieta el botón— nadie recibe la misma
 *    encuesta dos veces.
 *
 * 2. LO ATRASADO SE ALCANZA, PERO NO DESDE EL PRINCIPIO DE LOS TIEMPOS. Se
 *    manda lo de hoy y hasta `GRACIA_DIAS` de atraso. Sin esa ventana, el
 *    primer día que esto corra le llegarían cinco encuestas de golpe a quien
 *    entró hace tres meses.
 *
 * 3. SIN TELÉFONO NO HAY ENVÍO, Y SE DICE. No se marca como enviada ni se
 *    finge: queda en la lista de pendientes para que RH la mande a mano.
 *
 * 4. SI EL BOT NO PUDO, NO SE MARCA. `enviado: false` deja la encuesta
 *    pendiente para el día siguiente. Marcar y rezar es como se pierden
 *    encuestas sin que nadie se entere.
 */
export const encuestasRouter = Router();

const TZ = 'America/Mexico_City';
const DIAS = [3, 7, 15, 30, 90] as const;
type DiaEncuesta = typeof DIAS[number];

/** Cuántos días de atraso se alcanzan. Más allá, ya no tiene caso preguntar. */
const GRACIA_DIAS = 5;

/**
 * Las ligas y los identificadores de campo de los cinco formularios.
 *
 * OJO: esto está DUPLICADO en src/app/core/models/encuestas-onboarding.model.ts
 * (el front arma la misma liga para el botón de "mandar por WhatsApp"). Son dos
 * bundles distintos y no hay código compartido entre ellos; si algún día
 * cambian los formularios, hay que tocar los dos lados.
 */
const FORMS: Record<DiaEncuesta, string> = {
  3:  'https://docs.google.com/forms/d/e/1FAIpQLScOtYref1t_oMTBxDZ98qBWcXL86G9KA47DECY43UQv5nB9Fg/viewform',
  7:  'https://docs.google.com/forms/d/e/1FAIpQLScbDQ6QT1AzHg3OTRW-Yyf5Z3cWqYN8ZfFwnvarmjb7P333aw/viewform',
  15: 'https://docs.google.com/forms/d/e/1FAIpQLScwwQtjtnY2Sz1WOZ7DD4LyHzVB31ZqyJiCWLP9AsJcvBXWog/viewform',
  30: 'https://docs.google.com/forms/d/e/1FAIpQLScC2Z13w1kLmSbffAjGYi8PBE8ZLq0hLzPqQer_tpa4bQ662g/viewform',
  90: 'https://docs.google.com/forms/d/e/1FAIpQLSfTbu2OunR-gXsSdFVChaGZiRB1WANhhTt6d6hivqF6YpoxZQ/viewform',
};
const CAMPOS = {
  nombre: 'entry.1886016675', puesto: 'entry.1652986177', sucursal: 'entry.2049177136',
  jefe: 'entry.1068800151', ingreso: 'entry.345419657', cual: 'entry.396823540',
};

/** La liga prellenada: seis campos menos que contestar y respuesta cruzable. */
export function ligaEncuesta(dia: DiaEncuesta, p: { nombre?: string; puesto?: string; ingreso?: string }): string {
  const q = new URLSearchParams();
  q.set('usp', 'pp_url');
  if (p.nombre) q.set(CAMPOS.nombre, p.nombre);
  if (p.puesto) q.set(CAMPOS.puesto, p.puesto);
  q.set(CAMPOS.cual, `DIA ${dia}`);
  const ing = String(p.ingreso || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(ing)) {
    const [a, m, d] = ing.split('-');
    q.set(`${CAMPOS.ingreso}_year`, a);
    q.set(`${CAMPOS.ingreso}_month`, String(Number(m)));
    q.set(`${CAMPOS.ingreso}_day`, String(Number(d)));
  }
  return `${FORMS[dia]}?${q.toString()}`;
}

interface Pendiente {
  id: string; nombre: string; puesto: string; telefono: string | null;
  ingreso: string; dia: DiaEncuesta; diasDeAtraso: number;
}

/** Quién tiene una encuesta que mandar hoy (o atrasada dentro de la gracia). */
async function pendientes(): Promise<{ hoy: string; lista: Pendiente[] }> {
  const hoy: string = (await pool.query(
    `SELECT to_char((now() AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS d`)).rows[0].d;

  const { rows } = await pool.query(
    `SELECT c.id, c.nombre_completo AS nombre, coalesce(c.puesto_interes,'') AS puesto,
            c.telefono,
            substring(c.portal_data->>'hiredAt' from 1 for 10) AS ingreso,
            coalesce(c.portal_data->'encuestas', '{}'::jsonb) AS encuestas
       FROM candidatos c
      WHERE c.deleted_at IS NULL
        AND c.portal_status = 'contratado'
        AND c.portal_data->>'hiredAt' ~ '^\\d{4}-\\d{2}-\\d{2}'`);

  const lista: Pendiente[] = [];
  for (const r of rows) {
    const dias = Math.round(
      (Date.parse(hoy + 'T12:00:00Z') - Date.parse(r.ingreso + 'T12:00:00Z')) / 86400000);
    for (const dia of DIAS) {
      const atraso = dias - dia;
      if (atraso < 0 || atraso > GRACIA_DIAS) continue;      // no le toca todavía, o ya pasó de largo
      const ya = r.encuestas?.[String(dia)];
      if (ya?.enviadaEn || ya?.omitidaEn) continue;           // ya se le mandó, o ya se decidió no mandarla
      lista.push({
        id: r.id, nombre: r.nombre, puesto: r.puesto, telefono: r.telefono,
        ingreso: r.ingreso, dia, diasDeAtraso: atraso,
      });
    }
  }
  return { hoy, lista };
}

/** Deja escrito que se mandó, para que nadie la reciba dos veces. */
async function marcarEnviada(candidatoId: string, dia: DiaEncuesta, via: string) {
  await pool.query(
    `UPDATE candidatos
        SET portal_data = coalesce(portal_data,'{}'::jsonb)
              || jsonb_build_object('encuestas',
                   coalesce(portal_data->'encuestas','{}'::jsonb)
                   || jsonb_build_object($2::text, jsonb_build_object(
                        'enviadaEn', to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                        'via', $3::text)))
      WHERE id = $1::uuid`,
    [candidatoId, String(dia), via]);
}

/**
 * Deja escrito que esta encuesta ya no se va a mandar, y por qué. Cuenta como
 * resuelta para que no vuelva a aparecer, pero NO como enviada: el día que se
 * mida cuántas encuestas se contestaron, estas no deben inflar el denominador.
 */
async function marcarOmitida(candidatoId: string, dia: DiaEncuesta, motivo: string) {
  await pool.query(
    `UPDATE candidatos
        SET portal_data = coalesce(portal_data,'{}'::jsonb)
              || jsonb_build_object('encuestas',
                   coalesce(portal_data->'encuestas','{}'::jsonb)
                   || jsonb_build_object($2::text, jsonb_build_object(
                        'omitidaEn', to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                        'motivo', $3::text)))
      WHERE id = $1::uuid`,
    [candidatoId, String(dia), motivo]);
}

/** Le pide al bot que mande una encuesta. El bot es el único que habla con WhatsApp. */
async function mandarPorBot(p: Pendiente): Promise<{ enviado: boolean; via?: string; motivo?: string }> {
  const base = String(process.env.BOT_RH_URL || '').replace(/\/+$/, '');
  const secret = String(process.env.AVISO_ASISTENCIA_SECRET || '');
  if (!base) return { enviado: false, motivo: 'sin BOT_RH_URL' };
  if (!p.telefono) return { enviado: false, motivo: 'sin teléfono' };

  try {
    const r = await fetch(`${base}/api/encuesta-onboarding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-aviso-secret': secret },
      body: JSON.stringify({
        telefono: p.telefono,
        nombre: p.nombre,
        dia: p.dia,
        liga: ligaEncuesta(p.dia, { nombre: p.nombre, puesto: p.puesto, ingreso: p.ingreso }),
      }),
    });
    const data: any = await r.json().catch(() => ({}));
    if (!r.ok) return { enviado: false, motivo: data?.error || `el bot respondió HTTP ${r.status}` };
    if (data?.enviado === false) {
      // El bot recibió la petición pero WhatsApp no soltó el mensaje. Casi
      // siempre es la ventana de 24 h: sin plantilla aprobada, el texto libre
      // solo llega si la persona escribió hace poco. Decirlo así y no "HTTP
      // 200" es la diferencia entre saber qué arreglar y no saberlo.
      return { enviado: false, motivo: 'WhatsApp no lo entregó (falta plantilla aprobada o está fuera de la ventana de 24 h)' };
    }
    return { enviado: true, via: data?.via };
  } catch (e: any) {
    return { enviado: false, motivo: e?.message || 'error de red al contactar al bot' };
  }
}

/** Manda todo lo que toca hoy. Devuelve el detalle para el log y la pantalla. */
export async function correrEncuestas(): Promise<{
  hoy: string; revisados: number; enviadas: number; fallidas: number; omitidas: number; detalle: any[];
}> {
  const { hoy, lista } = await pendientes();
  const detalle: any[] = [];
  let enviadas = 0, fallidas = 0, omitidas = 0;

  /**
   * UNA ENCUESTA POR PERSONA, LA MÁS OPORTUNA.
   *
   * Quien lleva 7 días y todavía no ha recibido nada tiene DOS pendientes: la
   * del día 3 (atrasada) y la del día 7 (de hoy). Mandarle las dos el mismo
   * día es la forma más rápida de que archive el chat — y además la del día 3
   * pregunta por "tus primeros días" una semana después, que ya no mide lo
   * que quería medir.
   *
   * Así que de cada persona se manda solo la de menor atraso (la más
   * oportuna) y las viejas se marcan como OMITIDAS, con su motivo. No se
   * borran ni se fingen enviadas: quedan escritas para que el día que alguien
   * pregunte "¿por qué no tengo la del día 3 de Fulano?" haya una respuesta.
   */
  const porPersona = new Map<string, Pendiente[]>();
  for (const p of lista) {
    if (!porPersona.has(p.id)) porPersona.set(p.id, []);
    porPersona.get(p.id)!.push(p);
  }

  const aMandar: Pendiente[] = [];
  for (const [, suyas] of porPersona) {
    suyas.sort((a, b) => a.diasDeAtraso - b.diasDeAtraso);
    aMandar.push(suyas[0]);
    for (const vieja of suyas.slice(1)) {
      await marcarOmitida(vieja.id, vieja.dia, `se pasó ${vieja.diasDeAtraso} día(s) y ya se le mandó la del día ${suyas[0].dia}`);
      omitidas++;
      detalle.push({ nombre: vieja.nombre, dia: vieja.dia, omitida: true });
    }
  }

  for (const p of aMandar) {
    const r = await mandarPorBot(p);
    if (r.enviado) {
      // Se marca DESPUÉS de que el bot confirma: si falló, mañana se reintenta.
      await marcarEnviada(p.id, p.dia, r.via || 'texto');
      enviadas++;
    } else {
      fallidas++;
    }
    detalle.push({ nombre: p.nombre, dia: p.dia, enviado: r.enviado, via: r.via, motivo: r.motivo });
  }

  if (lista.length) {
    console.log(`[encuestas] ${hoy} · ${enviadas} enviada(s), ${fallidas} fallida(s), ${omitidas} omitida(s) de ${lista.length} pendiente(s)`);
  }
  return { hoy, revisados: lista.length, enviadas, fallidas, omitidas, detalle };
}

// =====================================================================
// EL CORREDOR: revisa una vez al día, sin que nadie apriete nada
// =====================================================================
//
// Mismo espíritu que el Agente de Horarios: si esto dependiera de que alguien
// entre a una pantalla, las encuestas del fin de semana no saldrían nunca. Se
// apaga con ENCUESTAS_AUTO=off.

let cronometro: NodeJS.Timeout | null = null;

export function arrancarEncuestas() {
  if (/^(off|0|false|no)$/i.test(String(process.env.ENCUESTAS_AUTO || ''))) {
    console.log('[encuestas] corredor APAGADO (ENCUESTAS_AUTO=off).');
    return;
  }
  if (cronometro) return;

  // Cada 6 h en vez de una vez al día: si el servicio se reinicia (Railway
  // redespliega seguido), una revisión diaria podría no correr nunca. Como no
  // se manda lo ya enviado, revisar de más no cuesta nada.
  const CADA_MS = 6 * 60 * 60 * 1000;
  const tick = async () => {
    try { await correrEncuestas(); }
    catch (e: any) { console.error('[encuestas] falló la corrida:', e?.message); }
  };
  // La primera pasada no es inmediata: al arrancar, el servicio todavía está
  // levantando conexiones y no hay prisa por mandar.
  setTimeout(tick, 90_000);
  cronometro = setInterval(tick, CADA_MS);
  console.log('[encuestas] corredor encendido · cada 6 h · primera pasada en 90s');
}

// =====================================================================
// PARA LA PANTALLA
// =====================================================================

encuestasRouter.use(requireAuth);

/** GET /encuestas/pendientes — a quién le toca hoy (sin mandar nada). */
encuestasRouter.get('/pendientes', async (_req: Request, res: Response) => {
  try {
    const { hoy, lista } = await pendientes();
    return res.json({
      hoy,
      total: lista.length,
      sinTelefono: lista.filter(p => !p.telefono).length,
      pendientes: lista,
    });
  } catch (e) {
    console.error('[encuestas] no se pudo leer los pendientes:', e);
    return res.status(500).json({ error: 'No se pudieron leer las encuestas pendientes.' });
  }
});

/** POST /encuestas/correr — mandar ahora lo que toca, sin esperar al corredor. */
encuestasRouter.post('/correr', async (_req: Request, res: Response) => {
  try {
    return res.json(await correrEncuestas());
  } catch (e) {
    console.error('[encuestas] falló la corrida manual:', e);
    return res.status(500).json({ error: 'No se pudo correr el envío.' });
  }
});
