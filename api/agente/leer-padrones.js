// api/agente/leer-padrones.js
//
// SOLO LECTURA. Lee la lista de usuarios enrolados en cada reloj del padrón y
// la guarda en un JSON, para compararla contra las fichas del sistema.
// Uso (con el servicio del agente DETENIDO: un reloj acepta una sola sesión):
//   node leer-padrones.js salida.json
const fs = require('fs');
const path = require('path');
const { conectar, cerrar, motivo } = require('../tools/lectura-verificada');
const { leerUsuarios } = require('../tools/lector-zk');
const { Enviador } = require('./enviar');

(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  const env = new Enviador(cfg, () => {});
  const relojes = (await env.padron()).filter((r) => r.modo === 'agente');
  const salida = [];
  for (const r of relojes) {
    const t0 = Date.now();
    let zk = null;
    try {
      zk = await conectar(r.ip, { puerto: r.puerto, commKey: r.commKey, timeoutMs: 20000 });
      const usuarios = await leerUsuarios(zk);
      salida.push({ serie: r.serie, sucursalId: r.sucursalId, alias: r.alias,
        usuarios: usuarios.map((u) => ({ codigo: String(u.userId || u.uid).trim(), nombre: (u.name || '').trim() })) });
      console.log(`${(r.alias || r.serie).padEnd(32)} ${String(usuarios.length).padStart(4)} usuarios (${Date.now() - t0} ms)`);
    } catch (e) {
      salida.push({ serie: r.serie, sucursalId: r.sucursalId, alias: r.alias, error: motivo(e) });
      console.log(`${(r.alias || r.serie).padEnd(32)} ERROR: ${motivo(e)}`);
    } finally {
      if (zk) { try { await cerrar(zk); } catch { /* ya estaba */ } }
    }
  }
  fs.writeFileSync(process.argv[2] || 'padrones.json', JSON.stringify(salida, null, 1));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
