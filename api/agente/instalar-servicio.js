// api/agente/instalar-servicio.js
//
// INSTALA EL AGENTE COMO SERVICIO DE WINDOWS.
//
// Por qué un servicio y no la tarea programada del `.bat`:
//   · Arranca solo cuando prende la PC, sin que nadie inicie sesión.
//   · Sobrevive al cierre de sesión (la tarea programada del .bat NO: en cuanto
//     alguien cerraba sesión en la PC de la plaza, la asistencia dejaba de
//     actualizarse y nadie se enteraba).
//   · Si el proceso muere, Windows lo levanta otra vez.
//
// Uso (en una consola de ADMINISTRADOR, dentro de api/agente):
//   node instalar-servicio.js instalar
//   node instalar-servicio.js quitar
//
// Si `node-windows` no se pudo instalar en esa máquina, abajo están las
// instrucciones equivalentes con NSSM.

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// Sin acentos ni signos raros A PROPÓSITO. node-windows deriva el id del
// servicio de aquí (`name.replace(/[^\w]/gi,'')`) y además usa el nombre para
// los archivos de log de winsw; un carácter no ASCII ahí depende de la página
// de códigos de la consola y se rompe en unas máquinas sí y en otras no.
const NOMBRE = 'Mega Talento Agente de Checadas';
const accion = (process.argv[2] || '').toLowerCase();

if (!['instalar', 'quitar', 'revisar'].includes(accion)) {
  console.log('Uso: node instalar-servicio.js instalar | quitar | revisar');
  process.exit(1);
}

if (process.platform !== 'win32') {
  console.error('Este instalador es para Windows. En Linux usa systemd.');
  process.exit(1);
}

if (!fs.existsSync(path.join(__dirname, 'config.json'))) {
  console.error('\nFalta config.json. Cópialo de config.ejemplo.json y llénalo ANTES de instalar el servicio.\n');
  process.exit(1);
}

let Service;
try {
  ({ Service } = require('node-windows'));
} catch {
  console.error('\nNo está node-windows. Opciones:\n');
  console.error('  1) npm install node-windows   (dentro de api/agente, como administrador)\n');
  console.error('  2) Con NSSM (https://nssm.cc), en una consola de administrador:\n');
  console.error(`       nssm install "MegaTalentoAgente" "${process.execPath}" "${path.join(__dirname, 'index.js')}"`);
  console.error(`       nssm set "MegaTalentoAgente" AppDirectory "${__dirname}"`);
  console.error('       nssm set "MegaTalentoAgente" Start SERVICE_AUTO_START');
  console.error('       nssm set "MegaTalentoAgente" AppExit Default Restart');
  console.error('       nssm start "MegaTalentoAgente"\n');
  process.exit(1);
}

