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
    vigilanciaMin: 30,    // sin que la API acepte NADA en este rato, el agente se reinicia solo
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
 * COPIA LOCAL DEL PADRÓN — para que un corte de internet no deje a la plaza sin
 * recoger checadas.
 *
 * El padrón vive en la API a propósito (ver `relojesDeEsteAgente`). Pero eso
 * ataba el arranque a que hubiera internet EN ESE INSTANTE, y los relojes están
 * en la LAN: sin nube se les puede seguir leyendo perfectamente, y lo leído se
 * va encolando en SQLite hasta que el enlace vuelva. Quedarse sin arrancar por
 * no poder consultar una lista que casi nunca cambia es tirar checadas que sí se
 * podían haber recogido.
 */
const RUTA_PADRON = path.join(__dirname, 'padron.json');

function guardarPadron(relojes) {
  try { fs.writeFileSync(RUTA_PADRON, JSON.stringify(relojes, null, 2)); }
  catch { /* si no se puede escribir, se sigue: es una caché, no la verdad */ }
}

function padronGuardado() {
  try {
    const r = JSON.parse(fs.readFileSync(RUTA_PADRON, 'utf8'));
    return Array.isArray(r) ? r : null;
  } catch { return null; }
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

/**
 * El padrón, insistiendo hasta conseguirlo. NO se sale.
 *
 * Antes, cualquiera de estos dos casos terminaba en `process.exit(1)`:
 *   · la API no contestó (internet intermitente al prender la PC en la mañana,
 *     Railway reiniciando, DNS todavía sin resolver);
 *   · el padrón llegó vacío.
 *
 * Y salirse es la peor reacción posible, porque node-windows reinicia como mucho
 * 3 veces en 60 s (`maxRestarts`) y luego SE RINDE. Un parpadeo de red de dos
 * minutos al arrancar la PC bastaba para dejar el servicio en "Detenido" hasta
 * que alguien lo notara — y como el proceso ya no existe, tampoco hay latidos,
 * así que del lado del portal se ve idéntico a diez relojes descompuestos.
 *
 * Ahora: si la API no contesta se arranca con la copia local y se sigue
 * recogiendo checadas a la cola; si tampoco hay copia, se espera y se reintenta.
 */
async function padronConEspera(cfg, enviador) {
  const ESPERAS = [10000, 30000, 60000, 120000, 300000];
  for (let intento = 0; ; intento++) {
    try {
      const relojes = await relojesDeEsteAgente(cfg, enviador);
      if (relojes.length) { guardarPadron(relojes); return relojes; }
      log('⚠ Este agente no tiene relojes asignados.');
      log('  Comprueba que el padrón tenga relojes con modo=agente, activo=true y pendiente=false,');
      log('  y que `sucursalId`/`relojes` del config no estén filtrando de más.');
    } catch (e) {
      log(`❌ No se pudo leer el padrón: ${motivo(e)}`);
      log('   Revisa apiUrl/token, y que el reloj esté dado de alta (tools/registrar-relojes.js).');
      const copia = padronGuardado();
      if (copia && copia.length) {
        log(`   Se arranca con la copia local del padrón (${copia.length} reloj(es)).`);
        log('   Los relojes están en la LAN: se les sigue leyendo y lo leído espera en la cola.');
        return copia;
      }
    }
    // En modo prueba sí se sale: quien lo corre a mano está esperando el
    // resultado en la consola, no que se quede insistiendo.
    if (UNA_VEZ) process.exit(1);
    const ms = ESPERAS[Math.min(intento, ESPERAS.length - 1)];
    log(`   Reintentando en ${Math.round(ms / 1000)} s (el servicio NO se sale).`);
    await new Promise((r) => setTimeout(r, ms));
  }
}

// ── Arranque ─────────────────────────────────────────────────────────
(async () => {
  const cfg = cargarConfig();
  limpiarLogs();

  log(`──── Agente de checadas ${VERSION} · ${os.hostname()} ────`);
  log(`API: ${cfg.apiUrl}`);

  const cola = new Cola(cfg.colaDb);
  const enviador = new Enviador(cfg, log);

  const relojes = await padronConEspera(cfg, enviador);

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
    const sinc = new SincronizadorHr(cfg, {
      cola, enviador, log,
      // Se le pasa CÓMO releer el padrón, no la lista: así un reloj que RH saca
      // de pausa entra solo, sin que nadie tenga que reiniciar el servicio en
      // la PC de la plaza.
      cargarRelojes: () => relojesDeEsteAgente(cfg, enviador),
    });

    if (UNA_VEZ) {
      await sinc.arrancar(relojes);
      await sinc.detener();
      log(`Cola: ${JSON.stringify(cola.estado())}`);
      cola.cerrar();
      return;
    }

    await sinc.arrancar(relojes);
    // Este camino ya relee el padrón solo (`cargarRelojes`), pero se traba igual
    // de callado que el otro: el vigilante global aplica a los dos.
    programarVigilanciaGlobal(enviador, cfg);
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

  programarPadron(cfg, enviador, cola, trabajos);
  programarVigilanciaGlobal(enviador, cfg);
  programarMantenimiento(cola);
  prepararApagado(cola, trabajos);
})().catch((e) => { console.error(motivo(e)); process.exit(1); });

/**
 * RELEER EL PADRÓN CADA `padronMin` — dar de alta un reloj no debe requerir
 * reiniciar un servicio en otra PC.
 *
 * `config.intervalos.padronMin` existía desde el principio y estaba comentado
 * como "cada cuánto se relee el padrón de la API", pero solo lo usaba el camino
 * `origen: 'hr'` (que sí recibe un `cargarRelojes`). En el camino de siempre
 * —`origen: 'relojes'`, el que corre en Mega Dulces— la lista se leía UNA vez al
 * arrancar y nunca más.
 *
 * Lo que costó: Sucursal PH se dio de alta el 20/08/2026 y Morelia Abastos el
 * 21/08, las dos verificadas y alcanzables (29,573 y 22,886 checadas leídas al
 * darlas de alta), con 69 y 82 empleados activos esperando. El agente llevaba
 * corriendo desde antes, así que nunca se enteró de que existían: cinco días en
 * rojo que no eran culpa de los equipos ni de la red, sino de que nadie reinició
 * el servicio. Marcar esos relojes como inactivos —que fue la primera idea—
 * habría escondido el síntoma y dejado a dos plazas sin asistencia.
 */
function programarPadron(cfg, enviador, cola, trabajos) {
  setInterval(async () => {
    let padron;
    try {
      padron = await relojesDeEsteAgente(cfg, enviador);
    } catch (e) {
      log(`padrón: no se pudo releer (${motivo(e)}); se sigue con los ${trabajos.length} de siempre.`);
      return;
    }
    // Un padrón vacío NO se obedece. Puede ser un despliegue a medias o una
    // respuesta rara, y soltar los relojes por eso dejaría la plaza sin recoger
    // nada. El arranque sí exige lista; una relectura, no.
    if (!padron.length) {
      log('padrón: llegó vacío. Se ignora y se sigue con los relojes actuales.');
      return;
    }
    guardarPadron(padron);

    const porSerie = new Map(padron.map((r) => [r.serie, r]));

    // ── Bajas: dados de baja, puestos en pausa, o movidos a otro agente ──
    for (const t of [...trabajos]) {
      if (porSerie.has(t.reloj.serie)) continue;
      log(`padrón: ${t.etiqueta} ya no le toca a este agente (baja, pausa o cambio de plaza). Se suelta.`);
      trabajos.splice(trabajos.indexOf(t), 1);
      await t.detener();
    }

    // ── Cambios en los que siguen ────────────────────────────────────
    for (const t of trabajos) {
      const r = porSerie.get(t.reloj.serie);
      if (r.alias) t.reloj.alias = r.alias;
      if (r.sucursalId) t.reloj.sucursalId = r.sucursalId;
      if (r.commKey != null) t.reloj.commKey = r.commKey;
      // La IP a propósito NO se pisa: si este agente ya encontró el equipo en
      // otra dirección, la suya es la buena y el padrón es el que va atrasado
      // (la API lo corrige sola con el siguiente lote). `descubrir()` se
      // encarga del caso contrario.
    }

    // ── Altas ────────────────────────────────────────────────────────
    const nuevos = padron.filter((r) => !trabajos.some((t) => t.reloj.serie === r.serie));
    for (let i = 0; i < nuevos.length; i++) {
      const r = nuevos[i];
      log(`padrón: ALTA de ${r.alias || r.serie} (${r.sucursalId}). Arrancando…`);
      const t = new RelojJob(r, { cola, enviador, intervalos: cfg.intervalos, log });
      trabajos.push(t);
      // Escalonados por la misma razón que en el arranque: si entran tres
      // relojes juntos, tres backfills completos a la vez saturan el enlace.
      await t.arrancar(3000 + i * 60000);
    }
  }, cfg.intervalos.padronMin * 60000);
}

/**
 * VIGILANTE GLOBAL — el agente TRABADO se ve igual que el sano.
 *
 * Un proceso que sigue vivo pero ya no le entrega nada a la API es el peor de
 * los casos: `Get-Service` dice "Running", el log no escribe una línea de error,
 * y Windows no tiene por qué reiniciar nada. Del lado del portal se ve como toda
 * la empresa en rojo, y RH acaba suponiendo faltas que no existen.
 *
 * Con el latido periódico del vigía (cada 5 min por reloj), media hora sin que
 * la API acepte UNA sola petición no tiene lectura inocente. Salirse con código
 * de error es lo único que hace que el servicio lo levante otra vez.
 *
 * Nada se pierde al reiniciar: la cola es SQLite en modo WAL y el backfill de
 * arranque recupera lo que el vigía no alcanzó a ver.
 */
function programarVigilanciaGlobal(enviador, cfg) {
  const limiteMs = (cfg.intervalos.vigilanciaMin || 30) * 60000;
  // Se revisa seguido pero nunca más de una vez por minuto: es una resta.
  const cadaMs = Math.max(1000, Math.min(60000, Math.round(limiteMs / 3)));
  setInterval(() => {
    const quieto = Date.now() - enviador.ultimoOk;
    if (quieto < limiteMs) return;
    log(`❌ ${Math.round(quieto / 60000)} min sin que la API acepte una sola petición de este agente.`);
    log('   El proceso sigue vivo, así que Windows no lo levantaría solo. Se sale con error A PROPÓSITO');
    log('   para que el servicio lo reinicie. La cola guarda lo pendiente y el backfill cierra el hueco.');
    process.exit(1);
  }, cadaMs);
}

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

  // Cierre ORDENADO pedido por el servicio de Windows.
  //
  // Cuando node-windows corre con `stopparentfirst`, el wrapper NO mata el
  // proceso: le manda un mensaje 'shutdown' por IPC y espera que se cierre solo
  // (lib/wrapper.js:190). Sin este escucha, ese mensaje cae en el vacío, el
  // proceso sigue vivo y el servicio se queda en "Deteniendo" hasta que alguien
  // lo mata a mano. Pasó el 17/08/2026 al reiniciar el agente.
  process.on('message', (m) => {
    if (m === 'shutdown') apagar('shutdown del servicio');
  });

  // Un error no atrapado NO debe tumbar el agente: la plaza se quedaría sin
  // checadas hasta que alguien lo notara. Se registra y se sigue; el servicio
  // de Windows reinicia si de plano el proceso muere.
  process.on('unhandledRejection', (e) => log(`⚠ promesa sin atrapar: ${motivo(e)}`));
  process.on('uncaughtException', (e) => log(`⚠ excepción sin atrapar: ${motivo(e)}`));
}
