// api/tools/fundir-reloj-comida.js
//
// FUNDE `corporativo-comida` DENTRO DE `corporativo`.
//
// ══ POR QUÉ ERAN DOS PLAZAS ══
//
// El reloj de comida de oficinas (192.168.0.81, serie CLXK233460626) es la MISMA
// GENTE de corporativo con OTRA numeración. Se le dio plaza propia el 05/08/2026
// justamente para no revolver códigos: jalarlo dentro de corporativo por código
// le habría atribuido las marcas a la persona equivocada. La nota de
// tools/targets.json lo dice y deja el pendiente: "Fundirlo con corporativo es
// el paso siguiente, vía reloj_codigo_map".
//
// ══ POR QUÉ NO SE PUEDE HACER CON EL PATRÓN +100 ══
//
// El patrón general es +100 (#5 de comida es el #105 de corporativo) y aguanta en
// 32 de 34 casos. Los otros dos están CRUZADOS, y eso es lo que arruina todo:
//
//     #26 es Viviana Flores    → en corporativo es #108 (el +100 daría #126)
//     #8  es Claudia Martínez  → en corporativo es #126 (el +100 daría #108)
//
// O sea que el +100 le pondría a Viviana las marcas de Claudia y al revés. Por
// eso la traducción se arma por NOMBRE y el +100 solo CORROBORA.
//
// ══ CÓMO SE RESUELVE CADA CÓDIGO ══
//
//   1. nombre idéntico (normalizado, palabras ordenadas)      → se acepta
//   2. apellidos compartidos (2+ palabras de 3+ letras) Y +100 → se acepta
//   3. un nombre contenido en el otro ("Camila" ⊂ "Verdines
//      Naranjo Camila Judith") Y +100                         → se acepta
//   4. una palabra es prefijo de la otra ("Ariz" ~ "Arizbeth")
//      Y +100                                                 → se acepta
//   5. cualquier otra cosa                                    → NO se traduce
//
// Los niveles 2 a 4 EXIGEN el +100. Sin esa corroboración, un parecido de
// nombres no alcanza para mover marcas de una persona a otra.
//
// Uso:
//   node tools/fundir-reloj-comida.js --dry-run     (enseña todo, no escribe)
//   node tools/fundir-reloj-comida.js
//
// Es idempotente: se puede correr dos veces sin duplicar nada.

try { require('dotenv').config(); } catch { /* dotenv opcional */ }
const { Pool } = require('pg');

const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes('--dry-run');

const ORIGEN = 'corporativo-comida';
const DESTINO = 'corporativo';
const SERIE = 'CLXK233460626';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

/** Palabras del nombre, sin acentos ni puntuación, en minúsculas. */
const palabras = (s) => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z ]/g, ' ')
  .split(/\s+/).filter(Boolean);
const clave = (s) => palabras(s).slice().sort().join(' ');
const largas = (s) => palabras(s).filter((w) => w.length >= 3);

/** ¿Alguna palabra de A es prefijo de una de B, o al revés? (4+ letras) */
function hayPrefijo(a, b) {
  for (const x of a) for (const y of b) {
    if (x.length >= 4 && y.length >= 4 && (x.startsWith(y) || y.startsWith(x))) return true;
  }
  return false;
}

