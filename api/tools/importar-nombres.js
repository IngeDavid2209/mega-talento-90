// Reimporta el CSV de nombres corregidos (columna NombreCorrecto) y actualiza
// los empleados. Match por sucursal + código. Uso:
//   ARCHIVO="ruta.csv" DATABASE_URL=... node tools/importar-nombres.js
const { Pool } = require('pg');
const fs = require('fs');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const SUC_ID = {
  'corporativo': 'corporativo', 'cedis': 'cedis',
  'canindo': 'zamora-canindo', 'damaso': 'zamora-catedral', 'dámaso': 'zamora-catedral',
  'la piedad abastos': 'la-piedad-abastos', 'yurecuaro': 'yurecuaro-centro', 'yurécuaro': 'yurecuaro-centro',
  '8 esquinas': '8-esquinas'
};

// Parser CSV mínimo que respeta comillas.
function parseCsv(texto) {
  const filas = [];
  let campo = '', fila = [], enComillas = false;
  texto = texto.replace(/^﻿/, '');
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (enComillas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') enComillas = false;
      else campo += c;
    } else {
      if (c === '"') enComillas = true;
      else if (c === ',') { fila.push(campo); campo = ''; }
      else if (c === '\n') { fila.push(campo); filas.push(fila); fila = []; campo = ''; }
      else if (c === '\r') { /* ignora */ }
      else campo += c;
    }
  }
  if (campo.length || fila.length) { fila.push(campo); filas.push(fila); }
  return filas;
}

(async () => {
  const archivo = process.env.ARCHIVO;
  if (!archivo) { console.error('Define ARCHIVO=ruta.csv'); process.exit(1); }
  const filas = parseCsv(fs.readFileSync(archivo, 'utf8'));
  const head = filas.shift().map(h => h.trim());
  const iSuc = head.indexOf('Sucursal'), iCod = head.indexOf('Codigo'), iNvo = head.indexOf('NombreCorrecto');
  let actualizados = 0, saltados = 0;
  for (const f of filas) {
    if (!f.length || !f[iCod]) continue;
    const nuevo = (f[iNvo] || '').trim();
    if (!nuevo) { saltados++; continue; }
    const sucId = SUC_ID[(f[iSuc] || '').trim().toLowerCase()];
    if (!sucId) { saltados++; continue; }
    const cod = String(f[iCod]).trim();
    const r = await pool.query(
      'UPDATE empleados SET nombre=$3 WHERE sucursal_id=$1 AND codigo_checador=$2',
      [sucId, cod, nuevo]
    );
    // También actualiza el nombre "pegado" en las checadas de esa persona.
    await pool.query(
      'UPDATE checadas SET empleado_nombre=$3 WHERE sucursal_id=$1 AND empleado_codigo=$2',
      [sucId, cod, nuevo]
    );
    actualizados += r.rowCount || 0;
  }
  console.log(`Nombres actualizados: ${actualizados} · sin cambio/omitidos: ${saltados}`);
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
