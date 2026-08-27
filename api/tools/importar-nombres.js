// api/tools/importar-nombres.js
//
// Reimporta el CSV que RH llenó (exportar-nombres.js) y guarda el NOMBRE FORMAL.
// Match por sucursal + código.
//
// ══ ESCRIBE EN `nombre_completo`, NO EN `nombre` ══
//
// Antes hacía `UPDATE empleados SET nombre = ...` y además reescribía
// `checadas.empleado_nombre` de esa persona. Estaba mal por partida doble:
//
//   · `nombre` es el APODO DEL RELOJ ("Memo", "Dolores", "Luciagarciatapia").
//     Es como se le reconoce en el equipo, y pisarlo con el nombre formal
//     borraba el único dato que liga la ficha con lo que muestra el reloj. Es
//     el mismo error que ya se había corregido en la pantalla de RH, donde la
//     etiqueta decía "Nombre completo" y guardaba en `nombre`.
//   · Y no llenaba `nombre_completo`, que es lo que el CSV viene a resolver: la
//     ficha seguía contando como "sin nombre formal" después de importarla.
//
// La columna del CSV se llama ahora `NombreFormal`. Se acepta `NombreCorrecto`
// por compatibilidad con los archivos viejos que RH todavía tenga.
//
// Uso:
//   ARCHIVO="ruta.csv" node tools/importar-nombres.js --dry-run
//   ARCHIVO="ruta.csv" node tools/importar-nombres.js
const { Pool } = require('pg');
const fs = require('fs');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const DRY = process.argv.includes('--dry-run');

// El CSV nuevo trae el `sucursal_id` tal cual, asi que el mapa solo hace falta
// para los archivos viejos, que traian el nombre bonito de la plaza.
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
  const iSuc = head.indexOf('Sucursal'), iCod = head.indexOf('Codigo');
  const iNvo = head.indexOf('NombreFormal') >= 0 ? head.indexOf('NombreFormal') : head.indexOf('NombreCorrecto');
  if (iSuc < 0 || iCod < 0 || iNvo < 0) {
    console.error('El CSV necesita las columnas Sucursal, Codigo y NombreFormal.');
    process.exit(1);
  }
  let actualizados = 0, saltados = 0;
  for (const f of filas) {
    if (!f.length || !f[iCod]) continue;
    const nuevo = (f[iNvo] || '').trim();
    if (!nuevo) { saltados++; continue; }
    const crudo = (f[iSuc] || '').trim();
    const sucId = SUC_ID[crudo.toLowerCase()] || (/^[a-z0-9-]+$/.test(crudo) ? crudo : null);
    if (!sucId) { saltados++; continue; }
    const cod = String(f[iCod]).trim();
    if (DRY) {
      console.log(`  ${sucId} #${cod} -> ${nuevo}`);
      actualizados++;
      continue;
    }
    // Solo `nombre_completo`. El apodo del reloj (`nombre`) y el nombre pegado
    // en `checadas` se quedan como están: son el rastro de lo que dijo el equipo.
    const r = await pool.query(
      'UPDATE empleados SET nombre_completo=$3 WHERE sucursal_id=$1 AND codigo_checador=$2',
      [sucId, cod, nuevo]
    );
    actualizados += r.rowCount || 0;
  }
  console.log(`Nombres actualizados: ${actualizados} · sin cambio/omitidos: ${saltados}`);
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
