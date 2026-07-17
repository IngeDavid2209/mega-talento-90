// Genera un CSV con todos los empleados (por sucursal + IP + código + nombre
// actual) y una columna vacía "NombreCorrecto" para que RH escriba los nombres
// bien. Luego se reimporta con importar-nombres.js.
const { Pool } = require('pg');
const fs = require('fs');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const IPS = {
  'corporativo': '192.168.0.80',
  'cedis': '192.168.0.153',
  'zamora-canindo': '192.168.50.101',
  'zamora-catedral': '192.168.54.10',
  'la-piedad-abastos': '192.168.42.37',
  'yurecuaro-centro': '192.168.44.37',
  '8-esquinas': '192.168.40.11'
};
const NOMBRE_SUC = {
  'corporativo': 'Corporativo', 'cedis': 'CEDIS',
  'zamora-canindo': 'Canindo', 'zamora-catedral': 'Damaso',
  'la-piedad-abastos': 'La Piedad Abastos', 'yurecuaro-centro': 'Yurecuaro',
  '8-esquinas': '8 Esquinas'
};
const csvSafe = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

(async () => {
  const r = await pool.query('SELECT sucursal_id, codigo_checador, nombre FROM empleados ORDER BY sucursal_id, (codigo_checador)::int NULLS LAST, codigo_checador');
  const lineas = ['Sucursal,IP,Codigo,NombreActual,NombreCorrecto'];
  for (const e of r.rows) {
    lineas.push([
      csvSafe(NOMBRE_SUC[e.sucursal_id] || e.sucursal_id),
      csvSafe(IPS[e.sucursal_id] || ''),
      csvSafe(e.codigo_checador),
      csvSafe(e.nombre),
      '""'
    ].join(','));
  }
  const salida = process.env.SALIDA || 'nombres-empleados.csv';
  fs.writeFileSync(salida, '﻿' + lineas.join('\r\n'), 'utf8'); // BOM para Excel
  console.log(`CSV generado: ${salida} (${r.rows.length} empleados)`);
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
