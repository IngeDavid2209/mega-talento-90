import { Router, Request, Response } from 'express';
import { pool } from './db';
import { aplicarLote, ChecadaEntrante } from './ingesta';

/**
 * ══════════════════════════════════════════════════════════════════
 * MODO PUSH (ADMS / protocolo iclock) · plazas SIN RUTA
 * ══════════════════════════════════════════════════════════════════
 *
 * Del barrido del 05/08/2026 (13 subredes × 254 direcciones): `Morelia Abastos`
 * (192.168.50.253) y `Sucursal PH` (192.168.10.2) NO responden desde la red del
 * corporativo y nunca van a responder — no hay VPN ni ruteo entre plazas. Un
 * agente local tampoco sirve si en esa plaza no hay una PC encendida.
 *
 * Los ZKTeco con firmware ADMS ("Cloud Server Setting" / "Configuración del
 * servidor en la nube", en el menú de Comunicación) hablan HTTP hacia AFUERA:
 * el reloj se conecta al servidor y le empuja sus checadas. No hace falta ruta
 * de entrada, solo que la VLAN del reloj tenga salida a internet.
 *
 * ⚠️ ANTES DE TOCAR NINGÚN EQUIPO:
 *   · Probar con UN SOLO reloj alcanzable. Muchos ZK viejos no manejan TLS
 *     moderno y necesitan HTTP plano en un subdominio dedicado o un relay.
 *   · Configurar un reloj en modo ADMS PUEDE DESCONECTARLO del software del
 *     proveedor. Confirmar con quien administra los relojes antes de cambiar
 *     nada.
 *   · Si el menú no tiene la opción, ese firmware no la trae: esa plaza necesita
 *     agente local o VPN, y no hay atajo.
 *
 * No lleva JWT —un reloj no puede autenticarse— y por eso la puerta es angosta:
 * solo se acepta un SN que ya esté dado de alta en `relojes` con `modo='push'`.
 * Cualquier otro SN se guarda en `ingesta_lotes` sin aplicar, igual que en la
 * ingesta del agente. La inserción es LA MISMA función (`aplicarLote`), así que
 * el dedup, la traducción de códigos y el latido se comportan idéntico.
 */
export const iclockRouter = Router();

/** El reloj manda texto plano; el `type` abarca todo porque el content-type varía por firmware. */
export const ICLOCK_CONTENT_TYPES = '*/*';

const log = (...a: any[]) => console.log('[iclock]', ...a);

/** Respuesta en texto plano: el firmware espera eso, no JSON. */
function texto(res: Response, cuerpo: string, codigo = 200) {
  res.status(codigo).type('text/plain').send(cuerpo);
}

/** ¿Este SN está dado de alta y en modo push? */
async function relojPush(sn: string) {
  const { rows } = await pool.query(
    `SELECT serie, sucursal_id, alias, modo, pendiente, activo FROM relojes WHERE serie=$1`, [sn]
  );
  return rows[0] || null;
}

/**
 * ATTLOG: una línea por checada, campos separados por TAB.
 *   <codigo>\t<yyyy-MM-dd HH:mm:ss>\t<estado>\t<verificacion>\t...
 *
 * Se leen SOLO los dos primeros campos y el estado. El resto cambia entre
 * firmwares y adivinarlo es la manera de acabar guardando el número de dedo
 * como si fuera el tipo de marca.
 */
export function parsearAttlog(cuerpo: string): { filas: ChecadaEntrante[]; ignoradas: number } {
  const filas: ChecadaEntrante[] = [];
  let ignoradas = 0;
  for (const linea of String(cuerpo || '').split(/\r?\n/)) {
    if (!linea.trim()) continue;
    const campos = linea.split('\t');
    const codigo = (campos[0] || '').trim();
    const marca = (campos[1] || '').trim();
    const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(marca);
    if (!codigo || !m) { ignoradas++; continue; }
    const tipoTxt = (campos[2] || '').trim();
    filas.push({
      codigo,
      fechaHora: `${m[1]}T${m[2]}`,
      fecha: m[1], hora: m[2],
      tipo: /^\d+$/.test(tipoTxt) ? parseInt(tipoTxt, 10) : null,
    });
  }
  return { filas, ignoradas };
}

/**
 * GET /iclock/cdata — handshake. El reloj pregunta cómo debe comportarse.
 *
 * La respuesta es un bloque de `clave=valor`. Lo importante:
 *   · `Stamp`/`OpStamp`: marcas de sincronía. Se responde 0 para que mande todo
 *     lo que tenga; el dedup del lado del servidor es lo que evita duplicar, y
 *     preferimos recibir de más a recibir de menos.
 *   · `Delay`: cada cuántos segundos vuelve a preguntar por comandos.
 *   · `TransTimes`/`TransInterval`: cada cuánto empuja sus checadas.
 *   · `ATTLOGStamp=None` NO se usa: haría que solo mandara lo nuevo desde su
 *     propia marca, y si el equipo se reinicia esa marca se pierde en silencio.
 */
