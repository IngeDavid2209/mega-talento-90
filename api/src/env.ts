import 'dotenv/config';

/** Configuración leída de variables de entorno (Railway / .env local). */
export const env = {
  DATABASE_URL: process.env.DATABASE_URL || '',
  PGSSL: (process.env.PGSSL || 'true') === 'true',
  JWT_SECRET: process.env.JWT_SECRET || 'inseguro-cambia-esto',
  PORT: parseInt(process.env.PORT || '3000', 10),
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*'
};

if (!env.DATABASE_URL) {
  console.warn('[env] Falta DATABASE_URL — el backend no podrá conectarse a Postgres.');
}
if (env.JWT_SECRET === 'inseguro-cambia-esto') {
  console.warn('[env] JWT_SECRET sin definir — usa uno real en producción.');
}
