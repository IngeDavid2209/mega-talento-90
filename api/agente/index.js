// api/agente/index.js
//
// AGENTE LOCAL DE CHECADAS · el servicio que corre DENTRO de la plaza.
//
// Sustituye a `jalar-en-vivo.bat` (una ventana de consola abierta que jalaba el
// log completo de cada reloj cada 5 minutos). Diferencias que importan:
//
//   · Tiempo real: el reloj EMPUJA cada checada al momento, no se sondea.
//   · Cola local: un corte de internet no cuesta checadas.
//   · Identidad por SERIE: si el DHCP le mueve la IP a un reloj, lo reencuentra.
//   · SIN DATABASE_URL: esta PC ya no tiene las credenciales de producción.
//   · Servicio de Windows: sobrevive al cierre de sesión y al reinicio.
//
// ⚠️ Sigue teniendo que correr en una PC de la MISMA RED (LAN) que los relojes.
// Las IPs son privadas; desde Railway no hay ruta y no existe VPN entre plazas.
//
// Uso:
//   node index.js                 (servicio: se queda corriendo)
//   node index.js --una-vez       (una pasada de backfill y sale; para probar)

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Cola } = require('./cola');
const { Enviador, VERSION } = require('./enviar');
const { RelojJob } = require('./reloj');
const { SincronizadorHr } = require('./origen-hr');
const { motivo } = require('../tools/lectura-verificada');

const ARGS = process.argv.slice(2);
const UNA_VEZ = ARGS.includes('--una-vez');

// ── Log ──────────────────────────────────────────────────────────────
// A archivo con rotación diaria además de a consola: cuando corre como
// servicio de Windows no hay ventana donde mirar, y un agente sin log es un
// agente del que no se puede decir si funcionó.
const DIR_LOGS = path.join(__dirname, 'logs');
fs.mkdirSync(DIR_LOGS, { recursive: true });

function log(...partes) {
  const linea = `${new Date().toISOString()} ${partes.join(' ')}`;
  console.log(linea);
  try {
    fs.appendFileSync(path.join(DIR_LOGS, `agente-${new Date().toISOString().slice(0, 10)}.log`), linea + '\n');
  } catch { /* si no se puede escribir el log, no se detiene el agente */ }
}

/** Borra los logs de más de 30 días para que la carpeta no crezca sin fin. */
function limpiarLogs() {
  const corte = Date.now() - 30 * 86400000;
  for (const f of fs.readdirSync(DIR_LOGS)) {
    const ruta = path.join(DIR_LOGS, f);
    try { if (fs.statSync(ruta).mtimeMs < corte) fs.unlinkSync(ruta); } catch { /* en uso */ }
  }
}

// ── Configuración ────────────────────────────────────────────────────
function cargarConfig() {
  const ruta = path.join(__dirname, 'config.json');
  if (!fs.existsSync(ruta)) {
    console.error('\nFalta api/agente/config.json.');
    console.error('Copia config.ejemplo.json a config.json y pon apiUrl + token.\n');
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(ruta, 'utf8'));
  if (!cfg.apiUrl || !cfg.token) {
    console.error('\nconfig.json necesita `apiUrl` y `token`.\n');
    process.exit(1);
  }
  cfg.intervalos = {
    backfillMin: 60,      // NO 5: bajar el log completo de 8 relojes no cierra en 5 min
    keepaliveSeg: 45,     // los ZK cierran la sesión inactiva
    agrupaSeg: 5,         // espera antes de mandar, para agrupar el cambio de turno
    padronMin: 30,        // cada cuánto se relee el padrón de la API
    // ── modo origen 'hr' ──
    pollSeg: 30,          // el "trigger": cada cuánto se busca lo nuevo
    traslapeMin: 10,      // cuánto se retrocede en cada vuelta
    reconciliarMin: 60,   // cada cuánto se hace la pasada amplia
    reconciliarDias: 7,   // qué tan atrás llega esa pasada
    ...(cfg.intervalos || {}),
  };
  // El origen puede ser los relojes por TCP ('relojes') o la base del sistema
  // del proveedor ('hr'). En Mega Dulces es 'hr': los 10 equipos rechazan
  // nuestro saludo con CMD_ACK_UNAUTH porque ese sistema ya tiene la sesión.
  cfg.origen = cfg.origen || (cfg.hrDbUrl ? 'hr' : 'relojes');
  return cfg;
}