/** Resuelve un empleado del reloj de comida contra el padrón de corporativo. */
function resolver(comida, corpPorClave, corpPorCodigo) {
  const cod = String(comida.codigo_checador).trim();
  const mas100 = corpPorCodigo.get(String(Number(cod) + 100)) || null;
  const codigoMas100 = mas100 ? String(mas100.codigo_checador).trim() : null;

  const exacto = corpPorClave.get(clave(comida.nom));
  if (exacto) {
    return { destino: String(exacto.codigo_checador).trim(), nivel: 'nombre idéntico', nombreDestino: exacto.nom };
  }
  // Los niveles siguientes NO se aplican sin el +100: un parecido de nombres, solo,
  // no alcanza para mover las marcas de una persona a otra.
  if (!mas100) return { destino: null, nivel: 'sin +100 y sin nombre', nombreDestino: null };

  const a = largas(comida.nom), b = largas(mas100.nom);
  const compartidas = a.filter((w) => b.includes(w));
  if (compartidas.length >= 2) {
    return { destino: codigoMas100, nivel: `apellidos compartidos (${compartidas.join(', ')}) + 100`, nombreDestino: mas100.nom };
  }
  const setA = new Set(a), setB = new Set(b);
  const contenido = a.length && a.every((w) => setB.has(w)) ? 'comida ⊂ corporativo'
    : (b.length && b.every((w) => setA.has(w)) ? 'corporativo ⊂ comida' : null);
  if (contenido) {
    return { destino: codigoMas100, nivel: `nombre contenido (${contenido}) + 100`, nombreDestino: mas100.nom };
  }
  if (hayPrefijo(a, b)) {
    return { destino: codigoMas100, nivel: 'apodo por prefijo + 100', nombreDestino: mas100.nom };
  }
  return { destino: null, nivel: 'el +100 apunta a otra persona', nombreDestino: mas100.nom };
}

