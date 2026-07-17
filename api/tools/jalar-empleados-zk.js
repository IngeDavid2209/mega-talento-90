// Lee los usuarios del checador ZKTeco (una sola vez, SOLO LECTURA) y los carga
// a la tabla `empleados` de Postgres. NO modifica nada en el reloj.
// Uso:
//   ZK_IP=192.168.0.80 SUCURSAL=santa-ana-pacueco DATABASE_URL=... node tools/jalar-empleados-zk.js --dry
//   (quita --dry para escribir en la base)
const ZKLib = require('node-zklib');
const { Pool } = require('pg');

const IP = process.env.ZK_IP || '192.168.0.80';
const PORT = parseInt(process.env.ZK_PORT || '4370', 10);
const SUC = process.env.SUCURSAL || 'santa-ana-pacueco';
const DRY = process.argv.includes('--dry');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  const zk = new ZKLib(IP, PORT, 10000, 4000);
  await zk.createSocket();
  let users = [];
  try {
    const res = await zk.getUsers();
    users = (res && res.data) || [];
  } finally {
    await zk.disconnect().catch(() => {});
  }

  console.log(`Usuarios leídos del reloj (${IP}): ${users.length}`);
  users.slice(0, 12).forEach(u => console.log(`   cod ${u.userId || u.uid} | ${u.name}`));
  if (users.length > 12) console.log(`   ...(+${users.length - 12} más)`);

  if (DRY) { console.log('(dry run: no se escribió nada en Postgres)'); await pool.end(); return; }

  let n = 0;
  for (const u of users) {
    const codigo = String(u.userId || u.uid || '').trim();
    if (!codigo) continue;
    const nombre = (u.name || '').trim() || `Empleado ${codigo}`;
    await pool.query(
      `INSERT INTO empleados (sucursal_id, codigo_checador, nombre, activo)
       VALUES ($1,$2,$3,true)
       ON CONFLICT (sucursal_id, codigo_checador) DO UPDATE SET nombre = EXCLUDED.nombre`,
      [SUC, codigo, nombre]
    );
    n++;
  }
  console.log(`Empleados cargados/actualizados en Postgres: ${n} (sucursal ${SUC})`);
  await pool.end();
})().catch(e => { console.error('ERROR:', e.message || e); process.exit(1); });
