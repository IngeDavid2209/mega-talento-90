// api/tools/mapear-codigos.js
//
// TRADUCE LA NUMERACIÓN DE UN RELOJ A LA DEL PADRÓN.
//
// ══ EL PROBLEMA ══
//
// El reloj 192.168.0.81 ("Oficinas desayuno y comida") tiene A LA MISMA GENTE
// que el de entrada/salida (192.168.0.80), pero numerada distinto: #11 es
// Alfonso, que en el padrón es #111; #6 es Perla (#106); #21 Ivonne (#121);
// #23 Carmen (#123).
//
// Jalarlo por código le atribuiría las marcas a la PERSONA EQUIVOCADA. Y eso no
// se nota mirando la pantalla: se ve un empleado con una comida registrada; no
// se ve que la comida era de alguien más. Por eso ese reloj está en pausa y sus
// lotes se guardan en `ingesta_lotes` sin aplicarse.
//
// ══ DE DÓNDE SALE LA PROPUESTA ══
//
// De la base de origen (`hr`), que ya ligó cada código de cada reloj a una
// PERSONA (`device_enrollments.employee_id`). Cruzando el reloj de comida con
// el de entrada/salida por esa persona, la traducción sale sola: no hay que
// adivinar por nombre.
//
// ══ POR QUÉ NO SE APLICA SOLA ══
//
// Porque el cruce de origen empata por nombre (`match_status='auto'`), y un
// empate de nombres NO es prueba. Equivocarse aquí ensucia a DOS personas a la
// vez: a una le sobran marcas y a la otra le faltan. La propuesta sale a un CSV
// para que RH la revise, y solo lo revisado se aplica.
//
// Uso:
//   node tools/mapear-codigos.js --proponer --ip 192.168.0.81 --contra 192.168.0.80
//   node tools/mapear-codigos.js --aplicar mapeo-<serie>.csv
//   node tools/mapear-codigos.js --estado --serie <serie>

try { require('dotenv').config(); } catch { /* dotenv opcional */ }
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const ARGS = process.argv.slice(2);
const val = (n) => { const i = ARGS.indexOf(n); return i >= 0 ? ARGS[i + 1] : null; };

