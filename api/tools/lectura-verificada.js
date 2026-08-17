// api/tools/lectura-verificada.js
//
// LO MÁS VALIOSO DE ESTE MÓDULO: la garantía de que una lectura del reloj está
// COMPLETA o no se usa. Vivía dentro de `jalar-todo-zk.js` y por eso el agente
// nuevo (api/agente/) no podía reusarla sin copiarla — y una regla copiada es
// una regla que se va a divergir. Aquí queda una sola vez y la importan los dos:
//
//   · tools/jalar-todo-zk.js   (backfill manual / --directo)
//   · tools/diagnostico-red.js (paso 4: qué declara el reloj)
//   · agente/reloj.js          (backfill horario del servicio en la LAN)
//
// La corrección del truncamiento de `node-zklib` NO está aquí: está en
// tools/lector-zk.js, que es quien baja los bytes. Aquí está la VERIFICACIÓN.
//
// ⚠️ Regla de oro del proyecto: nunca cargar lecturas parciales. Si la lectura
// no se puede verificar contra `info.logCounts`, se LANZA y no se escribe nada.

const ZKLib = require('node-zklib');
const { COMMANDS } = require('node-zklib/constants');
const { leerChecadas, leerUsuarios } = require('./lector-zk');

const PUERTO_DEFAULT = parseInt(process.env.ZK_PORT || '4370', 10) || 4370;
// Reintentos cuando la lectura no cuadra con lo que el reloj declara.
// Calibrados contra los equipos reales: con pausa de 2.5 s un reloj falló 5 de
// 5 intentos; con 4 s pasó en el segundo.
const INTENTOS_DEFAULT = parseInt(process.env.ZK_INTENTOS || '8', 10) || 8;
const PAUSA_MS_DEFAULT = parseInt(process.env.ZK_PAUSA_MS || '4000', 10) || 4000;

// ──────────────────────────────────────────────────────────────────
// motivo(e) — node-zklib lanza OBJETOS, no Error: sin esto los fallos salen
// como "[object Object]" y no se distingue un reloj apagado de un bug propio.
// ──────────────────────────────────────────────────────────────────
function motivo(e) {
  if (!e) return 'error desconocido';
  if (typeof e === 'string') return e;
  if (e.message) return e.message;
  if (e.err && e.err.message) return e.err.message;
  if (e.code) return `${e.code}${e.address ? ' ' + e.address : ''}`;
  try { return JSON.stringify(e); } catch { return String(e); }
}

/** ¿El error dice que no hay ruta hasta el equipo? Entonces no hay qué reintentar. */
function esInalcanzable(m) {
  return /ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNREFUSED|ECONNRESET|TCP CONNECT/i.test(String(m));
}

const pad = (n) => String(n).padStart(2, '0');
/** Date → las tres formas en que la base guarda una checada (hora LOCAL del reloj). */
function fmt(d) {
  const y = d.getFullYear(), mo = pad(d.getMonth() + 1), da = pad(d.getDate());
  const h = pad(d.getHours()), mi = pad(d.getMinutes()), s = pad(d.getSeconds());
  return { fecha: `${y}-${mo}-${da}`, hora: `${h}:${mi}:${s}`, fechaHora: `${y}-${mo}-${da}T${h}:${mi}:${s}` };
}

// ──────────────────────────────────────────────────────────────────
// LA IDENTIDAD DEL RELOJ ES SU NÚMERO DE SERIE, NO SU IP.
//
// Media plaza corre con DHCP encendido (Morelia Madero, 192.168.32.215, es el
// caso documentado). Identificar por IP significa que en cuanto el equipo se
// reinicia la plaza deja de bajar y NADIE se entera: no hay error, simplemente
// dejan de llegar checadas. Con la serie, el agente lo reencuentra solo.
//
// Se lee con CMD_OPTIONS_RRQ '~SerialNumber'. Se saca por expresión regular del
// buffer completo y no por offset fijo, porque el offset cambia entre firmwares
// y un offset equivocado devuelve basura que PARECE una serie.
// ──────────────────────────────────────────────────────────────────
async function leerSerie(zk) {
  const buf = await zk.executeCmd(COMMANDS.CMD_OPTIONS_RRQ, '~SerialNumber');
  const txt = Buffer.isBuffer(buf) ? buf.toString('ascii') : String(buf || '');
  const m = /~SerialNumber\s*=\s*([^\0\r\n]*)/i.exec(txt);
  const serie = (m ? m[1] : '').trim();
  if (!serie) throw new Error('el reloj no devolvió número de serie');
  return serie;
}

