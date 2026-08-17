// api/tools/inspeccionar-hr.js
//
// RADIOGRAFÍA DE LA BASE DE ORIGEN (servidor_245 · base `hr`).
//
// Es el sistema de asistencia que ya está instalado en el corporativo y que SÍ
// habla con los relojes —tiene la Comm Key que a nosotros nos rebota—. En vez
// de pelearnos con los equipos por el puerto 4370, leemos de aquí.
//
// Esta herramienta NO escribe nada. Solo describe lo que hay, para poder
// escribir la sincronización contra las columnas que existen y no contra las
// que uno supone.
//
// Uso:  node tools/inspeccionar-hr.js            (estructura + frescura)
//       node tools/inspeccionar-hr.js --muestra  (además, filas de ejemplo)

try { require('dotenv').config(); } catch { /* dotenv opcional */ }
const { Pool } = require('pg');

const URL = process.env.HR_DB_URL || '';
if (!URL) {
  console.error('Falta HR_DB_URL en api/.env');
  process.exit(1);
}
const MUESTRA = process.argv.includes('--muestra');
const pool = new Pool({ connectionString: URL, ssl: false, connectionTimeoutMillis: 8000 });

const TABLAS = [
  'attendance_logs', 'attendance_devices', 'employees',
  'device_enrollments', 'attendance_days', 'device_sync_runs',
];

(async () => {
  const v = await pool.query('SELECT current_database() AS db, version() AS v');
  console.log(`\nBase: ${v.rows[0].db} · ${v.rows[0].v.split(',')[0]}`);

  for (const t of TABLAS) {
    const cols = await pool.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema='hr' AND table_name=$1
        ORDER BY ordinal_position`, [t]
    );
    if (!cols.rows.length) { console.log(`\n=== hr.${t} — no existe ===`); continue; }
    const n = await pool.query(`SELECT count(*)::int AS n FROM hr.${t}`);
    console.log(`\n=== hr.${t} · ${n.rows[0].n} filas ===`);
    console.log(cols.rows.map((c) => `${c.column_name} ${c.data_type}`).join(' | '));

    if (MUESTRA && n.rows[0].n) {
      const m = await pool.query(`SELECT * FROM hr.${t} LIMIT 3`);
      console.log(JSON.stringify(m.rows, null, 2).slice(0, 1500));
    }
  }
  await pool.end();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
