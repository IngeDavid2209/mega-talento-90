// api/tools/marcar-promotoras.js
//
// MARCA COMO PROMOTORAS a la gente que viene en el concentrado de promotoría de
// RH, para que salgan en su propia sección y dejen de medirse con la vara del
// personal de piso.
//
// ══ POR QUÉ IMPORTA ══
//
// Una promotora no checa como el personal de planta: anda entre plazas y llena
// su marca donde le toca ese día. Medida con la misma vara sale con falta todos
// los días, y un tablero que grita a diario deja de mirarse. La app ya tiene el
// campo (`empleados.es_promotora`) y su sección aparte; lo que faltaba era saber
// QUIÉNES son, y eso solo lo sabe RH.
//
// ══ LA PISTA QUE NADIE HABÍA USADO: LA MARCA ══
//
// En el padrón del reloj muchas promotoras están enroladas por su MARCA y no por
// su nombre: "Delicias", "Hersheys", "Canels", "(TOTIS) DANIELA", "LA ROSA
// ALEJANDRA", "TANIA DELICIAS". Eso se veía como basura en el padrón, y en
// realidad es el dato: el concentrado trae NOMBRE y MARCA de cada una, así que
// la marca sirve de segunda llave cuando el nombre no empata.
//
// Se resuelve por niveles, del más seguro al más flojo:
//   1. nombre completo idéntico (palabras ordenadas)
//   2. dos o más palabras compartidas, UNA DE ELLAS POCO COMÚN
//   3. marca + una palabra del nombre  ("TANIA DELICIAS" ↔ Tania, DELICIAS)
//   4. la ficha del reloj ES la marca   ("Delicias", "Hersheys")
//
// El nivel 4 no identifica a una PERSONA sino a un PUESTO de promotora, y con
// eso basta para lo que se busca: esa ficha no se mide como personal de piso.
//
// ══ "DOS PALABRAS COMPARTIDAS" NO ALCANZA, Y CASI LO APLICO ══
//
// La primera versión pedía dos palabras iguales y nada más. Sobre el padrón
// real eso daba disparates: "Macias Perez María Guadalupe" de corporativo
// empataba con "MARIA GUADALUPE RODRIGUEZ HERNANDEZ" (marca CUETARA) porque
// comparten *maría* y *guadalupe*, y "HERNANDEZ CHAVEZ LUIS ANGEL" con "LUIS
// ANGEL CAZAREZ CONTRERAS" por *luis* y *ángel*.
//
// No es un detalle cosmético: marcar como promotora a alguien de oficina lo SACA
// de la medición de asistencia —es justo para eso que existe el campo—, así que
// un falso positivo aquí esconde a una persona del tablero sin que nadie lo note.
//
// Por eso el nivel 2 exige que al menos una de las palabras compartidas sea POCO
// COMÚN en el padrón (aparece en 1% o menos de los nombres). *Zamarripa* califica;
// *maría*, *guadalupe*, *luis* y *hernández* no. Es el mismo criterio que hace que
// un apellido raro identifique y un nombre de pila no.
//
// Y los empates de UNA SOLA palabra —el concentrado trae varias promotoras
// anotadas solo como "RAQUEL" o "MARIBEL"— no se aplican solos: se reportan
// aparte para que RH los confirme. Con `--incluir-dudosos` se aplican también.
//
// Uso:
//   node tools/marcar-promotoras.js --archivo "C:/ruta/CONCENTRADO.xlsx" --dry-run
//   node tools/marcar-promotoras.js --archivo "C:/ruta/CONCENTRADO.xlsx"
//   node tools/marcar-promotoras.js ... --nivel 3    (tope de nivel a aplicar)
//
// `xlsx` vive en las dependencias del front (raíz del repo), no en las de la
// API: este script es de escritorio, se corre a mano y no forma parte del
// servicio, así que se toma de ahí en vez de duplicar la dependencia.

try { require('dotenv').config(); } catch { /* dotenv opcional */ }
const path = require('path');
const { Pool } = require('pg');
const XLSX = require(path.join(__dirname, '..', '..', 'node_modules', 'xlsx'));