const origen = new Pool({ connectionString: process.env.HR_DB_URL, ssl: false, connectionTimeoutMillis: 8000 });
const nuestra = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ── Proponer ─────────────────────────────────────────────────────────
async function proponer(ipOrigen, ipDestino) {
  const { rows: eq } = await origen.query(
    'SELECT serial_number, ip_address FROM hr.attendance_devices WHERE ip_address IN ($1,$2)',
    [ipOrigen, ipDestino]
  );
  const serie = eq.find((e) => e.ip_address === ipOrigen)?.serial_number;
  if (!serie) throw new Error(`no hay ningún equipo con IP ${ipOrigen} en hr.attendance_devices`);
  if (!eq.find((e) => e.ip_address === ipDestino)) throw new Error(`no existe el equipo de referencia ${ipDestino}`);

  const { rows } = await origen.query(
    `WITH a AS (
       SELECT en.employee_id, en.device_user_id AS cod, en.device_name AS nom
         FROM hr.device_enrollments en
         JOIN hr.attendance_devices d ON d.id = en.device_id
        WHERE d.ip_address = $1
     ), b AS (
       SELECT en.employee_id, en.device_user_id AS cod, en.device_name AS nom
         FROM hr.device_enrollments en
         JOIN hr.attendance_devices d ON d.id = en.device_id
        WHERE d.ip_address = $2
     )
     SELECT a.cod AS cod_origen, a.nom AS nom_origen,
            b.cod AS cod_destino, b.nom AS nom_destino
       FROM a LEFT JOIN b ON b.employee_id = a.employee_id AND a.employee_id IS NOT NULL
      ORDER BY (a.cod ~ '^[0-9]+$') DESC, nullif(regexp_replace(a.cod,'\\D','','g'),'')::bigint`,
    [ipOrigen, ipDestino]
  );

  // ¿Hay un patrón aritmético? En el .81 resultó ser exactamente "+100". Que la
  // regla y el cruce por persona digan LO MISMO es la mejor evidencia que se
  // puede tener sin preguntarle a cada empleado.
  const ligados = rows.filter((r) => r.cod_destino);
  const deltas = new Map();
  for (const r of ligados) {
    if (!/^\d+$/.test(r.cod_origen) || !/^\d+$/.test(r.cod_destino)) continue;
    const d = Number(r.cod_destino) - Number(r.cod_origen);
    deltas.set(d, (deltas.get(d) || 0) + 1);
  }
  const [mejorDelta, cuantos] = [...deltas.entries()].sort((a, b) => b[1] - a[1])[0] || [null, 0];
  const patron = cuantos >= ligados.length * 0.8 ? mejorDelta : null;

  console.log(`\n  Reloj ${ipOrigen} · serie ${serie} · ${rows.length} códigos`);
  console.log(`  ${ligados.length} ligan con alguien de ${ipDestino} · ${rows.length - ligados.length} NO ligan`);
  if (patron != null) {
    const concuerdan = ligados.filter((r) =>
      /^\d+$/.test(r.cod_origen) && Number(r.cod_destino) === Number(r.cod_origen) + patron).length;
    console.log(`  📐 Patrón detectado: código_destino = código_origen ${patron >= 0 ? '+' : '−'} ${Math.abs(patron)}` +
                `  (lo cumplen ${concuerdan} de ${ligados.length})`);
    console.log('     Que el cruce por persona y la regla aritmética coincidan es buena señal,');
    console.log('     pero NO sustituye la revisión: el cruce de origen empata por nombre.');
  }

  const filas = rows.map((r) => {
    const porPatron = patron != null && /^\d+$/.test(r.cod_origen)
      ? String(Number(r.cod_origen) + patron) : '';
    let confianza;
    if (r.cod_destino && r.cod_destino === porPatron) confianza = 'PERSONA+PATRON';
    else if (r.cod_destino) confianza = 'SOLO-PERSONA';
    else if (porPatron) confianza = 'SOLO-PATRON-REVISAR';
    else confianza = 'SIN-PROPUESTA';
    return {
      codigoReloj: r.cod_origen,
      // Los que solo tienen el patrón NO se rellenan: que RH los escriba a mano
      // es justo la barrera que queremos, porque son los dudosos.
      codigoEmpleado: r.cod_destino || '',
      confianza, nomOrigen: r.nom_origen || '', nomDestino: r.nom_destino || '',
      sugerenciaPatron: porPatron,
    };
  });

  const archivo = path.join(__dirname, `mapeo-${serie}.csv`);
  fs.writeFileSync(archivo, [
    'codigo_reloj,codigo_empleado,confianza,nombre_en_este_reloj,nombre_en_el_otro,sugerencia_por_patron',
    ...filas.map((f) => [
      f.codigoReloj, f.codigoEmpleado, f.confianza,
      `"${f.nomOrigen.replace(/"/g, "'")}"`, `"${f.nomDestino.replace(/"/g, "'")}"`,
      f.sugerenciaPatron,
    ].join(',')),
  ].join('\n'), 'utf8');

  const cuenta = filas.reduce((a, f) => (a[f.confianza] = (a[f.confianza] || 0) + 1, a), {});
  console.log('\n  ' + Object.entries(cuenta).map(([k, v]) => `${v} ${k}`).join(' · '));
  console.log(`\n  Propuesta escrita en: ${archivo}`);
  console.log('\n  QUÉ SIGUE:');
  console.log('   1. Ábrelo en Excel y revísalo CON RH, renglón por renglón.');
  console.log('   2. Llena `codigo_empleado` en los SOLO-PATRON-REVISAR y SIN-PROPUESTA,');
  console.log('      o bórrales el renglón si esa persona no existe en el otro reloj.');
  console.log(`   3. node tools/mapear-codigos.js --aplicar mapeo-${serie}.csv`);
  console.log('\n  El reloj sigue EN PAUSA hasta que no quede ningún código sin traducir.');
  console.log('  Sacarlo de pausa a medias significa atribuirle marcas a quien no es.');
  return { serie, total: rows.length };
}

