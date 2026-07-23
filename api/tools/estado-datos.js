// Reporta, por cada reloj de targets.json, cuántas checadas tiene en Postgres
// y su rango de fechas. Los que salen en 0 son los que NO tienen datos.
// Uso:  npm run estado    (lee tools/targets.json y DATABASE_URL del .env)
try { require('dotenv').config(); } catch { /* dotenv opcional */ }
const { Pool } = require('pg');
const targets = require('./targets.json');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('Falta DATABASE_URL (ponlo en api/.env o como variable de entorno).');
    process.exit(1);
  }

  console.log('\nEstado de datos por reloj (tabla checadas):\n');
  console.log('IP'.padEnd(17) + 'SUCURSAL'.padEnd(26) + 'CHECADAS'.padStart(9) + '   RANGO');
  console.log('─'.repeat(78));

  const sinDatos = [];
  for (const t of targets) {
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n, min(fecha) AS min, max(fecha) AS max FROM checadas WHERE sucursal_id=$1',
      [t.suc]
    );
    const r = rows[0] || { n: 0 };
    const rango = r.n ? `${r.min} → ${r.max}` : '— sin datos —';
    console.log(
      String(t.ip).padEnd(17) +
      String(t.nota || t.suc).padEnd(26) +
      String(r.n).padStart(9) + '   ' + rango
    );
    if (!r.n) sinDatos.push(t);
  }

  console.log('');
  if (sinDatos.length) {
    console.log(`Relojes SIN datos (${sinDatos.length}):`);
    for (const t of sinDatos) console.log(`   • ${t.ip}  →  ${t.nota || t.suc}`);
  } else {
    console.log('✅ Todos los relojes tienen datos.');
  }
  console.log('');

  await pool.end();
})().catch(e => { console.error('ERROR:', e.message || e); process.exit(1); });
