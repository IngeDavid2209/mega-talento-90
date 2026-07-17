// Lee las checadas del reloj ZKTeco (SOLO LECTURA), muestra un resumen de
// entradas/salidas y las carga a Postgres (tabla `checadas`) con deduplicación.
// Uso:
//   ZK_IP=192.168.0.80 SUCURSAL=santa-ana-pacueco DATABASE_URL=... node tools/jalar-checadas-zk.js --dry
const ZKLib = require('node-zklib');
const { Pool } = require('pg');

const IP = process.env.ZK_IP || '192.168.0.80';
const PORT = parseInt(process.env.ZK_PORT || '4370', 10);
const SUC = process.env.SUCURSAL || 'santa-ana-pacueco';
const DRY = process.argv.includes('--dry');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const pad = n => String(n).padStart(2, '0');
function fmt(d) {
  const y = d.getFullYear(), mo = pad(d.getMonth() + 1), da = pad(d.getDate());
  const h = pad(d.getHours()), mi = pad(d.getMinutes()), s = pad(d.getSeconds());
  return { fecha: `${y}-${mo}-${da}`, hora: `${h}:${mi}:${s}`, fechaHora: `${y}-${mo}-${da}T${h}:${mi}:${s}` };
}

(async () => {
  const zk = new ZKLib(IP, PORT, 10000, 4000);
  await zk.createSocket();
  let logs = [];
  try { const res = await zk.getAttendances(); logs = (res && res.data) || []; }
  finally { await zk.disconnect().catch(() => {}); }
  console.log(`Checadas leídas del reloj: ${logs.length}`);

  const emp = await pool.query('SELECT codigo_checador, nombre FROM empleados WHERE sucursal_id=$1', [SUC]);
  const mapa = new Map(emp.rows.map(r => [String(r.codigo_checador).trim(), r.nombre]));

  const filas = logs.map(l => {
    const codigo = String(l.deviceUserId ?? l.userId ?? l.uid ?? '').trim();
    const t = l.recordTime instanceof Date ? l.recordTime : new Date(l.recordTime);
    if (!codigo || isNaN(t.getTime())) return null;
    return { codigo, nombre: mapa.get(codigo) || null, ...fmt(t) };
  }).filter(Boolean);

  // Resumen del día más reciente: por empleado, primera (entrada) y última (salida).
  const fechas = [...new Set(filas.map(f => f.fecha))].sort().reverse();
  const ultima = fechas[0];
  if (ultima) {
    console.log(`\n=== Entradas / Salidas del ${ultima} ===`);
    const delDia = filas.filter(f => f.fecha === ultima);
    const porEmp = new Map();
    for (const f of delDia) {
      if (!porEmp.has(f.codigo)) porEmp.set(f.codigo, []);
      porEmp.get(f.codigo).push(f.hora);
    }
    for (const [cod, horas] of porEmp) {
      horas.sort();
      const nom = mapa.get(cod) || `cod ${cod}`;
      console.log(`   ${nom.padEnd(16)} entrada ${horas[0]}  |  salida ${horas[horas.length - 1]}  (${horas.length} marcas)`);
    }
  }
  console.log(`\nRango de fechas en el reloj: ${fechas[fechas.length - 1]} → ${fechas[0]}`);

  if (DRY) { console.log('(dry run: no se escribió en Postgres)'); await pool.end(); return; }

  // Dedup y carga por lotes.
  const vistos = new Set();
  const unicas = [];
  for (const f of filas) {
    const key = `${SUC}__${f.codigo}__${f.fechaHora}`;
    if (vistos.has(key)) continue;
    vistos.add(key);
    unicas.push({ ...f, dedupKey: key });
  }
  let nuevas = 0;
  for (let i = 0; i < unicas.length; i += 200) {
    const grupo = unicas.slice(i, i + 200);
    const vals = [], params = [];
    grupo.forEach((c, j) => {
      const b = j * 8;
      vals.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`);
      params.push(SUC, c.codigo, c.nombre, c.fechaHora, c.fecha, c.hora, null, c.dedupKey);
    });
    const r = await pool.query(
      `INSERT INTO checadas (sucursal_id, empleado_codigo, empleado_nombre, fecha_hora, fecha, hora, tipo, dedup_key)
       VALUES ${vals.join(',')} ON CONFLICT (dedup_key) DO NOTHING`, params
    );
    nuevas += r.rowCount || 0;
  }
  console.log(`\nChecadas cargadas a Postgres: ${nuevas} nuevas (de ${unicas.length} únicas).`);
  await pool.end();
})().catch(e => { console.error('ERROR:', e.message || e); process.exit(1); });
