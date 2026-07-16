import { pool } from '../db';

/**
 * Inspección de SOLO LECTURA de la base existente. No escribe nada.
 * Sirve para entender la estructura que ya creó el bot antes de migrar.
 */
async function main() {
  const tablas = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' ORDER BY table_name`
  );
  console.log('\n===== TABLAS EN public =====');
  console.log(tablas.rows.map(r => r.table_name).join(', '));

  // Columnas de las tablas clave para la app.
  const claves = ['candidatos', 'usuarios', 'empleados', 'checadas', 'horarios_sucursal', 'areas_checador', 'productos'];
  for (const t of claves) {
    const cols = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [t]
    );
    if (!cols.rows.length) {
      console.log(`\n----- ${t}: (no existe) -----`);
      continue;
    }
    console.log(`\n----- ${t} -----`);
    for (const c of cols.rows) {
      console.log(`  ${c.column_name.padEnd(28)} ${c.data_type}${c.is_nullable === 'NO' ? ' NOT NULL' : ''}`);
    }
    try {
      const cuenta = await pool.query(`SELECT count(*)::int AS n FROM "${t}"`);
      console.log(`  → filas: ${cuenta.rows[0].n}`);
    } catch { /* ignore */ }
  }

  await pool.end();
}

main().catch((e) => { console.error('inspect error:', e); process.exit(1); });