/**
 * Hora del RELOJ (no la del servidor). CMD_GET_TIME devuelve 4 bytes con la
 * fecha codificada; los primeros 8 bytes de la respuesta son la cabecera de
 * comando (la librería ya quitó los 16 de TCP).
 *
 * Esto es el paso que nadie revisa y el que más daño hace: si el reloj está 6
 * minutos adelantado, la tolerancia de `horarios_sucursal.tolerancia_min` se
 * aplica sobre una hora falsa y RH ve retardos que no existen.
 */
async function leerHoraReloj(zk) {
  const buf = await zk.executeCmd(COMMANDS.CMD_GET_TIME, '');
  if (!Buffer.isBuffer(buf) || buf.length < 12) throw new Error('respuesta de hora inesperada');
  let t = buf.readUInt32LE(8);
  const seg = t % 60; t = (t - seg) / 60;
  const min = t % 60; t = (t - min) / 60;
  const hor = t % 24; t = (t - hor) / 24;
  const dia = (t % 31) + 1; t = (t - (dia - 1)) / 31;
  const mes = t % 12; t = (t - mes) / 12;
  return new Date(t + 2000, mes, dia, hor, min, seg);
}

// ──────────────────────────────────────────────────────────────────
// CONTRASEÑA DE COMUNICACIÓN (Comm Key)
//
// Un reloj con Comm Key configurada se ve EXACTAMENTE igual que uno apagado, y
// no lo es. Peor: `createSocket()` de node-zklib lo da por conectado, porque
// solo comprueba que el equipo haya contestado ALGO (zklibtcp.js ~línea 57) y
// no mira que la respuesta sea CMD_ACK_UNAUTH (2005). Después falla todo lo
// demás y parece un problema de red.
//
// El algoritmo es el estándar de ZKTeco (el mismo de pyzk): la clave se mezcla
// con el sessionId que acaba de dar el equipo, se enmascara con "ZKSO" y se le
// aplica un tic. Se manda con CMD_AUTH sobre la sesión ya abierta.
// ──────────────────────────────────────────────────────────────────
function claveComunicacion(clave, sessionId, ticks = 50) {
  let k = 0;
  const key = Number(clave) | 0;
  for (let i = 0; i < 32; i++) k = (key & (1 << i)) ? ((k << 1) | 1) : (k << 1);
  k = (k + Number(sessionId)) >>> 0;

  const b = Buffer.alloc(4);
  b.writeUInt32LE(k, 0);
  const x = Buffer.from([
    b[0] ^ 'Z'.charCodeAt(0), b[1] ^ 'K'.charCodeAt(0),
    b[2] ^ 'S'.charCodeAt(0), b[3] ^ 'O'.charCodeAt(0),
  ]);
  // Se intercambian los dos u16, como hace el firmware.
  const s = Buffer.alloc(4);
  s.writeUInt16LE(x.readUInt16LE(2), 0);
  s.writeUInt16LE(x.readUInt16LE(0), 2);

  const t = ticks & 0xff;
  return Buffer.from([s[0] ^ t, s[1] ^ t, s[2], s[3] ^ t]);
}

