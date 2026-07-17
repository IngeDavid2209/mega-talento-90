// Jala empleados + checadas de VARIOS checadores ZKTeco (SOLO LECTURA) y los
// carga a Postgres. Recibe la lista por env TARGETS (JSON): [{"ip","suc"}]
const ZKLib = require('node-zklib');
const { Pool } = require('pg');

const PORT = parseInt(process.env.ZK_PORT || '4370', 10);
const TARGETS = JSON.parse(process.env.TARGETS || '[]');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const pad = n => String(n).padStart(2, '0');
function fmt(d) {
  const y = d.getFullYear(), mo = pad(d.getMonth() + 1), da = pad(d.getDate());
  const h = pad(d.getHours()), mi = pad(d.getMinutes()), s = pad(d.getSeconds());
  return { fecha: `${y}-${mo}-${da}`, hora: `${h}:${mi}:${s}`, fechaHora: `${y}-${mo}-${da}T${h}:${mi}:${s}` };
}

async function jalarUno({ ip, suc }) {
  const zk = new ZKLib(ip, PORT, 10000, 4000);
  await zk.createSocket();
  let users = [], logs = [];
  try {
    users = ((await zk.getUsers()) || {}).data || [];
    logs = ((await zk.getAttendances()) || {}).data || [];
  } finally { await zk.disconnect().catch(() => {}); }

  // Empleados
  let ne = 0;
  const mapa = new Map();
  for (const u of users) {
    const codigo = String(u.userId ?? u.uid ?? '').trim();
    if (!codigo) continue;
    const nombre = (u.name || '').trim() || `Empleado ${codigo}`;
    mapa.set(codigo, nombre);
    await pool.query(
      `INSERT INTO empleados (sucursal_id, codigo_checador, nombre, activo) VALUES ($1,$2,$3,true)
       ON CONFLICT (sucursal_id, codigo_checador) DO UPDATE SET nombre=EXCLUDED.nombre`,
      [suc, codigo, nombre]
    );
    ne++;
  }

  // Checadas (dedup + lotes)
  const vistos = new Set(); const filas = [];
  for (const l of logs) {
    const codigo = String(l.deviceUserId ?? l.userId ?? l.uid ?? '').trim();
    const t = l.recordTime instanceof Date ? l.recordTime : new Date(l.recordTime);
    if (!codigo || isNaN(t.getTime())) continue;
    const f = fmt(t);
    const key = `${suc}__${codigo}__${f.fechaHora}`;
    if (vistos.has(key)) continue;
    vistos.add(key);
    filas.push({ codigo, nombre: mapa.get(codigo) || null, ...f, key });
  }
  let nc = 0;
  for (let i = 0; i < filas.length; i += 200) {
    const grupo = filas.slice(i, i + 200);
    const vals = [], params = [];
    grupo.forEach((c, j) => {
      const b = j * 8;
      vals.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`);
      params.push(suc, c.codigo, c.nombre, c.fechaHora, c.fecha, c.hora, null, c.key);
    });
    const r = await pool.query(
      `INSERT INTO checadas (sucursal_id, empleado_codigo, empleado_nombre, fecha_hora, fecha, hora, tipo, dedup_key)
       VALUES ${vals.join(',')} ON CONFLICT (dedup_key) DO NOTHING`, params);
    nc += r.rowCount || 0;
  }
  return { ne, nc, totalChecadas: filas.length };
}

(async () => {
  for (const t of TARGETS) {
    try {
      const r = await jalarUno(t);
      console.log(`✅ ${t.suc.padEnd(20)} (${t.ip}) → ${r.ne} empleados, ${r.nc} checadas nuevas (${r.totalChecadas} únicas)`);
    } catch (e) {
      console.log(`❌ ${t.suc.padEnd(20)} (${t.ip}) → ERROR: ${e.message || e}`);
    }
  }
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
