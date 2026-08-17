// api/tools/diagnostico-red.js
//
// POR QUÉ EXISTE ESTA HERRAMIENTA
//
// Hasta hoy, cuando un reloj no bajaba, el importador decía "no responde". Esa
// frase tapa CUATRO fallas distintas que se arreglan de cuatro maneras distintas:
//
//   1. No hay ruta a la subred (o el equipo está apagado)  → red / campo
//   2. El puerto 4370 no acepta conexiones                 → servicio caído o firewall
//   3. Hay OTRA sesión abierta                             → los ZK aceptan UNA sola
//   4. El equipo pide contraseña de comunicación (Comm Key) → configuración
//
// Y una quinta que ni siquiera se reporta como falla y es la más cara:
//
//   5. La IP contesta, pero es OTRO reloj (DHCP le movió la dirección).
//      Las checadas entrarían bajo la sucursal equivocada y eso NO se nota
//      mirando la pantalla.
//
// Este script hace los 6 pasos en orden y dice EN CUÁL se rompió.
//
// Uso:
//   node tools/diagnostico-red.js                 (todos los relojes de targets.json)
//   node tools/diagnostico-red.js --json          (salida para guardar como evidencia)
//   node tools/diagnostico-red.js --ip 192.168.0.80
//   node tools/diagnostico-red.js --barrer 192.168.40.0/24
//   node tools/diagnostico-red.js --incluir-pendientes
//
// ⚠️ Se corre desde una PC EN LA LAN de los relojes. Desde Railway no hay ruta:
// las IPs son privadas y no existe VPN entre plazas.

try { require('dotenv').config(); } catch { /* dotenv opcional */ }
const net = require('net');
const { execFile } = require('child_process');
const { createTCPHeader, decodeTCPHeader } = require('node-zklib/utils');
const { COMMANDS } = require('node-zklib/constants');
const {
  motivo, conectar, cerrar, leerSerie, leerHoraReloj, PUERTO_DEFAULT,
} = require('./lectura-verificada');

const ARGS = process.argv.slice(2);
const flag = (n) => ARGS.includes(n);
const valor = (n) => { const i = ARGS.indexOf(n); return i >= 0 ? ARGS[i + 1] : null; };

const JSON_OUT = flag('--json');
const PUERTO = parseInt(valor('--puerto') || String(PUERTO_DEFAULT), 10);
const TIMEOUT_TCP = parseInt(valor('--timeout') || '1500', 10);
// El desfase a partir del cual el dato ya no sirve: con el reloj 2 min corrido,
// la tolerancia del horario se aplica sobre una hora que no es.
const DESFASE_GRAVE_SEG = parseInt(process.env.ZK_DESFASE_GRAVE_SEG || '120', 10);

const say = (...a) => { if (!JSON_OUT) console.log(...a); };

// ── Paso 1 · ICMP ────────────────────────────────────────────────────
// `ping` del sistema: no hay ICMP en Node sin permisos de administrador.
function ping(ip) {
  const win = process.platform === 'win32';
  const args = win ? ['-n', '1', '-w', '900', ip] : ['-c', '1', '-W', '1', ip];
  return new Promise((resolve) => {
    execFile('ping', args, { timeout: 4000, windowsHide: true }, (err, stdout) => {
      // En Windows `ping` sale con código 0 aunque el destino sea inalcanzable,
      // así que hay que leer la salida y no solo el código.
      const txt = String(stdout || '');
      const inalcanzable = /inalcanzable|unreachable|100% (packet )?loss|100% perdidos|tiempo de espera agotado|Request timed out/i.test(txt);
      const respondio = /bytes=|ttl=|tiempo[=<]|time[=<]/i.test(txt);
      resolve(!err && respondio && !inalcanzable);
    });
  });
}

// ── Paso 2 · TCP 4370 ────────────────────────────────────────────────
function tcpAbierto(ip, puerto = PUERTO, timeout = TIMEOUT_TCP) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let hecho = false;
    const fin = (ok, causa) => { if (hecho) return; hecho = true; s.destroy(); resolve({ ok, causa }); };
    s.setTimeout(timeout);
    s.once('connect', () => fin(true, null));
    s.once('timeout', () => fin(false, 'sin respuesta (filtrado o equipo apagado)'));
    s.once('error', (e) => fin(false, e.code === 'ECONNREFUSED' ? 'conexión rechazada' : (e.code || e.message)));
    s.connect(puerto, ip);
  });
}