const servicio = new Service({
  name: NOMBRE,
  description: 'Lee las checadas de los relojes de esta plaza y las empuja a Mega Talento 90. ' +
               'Debe correr en una PC de la misma red que los relojes.',
  script: path.join(__dirname, 'index.js'),
  nodeOptions: [],
  // Reinicio automático: si el proceso muere, vuelve en 5 s. Sin esto, un error
  // a las 3 de la mañana deja a la plaza sin datos hasta que alguien lo note al
  // día siguiente.
  wait: 5,
  grow: 0.25,

  // ══ POR QUÉ 60 Y NO 3 ══════════════════════════════════════════════
  //
  // `maxRestarts` es cuántas veces node-windows reintenta dentro de una ventana
  // de 60 s ANTES DE RENDIRSE PARA SIEMPRE (lib/wrapper.js). Con 3, cualquier
  // fallo que durara más de unos segundos al arrancar —la PC prende y todavía no
  // hay DNS, el switch tarda en dar enlace, Railway reiniciando— gastaba los
  // tres intentos en menos de un minuto y el servicio quedaba "Detenido" hasta
  // que un humano lo notara. Que es justo lo que este módulo lleva meses
  // tratando de que no vuelva a pasar.
  //
  // El riesgo que `maxRestarts` bajo pretende cubrir —dar vueltas reiniciando un
  // proceso que no puede arrancar— ya no aplica: `padronConEspera` no se sale
  // cuando la API no contesta, arranca con la copia local del padrón y sigue
  // recogiendo checadas a la cola. Hoy el agente solo se sale si de verdad no
  // puede trabajar, y en ese caso insistir es lo correcto.
  maxRestarts: 60,

  // ══ POR QUÉ SE PASA logOnAs EXPLÍCITO ══════════════════════════════
  //
  // Sin esta línea el servicio se instala y NUNCA arranca: queda en
  // "Detenido" con arranque automático y sin escribir un solo log, que es de
  // los fallos más difíciles de leer porque no deja rastro.
  //
  // node-windows siempre escribe un bloque <serviceaccount> en el XML de winsw
  // (lib/winsw.js ~124) y por omisión pone como dominio el NOMBRE DE LA PC:
  //
  //     <domain>DAVID-CISNEROS</domain>
  //     <user>LocalSystem</user>
  //
  // Windows entiende eso como la cuenta `DAVID-CISNEROS\LocalSystem`, que no
  // existe. El inicio de sesión falla antes de que winsw llegue siquiera a
  // crear su log. La cuenta de verdad es `NT AUTHORITY\LocalSystem`.
  logOnAs: { domain: 'NT AUTHORITY', account: 'LocalSystem', password: '' },

  // ══ CUIDADO CON ESTE VALOR: DECIDE CÓMO SE DETIENE EL SERVICIO ══════
  //
  // node-windows SIEMPRE mete `--stopparentfirst <valor>` en el XML, así que no
  // se puede simplemente omitir. Y el wrapper lo lee como booleano crudo
  // (lib/wrapper.js:190):
  //
  //     if (argv.s) { child.send('shutdown') } else { child.kill() }
  //
  // Con CUALQUIER texto ahí —'true', 'false', 'no', 'undefined'— la condición es
  // verdadera, porque una cadena no vacía es truthy. Entonces el wrapper deja de
  // matar el proceso y le PIDE por mensaje que se cierre solo. Si el agente no
  // escucha ese mensaje, nunca se entera: el servicio se queda en "Deteniendo"
  // para siempre y hay que matarlo a mano (pasó el 17/08/2026 al reiniciar).
  //
  // La cadena vacía es el único valor que sale falsy y devuelve el camino
  // confiable, `child.kill()`. Matar de golpe es seguro aquí: la cola es SQLite
  // en modo WAL, justamente para que un corte brusco no la corrompa.
  //
  // Aparte, index.js sí escucha 'shutdown' — así que si alguien enciende esta
  // opción, el cierre ordenado también funciona.
  stopparentfirst: '',
});

/** El id que node-windows deriva del nombre, y dónde deja el XML de winsw. */
const ID = NOMBRE.replace(/[^\w]/gi, '').toLowerCase();
const XML = path.join(__dirname, 'daemon', `${ID}.xml`);

/**
 * Lo que Windows REALMENTE registró, que no siempre es lo que dice el XML.
 *
 * `sc qc` devuelve la cuenta con la que arranca el servicio (SERVICE_START_NAME)
 * y `sc query` si está corriendo. Se prefiere esto al XML porque el XML es lo
 * que winsw PIDIÓ y esto es lo que Windows CONCEDIÓ — y en la cuenta,
 * justamente, no coinciden. Si el servicio no existe, devuelve null.
 */
function estadoReal() {
  try {
    const qc = execSync(`sc qc "${ID}.exe"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const cuenta = (/SERVICE_START_NAME\s*:\s*(.+)/.exec(qc)?.[1] || '').trim();
    let estado = '';
    try {
      const q = execSync(`sc query "${ID}.exe"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      estado = (/STATE\s*:\s*\d+\s+(\w+)/.exec(q)?.[1] || '').trim();
    } catch { /* existe pero no se pudo consultar el estado */ }
    return { cuenta, estado };
  } catch { return null; }
}

/**
 * REVISA LO QUE QUEDÓ, en vez de confiar en que "instalar" dijo que sí.
 *
 * `servicio.start()` avisa que arrancó aunque el servicio se haya caído medio
 * segundo después: node-windows solo lanza el comando, no comprueba el estado.
 * Así fue como la primera instalación quedó en "Detenido, arranque automático,
 * cero logs" mientras la consola decía "▶️ Servicio arrancado".
 *
 * ══ POR QUÉ SE LE PREGUNTA A WINDOWS Y NO SOLO AL XML ══
 *
 * Esto antes daba por rota cualquier instalación cuyo XML tuviera el nombre de
 * la PC en `<domain>`, y mandaba a reinstalar. Dos problemas: reinstalar
 * **reproduce** el mismo XML —node-windows ignora el `logOnAs` que se le pasa y
 * vuelve a escribir el nombre del equipo—, y sobre todo **la premisa era
 * falsa**. El 25/08/2026 se instaló aquí con `<domain>LAPSISTEMASA</domain>` y
 * Windows registró `SERVICE_START_NAME: LocalSystem`, con el servicio Running:
 * winsw no usa el dominio cuando la cuenta es `LocalSystem`.
 *
 * O sea que el aviso mandaba a perseguir un problema inexistente, en la
 * pantalla cuyo único trabajo es decir si el servicio va a levantar. Ahora se
 * consulta la cuenta de verdad (`sc qc`) y solo se reporta si ESA está mal.
 */