const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes('--dry-run');
const valor = (n) => { const i = ARGS.indexOf(n); return i >= 0 ? ARGS[i + 1] : null; };
const ARCHIVO = valor('--archivo');
const NIVEL_MAX = parseInt(valor('--nivel') || '4', 10);
// Los empates flojos (una sola palabra) se reportan pero no se aplican,
// salvo que se pidan a proposito.
const INCLUIR_DUDOSOS = ARGS.includes('--incluir-dudosos');

if (!ARCHIVO) {
  console.error('Falta --archivo con la ruta del concentrado de promotoría (.xlsx).');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const limpia = (s) => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ')
  .replace(/\s+/g, ' ').trim();
/**
 * Partículas que no identifican a nadie. Se ven como apellidos raros porque casi
 * ningún nombre del padrón las trae escritas, y con eso colaban empates como
 * "MARIA DEL PILAR" ↔ "MARIA DEL CARMEN" por compartir *del*.
 */
const PARTICULAS = new Set(['del', 'las', 'los', 'san', 'santa', 'dela', 'delos']);
const palabras = (s) => limpia(s).split(' ').filter((w) => w.length >= 3 && !PARTICULAS.has(w));
const clave = (s) => palabras(s).slice().sort().join(' ');

/**
 * ¿Está esta palabra en ese nombre?
 *
 * Se compara palabra por palabra, y solo se cae al empate por SUBCADENA cuando el
 * nombre de la ficha viene PEGADO —un solo token, como los escribe el reloj:
 * "Luciagarciatapia", "Fabiolatotis"—.
 *
 * Buscar la subcadena en cualquier nombre era una fuga grave: *rosa* aparece
 * dentro de "Rosario", así que "García Pérez Perla Del Rosario" —de oficina—
 * empataba con la promotora de LA ROSA, y *mora* dentro de "MORALES". Marcar a
 * alguien de oficina como promotora lo saca de la medición, así que la fuga no se
 * pagaba con ruido sino con una persona desaparecida del tablero.
 */
function contiene(nombre, w) {
  if (palabras(nombre).includes(w)) return 'palabra';
  const unSoloToken = limpia(nombre).split(' ').filter(Boolean).length === 1;
  if (unSoloToken && w.length >= 4 && limpia(nombre).includes(w)) return 'subcadena';
  return '';
}

/**
 * Saca las promotoras de cada hoja que tenga una fila de encabezados con NOMBRE
 * y MARCA. Las hojas de HORARIO se ignoran solas: no traen esa fila.
 */
function leerConcentrado(archivo) {
  const wb = XLSX.readFile(archivo);
  const out = [];
  for (const hoja of wb.SheetNames) {
    const filas = XLSX.utils.sheet_to_json(wb.Sheets[hoja], { header: 1, defval: '', raw: false });
    const iEnc = filas.findIndex((f) => f.some((c) => limpia(c) === 'nombre') && f.some((c) => limpia(c) === 'marca'));
    if (iEnc < 0) continue;
    const enc = filas[iEnc].map(limpia);
    const cNom = enc.indexOf('nombre');
    const cMarca = enc.indexOf('marca');
    const cEstatus = enc.findIndex((c) => c.startsWith('estatus'));
    for (const f of filas.slice(iEnc + 1)) {
      const nombre = String(f[cNom] || '').trim();
      if (!nombre || palabras(nombre).length === 0) continue;
      // Los pies de tabla ("TOTAL", "BAJAS") no son personas.
      if (/^(total|bajas?|altas?|nota)/i.test(limpia(nombre))) continue;
      out.push({
        hoja,
        nombre,
        marca: String(f[cMarca] || '').trim(),
        estatus: cEstatus >= 0 ? String(f[cEstatus] || '').trim() : '',
      });
    }
  }
  return out;
}

/**
 * Empata una promotora del concentrado con una ficha del padrón.
 * Devuelve { nivel, dudoso, porque } — nivel 0 es "no empata".
 */
function nivelDeEmpate(promo, emp, esRara) {
  const pNom = palabras(promo.nombre);
  const eNom = palabras(emp.nombre);

  if (clave(promo.nombre) && clave(promo.nombre) === clave(emp.nombre)) {
    // Un nombre de una sola palabra ("RAQUEL") empata por casualidad: hay dos
    // Raqueles distintas en la misma plaza y no se sabe cuál es la promotora.
    const flojo = pNom.length < 2;
    return { nivel: 1, dudoso: flojo, porque: flojo ? 'nombre de una sola palabra' : 'nombre idéntico' };
  }

  const compartidas = pNom.filter((w) => contiene(emp.nombre, w));
  const raras = compartidas.filter(esRara);
  if (compartidas.length >= 2 && raras.length >= 1) {
    // Si la palabra que identifica solo aparece PARTIDA dentro del nombre pegado,
    // el empate se sostiene de poco: *rosa* está dentro de "Mariarosario" sin que
    // eso la haga Rosa María. Se reporta y lo confirma RH.
    const porSubcadena = raras.every((w) => contiene(emp.nombre, w) === 'subcadena');
    return {
      nivel: 2, dudoso: porSubcadena,
      porque: `comparten ${raras.join(', ')}` + (porSubcadena ? ' (dentro del nombre pegado)' : ''),
    };
  }

  const marcaPalabras = palabras(promo.marca).filter((w) => w.length >= 4);
  const marcaEnFicha = marcaPalabras.length > 0 &&
    marcaPalabras.some((w) => contiene(emp.nombre, w));
  if (marcaEnFicha) {
    // La marca y ADEMÁS algo de su nombre: es ella, escrita como la escribe el
    // reloj ("TANIA DELICIAS"). La marca ya es una llave fuerte, así que aquí no
    // se pide rareza: el nombre solo confirma.
    if (compartidas.length >= 1) {
      return { nivel: 3, dudoso: false, porque: `marca ${promo.marca} + ${compartidas.join(', ')}` };
    }
    // Solo la marca: la ficha es el PUESTO de esa marca. No identifica a una
    // persona, pero tampoco es personal de piso.
    if (eNom.every((w) => marcaPalabras.includes(w) || w.length < 4)) {
      return { nivel: 4, dudoso: false, porque: `la ficha es la marca ${promo.marca}` };
    }
  }
  return { nivel: 0, dudoso: false, porque: '' };
}

(async () => {
  const promos = leerConcentrado(ARCHIVO);
  const emp = await pool.query(
    `SELECT id, sucursal_id, codigo_checador, es_promotora,
            COALESCE(NULLIF(btrim(nombre_completo),''), nombre) AS nombre
       FROM empleados WHERE nombre IS NOT NULL AND btrim(nombre) <> ''`);

  console.log(`\n──── Marcar promotoras ${DRY_RUN ? '(DRY RUN: no escribe) ' : ''}────\n`);
  console.log(`  concentrado: ${promos.length} promotoras en ${new Set(promos.map((p) => p.hoja)).size} hojas`);
  console.log(`  padrón: ${emp.rows.length} fichas · ya marcadas: ${emp.rows.filter((e) => e.es_promotora).length}`);

  // Qué tan común es cada palabra en el padrón. Es lo que separa un apellido que
  // identifica de un nombre de pila que empata con media plaza.
  const frec = new Map();
  for (const e of emp.rows) {
    for (const w of new Set(palabras(e.nombre))) frec.set(w, (frec.get(w) || 0) + 1);
  }
  const TOPE_RARA = Math.max(3, Math.round(emp.rows.length * 0.01));
  const esRara = (w) => !PARTICULAS.has(w) && (frec.get(w) || 0) <= TOPE_RARA;
  console.log(`  una palabra cuenta como poco común con ${TOPE_RARA} apariciones o menos\n`);

  // Cada ficha se queda con su MEJOR empate (el nivel más bajo).
  const porFicha = new Map();
  for (const p of promos) {
    for (const e of emp.rows) {
      const r = nivelDeEmpate(p, e, esRara);
      if (!r.nivel || r.nivel > NIVEL_MAX) continue;
      const prev = porFicha.get(e.id);
      // Un empate seguro le gana a uno dudoso aunque el dudoso sea de nivel más bajo.
      const mejor = !prev || (prev.dudoso && !r.dudoso) ||
        (prev.dudoso === r.dudoso && r.nivel < prev.nivel);
      if (mejor) porFicha.set(e.id, { emp: e, promo: p, ...r });
    }
  }

  const NOMBRE_NIVEL = {
    1: 'nombre idéntico', 2: 'apellido poco común compartido',
    3: 'marca + nombre', 4: 'la ficha es la marca',
  };
  const pinta = (m) => {
    const ya = m.emp.es_promotora ? ' [ya estaba]' : '';
    console.log(`     ${m.emp.sucursal_id.padEnd(26)} #${String(m.emp.codigo_checador).padStart(3)} ` +
                `${String(m.emp.nombre).slice(0, 30).padEnd(30)} ← ${String(m.promo.nombre).slice(0, 28).padEnd(28)} ` +
                `${String(m.promo.marca).slice(0, 14).padEnd(14)} · ${m.porque}${ya}`);
  };
  const orden = (a, b) => a.emp.sucursal_id.localeCompare(b.emp.sucursal_id) ||
    Number(a.emp.codigo_checador) - Number(b.emp.codigo_checador);

  const seguros = [...porFicha.values()].filter((m) => !m.dudoso);
  const dudosos = [...porFicha.values()].filter((m) => m.dudoso);

  for (const nivel of [1, 2, 3, 4]) {
    const lista = seguros.filter((m) => m.nivel === nivel).sort(orden);
    if (!lista.length) continue;
    console.log(`  ── nivel ${nivel}: ${NOMBRE_NIVEL[nivel]} (${lista.length}) ──`);
    lista.forEach(pinta);
    console.log('');
  }
  if (dudosos.length) {
    console.log(`  ── POR CONFIRMAR, no se aplican (${dudosos.length}) ──`);
    console.log(`     El concentrado las trae con una sola palabra, y esa palabra empata`);
    console.log(`     con más de una persona. Con --incluir-dudosos se aplican también.`);
    dudosos.sort(orden).forEach(pinta);
    console.log('');
  }

  // Las del concentrado que no aparecen en ningún reloj: no se pueden marcar,
  // pero hay que decirlo — es padrón que RH todavía no ha dado de alta.
  const empatadas = new Set([...porFicha.values()].map((m) => m.promo.nombre + '|' + m.promo.hoja));
  const sinFicha = promos.filter((p) => !empatadas.has(p.nombre + '|' + p.hoja));
  if (sinFicha.length) {
    console.log(`  ── sin ficha en ningún reloj (${sinFicha.length}) ──`);
    for (const p of sinFicha) {
      console.log(`     ${p.hoja.padEnd(12)} ${String(p.nombre).slice(0, 34).padEnd(34)} ${p.marca}` +
                  (p.estatus ? ` · ${p.estatus}` : ''));
    }
    console.log('');
  }

  const aplicables = INCLUIR_DUDOSOS ? [...porFicha.values()] : seguros;
  const porMarcar = aplicables.filter((m) => !m.emp.es_promotora);
  console.log(`  ${porFicha.size} fichas empatadas (${seguros.length} seguras, ${dudosos.length} por confirmar) · ` +
              `${porMarcar.length} por marcar`);

  if (DRY_RUN) { console.log('\n  (DRY RUN: no se escribió nada.)'); await pool.end(); return; }
  if (!porMarcar.length) { console.log('\n  Nada que cambiar.'); await pool.end(); return; }

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const r = await cliente.query(
      `UPDATE empleados SET es_promotora = TRUE WHERE id = ANY($1::uuid[])`,
      [porMarcar.map((m) => m.emp.id)]);
    await cliente.query('COMMIT');
    console.log(`\n  ✅ ${r.rowCount} fichas marcadas como promotoras.`);
  } catch (e) {
    await cliente.query('ROLLBACK');
    console.error('\n  ❌ ROLLBACK, no se cambió nada:', e.message);
    process.exitCode = 1;
  } finally {
    cliente.release();
    await pool.end();
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