iclockRouter.get('/cdata', async (req: Request, res: Response) => {
  const sn = String(req.query.SN || '').trim();
  const reloj = sn ? await relojPush(sn) : null;
  log(`handshake SN=${sn || '(vacío)'}${reloj ? ` → ${reloj.sucursal_id}` : ' → NO registrado'}`);

  if (!reloj) {
    // Se contesta OK igual: si se le niega el saludo, el reloj deja de intentar
    // y perdemos hasta la pista de que existe. Sus lotes se guardan sin aplicar.
    log(`⚠ SN ${sn} no está en el padrón. Se le deja hablar, pero su dato no entra a checadas.`);
  }

  const cuerpo = [
    `GET OPTION FROM: ${sn}`,
    'ATTLOGStamp=0',
    'OPERLOGStamp=0',
    'ATTPHOTOStamp=0',
    'ErrorDelay=30',
    'Delay=30',
    'TransTimes=00:00;12:00',
    'TransInterval=1',
    'TransFlag=1000000000',
    'Realtime=1',
    'Encrypt=0',
  ].join('\n');
  texto(res, cuerpo);
});

/**
 * POST /iclock/cdata?SN=..&table=ATTLOG — las checadas.
 *
 * El firmware espera literalmente `OK: <n>`. Si no lo recibe, REENVÍA el mismo
 * lote indefinidamente. Por eso se contesta OK incluso cuando el SN no está
 * registrado: el dato ya quedó guardado en `ingesta_lotes` y volver a pedirlo
 * no arregla nada, solo deja al reloj en un ciclo.
 */
iclockRouter.post('/cdata', async (req: Request, res: Response) => {
  const sn = String(req.query.SN || '').trim();
  const tabla = String(req.query.table || 'ATTLOG').toUpperCase();
  const cuerpo = typeof req.body === 'string' ? req.body : String(req.body || '');

  if (tabla !== 'ATTLOG') {
    // OPERLOG (operaciones del menú), USERINFO, fotos… no se guardan: no
    // alimentan asistencia y sí llenarían la base.
    log(`SN=${sn} tabla=${tabla} ignorada (${cuerpo.length} bytes)`);
    return texto(res, 'OK');
  }

  const { filas, ignoradas } = parsearAttlog(cuerpo);
  try {
    const r = await aplicarLote({
      serie: sn, origen: 'push', ip: req.ip,
      checadas: filas, completa: false,
      agenteHost: 'iclock', agenteVersion: String(req.query.pushver || ''),
    });
    log(`SN=${sn} ATTLOG: ${filas.length} líneas → ${r.aceptadas} nuevas, ` +
        `${r.duplicadas} repetidas, ${ignoradas} ilegibles (${r.estado})`);
  } catch (e) {
    console.error('[iclock] no se pudo aplicar el lote de', sn, e);
    // Aun así se contesta OK: reintentarlo llevaría al reloj a un ciclo, y el
    // backfill/agente puede recuperar lo que falte. El fallo queda en el log.
  }
  texto(res, `OK: ${filas.length}`);
});

/**
 * GET /iclock/getrequest — el reloj pregunta si hay comandos para él.
 *
 * Se contesta `OK` (sin comandos) a propósito. Desde aquí se le podría mandar
 * `CLEAR LOG`, cambiarle la hora o borrar usuarios; nada de eso se hace desde el
 * sistema. En particular BORRAR EL LOG es irreversible y el reloj es la única
 * copia si la base se pierde.
 */
iclockRouter.get('/getrequest', async (req: Request, res: Response) => {
  const sn = String(req.query.SN || '').trim();
  if (sn) {
    await pool.query(
      `INSERT INTO relojes_estado (serie, ultima_senal, ip_vista)
       SELECT $1, now(), $2 WHERE EXISTS (SELECT 1 FROM relojes WHERE serie=$1)
       ON CONFLICT (serie) DO UPDATE SET ultima_senal = now(), ip_vista = EXCLUDED.ip_vista`,
      [sn, req.ip]
    ).catch((e) => console.error('[iclock] latido', e));
  }
  texto(res, 'OK');
});

/** POST /iclock/devicecmd — acuse de comandos. Como no mandamos, solo se acusa. */
iclockRouter.post('/devicecmd', (_req: Request, res: Response) => texto(res, 'OK'));

/** Cualquier otra ruta del protocolo: se acusa para no dejar al reloj reintentando. */
iclockRouter.all('/*', (req: Request, res: Response) => {
  log(`ruta no implementada: ${req.method} ${req.originalUrl}`);
  texto(res, 'OK');
});
