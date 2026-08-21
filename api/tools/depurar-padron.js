// api/tools/depurar-padron.js
//
// BARRIDO DEL PADRÓN: quién sobra en `empleados`, plaza por plaza.
//
// ══ POR QUÉ NO ALCANZA CON "SIN CHECADAS EN 3 MESES" ══
//
// Ese criterio, solo, borra gente que sí trabaja aquí:
//
//   · Una plaza con el reloj caído deja a TODA su gente sin marcas. Morelia
//     Abastos llevaba desde siempre con cero checadas y su padrón de 60 personas
//     estaba completo y vigente: el 20/08/2026 se conectó su reloj y aparecieron
//     ocho meses de historia. Aplicar la regla el 19 habría borrado la plaza.
//   · Sucursal PH tiene 175 personas en el padrón y solo 79 códigos con marcas:
//     su padrón vino del REPORTE, no del reloj.
//   · Una incapacidad larga, una licencia o alguien que no checa por su puesto
//     se ven exactamente igual que una baja.
//
// La ausencia de dato no es la ausencia de la persona, y confundir las dos cosas
// aquí se paga borrando a alguien de nómina.
//
// ══ EL COTEJO ══
//
// RH pasó los reportes semanales oficiales (semana 33, uno por plaza). Ese es el
// padrón de quién SÍ está: si alguien aparece en cualquiera de ellos, está
// trabajando, con o sin checadas. Así que sobra quien cumple LAS DOS:
//
//   1. no tiene checadas en los últimos `--dias` (90 por omisión), y
//   2. no aparece en NINGÚN reporte de la semana 33.
//
// El empate de nombres contra el reporte es a propósito GENEROSO —basta con dos
// palabras compartidas—. Aquí los dos errores no cuestan lo mismo: empatar de
// más deja a alguien en el padrón (ruido), no empatar borra a alguien que
// trabaja. Ante la duda, se queda.
//
// ══ Y EL REPORTE TIENE QUE ESTAR COMPLETO ══
//
// Un reporte parcial es igual de peligroso que un reloj caído, y menos evidente.
// Medido en la carpeta del 21/08/2026: el de La Piedad traía 8 personas para un
// padrón de 60 con 44 marcando, y el de Yurécuaro 4 para 16. Cotejar contra eso
// habría dado de baja a plazas enteras "porque no aparecen en el reporte".
//
// Así que cada reporte se mide contra la gente que SÍ marcó el último mes en esa
// plaza. Si trae mucho menos que eso, no es autoridad para nadie: la plaza se
// protege y se dice por qué.
//
// Uso:
//   node tools/depurar-padron.js --reportes "C:/ruta/cotejo-docs" --dry-run
//   node tools/depurar-padron.js --reportes "C:/ruta/cotejo-docs" --baja
//   node tools/depurar-padron.js --reportes "C:/ruta/cotejo-docs" --borrar
//   ... --dias 120        (cambia la ventana de silencio)
//
// ══ BORRAR NO SIRVE: LA FICHA REVIVE. USA --baja ══
//
// Medido el 21/08/2026, y con reloj en mano. Se borraron 503 fichas y diez
// minutos después las 10 de Zamora Catedral estaban de vuelta, con `creado_en`
// de las 19:40 —minutos después del borrado—.
//
// La causa está en el upsert de la ingesta (src/ingesta.ts):
//
//     INSERT INTO empleados (sucursal_id, codigo_checador, nombre, activo)
//     VALUES ($1,$2,$3,true)
//     ON CONFLICT (sucursal_id, codigo_checador) DO UPDATE SET nombre = …
//
// Fíjate en lo que el UPDATE NO toca: `activo`. De ahí sale todo:
//
//   · Si la ficha EXISTE, cada lote solo le repasa el nombre. Un `activo=FALSE`
//     puesto a mano se queda puesto para siempre.
//   · Si la ficha NO existe porque se borró, el lote siguiente entra por el
//     INSERT y la repone con `activo = true`. El borrado se deshace solo, sin
//     error y sin que nadie se entere.
//
// Y la ficha vuelve porque la persona SIGUE ENROLADA EN EL RELOJ: el equipo
// manda su padrón completo en cada lote. Borrarla de la base sin darla de baja
// en el equipo es discutir con el reloj, y el reloj tiene la última palabra.
//
// Por eso `--baja` es el modo bueno: sobrevive a la ingesta, conserva el nombre
// que RH haya corregido a mano y el `candidato_id` que liga a la persona con su
// contratación (de ahí sale el KPI de permanencia a 90 días). Las checadas no se
// pierden en ningún caso: guardan su propio `empleado_nombre`.
//
// `--borrar` se queda, pero exige `--si-de-verdad` y sirve para un solo caso:
// fichas cuyo código YA NO ESTÁ enrolado en el reloj, que son las únicas que no
// pueden volver.

