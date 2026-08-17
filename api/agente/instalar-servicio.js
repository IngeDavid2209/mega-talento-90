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
  // Reinicio automático: si el proceso muere, vuelve en 5 s y hasta 3 veces por
  // minuto. Sin esto, un error a las 3 de la mañana deja a la plaza sin datos
  // hasta que alguien lo note al día siguiente.
  wait: 5,
  grow: 0.25,
  maxRestarts: 3,

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
 * REVISA EL XML QUE QUEDÓ, en vez de confiar en que "instalar" dijo que sí.
 *
 * `servicio.start()` avisa que arrancó aunque el servicio se haya caído medio
 * segundo después: node-windows solo lanza el comando, no comprueba el estado.
 * Así fue como la primera instalación quedó en "Detenido, arranque automático,
 * cero logs" mientras la consola decía "▶️ Servicio arrancado".
 */
function revisar() {
  if (!fs.existsSync(XML)) {
    console.log(`No hay servicio instalado (falta ${XML}).`);
    return false;
  }
  const xml = fs.readFileSync(XML, 'utf8');
  const problemas = [];

  const dominio = /<domain>([^<]*)<\/domain>/.exec(xml)?.[1] || '';
  const cuenta = /<user>([^<]*)<\/user>/.exec(xml)?.[1] || '';
  if (cuenta === 'LocalSystem' && dominio && dominio.toUpperCase() !== 'NT AUTHORITY') {
    problemas.push(
      `la cuenta quedó como "${dominio}\\${cuenta}", que no existe — tiene que ser "NT AUTHORITY\\LocalSystem". ` +
      'El servicio se instala y nunca arranca, sin dejar log.');
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
  console.log(`  Cuenta: ${dominio}\\${cuenta}`);
  if (!problemas.length) {
    console.log('  ✅ La configuración se ve bien.');
    console.log('\n  Comprueba que de verdad esté corriendo:');
    console.log(`     powershell "Get-Service ${ID}.exe | Select Name,Status"`);
    console.log('  Debe decir Running. Si dice Stopped, mira el log de winsw en daemon\\.');
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