function revisar() {
  if (!fs.existsSync(XML)) {
    console.log(`No hay servicio instalado (falta ${XML}).`);
    return false;
  }
  const xml = fs.readFileSync(XML, 'utf8');
  const problemas = [];

  // Las cuentas de sistema que SÍ sirven. Windows acepta `LocalSystem` a secas
  // como sinónimo de `NT AUTHORITY\LocalSystem`.
  const CUENTAS_OK = ['localsystem', 'nt authority\\localsystem',
                      'nt authority\\localservice', 'nt authority\\networkservice'];
  const real = estadoReal();
  if (real && real.cuenta && !CUENTAS_OK.includes(real.cuenta.toLowerCase())) {
    problemas.push(
      `Windows lo va a arrancar como "${real.cuenta}". Si esa cuenta no existe o no tiene ` +
      'permisos, el servicio se instala y nunca arranca, sin dejar log. Tiene que ser ' +
      '"LocalSystem". Se corrige sin reinstalar:\n' +
      `       sc config "${ID}.exe" obj= "LocalSystem"`);
  }
  if (/<argument>undefined<\/argument>/.test(xml)) {
    problemas.push('hay un argumento literal "undefined" en el XML.');
  }
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(/<name>([^<]*)<\/name>/.exec(xml)?.[1] || '')) {
    problemas.push('el nombre del servicio tiene caracteres no ASCII: winsw los usa para nombrar sus logs.');
  }
  if (!fs.existsSync(path.join(__dirname, 'config.json'))) {
    problemas.push('falta config.json: el agente arrancará y se saldrá de inmediato.');
  }

  console.log(`\nServicio: ${NOMBRE}`);
  console.log(`  XML:    ${XML}`);
  console.log(`  Cuenta: ${real ? real.cuenta : '(no está registrado en Windows)'}`);
  if (real && real.estado) console.log(`  Estado: ${real.estado}`);
  if (!problemas.length) {
    console.log('  ✅ La configuración se ve bien.');
    // Y ahora la pregunta que de verdad importa, ya contestada y no delegada al
    // que lee: node-windows canta "arrancado" sin comprobar nada.
    if (real && real.estado === 'RUNNING') {
      console.log('  ✅ Y está corriendo.');
    } else {
      console.log(`\n  ⚠ Pero Windows lo reporta como ${(real && real.estado) || 'no instalado'}, no RUNNING.`);
      console.log('    Mira el log de winsw en daemon\\, y el del agente en logs\\.');
    }
    return true;
  }
  console.log('  ❌ Problemas:');
  problemas.forEach((p) => console.log(`     · ${p}`));
  console.log('\n  Se corrigen reinstalando:  node instalar-servicio.js quitar  &&  node instalar-servicio.js instalar');
  return false;
}

servicio.on('install', () => {
  console.log(`✅ Servicio instalado: ${NOMBRE}`);
  revisar();
  servicio.start();
});
servicio.on('start', () => {
  console.log('\n▶️  Arranque solicitado.');
  console.log(`   Log del agente: ${path.join(__dirname, 'logs')}`);
  console.log(`   Log de winsw:   ${path.join(__dirname, 'daemon')}`);
  console.log('\n   COMPRUÉBALO — que diga "arrancado" no basta:');
  console.log(`     powershell "Get-Service ${ID}.exe | Select Name,Status"`);
  console.log('   Tiene que decir Running, y el semáforo del portal ponerse en verde en menos de 2 min.');
});
servicio.on('alreadyinstalled', () => {
  console.log('El servicio ya estaba instalado.');
  revisar();
});
servicio.on('uninstall', () => console.log('🗑️  Servicio desinstalado.'));
servicio.on('error', (e) => console.error('Error del servicio:', e));

if (accion === 'revisar') revisar();
else if (accion === 'instalar') servicio.install();
else servicio.uninstall();
