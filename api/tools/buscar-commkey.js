// api/tools/buscar-commkey.js
//
// BUSCA LA CONTRASEÑA DE COMUNICACIÓN DE LOS RELOJES en la base de origen.
//
// Solo LEE. No toca los relojes, no prueba claves, no escribe nada.
//
// Por qué hace falta: los 10 equipos rechazan nuestro saludo con
// CMD_ACK_UNAUTH (2005). La app `hr` sí los lee, así que en algún lado guarda
// la clave buena. `hr.attendance_devices.comm_key` dice 0, y el 0 ya se probó
// contra el reloj y lo rechaza — o sea que ese campo NO es la clave real, es
// un valor por omisión sin llenar.

try { require('dotenv').config(); } catch { /* dotenv opcional */ }
const { Pool } = require('pg');

const URL = process.env.HR_DB_URL || '';
if (!URL) { console.error('Falta HR_DB_URL en api/.env'); process.exit(1); }
const pool = new Pool({ connectionString: URL, ssl: false, connectionTimeoutMillis: 8000 });

// Nombres de columna que podrían guardar una clave de comunicación.
const RE_COLUMNA = /(comm.?key|commkey|passw|pwd|clave|secret|token|device_key|auth)/i;

(async () => {
  console.log('\n════ 1a · TODAS las tablas de la base de origen ════');
  const { rows: tablas } = await pool.query(
    `SELECT table_schema, table_name
       FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog','information_schema')
        AND table_type = 'BASE TABLE'
      ORDER BY 1,2`
  );
  console.table(tablas);

  console.log('\n════ 1b · Columnas que podrían llevar una clave ════');
  const { rows: cols } = await pool.query(
    `SELECT table_schema, table_name, column_name, data_type
       FROM information_schema.columns
      WHERE table_schema NOT IN ('pg_catalog','information_schema')
      ORDER BY 1,2,ordinal_position`
  );
  const sospechosas = cols.filter((c) => RE_COLUMNA.test(c.column_name));
  if (!sospechosas.length) console.log('  (ninguna columna con nombre de clave)');
  else console.table(sospechosas);

  // Los valores, uno por uno. Si la clave está guardada, aquí sale.
  for (const c of sospechosas) {
    const t = `${c.table_schema}.${c.table_name}`;
    try {
      const { rows } = await pool.query(
        `SELECT DISTINCT "${c.column_name}"::text AS valor, count(*)::int AS filas
           FROM ${t} GROUP BY 1 ORDER BY 2 DESC LIMIT 15`
      );
      console.log(`\n  ${t}.${c.column_name}:`);
      console.table(rows);
    } catch (e) { console.log(`  ${t}.${c.column_name}: no se pudo leer (${e.message})`); }
  }

  console.log('\n════ 1c · La clave por equipo, tal como la tiene el origen ════');
  const { rows: eq } = await pool.query(
    `SELECT ip_address, serial_number, comm_key, model, platform, timezone
       FROM hr.attendance_devices ORDER BY ip_address`
  );
  console.table(eq);
  const distintas = [...new Set(eq.map((e) => String(e.comm_key)))];
  console.log(`  Valores distintos de comm_key entre los 10: ${distintas.join(', ')}`);
  console.log('  ⚠ El 0 ya se probó contra 192.168.40.12 y el reloj lo RECHAZA.');
  console.log('    Así que este campo no trae la clave real: quedó en su valor por omisión.');

  // ¿Guardó el origen alguna configuración suelta? (tablas tipo settings/config)
  console.log('\n════ 1d · ¿Hay alguna tabla de configuración con secretos? ════');
  const candidatas = tablas.filter((t) => /config|setting|param|secret|env|integration|credential/i.test(t.table_name));
  if (!candidatas.length) console.log('  (ninguna)');
  for (const t of candidatas) {
    const nombre = `${t.table_schema}.${t.table_name}`;
    try {
      const { rows } = await pool.query(`SELECT * FROM ${nombre} LIMIT 20`);
      console.log(`\n  ${nombre} (${rows.length} filas):`);
      console.log(JSON.stringify(rows, null, 2).slice(0, 1200));
    } catch (e) { console.log(`  ${nombre}: ${e.message}`); }
  }

  await pool.end();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