// ── Paso 3 · Handshake ZK crudo ──────────────────────────────────────
//
// NO se usa `createSocket()` de node-zklib para diagnosticar, a propósito: esa
// función da por buena CUALQUIER respuesta del reloj (zklibtcp.js línea ~57
// solo comprueba que `reply` no sea vacío). Con Comm Key configurada el equipo
// responde CMD_ACK_UNAUTH (2005) y la librería lo reporta como conexión
// EXITOSA; después todo lo demás falla y parece un problema de red.
//
// Aquí se lee el commandId de la respuesta, que es lo que separa "está ocupado"
// de "pide contraseña".
function handshake(ip, puerto = PUERTO, timeout = 4000) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let hecho = false;
    const fin = (r) => { if (hecho) return; hecho = true; s.destroy(); resolve(r); };
    s.setTimeout(timeout);
    s.once('timeout', () => fin({ ok: false, codigo: null, causa: 'el reloj aceptó el socket pero no contestó el saludo' }));
    s.once('error', (e) => fin({ ok: false, codigo: null, causa: e.code || e.message }));
    s.once('connect', () => {
      s.write(createTCPHeader(COMMANDS.CMD_CONNECT, 0, 0, ''));
    });
    s.once('data', (data) => {
      try {
        const h = decodeTCPHeader(data.subarray(0, 16));
        fin({ ok: h.commandId === COMMANDS.CMD_ACK_OK, codigo: h.commandId, sessionId: h.sessionId });
      } catch (e) { fin({ ok: false, codigo: null, causa: motivo(e) }); }
    });
    s.connect(puerto, ip);
  });
}

/** Lo que significa cada respuesta del saludo, en español y accionable. */
function explicarHandshake(h) {
  if (h.ok) return null;
  if (h.codigo === COMMANDS.CMD_ACK_UNAUTH) {
    return 'el reloj pide CONTRASEÑA DE COMUNICACIÓN (Comm Key). Ponla en relojes.comm_key ' +
           'o quítala en el equipo: Menú → Comunicación → Seguridad.';
  }
  if (h.codigo != null) return `el reloj respondió un comando inesperado (${h.codigo})`;
  return (h.causa || 'sin respuesta al saludo') +
         '. Lo más común: ya hay OTRA SESIÓN abierta (estos equipos aceptan una sola) — ' +
         'el software del proveedor conectado, o un socket colgado. Se libera solo en unos minutos, ' +
         'o reiniciando el equipo.';
}

