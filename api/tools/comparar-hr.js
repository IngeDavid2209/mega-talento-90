// api/tools/comparar-hr.js
//
// COMPARA la base de origen (servidor_245 · `hr`) contra la nuestra.
//
// Antes de sincronizar hay que contestar tres preguntas, y ninguna se puede
// suponer:
//   1. ¿La base de origen está MÁS AL DÍA que la nuestra? (si no, no sirve)
//   2. ¿Qué `site_code` de allá corresponde a qué `sucursal_id` de acá?
//      Si una plaza queda pegada al slug equivocado, las checadas entran bajo
//      otra sucursal y eso NO se nota mirando la pantalla.
//   3. ¿Los códigos de empleado empatan, o hay que traducirlos?
//
// Solo lee. No escribe en ninguna de las dos bases.

try { require('dotenv').config(); } catch { /* dotenv opcional */ }
const { Pool } = require('pg');

const origen = new Pool({ connectionString: process.env.HR_DB_URL, ssl: false, connectionTimeoutMillis: 8000 });
const nuestra = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  console.log('\n════ 1 · FRESCURA ════');
  const o = await origen.query(
    `SELECT count(*)::int n, min(punched_local)::date mn, max(punched_local)::date mx,
            max(punched_local) ultimo
       FROM hr.attendance_logs`
  );
  const n = await nuestra.query(
    `SELECT count(*)::int n, min(fecha) mn, max(fecha) mx FROM checadas`
  );
  console.log(`  origen  (hr): ${o.rows[0].n} checadas · ${o.rows[0].mn} → ${o.rows[0].mx} · última ${o.rows[0].ultimo?.toISOString?.() || o.rows[0].ultimo}`);
  console.log(`  nuestra     : ${n.rows[0].n} checadas · ${n.rows[0].mn} → ${n.rows[0].mx}`);

  console.log('\n════ 2 · RELOJES DE ORIGEN ════');
  const d = await origen.query(
    `SELECT d.serial_number, d.label, d.site_code, d.ip_address, d.comm_key, d.is_active,
            d.record_count, d.clock_drift_seconds, d.last_seen_at, d.last_sync_at, d.last_error,
            (SELECT count(*) FROM hr.attendance_logs l WHERE l.device_id = d.id)::int AS logs,
            (SELECT max(punched_local)::date FROM hr.attendance_logs l WHERE l.device_id = d.id) AS ultima
       FROM hr.attendance_devices d ORDER BY d.site_code, d.label`
  );
  console.table(d.rows.map((r) => ({
    serie: r.serial_number, label: r.label, site: r.site_code, ip: r.ip_address,
    commKey: r.comm_key, activo: r.is_active, logs: r.logs, ultima: r.ultima,
    derivaSeg: r.clock_drift_seconds,
    visto: r.last_seen_at ? new Date(r.last_seen_at).toISOString().slice(0, 16) : null,
  })));
  for (const r of d.rows) if (r.last_error) console.log(`  ⚠ ${r.label}: ${r.last_error}`);

  console.log('\n════ 3 · PLAZAS: site_code (origen) vs sucursal_id (nuestra) ════');
  const sitios = await origen.query(
    `SELECT site_code, count(*)::int empleados FROM hr.employees GROUP BY 1 ORDER BY 1`
  );
  const sucs = await nuestra.query(
    `SELECT sucursal_id, count(*)::int n, max(fecha) ultima FROM checadas GROUP BY 1 ORDER BY 1`
  );
  console.log('  origen :', sitios.rows.map((r) => `${r.site_code}(${r.empleados})`).join(' '));
  console.log('  nuestra:', sucs.rows.map((r) => `${r.sucursal_id}(${r.n})`).join(' '));

  console.log('\n════ 4 · ¿EMPATAN LOS CÓDIGOS? ════');
  // Se compara el código del reloj de origen contra el codigo_checador nuestro,
  // por plaza. Si el traslape es bajo, hace falta traducción.
  const codOrigen = await origen.query(
    `SELECT e.site_code, e.employee_code, e.full_name FROM hr.employees e WHERE e.status <> 'inactive'`
  );
  const codNuestro = await nuestra.query(
    `SELECT sucursal_id, codigo_checador, nombre FROM empleados WHERE activo = TRUE`
  );
  const porSitio = new Map();
  for (const r of codOrigen.rows) {
    if (!porSitio.has(r.site_code)) porSitio.set(r.site_code, new Set());
    porSitio.get(r.site_code).add(String(r.employee_code).trim());
  }
  const porSuc = new Map();
  for (const r of codNuestro.rows) {
    if (!porSuc.has(r.sucursal_id)) porSuc.set(r.sucursal_id, new Set());
    porSuc.get(r.sucursal_id).add(String(r.codigo_checador).trim());
  }
  const filas = [];
  for (const [sitio, cods] of porSitio) {
    let mejor = null;
    for (const [suc, nuestros] of porSuc) {
      let comunes = 0;
      for (const c of cods) if (nuestros.has(c)) comunes++;
      const pct = Math.round((comunes / cods.size) * 100);
      if (!mejor || pct > mejor.pct) mejor = { suc, comunes, pct, total: nuestros.size };
    }
    filas.push({ site_code: sitio, codigos: cods.size, mejorSucursal: mejor?.suc,
                 comunes: mejor?.comunes, empate: `${mejor?.pct}%` });
  }
  console.table(filas);

  await origen.end(); await nuestra.end();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
