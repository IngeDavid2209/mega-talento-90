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

const NOMBRE = 'Mega Talento · Agente de checadas';
const accion = (process.argv[2] || '').toLowerCase();

if (!['instalar', 'quitar'].includes(accion)) {
  console.log('Uso: node instalar-servicio.js instalar | quitar');
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
  description: 'Lee los relojes checadores de esta plaza y empuja las checadas a Mega Talento 90. ' +
               'Debe correr en una PC de la misma red que los relojes.',
  script: path.join(__dirname, 'index.js'),
  nodeOptions: [],
  // Reinicio automático: si el proceso muere, vuelve en 5 s y hasta 3 veces por
  // minuto. Sin esto, un error a las 3 de la mañana deja a la plaza sin datos
  // hasta que alguien lo note al día siguiente.
  wait: 5,
  grow: 0.25,
  maxRestarts: 3,
});

servicio.on('install', () => {
  console.log(`✅ Servicio instalado: ${NOMBRE}`);
  servicio.start();
});
servicio.on('start', () => {
  console.log('▶️  Servicio arrancado.');
  console.log(`   Log:  ${path.join(__dirname, 'logs')}`);
  console.log('   Comprueba el semáforo en el portal: la sucursal debe ponerse en verde en menos de 2 min.');
});
servicio.on('alreadyinstalled', () => console.log('El servicio ya estaba instalado.'));
servicio.on('uninstall', () => console.log('🗑️  Servicio desinstalado.'));
servicio.on('error', (e) => console.error('Error del servicio:', e));

if (accion === 'instalar') servicio.install();
else servicio.uninstall();