// ── Aplicar ──────────────────────────────────────────────────────────
async function aplicar(archivo) {
  const ruta = path.isAbsolute(archivo) ? archivo : path.join(__dirname, archivo);
  const serie = /mapeo-(.+)\.csv$/.exec(path.basename(ruta))?.[1];
  if (!serie) throw new Error('el archivo debe llamarse mapeo-<serie>.csv para saber a qué reloj pertenece');

  const { rows } = await nuestra.query('SELECT serie FROM relojes WHERE serie=$1', [serie]);
  if (!rows.length) throw new Error(`la serie ${serie} no está en la tabla relojes. Corre tools/registrar-relojes-hr.js`);

  const lineas = fs.readFileSync(ruta, 'utf8').split(/\r?\n/).slice(1).filter((l) => l.trim());
  let n = 0, sinDestino = 0;
  for (const linea of lineas) {
    const [codigoReloj, codigoEmpleado, confianza] = linea.split(',');
    if (!codigoReloj?.trim()) continue;
    if (!codigoEmpleado?.trim()) { sinDestino++; continue; }
    await nuestra.query(
      `INSERT INTO reloj_codigo_map (serie, codigo_reloj, codigo_empleado, nota)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (serie, codigo_reloj) DO UPDATE
         SET codigo_empleado = EXCLUDED.codigo_empleado, nota = EXCLUDED.nota`,
      [serie, codigoReloj.trim(), codigoEmpleado.trim(),
       `revisado por RH el ${new Date().toISOString().slice(0, 10)} (${confianza || 'sin marca'})`]
    );
    n++;
  }
  console.log(`\n  ${n} traducciones guardadas para ${serie}.`);
  if (sinDestino) {
    console.log(`  ⚠ ${sinDestino} renglones SIN destino: esos códigos siguen sin traducir.`);
  }
  await estado(serie);
}

// ── Estado ───────────────────────────────────────────────────────────
async function estado(serie) {
  const { rows: r } = await nuestra.query('SELECT * FROM relojes WHERE serie=$1', [serie]);
  if (!r.length) throw new Error(`la serie ${serie} no está registrada`);
  const { rows: m } = await nuestra.query(
    'SELECT count(*)::int n FROM reloj_codigo_map WHERE serie=$1', [serie]);

  // Cuántos códigos usa ese reloj DE VERDAD (los que han checado), contra
  // cuántos están traducidos. Contar contra el padrón completo del equipo
  // sobrestima: hay usuarios dados de alta que nunca marcan.
  let usados = null;
  try {
    const { rows: u } = await origen.query(
      `SELECT count(DISTINCT l.device_user_id)::int n
         FROM hr.attendance_logs l
         JOIN hr.attendance_devices d ON d.id = l.device_id
        WHERE d.serial_number = $1`, [serie]);
    usados = u[0]?.n ?? null;
  } catch { /* sin acceso al origen, se reporta solo lo nuestro */ }

  console.log(`\n  ${r[0].alias || serie} · sucursal ${r[0].sucursal_id}`);
  console.log(`  ${m[0].n} códigos traducidos${usados != null ? ` de ${usados} que sí han checado` : ''}`);
  if (r[0].pendiente) {
    const faltan = usados != null ? usados - m[0].n : null;
    console.log(`  ⏸ EN PAUSA${faltan != null && faltan > 0 ? ` · faltan ${faltan} por traducir` : ''}.`);
    console.log('     Sus lotes se guardan en ingesta_lotes pero NO entran a checadas.');
    if (faltan === 0) {
      console.log('\n  ✅ Ya no falta ninguno. Para activarlo:');
      console.log(`     UPDATE relojes SET pendiente=FALSE, sucursal_id='<la que sea>' WHERE serie='${serie}';`);
      console.log(`     y luego reprocesa lo guardado:  POST /checador/relojes/lotes/${serie}/reprocesar`);
    }
  } else {
    console.log('  ▶ Activo: sus checadas entran traducidas.');
  }
}

(async () => {
  try {
    if (ARGS.includes('--aplicar')) await aplicar(val('--aplicar'));
    else if (ARGS.includes('--estado')) await estado(val('--serie'));
    else if (ARGS.includes('--proponer')) {
      const ip = val('--ip'), contra = val('--contra');
      if (!ip || !contra) {
        console.log('Uso: node tools/mapear-codigos.js --proponer --ip 192.168.0.81 --contra 192.168.0.80');
        process.exit(1);
      }
      await proponer(ip, contra);
    } else {
      console.log('Uso:');
      console.log('  --proponer --ip <reloj a traducir> --contra <reloj de referencia>');
      console.log('  --aplicar mapeo-<serie>.csv');
      console.log('  --estado --serie <serie>');
      process.exit(1);
    }
  } finally { await origen.end().catch(() => {}); await nuestra.end().catch(() => {}); }
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
