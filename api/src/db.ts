import { Pool } from 'pg';
import { env } from './env';

/**
 * Pool de conexiones a Postgres. Railway (red pública) requiere SSL; en la red
 * interna de Railway o en local sin SSL, pon PGSSL=false.
 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.PGSSL ? { rejectUnauthorized: false } : undefined,
  max: 10
});

pool.on('error', (err) => {
  console.error('[db] Error inesperado en el pool de Postgres:', err);
});

/** Atajo para consultas parametrizadas. */
export function query<T = any>(text: string, params: any[] = []) {
  return pool.query<T extends Record<string, any> ? T : any>(text, params);
}