// ── Pasos 4-6 · sesión completa ──────────────────────────────────────
async function inspeccionar(ip, esperado) {
  const r = {
    ip, sucursalEsperada: esperado?.suc || null, serieEsperada: esperado?.serie || null,
    ping: false, tcp: false, saludo: false,
    serie: null, logCounts: null, userCounts: null,
    horaReloj: null, horaServidor: null, desfaseSeg: null,
    paso: 0, ok: false, falla: null, aviso: null,
  };

  r.ping = await ping(ip);
  if (!r.ping) {
    // Se sigue de todos modos: hay redes que bloquean ICMP y dejan pasar TCP.
    r.aviso = 'no contesta ping (puede ser ICMP bloqueado)';
  }
  r.paso = 1;

  const tcp = await tcpAbierto(ip);
  r.tcp = tcp.ok;
  if (!tcp.ok) {
    r.falla = r.ping
      ? `el equipo está en red pero el puerto ${PUERTO} no acepta conexiones: ${tcp.causa}. ` +
        'Servicio del reloj caído, firewall, u OTRA SESIÓN ya abierta.'
      : `sin ruta a ${ip}: ${tcp.causa}. La subred no se alcanza desde aquí, o el equipo está apagado.`;
    return r;
  }
  r.paso = 2;

  const h = await handshake(ip);
  r.saludo = h.ok;
  if (!h.ok) { r.falla = explicarHandshake(h); return r; }
  r.paso = 3;

  let zk = null;
  try {
    zk = await conectar(ip, { puerto: PUERTO, timeoutMs: 10000, commKey: esperado?.commKey ?? esperado?.comm_key });
    const info = await zk.getInfo();
    r.logCounts = info.logCounts;
    r.userCounts = info.userCounts;
    r.paso = 4;

    try {
      const hr = await leerHoraReloj(zk);
      const ahora = new Date();
      r.horaReloj = hr.toISOString();
      r.horaServidor = ahora.toISOString();
      r.desfaseSeg = Math.round((hr.getTime() - ahora.getTime()) / 1000);
      r.paso = 5;
    } catch (e) { r.aviso = [r.aviso, `no se pudo leer la hora del reloj (${motivo(e)})`].filter(Boolean).join(' · '); }

    try { r.serie = await leerSerie(zk); r.paso = 6; }
    catch (e) { r.aviso = [r.aviso, `no se pudo leer la serie (${motivo(e)})`].filter(Boolean).join(' · '); }
  } catch (e) {
    r.falla = `el saludo pasó pero la sesión falló: ${motivo(e)}`;
    return r;
  } finally {
    await cerrar(zk);
  }

  // Paso 6 — identidad. Este es el que evita que las checadas de una plaza
  // entren bajo el nombre de otra.
  if (r.serieEsperada && r.serie && r.serie !== r.serieEsperada) {
    r.falla = `ESTA IP YA NO ES ESE RELOJ: el padrón espera la serie ${r.serieEsperada} y ` +
              `contesta ${r.serie}. Si se jala así, las checadas entran bajo la sucursal equivocada.`;
    return r;
  }

  const desfaseGrave = r.desfaseSeg != null && Math.abs(r.desfaseSeg) > DESFASE_GRAVE_SEG;
  if (desfaseGrave) {
    r.aviso = [r.aviso, `RELOJ DESFASADO ${r.desfaseSeg > 0 ? '+' : ''}${r.desfaseSeg}s contra el servidor: ` +
      'la tolerancia se está aplicando sobre una hora falsa y salen retardos que no existen'].filter(Boolean).join(' · ');
  }
  r.ok = true;
  return r;
}

// ── Barrido de una /24 ───────────────────────────────────────────────
function expandirRango(txt) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?(?:\/(\d+))?$/.exec(String(txt).trim());
  if (!m) throw new Error(`rango no entendido: "${txt}". Usa 192.168.40.0/24 o 192.168.40`);
  const bits = m[5] ? parseInt(m[5], 10) : 24;
  if (bits !== 24) throw new Error('solo se barren /24 (254 direcciones); las plazas están así.');
  const base = `${m[1]}.${m[2]}.${m[3]}`;
  return Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`);
}

async function barrer(rango) {
  const ips = expandirRango(rango);
  say(`\n🔎 Barriendo ${rango} — ${ips.length} direcciones, puerto ${PUERTO}…`);
  const CONCURRENCIA = 32;
  const abiertas = [];
  let siguiente = 0;
  await Promise.all(Array.from({ length: CONCURRENCIA }, async () => {
    while (siguiente < ips.length) {
      const ip = ips[siguiente++];
      const t = await tcpAbierto(ip, PUERTO, 800);
      if (t.ok) { abiertas.push(ip); say(`   · ${ip} abre el ${PUERTO}`); }
    }
  }));
  abiertas.sort();
  say(`   ${abiertas.length} equipo(s) con el ${PUERTO} abierto. Leyendo su identidad…`);

  const encontrados = [];
  for (const ip of abiertas) {
    let zk = null;
    const fila = { ip, serie: null, logCounts: null, userCounts: null, error: null };
    try {
      zk = await conectar(ip, { puerto: PUERTO, timeoutMs: 10000 });
      const info = await zk.getInfo();
      fila.logCounts = info.logCounts; fila.userCounts = info.userCounts;
      try { fila.serie = await leerSerie(zk); } catch { /* firmware viejo */ }
    } catch (e) { fila.error = motivo(e); }
    finally { await cerrar(zk); }
    encontrados.push(fila);
    say(`   ${ip}  serie=${fila.serie || '?'}  usuarios=${fila.userCounts ?? '?'}  checadas=${fila.logCounts ?? '?'}` +
        (fila.error ? `  ⚠ ${fila.error}` : ''));
  }
  return { rango, abiertas, encontrados };
}

// ── Padrón contra el que se compara ──────────────────────────────────
//
// De la API si hay credenciales del agente (ahí vive la tabla `relojes`, que es
// la fuente buena), y si no, de targets.json. El diagnóstico se corre en PCs de
// sucursal, y esas PCs NO deben tener el DATABASE_URL de producción.
async function cargarPadron() {
  const url = process.env.INGESTA_URL || process.env.API_URL || '';
  const token = process.env.INGESTA_TOKEN || '';
  if (url && token) {
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/checador/ingesta/relojes`, {
        headers: { 'X-Agente-Token': token },
      });
      if (res.ok) {
        const relojes = await res.json();
        say(`  (padrón tomado de la API: ${relojes.length} relojes)`);
        return relojes.map((r) => ({
          ip: r.ip, suc: r.sucursalId, serie: r.serie, commKey: r.commKey,
          pendiente: !r.activo || r.pendiente, nota: r.nota,
        }));
      }
      say(`  (la API contestó ${res.status} al pedir el padrón; se usa targets.json)`);
    } catch (e) { say(`  (no se pudo leer el padrón de la API: ${motivo(e)}; se usa targets.json)`); }
  }
  return require('./targets.json').filter((t) => t && typeof t.ip === 'string' && t.ip.trim());
}

