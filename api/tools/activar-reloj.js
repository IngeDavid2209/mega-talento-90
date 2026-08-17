// api/tools/activar-reloj.js
//
// SACA UN RELOJ DE PAUSA, dándole su propio espacio de códigos.
//
// ══ EL PROBLEMA QUE RESUELVE ══
//
// Dos de los diez relojes estaban en pausa y su dato no llegaba a la pantalla:
//
//   · 192.168.0.81 "Oficinas desayuno y comida" (4,018 checadas). Es la misma
//     gente de corporativo con OTRA numeración: #11 es quien allá es #111. El
//     patrón es +100 y lo cumplen 35 de 48 códigos... pero de los 13 restantes,
//     CUATRO tienen ese número ya ocupado por otra persona: el #8 es Claudia
//     Mata y el #108 del otro reloj es Viviana. Aplicar el patrón a ciegas le
//     carga las comidas de Claudia a Viviana, y cruzado.
//
//   · 192.168.0.196 (1,314 checadas). 12 personas checando a diario y NO se
//     sabe de qué plaza es. Sus nombres empatan parecido con tres sucursales
//     distintas.
//
// ══ LA SALIDA ══
//
// Darle a cada uno SU PROPIO `sucursal_id`.
//
// El choque de códigos solo existe si se mezclan dos relojes en el mismo
// espacio de nombres. Con plaza propia, el código #8 es "#8 de ese reloj" y su
// nombre lo declara el reloj mismo: no hay forma de que una marca acabe en la
// persona equivocada. Se ve el dato hoy, sin decidir nada que después no se
// pueda deshacer.
//
// Lo que queda pendiente NO es la atribución sino la FUSIÓN: unir la plantilla
// del reloj de comida con la de corporativo para que la comida y la entrada de
// una persona salgan juntas. Eso se hace con `reloj_codigo_map` cuando RH
// resuelva los 6 códigos dudosos (ver tools/mapear-codigos.js).
//
// Uso:
//   node tools/activar-reloj.js --listar
//   node tools/activar-reloj.js --serie CLXK233460626 --sucursal corporativo-comida
//   node tools/activar-reloj.js --serie CLXK233460626 --pausar

try { require('dotenv').config(); } catch { /* dotenv opcional */ }
const { Pool } = require('pg');

const ARGS = process.argv.slice(2);
const val = (n) => { const i = ARGS.indexOf(n); return i >= 0 ? ARGS[i + 1] : null; };
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function listar() {
  const { rows } = await pool.query(
    `SELECT r.serie, r.sucursal_id, r.alias, r.ip, r.pendiente,
            (SELECT count(*) FROM checadas c WHERE c.serie_reloj = r.serie)::int AS checadas
       FROM relojes r ORDER BY r.pendiente DESC, r.sucursal_id`
  );
  console.table(rows.map((r) => ({
    serie: r.serie, ip: r.ip, sucursal: r.sucursal_id, alias: r.alias,
    estado: r.pendiente ? '⏸ EN PAUSA' : '▶ activo', checadas: r.checadas,
  })));
  const pausados = rows.filter((r) => r.pendiente);
  if (pausados.length) {
    console.log(`\n  ${pausados.length} en pausa: su dato NO entra a checadas y no salen en la asistencia.`);
    console.log('  Para activar uno dándole plaza propia:');
    console.log(`     node tools/activar-reloj.js --serie ${pausados[0].serie} --sucursal <id-nuevo>`);
  }
}

async function activar(serie, sucursal, nota) {
  const { rows: antes } = await pool.query('SELECT * FROM relojes WHERE serie=$1', [serie]);
  if (!antes.length) throw new Error(`la serie ${serie} no está en el padrón`);
  const r = antes[0];

  // No se permite mandar un reloj a una plaza que YA tiene otro reloj activo,
  // salvo que se diga explícitamente: ahí es donde vuelven los choques de
  // código. Corporativo ya tiene el de entrada/salida.
  const { rows: vecinos } = await pool.query(
    'SELECT serie, alias FROM relojes WHERE sucursal_id=$1 AND serie<>$2 AND pendiente=false',
    [sucursal, serie]
  );
  if (vecinos.length && !ARGS.includes('--compartir-plaza')) {
    console.error(`\n⛔ La plaza "${sucursal}" ya tiene otro reloj activo: ${vecinos.map((v) => v.alias || v.serie).join(', ')}.`);
    console.error('   Dos relojes en la misma plaza comparten espacio de códigos, y ahí es donde una');
    console.error('   marca puede acabar en la persona equivocada. Si de verdad son la misma plantilla');
    console.error('   y ya está cargado su reloj_codigo_map, repite con --compartir-plaza.');
    process.exit(1);
  }

  await pool.query(
    `UPDATE relojes SET sucursal_id=$2, pendiente=FALSE, activo=TRUE,
            nota = COALESCE(nota,'') || $3
      WHERE serie=$1`,
    [serie, sucursal, nota ? ` | ${new Date().toISOString().slice(0, 10)}: ${nota}` : '']
  );
  console.log(`\n▶ ${r.alias || serie} activado.`);
  console.log(`   ${r.sucursal_id}  →  ${sucursal}`);
  console.log('\n   El agente lo tomará en su próxima relectura del padrón (cada 30 min),');
  console.log('   o de inmediato si se reinicia el servicio. Su histórico completo entra solo.');
}

async function pausar(serie) {
  const { rowCount } = await pool.query('UPDATE relojes SET pendiente=TRUE WHERE serie=$1', [serie]);
  if (!rowCount) throw new Error(`la serie ${serie} no está en el padrón`);
  console.log(`\n⏸ ${serie} en pausa. Sus lotes se guardarán en ingesta_lotes sin aplicarse.`);
  console.log('   Lo YA cargado no se borra: pausar detiene la entrada, no deshace el pasado.');
}

(async () => {
  try {
    const serie = val('--serie');
    if (ARGS.includes('--listar') || !serie) return await listar();
    if (ARGS.includes('--pausar')) return await pausar(serie);
    const suc = val('--sucursal');
    if (!suc) {
      console.error('Falta --sucursal. Usa un id NUEVO si el reloj no comparte plantilla con otro reloj.');
      process.exit(1);
    }
    await activar(serie, suc, val('--nota'));
  } finally { await pool.end(); }
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
