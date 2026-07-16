import { pool } from '../db';

async function main() {
  const dup = await pool.query(
    `SELECT portal_candidate_id FROM candidatos
     WHERE portal_candidate_id IS NOT NULL
     GROUP BY portal_candidate_id HAVING count(*) > 1`
  );
  for (const d of dup.rows) {
    const rows = await pool.query(
      `SELECT id, telefono, estado, nombre_completo, puesto_interes,
              (portal_data <> '{}'::jsonb) AS tiene_portal, creado_en
       FROM candidatos WHERE portal_candidate_id = $1 ORDER BY creado_en`,
      [d.portal_candidate_id]
    );
    console.log('\npid', d.portal_candidate_id);
    rows.rows.forEach(r => console.log('   ', JSON.stringify(r)));

    if (process.argv.includes('--fix')) {
      // Conservar la fila con teléfono "real" (no 'sin-tel-...') y con datos;
      // borrar la otra. Si ambas válidas, conservar la más antigua.
      const orden = [...rows.rows].sort((a, b) => {
        const aReal = a.telefono && !String(a.telefono).startsWith('sin-tel') ? 1 : 0;
        const bReal = b.telefono && !String(b.telefono).startsWith('sin-tel') ? 1 : 0;
        if (aReal !== bReal) return bReal - aReal;
        if (a.tiene_portal !== b.tiene_portal) return b.tiene_portal ? 1 : -1;
        return new Date(a.creado_en).getTime() - new Date(b.creado_en).getTime();
      });
      const conservar = orden[0];
      const borrar = orden.slice(1);
      for (const b of borrar) {
        await pool.query('DELETE FROM candidatos WHERE id=$1', [b.id]);
        console.log('   -> borrado', b.id, '| conservado', conservar.id);
      }
    }
  }
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