// ── Salida ───────────────────────────────────────────────────────────
const PASOS = ['—', 'ping', 'puerto 4370', 'saludo ZK', 'getInfo', 'hora', 'identidad'];

function tabla(filas) {
  const col = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
  console.log('');
  console.log(col('IP', 16) + col('SUCURSAL', 24) + col('LLEGÓ A', 12) + col('SERIE', 18) + col('CHECADAS', 10) + 'DESFASE');
  console.log('─'.repeat(96));
  for (const r of filas) {
    const icono = r.ok ? (r.aviso ? '🟡' : '🟢') : '🔴';
    const desfase = r.desfaseSeg == null ? '—'
      : `${r.desfaseSeg > 0 ? '+' : ''}${r.desfaseSeg}s${Math.abs(r.desfaseSeg) > DESFASE_GRAVE_SEG ? ' ⚠' : ''}`;
    console.log(
      icono + ' ' + col(r.ip, 14) + col(r.sucursalEsperada || '—', 24) +
      col(PASOS[r.paso] || r.paso, 12) + col(r.serie || '—', 18) +
      col(r.logCounts ?? '—', 10) + desfase);
    if (r.falla) console.log(`     ↳ ${r.falla}`);
    if (r.aviso) console.log(`     ↳ ⚠ ${r.aviso}`);
  }
}

(async () => {
  if (valor('--barrer')) {
    const r = await barrer(valor('--barrer'));
    if (JSON_OUT) console.log(JSON.stringify(r, null, 2));
    return;
  }

  const padron = await cargarPadron();
  const soloIp = valor('--ip');
  const objetivos = soloIp
    ? [padron.find((t) => t.ip === soloIp) || { ip: soloIp, suc: null }]
    : (flag('--incluir-pendientes') ? padron : padron.filter((t) => !t.pendiente));

  say(`\n──── Diagnóstico de red · ${new Date().toLocaleString('es-MX')} · ${objetivos.length} reloj(es) ────`);

  const filas = [];
  for (const t of objetivos) {
    say(`\n  ${t.suc || '(sin sucursal)'} — ${t.ip}`);
    const r = await inspeccionar(t.ip, t);
    filas.push(r);
    say(`    llegó al paso ${r.paso} (${PASOS[r.paso]})${r.ok ? ' ✅' : ' ❌'}`);
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ hora: new Date().toISOString(), puerto: PUERTO, relojes: filas }, null, 2));
    return;
  }

  tabla(filas);

  const ok = filas.filter((f) => f.ok).length;
  const desfasados = filas.filter((f) => f.desfaseSeg != null && Math.abs(f.desfaseSeg) > DESFASE_GRAVE_SEG);
  console.log('');
  console.log(`  ${ok} de ${filas.length} relojes contestaron completo.`);
  if (desfasados.length) {
    console.log(`  ⚠ ${desfasados.length} con la hora corrida más de ${DESFASE_GRAVE_SEG}s: ` +
                `${desfasados.map((d) => d.sucursalEsperada || d.ip).join(', ')}.`);
    console.log('    Eso produce retardos que no existen. Se corrige en el equipo, no en el sistema.');
  }
  console.log('  Guarda la evidencia con:  node tools/diagnostico-red.js --json > diagnostico.json');
})().catch((e) => { console.error(motivo(e)); process.exit(1); });
