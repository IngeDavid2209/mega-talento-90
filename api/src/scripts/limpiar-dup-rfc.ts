import { pool } from '../db';

/**
 * Deduplicación de candidatos por RFC.
 *
 * Regla: si dos o más candidatos ACTIVOS (deleted_at IS NULL) comparten el mismo
 * RFC, se CONSERVA el más antiguo (creado_en) y los demás se mandan a la PAPELERA
 * (soft-delete: deleted_at=now() + motivoBorrado='duplicado_rfc'). Es REVERSIBLE
 * desde la papelera del portal.
 *
 * - Ignora RFC placeholder ("NO APLICA", "N/A", vacío, <10 chars…): no son
 *   personas duplicadas, solo gente que no puso su RFC.
 * - El RFC puede estar en la columna `rfc` o en portal_data->>'rfc'.
 * - Empate de fecha: conserva el que tenga CV (cv_url o documentos[].slot='cv').
 *
 * Uso:
 *   npm run limpiar:dup-rfc         (DRY RUN: solo muestra, no escribe)
 *   npm run limpiar:dup-rfc -- --commit   (aplica los cambios)
 */

const COMMIT = process.argv.includes('--commit');

const PLACEHOLDER = new Set([
  'NO APLICA', 'NOAPLICA', 'N/A', 'NA', 'NO TENGO', 'NINGUNO', 'SIN RFC',
  'XXXX', '0', 'NO', 'NO SE', 'NOSE', 'PENDIENTE', 'TRAMITE', 'EN TRAMITE'
]);

function rfcValido(raw: any): string | null {
  const r = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!r || PLACEHOLDER.has(r) || r.length < 10) return null;
  return r;
}

function tieneCV(row: any): boolean {
  if (row.cv_url && String(row.cv_url).trim()) return true;
  if (row.cv_json && String(row.cv_json).trim()) return true;
  const docs = Array.isArray(row.documentos) ? row.documentos : [];
  if (docs.some((x: any) => String(x && (x.slot || x.tipo) || '').toLowerCase() === 'cv')) return true;
  return false;
}

async function main() {
  const { rows } = await pool.query(`
    SELECT id, creado_en, estado, portal_status, nombre_completo,
           cv_url, rfc AS rfc_col,
           portal_data->>'rfc'   AS rfc_json,
           portal_data->>'cvUrl' AS cv_json,
           documentos
    FROM candidatos
    WHERE deleted_at IS NULL
    ORDER BY creado_en ASC`);

  const rfcDe = (r: any) => rfcValido(r.rfc_col) || rfcValido(r.rfc_json);

  // Agrupar por RFC válido
  const grupos = new Map<string, any[]>();
  for (const r of rows) {
    const k = rfcDe(r);
    if (!k) continue;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k)!.push(r);
  }

  const aBorrar: any[] = [];
  for (const [rfc, arr] of grupos) {
    if (arr.length < 2) continue;
    // Conservar el más antiguo; empate de fecha -> el que tenga CV.
    const orden = [...arr].sort((a, b) => {
      const ta = new Date(a.creado_en).getTime();
      const tb = new Date(b.creado_en).getTime();
      if (ta !== tb) return ta - tb;
      return (tieneCV(b) ? 1 : 0) - (tieneCV(a) ? 1 : 0);
    });
    const conservar = orden[0];
    console.log(`\nRFC ${rfc}  (conservar ${conservar.id} · ${new Date(conservar.creado_en).toISOString().slice(0, 10)} · ${conservar.nombre_completo || ''})`);
    for (const r of orden.slice(1)) {
      aBorrar.push(r);
      console.log(`   -> papelera ${r.id} · ${new Date(r.creado_en).toISOString().slice(0, 10)} · estado=${r.estado || ''} · ${r.nombre_completo || ''}`);
    }
  }

  console.log(`\nGrupos con duplicado: ${[...grupos.values()].filter(a => a.length > 1).length}`);
  console.log(`Registros a mandar a papelera: ${aBorrar.length}`);
  console.log(`Modo: ${COMMIT ? '*** COMMIT (escribiendo) ***' : 'DRY RUN (no escribe; usa -- --commit para aplicar)'}`);

  if (COMMIT && aBorrar.length) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let n = 0;
      for (const r of aBorrar) {
        const res = await client.query(
          `UPDATE candidatos
             SET deleted_at = now(),
                 portal_data = coalesce(portal_data,'{}'::jsonb)
                               || jsonb_build_object('motivoBorrado','duplicado_rfc','borradoPor','limpiar-dup-rfc')
           WHERE id = $1 AND deleted_at IS NULL`,
          [r.id]
        );
        n += res.rowCount ?? 0;
      }
      await client.query('COMMIT');
      console.log(`\n✅ Listo. Movidos a papelera: ${n}/${aBorrar.length}`);
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('\n❌ ROLLBACK por error:', e);
      process.exitCode = 1;
    } finally {
      client.release();
    }
  }

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
