// api/tools/exportar-nombres.js
//
// Genera el CSV que RH llena con los NOMBRES FORMALES que faltan, para
// reimportarlo con importar-nombres.js.
//
// ══ QUÉ ES CADA NOMBRE ══
//
// Una ficha tiene DOS nombres y no son intercambiables:
//   · `nombre`           el apodo con el que está enrolada en el reloj
//                        ("Luciagarciatapia", "Memo", "Dolores"). Sirve para
//                        reconocerla EN EL EQUIPO, y por eso no se toca.
//   · `nombre_completo`  el del reporte de RH ("GARCIA TAPIA LUCIA"). Es el que
//                        se firma, y es el que falta.
//
// Este CSV pide el segundo. Al 27/08/2026 faltaba en 157 de 484 fichas activas,
// y solo 1 se pudo recuperar del reporte semanal que ya se había parseado: los
// otros 156 no existen en ninguna parte del sistema. Solo RH los tiene.
//
// ══ POR QUÉ YA NO HAY UNA TABLA DE IPs AQUÍ ══
//
// La versión anterior llevaba las IPs a mano y se quedaron viejas (Yurécuaro en
// .44.37 cuando es .44.12, Canindo en .50.101 cuando es .50.12), y le faltaban
// cuatro plazas enteras —Morelia Abastos, Sucursal PH, Morelia Madero y el reloj
// sin identificar—, así que su gente no salía en el CSV y nadie podía corregirla.
// Ahora la IP y el alias salen del padrón `relojes`, que es donde viven de verdad
// y se actualizan solos cuando el agente reencuentra un equipo.
//
// Uso:
//   node tools/exportar-nombres.js                 (solo a quien le falta)
//   node tools/exportar-nombres.js --todos         (el padrón completo)
//   SALIDA=ruta.csv node tools/exportar-nombres.js

try { require('dotenv').config(); } catch { /* dotenv opcional */ }
const { Pool } = require('pg');
const fs = require('fs');

const TODOS = process.argv.includes('--todos');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
});

const csvSafe = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

(async () => {
  const { rows } = await pool.query(`
    SELECT e.sucursal_id, e.codigo_checador, e.nombre,
           COALESCE(NULLIF(btrim(e.nombre_completo), ''), '') AS nombre_completo,
           COALESCE(e.departamento, '') AS departamento,
           COALESCE(r.alias, '') AS reloj, COALESCE(r.ip, '') AS ip
      FROM empleados e
      LEFT JOIN LATERAL (
        SELECT alias, ip FROM relojes WHERE sucursal_id = e.sucursal_id AND activo
         ORDER BY alias LIMIT 1
      ) r ON TRUE
     WHERE e.activo
       ${TODOS ? '' : "AND NULLIF(btrim(e.nombre_completo), '') IS NULL"}
     ORDER BY e.sucursal_id, (e.codigo_checador)::int NULLS LAST, e.codigo_checador`);

  // `NombreFormal` va vacío a propósito cuando falta: es la columna que RH
  // llena. Si ya hay uno (con --todos) se manda, para que se vea y se pueda
  // corregir en vez de volver a escribirlo desde cero.
  const lineas = ['Sucursal,Reloj,IP,Codigo,ApodoEnElReloj,Departamento,NombreFormal'];
  for (const e of rows) {
    lineas.push([
      csvSafe(e.sucursal_id), csvSafe(e.reloj), csvSafe(e.ip),
      csvSafe(e.codigo_checador), csvSafe(e.nombre), csvSafe(e.departamento),
      csvSafe(e.nombre_completo),
    ].join(','));
  }

  const salida = process.env.SALIDA || `tools/analisis-nombres-faltantes.csv`;
  fs.writeFileSync(salida, '﻿' + lineas.join('\r\n'), 'utf8'); // BOM para Excel
  console.log(`CSV generado: ${salida} (${rows.length} fichas)`);
  if (!TODOS) console.log('Son las que NO tienen nombre formal. Con --todos sale el padrón completo.');
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