/** Autentica una sesión ya abierta contra un reloj con Comm Key. */
async function autenticar(zk, commKey) {
  const tcp = zk.zklibTcp;
  const paquete = claveComunicacion(commKey, tcp.sessionId);
  const respuesta = await zk.executeCmd(COMMANDS.CMD_AUTH, paquete);
  // La librería resuelve con cualquier respuesta, así que el commandId se
  // revisa aquí: es la diferencia entre "entré" y "creí que entré".
  if (Buffer.isBuffer(respuesta) && respuesta.length >= 2) {
    const cmd = respuesta.readUInt16LE(0);
    if (cmd === COMMANDS.CMD_ACK_UNAUTH) {
      throw new Error('la contraseña de comunicación (comm_key) no es la correcta');
    }
  }
  return true;
}

/**
 * Abre una sesión con el reloj. Devuelve la instancia ZKLib conectada.
 *
 * ⚠️ Los ZKTeco aceptan UNA SOLA sesión TCP en el 4370. Si queda un socket
 * colgado —o si el software del proveedor está conectado— el reloj "no
 * responde" aunque esté prendido y con ping. Por eso cada uso va con su
 * `cerrar()` en un finally, siempre.
 */
async function conectar(ip, opciones = {}) {
  const puerto = opciones.puerto || PUERTO_DEFAULT;
  const zk = new ZKLib(ip, puerto, opciones.timeoutMs || 20000, opciones.inportMs || 5000);
  await zk.createSocket();
  if (opciones.commKey != null && opciones.commKey !== '') {
    try { await autenticar(zk, opciones.commKey); }
    catch (e) { await cerrar(zk); throw e; }
  }
  return zk;
}

/** Cierre defensivo: nunca lanza, porque siempre se llama desde un finally. */
async function cerrar(zk) {
  if (!zk) return;
  try { await zk.disconnect(); } catch { /* el socket ya se había ido */ }
}

