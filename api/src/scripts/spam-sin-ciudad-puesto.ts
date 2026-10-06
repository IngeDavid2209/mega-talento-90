import { pool } from '../db';
import { ES_POSTULACION, NO_ES_SPAM, SIN_CIUDAD_NI_PUESTO } from '../candidatos';

/**
 * Manda a SPAM las postulaciones que llegaron SIN ciudad y SIN puesto
 * (pedido de Capital Humano, 06/10/2026).
 *
 * Es una marca, no un borrado: cada uno se puede sacar de spam desde el
 * apartado "Spam" del portal y vuelve tal cual a la lista.
 *
 *   npx tsx src/scripts/spam-sin-ciudad-puesto.ts            solo lista, no toca nada
 *   npx tsx src/scripts/spam-sin-ciudad-puesto.ts --aplicar  los marca
 *
 * Al final cuenta también a los que les falta SOLO uno de los dos: esos NO se
 * marcan (la regla es "sin ciudad y sin puesto"), pero RH debería saberlo.
 */
const MOTIVO = 'Postulación sin ciudad y sin puesto';
const aplicar = process.argv.includes('--aplicar');

async function main() {
  const filtro = `deleted_at IS NULL AND ${NO_ES_SPAM} AND ${ES_POSTULACION}`;

  const { rows } = await pool.query(
    `SELECT id, coalesce(nombre_completo, '(sin nombre)') AS nombre, telefono,
            coalesce(nullif(origen,''), nullif(fuente,''), 'portal') AS origen,
            coalesce(portal_status, '') AS etapa,
            to_char(creado_en AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD HH24:MI') AS creado
       FROM candidatos
      WHERE ${filtro} AND ${SIN_CIUDAD_NI_PUESTO}
      ORDER BY creado_en DESC`);

  console.log(`\nPostulaciones SIN ciudad y SIN puesto: ${rows.length}\n`);
  for (const r of rows) {
    console.log(`  ${r.creado}  ${String(r.nombre).padEnd(35).slice(0, 35)}  ${String(r.telefono || '').padEnd(14)}  ${r.origen}${r.etapa ? '  · etapa ' + r.etapa : ''}`);
  }

  const soloUno = await pool.query(
    `SELECT count(*) FILTER (WHERE coalesce(btrim(ciudad_sucursal),'') = '')::int AS sin_ciudad,
            count(*) FILTER (WHERE coalesce(btrim(puesto_interes),'') = '')::int AS sin_puesto
       FROM candidatos
      WHERE ${filtro} AND NOT ${SIN_CIUDAD_NI_PUESTO}`);
  const s = soloUno.rows[0];
  console.log(`\nNo se tocan (les falta solo uno): ${s.sin_ciudad} sin ciudad, ${s.sin_puesto} sin puesto.`);

  if (!aplicar) {
    console.log('\nSolo se listaron. Para mandarlos a spam: --aplicar\n');
    return;
  }
  if (!rows.length) {
    console.log('\nNada que marcar.\n');
    return;
  }

  const ids = rows.map((r) => r.id);
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const upd = await cliente.query(
      `UPDATE candidatos
          SET spam = true, spam_motivo = $2, spam_por = 'Limpieza 06/10/2026', spam_en = now()
        WHERE id = ANY($1::uuid[]) AND NOT spam`,
      [ids, MOTIVO]);
    await cliente.query(
      `INSERT INTO candidatos_eventos (candidato_id, tipo, canal, nota, por)
       SELECT unnest($1::uuid[]), 'nota', 'portal', $2, 'Limpieza 06/10/2026'`,
      [ids, `Enviado a SPAM: ${MOTIVO}`]);
    await cliente.query('COMMIT');
    console.log(`\n✔ ${upd.rowCount} mandados a spam.\n`);
  } catch (e) {
    await cliente.query('ROLLBACK');
    throw e;
  } finally {
    cliente.release();
  }
}

main()
  .catch((e) => { console.error('[spam] Falló:', e); process.exitCode = 1; })
  .finally(() => pool.end());
