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
  // Se aplican en orden. Todos son idempotentes (CREATE ... IF NOT EXISTS).
  const archivos = [
    'schema.sql',            // checadas + asistencia_revision (justificación/verificación)
    'schema-portal.sql',     // portal: candidatos + puestos + candidatos_transiciones (KPI de fases)
    'agente-horarios.sql',   // Fase 1: asistencia_alertas + asistencia_config
    'checadas-vivo.sql',     // padrón de relojes por SERIE + latido + cola de ingesta
    'incidencias.sql',       // vacaciones, permisos, incapacidades… por periodo
    'reloj-comandos.sql',    // cola de cambios hacia los relojes + empleados.eliminado_en
  ];
  const dirDb = join(__dirname, '..', '..', 'db');
  for (const archivo of archivos) {
    const ruta = join(dirDb, archivo);
    const sql = readFileSync(ruta, 'utf8');
    console.log('[migrate] Aplicando', archivo);
    await pool.query(sql);
  }
  console.log('[migrate] Esquema aplicado correctamente ✔');
  await pool.end();
}

main().catch((e) => {
  console.error('[migrate] Falló la migración:', e);
  process.exit(1);
});