// ──────────────────────────────────────────────────────────────────
// leerVerificado(ip) — lee el reloj y GARANTIZA que la lectura esté completa,
// o lanza. Nunca devuelve datos parciales.
//
// Cómo se verifica: `info.logCounts` sí reporta el total correcto. Se lee ANTES
// y DESPUÉS de bajar las checadas, porque si alguien checa en medio el total
// sube — una lectura válida debe caer entre esos dos valores. Comparar contra un
// solo número daría falsos negativos justo en las horas de entrada y salida.
//
// Y se valida el CONTENIDO, no solo la cantidad: un desalineamiento de bytes
// produce el número correcto de registros con código vacío y fecha 2000-01-01.
// La cantidad cuadra y el dato no sirve.
// ──────────────────────────────────────────────────────────────────
async function leerVerificado(ip, opciones = {}) {
  const intentos = opciones.intentos || INTENTOS_DEFAULT;
  const pausaMs = opciones.pausaMs != null ? opciones.pausaMs : PAUSA_MS_DEFAULT;
  const log = opciones.log || (() => {});
  const historial = [];

  for (let intento = 1; intento <= intentos; intento++) {
    // Socket NUEVO en cada intento: reutilizarlo arrastra el buffer a medias.
    let zk = null;
    try {
      zk = await conectar(ip, opciones);
      const antes = await zk.getInfo();

      // La serie y la hora se leen en la MISMA sesión que las checadas: así el
      // lote que se manda no puede atribuirse a un equipo distinto del que se
      // acaba de leer (que es justo lo que pasa cuando la IP cambió de dueño).
      let serie = null;
      try { serie = await leerSerie(zk); } catch { /* firmware viejo: se sigue sin serie */ }
      let horaReloj = null;
      try { horaReloj = await leerHoraReloj(zk); } catch { /* idem */ }

      const users = await leerUsuarios(zk);
      const logs = await leerChecadas(zk);

      let despues = antes.logCounts;
      try { despues = (await zk.getInfo()).logCounts; } catch { /* se queda el de antes */ }

      const min = Math.min(antes.logCounts, despues);
      const max = Math.max(antes.logCounts, despues);
      const cantidadOk = logs.length >= min && logs.length <= max;
      const usuariosOk = antes.userCounts === undefined || users.length >= antes.userCounts;

      // Contenido creíble: con código y fecha posterior a 2001 (los relojes sin
      // hora configurada graban 2000-01-01).
      const sanos = logs.filter((x) => {
        const cod = String(x.deviceUserId ?? '').trim();
        const t = new Date(x.recordTime).getTime();
        return cod !== '' && Number.isFinite(t) && t > Date.UTC(2001, 0, 1);
      }).length;
      const contenidoOk = logs.length === 0 || sanos / logs.length >= 0.9;

      historial.push({ intento, dice: antes.logCounts, leidas: logs.length, sanos });

      if (cantidadOk && usuariosOk && contenidoOk) {
        return {
          users, logs, esperadas: min, intentos: intento,
          serie, horaReloj, ip,
          info: { logCounts: antes.logCounts, userCounts: antes.userCounts },
        };
      }
      const falla = !contenidoOk
        ? `contenido inválido (${sanos}/${logs.length} registros creíbles)`
        : !usuariosOk ? `usuarios incompletos (${users.length} de ${antes.userCounts})`
        : `checadas incompletas (${logs.length} de ${antes.logCounts})`;
      log(`    intento ${intento}/${intentos}: ${falla}`);
    } catch (e) {
      const m = motivo(e);
      log(`    intento ${intento}/${intentos}: ${m}`);
      // Sin conexión no hay nada que reintentar.
      if (esInalcanzable(m)) {
        throw new Error(`no se pudo conectar a ${ip}:${opciones.puerto || PUERTO_DEFAULT} — ${m}`);
      }
    } finally {
      // Siempre cerrar: estos equipos aceptan UNA sesión a la vez y dejarla
      // abierta los vuelve inaccesibles para el siguiente intento.
      await cerrar(zk);
    }
    if (intento < intentos) await new Promise((r) => setTimeout(r, pausaMs));
  }

  const mejor = Math.max(0, ...historial.map((h) => h.leidas || 0));
  const dice = historial.length ? historial[historial.length - 1].dice : '?';
  throw new Error(
    `lectura INCOMPLETA tras ${intentos} intentos: el reloj reporta ${dice} checadas y ` +
    `la mejor lectura fue ${mejor}. NO se carga nada.`);
}

/**
 * Convierte el log crudo del reloj al formato que espera la API
 * (`{ codigo, fechaHora, fecha, hora, tipo }`), dedup dentro del propio lote.
 * No decide sucursal ni traduce códigos: eso es del servidor, que es el único
 * que conoce `relojes` y `reloj_codigo_map`.
 */
function normalizarChecadas(logs) {
  const vistos = new Set();
  const filas = [];
  for (const l of logs || []) {
    const codigo = String(l.deviceUserId ?? l.userId ?? l.uid ?? '').trim();
    const t = l.recordTime instanceof Date ? l.recordTime : new Date(l.recordTime);
    if (!codigo || isNaN(t.getTime())) continue;
    const f = fmt(t);
    const clave = `${codigo}__${f.fechaHora}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    filas.push({ codigo, ...f, tipo: typeof l.tipo === 'number' ? l.tipo : null });
  }
  return filas;
}

/** Padrón del reloj → `[{ codigo, nombre }]`, sin códigos vacíos. */
function normalizarUsuarios(users) {
  const out = [];
  for (const u of users || []) {
    const codigo = String(u.userId ?? u.uid ?? '').trim();
    if (!codigo) continue;
    out.push({ codigo, nombre: (u.name || '').trim() || `Empleado ${codigo}` });
  }
  return out;
}

module.exports = {
  motivo, esInalcanzable, fmt, pad,
  conectar, cerrar, leerSerie, leerHoraReloj, autenticar, claveComunicacion,
  leerVerificado, normalizarChecadas, normalizarUsuarios,
  PUERTO_DEFAULT, INTENTOS_DEFAULT, PAUSA_MS_DEFAULT,
};