/**
 * Qué relojes le tocan a este agente.
 *
 * La lista viene de la API, no del config: así dar de alta un reloj o cambiarle
 * la sucursal es trabajo de RH en el portal, y no de alguien entrando por
 * escritorio remoto a la PC de la plaza a editar un JSON.
 *
 * `config.relojes` sirve solo para acotar (por serie) cuáles de todos le tocan
 * a ESTA máquina, que es lo normal: cada plaza ve su propio reloj.
 */
async function relojesDeEsteAgente(cfg, enviador) {
  const padron = await enviador.padron(cfg.sucursalId);
  const soloEstos = Array.isArray(cfg.relojes) && cfg.relojes.length
    ? new Set(cfg.relojes.map((r) => (typeof r === 'string' ? r : r.serie)).filter(Boolean))
    : null;

  const fuera = padron.filter((r) => r.pendiente).map((r) => `${r.alias || r.serie}`);
  if (fuera.length) {
    log(`⏸ Fuera por estar en pausa (sin identificar o sin traducir su numeración): ${fuera.join(', ')}`);
  }

  return padron.filter((r) => {
    if (r.modo !== 'agente') return false;            // los 'push' hablan solos por /iclock
    if (r.pendiente) return false;                    // sin identificar/mapear: NO se jalan
    if (soloEstos && !soloEstos.has(r.serie)) return false;
    return true;
  }).map((r) => {
    // La IP del config manda sobre la del padrón solo si el padrón no trae
    // ninguna: el descubrimiento por serie corrige el resto.
    const local = (cfg.relojes || []).find((x) => typeof x === 'object' && x.serie === r.serie);
    return { ...r, ip: r.ip || local?.ip || null, commKey: r.commKey ?? local?.commKey };
  });
}