try { require('dotenv').config(); } catch { /* dotenv opcional */ }
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Pool } = require('pg');

const ARGS = process.argv.slice(2);
const valor = (n) => { const i = ARGS.indexOf(n); return i >= 0 ? ARGS[i + 1] : null; };
const DIR_REPORTES = valor('--reportes');
const DIAS = parseInt(valor('--dias') || '90', 10);
const MODO = ARGS.includes('--borrar') ? 'borrar' : ARGS.includes('--baja') ? 'baja' : 'dry-run';
if (MODO === 'borrar' && !ARGS.includes('--si-de-verdad')) {
  console.error('--borrar NO se sostiene: la ingesta repone la ficha con activo=true en el',
    'siguiente lote, porque la persona sigue enrolada en el reloj. Se midió el 21/08/2026.');
  console.error('Usa --baja (sobrevive a la ingesta) o, si de verdad quieres borrar, agrega --si-de-verdad.');
  process.exit(1);
}
// Un borrado de cientos de filas sin respaldo no se puede deshacer. Con el
// respaldo, si manana aparece alguien que no debia salir, se vuelve a meter.
const RESPALDO = valor('--respaldo');

if (!DIR_REPORTES) {
  console.error('Falta --reportes con la carpeta de los PDF del reporte semanal.');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const limpia = (s) => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
const PART = new Set(['del', 'las', 'los', 'san', 'santa']);
const palabras = (s) => limpia(s).split(' ').filter((w) => w.length >= 3 && !PART.has(w));
const clave = (s) => palabras(s).slice().sort().join(' ');

/** Lee los reportes con el parser que ya existe (tools/parsear-reportes.py). */
function leerReportes(dir) {
  const tmp = path.join(os.tmpdir(), `reportes-${Date.now()}.json`);
  execFileSync('python', [path.join(__dirname, 'parsear-reportes.py'), dir, '--json', tmp],
    { stdio: ['ignore', 'ignore', 'inherit'] });
  const crudo = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  fs.unlinkSync(tmp);

  // La forma es EXACTA y se recorre así a propósito:
  //   [ { archivo, titulo, rango, departamentos: [ { codigo, nombre, gente: [[cod, nombre], …] } ] } ]
  //
  // El primer intento aplanaba el JSON buscando cualquier campo `nombre`, y eso
  // recogía el nombre del DEPARTAMENTO en vez de la gente: 64 nombres en lugar de
  // 366. Con el cotejo así de vacío el barrido marcaba 601 fichas de sobra —media
  // empresa— y ninguna plaza empataba con su propio reporte. Recorrer a ciegas
  // una estructura que se conoce es como se llega a un borrado masivo.
  const salida = [];
  for (const rep of crudo) {
    const nombres = [];
    for (const dep of rep.departamentos || []) {
      for (const g of dep.gente || []) {
        const nom = Array.isArray(g) ? g[1] : g && g.nombre;
        if (typeof nom === 'string' && nom.trim()) nombres.push(nom.trim());
      }
    }
    salida.push({ archivo: rep.archivo, nombres });
  }
  const total = salida.reduce((t, r) => t + r.nombres.length, 0);
  if (!total) throw new Error('los reportes no dieron ni un nombre: no se puede cotejar nada');
  return salida;
}

/** Fracción del padrón activo que debe traer un reporte para darlo por completo. */
const COBERTURA_MIN = 0.6;

(async () => {
  const reportes = leerReportes(DIR_REPORTES);
  const nombresReporte = reportes.flatMap((r) => r.nombres);
  const claves = new Set(nombresReporte.map(clave).filter(Boolean));
  const bolsaPalabras = nombresReporte.map(palabras);

  /** ¿Aparece en algún reporte? Generoso a propósito: ante la duda, se queda. */
  const estaEnReporte = (nombre) => {
    const k = clave(nombre);
    if (k && claves.has(k)) return true;
    const p = palabras(nombre);
    if (p.length < 2) return false;
    return bolsaPalabras.some((r) => p.filter((w) => r.includes(w)).length >= 2);
  };

  const emp = await pool.query(
    `SELECT e.id, e.sucursal_id, e.codigo_checador, e.activo, e.es_promotora, e.departamento,
            e.candidato_id,
            COALESCE(NULLIF(btrim(e.nombre_completo),''), e.nombre) AS nombre,
            (SELECT max(c.fecha) FROM checadas c
              WHERE c.sucursal_id = e.sucursal_id AND c.empleado_codigo = e.codigo_checador) AS ultima
       FROM empleados e`);

  // Lo último que se vio en CADA plaza: si el reloj de la plaza está callado, el
  // silencio de su gente no dice nada de ellos.
  const plaza = await pool.query(
    `SELECT sucursal_id, max(fecha) AS ultima, count(*)::int AS checadas
       FROM checadas GROUP BY sucursal_id`);
  const ultimaPlaza = new Map(plaza.rows.map((r) => [r.sucursal_id, r.ultima]));

  // Cuánta gente marcó el ÚLTIMO MES en cada plaza: es la medida contra la que
  // se juzga si su reporte viene completo.
  const act = await pool.query(
    `SELECT sucursal_id, count(DISTINCT empleado_codigo)::int AS n
       FROM checadas WHERE fecha >= $1 GROUP BY sucursal_id`,
    [new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)]);
  const activosPlaza = new Map(act.rows.map((r) => [r.sucursal_id, r.n]));

  // A qué plaza pertenece cada reporte: la que más nombres exactos comparte.
  // No se adivina por el nombre del archivo —"PABLP", "DAMASO", "MADERO" no se
  // parecen a ningún slug— sino por su contenido.
  const padronPorSuc = new Map();
  for (const e of emp.rows) {
    if (!padronPorSuc.has(e.sucursal_id)) padronPorSuc.set(e.sucursal_id, new Set());
    padronPorSuc.get(e.sucursal_id).add(clave(e.nombre));
  }
  const reportePorSuc = new Map();
  for (const r of reportes) {
    const ks = r.nombres.map(clave);
    let mejor = null, max = 0;
    for (const [suc, set] of padronPorSuc) {
      const n = ks.filter((k) => k && set.has(k)).length;
      if (n > max) { max = n; mejor = suc; }
    }
    if (mejor) {
      const prev = reportePorSuc.get(mejor);
      // Dos archivos pueden ser de la misma sede (oficinas: jornada y comida):
      // se suman, no se pisan.
      reportePorSuc.set(mejor, { archivos: [...(prev?.archivos || []), r.archivo], gente: (prev?.gente || 0) + r.nombres.length });
    }
  }

  const hoy = new Date();
  const corte = new Date(hoy.getTime() - DIAS * 86400000).toISOString().slice(0, 10);
  const dias = (iso) => iso ? Math.round((hoy - new Date(iso + 'T12:00:00')) / 86400000) : null;

  console.log(`\n──── Barrido del padrón${MODO === 'dry-run' ? ' (DRY RUN: no escribe)' : ` · modo ${MODO.toUpperCase()}`} ────\n`);
  console.log(`  reportes: ${nombresReporte.length} personas en la semana 33`);
  console.log(`  padrón:   ${emp.rows.length} fichas`);
  console.log(`  silencio: sin checadas desde antes del ${corte} (${DIAS} días)\n`);

  const porSuc = new Map();
  for (const e of emp.rows) {
    if (!porSuc.has(e.sucursal_id)) porSuc.set(e.sucursal_id, []);
    porSuc.get(e.sucursal_id).push(e);
  }

  const sobran = [];
  const protegidas = [];
  for (const [suc, gente] of [...porSuc.entries()].sort()) {
    const ultPlaza = ultimaPlaza.get(suc) || null;
    // Si la plaza entera no ha reportado en la ventana, no se toca a nadie.
    const plazaCallada = !ultPlaza || ultPlaza < corte;

    // Y tampoco se toca si su reporte no existe o viene corto: sin autoridad
    // completa, "no aparece en el reporte" no significa nada.
    const rep33 = reportePorSuc.get(suc);
    const activos = activosPlaza.get(suc) || 0;
    const sinReporte33 = !rep33;
    const reporteCorto = !!rep33 && activos > 0 && rep33.gente < activos * COBERTURA_MIN;
    const motivo = plazaCallada ? `PLAZA CALLADA (última checada ${ultPlaza || 'nunca'})`
      : sinReporte33 ? 'SIN REPORTE en la carpeta'
      : reporteCorto ? `REPORTE CORTO (${rep33.gente} en el reporte vs ${activos} marcando el último mes)`
      : '';

    const callados = gente.filter((e) => !e.ultima || e.ultima < corte);
    const sinReporte = callados.filter((e) => !estaEnReporte(e.nombre));
    const conReporte = callados.length - sinReporte.length;

    console.log(`  ${suc.padEnd(26)} ${String(gente.length).padStart(4)} fichas · ` +
      `${String(callados.length).padStart(4)} calladas · ${String(conReporte).padStart(3)} en el reporte · ` +
      `sobran ${String(motivo ? 0 : sinReporte.length).padStart(3)}` +
      (motivo ? `   ⚠ ${motivo}: no se toca` : ''));

    if (motivo) protegidas.push({ suc, fichas: gente.length, motivo });
    else sobran.push(...sinReporte.map((e) => ({ ...e, suc })));
  }

  console.log('');
  if (protegidas.length) {
    console.log(`  ${protegidas.length} plaza(s) protegida(s) por falta de AUTORIDAD, no por su gente:`);
    for (const p of protegidas) console.log(`     ${p.suc.padEnd(26)} ${p.fichas} fichas · ${p.motivo}`);
    console.log('');
  }

  console.log(`  ── SOBRAN: ${sobran.length} fichas ──`);
  const conCandidato = sobran.filter((e) => e.candidato_id).length;
  const nunca = sobran.filter((e) => !e.ultima).length;
  for (const e of sobran.sort((a, b) => a.suc.localeCompare(b.suc) || Number(a.codigo_checador) - Number(b.codigo_checador))) {
    console.log(`     ${e.suc.padEnd(26)} #${String(e.codigo_checador).padStart(3)} ` +
      `${String(e.nombre).slice(0, 32).padEnd(32)} ` +
      (e.ultima ? `última ${e.ultima} (${dias(e.ultima)} días)` : 'NUNCA checó') +
      (e.es_promotora ? ' · promotora' : '') +
      (e.candidato_id ? ' · ligada a su contratación' : ''));
  }
  console.log('');
  console.log(`  ${nunca} nunca checaron · ${conCandidato} tienen liga con su contratación (se pierde al borrar)`);

  if (MODO === 'dry-run') { console.log('\n  (DRY RUN: no se escribió nada.)'); await pool.end(); return; }
  if (!sobran.length) { console.log('\n  Nada que hacer.'); await pool.end(); return; }

  // El respaldo se escribe ANTES de tocar la base, y si no se puede escribir, no
  // se toca nada: es la unica forma de deshacer un borrado masivo.
  const destino = RESPALDO || path.join(DIR_REPORTES, `respaldo-padron-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(destino, JSON.stringify({
    generado: new Date().toISOString(), modo: MODO, dias: DIAS,
    criterio: 'sin checadas en la ventana Y sin aparecer en ningun reporte de la semana 33',
    fichas: sobran.map((e) => ({
      sucursalId: e.suc, codigo: e.codigo_checador, nombre: e.nombre,
      departamento: e.departamento, esPromotora: e.es_promotora,
      candidatoId: e.candidato_id, ultimaChecada: e.ultima, activo: e.activo,
    })),
  }, null, 1), 'utf8');
  console.log(`
  respaldo: ${destino}`);

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const ids = sobran.map((e) => e.id);
    const r = MODO === 'borrar'
      ? await cliente.query('DELETE FROM empleados WHERE id = ANY($1::uuid[])', [ids])
      : await cliente.query('UPDATE empleados SET activo = FALSE WHERE id = ANY($1::uuid[])', [ids]);
    await cliente.query('COMMIT');
    console.log(`\n  ✅ ${r.rowCount} fichas ${MODO === 'borrar' ? 'borradas' : 'dadas de baja (activo=FALSE)'}.`);
  } catch (e) {
    await cliente.query('ROLLBACK');
    console.error('\n  ❌ ROLLBACK, no se cambió nada:', e.message);
    process.exitCode = 1;
  } finally {
    cliente.release();
    await pool.end();
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
