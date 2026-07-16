import { readFileSync } from 'fs';
import { join } from 'path';
import { pool } from '../db';

/**
 * Aplica db/schema.sql contra la base configurada en DATABASE_URL.
 * Es idempotente (usa CREATE ... IF NOT EXISTS), así que se puede correr
 * cuantas veces haga falta.
 *
 * Uso:
 *   npm run migrate:dev     (local, con tsx)
 *   npm run migrate         (en Railway, tras `npm run build`)
 */
async function main() {
  const rutaSql = join(__dirname, '..', '..', 'db', 'schema.sql');
  const sql = readFileSync(rutaSql, 'utf8');
  console.log('[migrate] Aplicando esquema desde', rutaSql);
  await pool.query(sql);
  console.log('[migrate] Esquema aplicado correctamente ✔');
  await pool.end();
}

main().catch((e) => {
  console.error('[migrate] Falló la migración:', e);
  process.exit(1);
});