(async () => {
  const emp = await pool.query(
    `SELECT sucursal_id, codigo_checador, COALESCE(NULLIF(btrim(nombre_completo),''), nombre) AS nom
       FROM empleados WHERE sucursal_id = ANY($1)`, [[ORIGEN, DESTINO]]);
  const corp = emp.rows.filter((e) => e.sucursal_id === DESTINO);
  const com = emp.rows.filter((e) => e.sucursal_id === ORIGEN);
  const corpPorClave = new Map(corp.map((e) => [clave(e.nom), e]));
  const corpPorCodigo = new Map(corp.map((e) => [String(e.codigo_checador).trim(), e]));

  const marcas = await pool.query(
    `SELECT empleado_codigo, count(*)::int AS n FROM checadas WHERE sucursal_id=$1 GROUP BY empleado_codigo`,
    [ORIGEN]);
  const porCodigo = new Map(marcas.rows.map((m) => [String(m.empleado_codigo).trim(), m.n]));

  console.log(`\n──── Fundir ${ORIGEN} → ${DESTINO} ${DRY_RUN ? '(DRY RUN: no escribe)' : ''} ────\n`);
  console.log(`  padrón: ${com.length} en comida · ${corp.length} en corporativo`);
  console.log(`  checadas por mover: ${[...porCodigo.values()].reduce((a, b) => a + b, 0)}\n`);

  const traducciones = [];
  const sinResolver = [];
  for (const c of com) {
    const cod = String(c.codigo_checador).trim();
    const r = resolver(c, corpPorClave, corpPorCodigo);
    const n = porCodigo.get(cod) || 0;
    if (r.destino) traducciones.push({ cod, nom: c.nom, ...r, marcas: n });
    else sinResolver.push({ cod, nom: c.nom, ...r, marcas: n });
  }

  // Dos códigos distintos no pueden apuntar a la misma persona: sería mezclar
  // las marcas de dos personas en una.
  const destinos = new Map();
  for (const t of traducciones) destinos.set(t.destino, [...(destinos.get(t.destino) || []), t.cod]);
  const choques = [...destinos.entries()].filter(([, v]) => v.length > 1);

  for (const t of traducciones) {
    console.log(`  ✅ #${t.cod.padStart(3)} → #${t.destino.padStart(3)}  ${String(t.nom).slice(0, 32).padEnd(32)} ` +
                `${String(t.marcas).padStart(4)} marcas  · ${t.nivel}`);
  }
  if (sinResolver.length) {
    console.log(`\n  Sin traducir (sus marcas NO se mueven):`);
    for (const s of sinResolver) {
      console.log(`  ⏭  #${s.cod.padStart(3)}  ${String(s.nom).slice(0, 32).padEnd(32)} ` +
                  `${String(s.marcas).padStart(4)} marcas  · ${s.nivel}` +
                  (s.nombreDestino ? ` (sería ${s.nombreDestino})` : ''));
    }
  }
  if (choques.length) {
    console.log(`\n  ❌ COLISIONES: dos códigos apuntan a la misma persona. No se escribe nada.`);
    for (const [d, v] of choques) console.log(`     #${d} ← ${v.map((x) => '#' + x).join(', ')}`);
    await pool.end();
    process.exit(1);
  }

  const mueven = traducciones.reduce((t, x) => t + x.marcas, 0);
  const quedan = sinResolver.reduce((t, x) => t + x.marcas, 0);
  console.log(`\n  ${traducciones.length} códigos traducidos (${mueven} marcas) · ` +
              `${sinResolver.length} sin traducir (${quedan} marcas se quedan donde están)`);

  if (DRY_RUN) {
    console.log('\n  (DRY RUN: no se escribió nada.)');
    await pool.end();
    return;
  }

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');

    // 1) La traducción, para que las marcas que lleguen DESPUÉS entren derecho.
    for (const t of traducciones) {
      await cliente.query(
        `INSERT INTO reloj_codigo_map (serie, codigo_reloj, codigo_empleado, nota)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (serie, codigo_reloj) DO UPDATE
            SET codigo_empleado = EXCLUDED.codigo_empleado, nota = EXCLUDED.nota`,
        [SERIE, t.cod, t.destino, `${t.nom} · resuelto por ${t.nivel} (21/08/2026)`]);
    }

    // 2) El reloj pasa a ser de corporativo y sale de pausa: ya se sabe traducir.
    await cliente.query(
      `UPDATE relojes SET sucursal_id=$1, pendiente=FALSE,
              nota = COALESCE(nota,'') || ' — FUNDIDO en corporativo el 21/08/2026 con reloj_codigo_map.'
        WHERE serie=$2`, [DESTINO, SERIE]);

    // 3) Las marcas que ya estaban. La dedup_key se recalcula con el código
    //    traducido, y las que ya existan en corporativo a esa hora se descartan:
    //    ON CONFLICT no basta porque el histórico viejo tiene otra dedup_key.
    let movidas = 0, repetidas = 0;
    for (const t of traducciones) {
      const r = await cliente.query(
        `UPDATE checadas c
            SET sucursal_id = $1, empleado_codigo = $2,
                dedup_key = $3 || '__' || $2 || '__' || c.fecha_hora
          WHERE c.sucursal_id = $4 AND c.empleado_codigo = $5
            AND NOT EXISTS (
              SELECT 1 FROM checadas d
               WHERE d.sucursal_id = $1 AND d.empleado_codigo = $2 AND d.fecha_hora = c.fecha_hora)`,
        [DESTINO, t.destino, SERIE, ORIGEN, t.cod]);
      movidas += r.rowCount || 0;
      const q = await cliente.query(
        `SELECT count(*)::int AS n FROM checadas WHERE sucursal_id=$1 AND empleado_codigo=$2`,
        [ORIGEN, t.cod]);
      repetidas += q.rows[0].n;
    }

    // 4) El padrón de la plaza vieja: se conserva pero inactivo, no se borra.
    //    Son nombres que RH pudo haber corregido a mano, y borrarlos perdería ese
    //    trabajo sin necesidad. Al no tener plaza en el catálogo, no se ven.
    const emps = await cliente.query(
      `UPDATE empleados SET activo=FALSE WHERE sucursal_id=$1 AND activo=TRUE`, [ORIGEN]);

    await cliente.query('COMMIT');
    console.log(`\n  ✅ ${movidas} checadas movidas a ${DESTINO}`);
    if (repetidas) console.log(`     ${repetidas} se quedaron: ya existía una marca de esa persona a esa hora`);
    console.log(`     ${traducciones.length} traducciones en reloj_codigo_map`);
    console.log(`     ${emps.rowCount} empleados de ${ORIGEN} pasaron a inactivos (no se borran)`);
  } catch (e) {
    await cliente.query('ROLLBACK');
    console.error('\n  ❌ ROLLBACK, no se cambió nada:', e.message);
    process.exitCode = 1;
  } finally {
    cliente.release();
    await pool.end();
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