// ── Arranque ─────────────────────────────────────────────────────────
(async () => {
  const cfg = cargarConfig();
  limpiarLogs();

  log(`──── Agente de checadas ${VERSION} · ${os.hostname()} ────`);
  log(`API: ${cfg.apiUrl}`);

  const cola = new Cola(cfg.colaDb);
  const enviador = new Enviador(cfg, log);

  let relojes = [];
  try {
    relojes = await relojesDeEsteAgente(cfg, enviador);
  } catch (e) {
    log(`❌ No se pudo leer el padrón: ${motivo(e)}`);
    log('   Revisa apiUrl/token, y que el reloj esté dado de alta (tools/registrar-relojes.js).');
    process.exit(1);
  }

  if (!relojes.length) {
    log('⚠ Este agente no tiene relojes asignados.');
    log('  Comprueba que el padrón tenga relojes con modo=agente, activo=true y pendiente=false,');
    log('  y que `sucursalId`/`relojes` del config no estén filtrando de más.');
    process.exit(1);
  }

  log(`Relojes a cargo: ${relojes.map((r) => `${r.alias || r.sucursalId} (${r.serie})`).join(', ')}`);

  // ══════════════════════════════════════════════════════════════════
  // ORIGEN 'hr' — se lee la base del sistema del proveedor, no los relojes.
  //
  // Es lo que aplica en Mega Dulces: los 10 equipos rechazan nuestro saludo
  // (CMD_ACK_UNAUTH) porque ese sistema ya tiene la única sesión que aceptan.
  // Pelearle el socket haría que los dos leyeran a medias.
  // ══════════════════════════════════════════════════════════════════
  if (cfg.origen === 'hr') {
    if (!cfg.hrDbUrl) {
      log('❌ origen="hr" pero falta `hrDbUrl` en config.json.');
      process.exit(1);
    }
    const sinc = new SincronizadorHr(cfg, { cola, enviador, log });

    if (UNA_VEZ) {
      await sinc.arrancar(relojes);
      await sinc.detener();
      log(`Cola: ${JSON.stringify(cola.estado())}`);
      cola.cerrar();
      return;
    }

    await sinc.arrancar(relojes);
    programarMantenimiento(cola);
    prepararApagado(cola, [sinc]);
    return;
  }

  const trabajos = relojes.map((r) => new RelojJob(r, { cola, enviador, intervalos: cfg.intervalos, log }));

  // ── Modo prueba: una pasada y salir ───────────────────────────────
  if (UNA_VEZ) {
    for (const t of trabajos) {
      t.corriendo = true;
      await t.backfill();
      await t.detener();
    }
    log(`Cola: ${JSON.stringify(cola.estado())}`);
    cola.cerrar();
    return;
  }

  // ── Servicio ──────────────────────────────────────────────────────
  // Los backfills se reparten a lo largo del intervalo para no pegarle a todos
  // los relojes al mismo tiempo.
  const paso = (cfg.intervalos.backfillMin * 60000) / Math.max(trabajos.length, 1);
  for (let i = 0; i < trabajos.length; i++) {
    // El primero arranca casi de inmediato: al levantar el servicio hay que
    // recuperar lo que se haya perdido mientras estuvo apagado.
    await trabajos[i].arrancar(i === 0 ? 3000 : Math.round(paso * i));
  }

  // Lo que quedó en la cola de una corrida anterior sale ahora. Este es el
  // caso de "matar el agente 30 min y levantarlo": lo pendiente se reenvía y
  // el backfill recupera lo que el stream no vio.
  for (const serie of cola.seriesPendientes()) {
    const t = trabajos.find((x) => x.reloj.serie === serie);
    if (t) t.programarEnvio();
    else log(`⚠ hay ${serie} pendiente en la cola pero ese reloj ya no le toca a este agente.`);
  }

  programarMantenimiento(cola);
  prepararApagado(cola, trabajos);
})().catch((e) => { console.error(motivo(e)); process.exit(1); });

/** Mantenimiento periódico de la cola + aviso si dejó de vaciarse. */
function programarMantenimiento(cola) {
  setInterval(() => {
    const borradas = cola.limpiar();
    limpiarLogs();
    const e = cola.estado();
    log(`mantenimiento: ${borradas} enviadas viejas borradas · ${e.sinEnviar} sin enviar · ${e.total} en total`);
    if (e.alerta) {
      log(`⚠ la cola pasó de ${e.alerta} filas. O la API lleva días sin recibir, o algo no confirma los envíos.`);
    }
  }, 6 * 60 * 60 * 1000);
}

/** Cierre limpio + red de seguridad contra errores sueltos. */
function prepararApagado(cola, trabajos) {
  const apagar = async (senal) => {
    log(`\nCerrando (${senal})…`);
    await Promise.all(trabajos.map((t) => t.detener()));
    cola.cerrar();
    process.exit(0);
  };
  process.on('SIGINT', () => apagar('SIGINT'));
  process.on('SIGTERM', () => apagar('SIGTERM'));

  // Un error no atrapado NO debe tumbar el agente: la plaza se quedaría sin
  // checadas hasta que alguien lo notara. Se registra y se sigue; el servicio
  // de Windows reinicia si de plano el proceso muere.
  process.on('unhandledRejection', (e) => log(`⚠ promesa sin atrapar: ${motivo(e)}`));
  process.on('uncaughtException', (e) => log(`⚠ excepción sin atrapar: ${motivo(e)}`));
}
