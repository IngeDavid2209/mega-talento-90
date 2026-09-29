// api/tools/sembrar-departamentos.js
//
// Siembra departamento + nombre completo en `empleados`, a partir de lo que
// tools/parsear-reportes.py sacó de los PDFs semanales (reportes-sem33.json).
//
// - Para una plaza que YA tiene empleados (su reloj sincroniza): UPDATE por
//   (sucursal_id, codigo_checador).
// - Para una plaza sin empleados todavía (PH, Morelia Abastos: su reloj no baja):
//   INSERT, para que su acomodo quede listo desde antes.
//
// `nombre_completo` va aparte de `nombre`: no se pisa lo que RH haya corregido.
//
// Uso:  node tools/sembrar-departamentos.js --dry-run   (enseña qué haría)
//       node tools/sembrar-departamentos.js

try { require('dotenv').config(); } catch { /* dotenv opcional */ }
const { Pool } = require('pg');
const reportes = require('./reportes-sem33.json');

const DRY = process.argv.includes('--dry-run');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Reporte (archivo) → sucursal_id. Confirmado con el usuario el 18/08/2026.
const A_SUCURSAL = {
  'COMIDAS SEM 33 ADMIN.pdf': 'corporativo-comida',
  'REPORTE DE ASIS SEM 33 8E.pdf': '8-esquinas',
  'REPORTE DE ASIS SEM 33 ADMIN.pdf': 'corporativo',
  'REPORTE DE ASIS SEM 33 CANINDO.pdf': 'zamora-canindo',
  'REPORTE DE ASIS SEM 33 DAMASO.pdf': 'zamora-catedral',
  'REPORTE DE ASIS SEM 33 MADERO.pdf': 'morelia-vicente-guerrero',
  'REPORTE DE ASIS SEM 33 MORELIA ABASTOS.pdf': 'morelia-abastos',
  'REPORTE DE ASIS SEM 33 PABLP.pdf': 'la-piedad-abastos',
  'REPORTE DE ASIS SEM 33 PH.pdf': 'sucursal-ph',
  'REPORTE DE ASIS SEM 33 YURECUARO.pdf': 'yurecuaro-centro',
  'reporte de asis sem 33 cedis.pdf': 'cedis',
};

/** Limpia el nombre del departamento de anotaciones sueltas ("+1", números al final). */
function limpiarDepto(nom) {
  if (!nom || nom === '(sin nombre)') return null;
  // En MAYÚSCULAS, como los guarda el portal: "Sistemas" y "SISTEMAS" salían
  // como dos secciones distintas en el reporte (29/09/2026).
  return nom.replace(/\s*\+\d+\s*$/, '').replace(/\s{2,}/g, ' ').trim().toUpperCase() || null;
}
/** Nombre completo en Mayúscula Inicial, quitando basura de cola. */
function limpiarNombre(nom) {
  const limpio = String(nom || '').replace(/\s*\+\d+\s*$/, '').replace(/\s{2,}/g, ' ').trim();
  return limpio || null;
}

(async () => {
  const plan = [];   // {sucursal, codigo, depto, nombre, existe}
  for (const rep of reportes) {
    const suc = A_SUCURSAL[rep.archivo];
    if (!suc) { console.log(`⚠ sin sucursal para ${rep.archivo}, se salta`); continue; }
    for (const d of rep.departamentos) {
      const depto = limpiarDepto(d.nombre);
      for (const [codigo, nombre] of d.gente) {
        plan.push({ suc, codigo: String(codigo), depto, nombre: limpiarNombre(nombre) });
      }
    }
  }

  // ¿Cuáles ya existen?
  const { rows } = await pool.query('SELECT sucursal_id, codigo_checador FROM empleados');
  const existentes = new Set(rows.map((r) => `${r.sucursal_id}__${r.codigo_checador}`));

  let upd = 0, ins = 0;
  const porSuc = {};
  for (const p of plan) {
    const existe = existentes.has(`${p.suc}__${p.codigo}`);
    porSuc[p.suc] = porSuc[p.suc] || { upd: 0, ins: 0 };
    if (existe) { upd++; porSuc[p.suc].upd++; } else { ins++; porSuc[p.suc].ins++; }

    if (!DRY) {
      if (existe) {
        await pool.query(
          `UPDATE empleados SET departamento=$3, nombre_completo=$4
             WHERE sucursal_id=$1 AND codigo_checador=$2`,
          [p.suc, p.codigo, p.depto, p.nombre]
        );
      } else {
        // Plaza sin sincronizar (PH, Morelia Abastos): se crea el registro para
        // que su acomodo quede listo. nombre = nombre_completo (aún no hay apodo
        // del reloj que respetar).
        await pool.query(
          `INSERT INTO empleados (sucursal_id, codigo_checador, nombre, nombre_completo, departamento, activo)
           VALUES ($1,$2,$3,$3,$4,TRUE)
           ON CONFLICT (sucursal_id, codigo_checador) DO UPDATE
             SET departamento=EXCLUDED.departamento, nombre_completo=EXCLUDED.nombre_completo`,
          [p.suc, p.codigo, p.nombre, p.depto]
        );
      }
    }
  }

  console.log(`\n${DRY ? '(DRY RUN) ' : ''}${plan.length} personas · ${upd} actualizadas · ${ins} nuevas\n`);
  console.table(Object.entries(porSuc).map(([s, v]) => ({ sucursal: s, actualiza: v.upd, inserta: v.ins })));
  if (DRY) console.log('\n(DRY RUN: no se escribió nada. Corre sin --dry-run para aplicar.)');
  await pool.end();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
