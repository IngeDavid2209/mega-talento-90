// Detecta la hora de entrada típica de cada sucursal a partir de las checadas
// (moda de la PRIMERA marca de cada empleado/día, redondeada a :00 o :30) y
// actualiza el horario general. La tolerancia (15 min) no se toca.
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const APLICAR = process.argv.includes('--aplicar');

const pad = n => String(n).padStart(2, '0');

(async () => {
  const sucs = await pool.query('SELECT DISTINCT sucursal_id FROM horarios_sucursal WHERE area_id IS NULL');
  console.log('SUCURSAL'.padEnd(20), 'ENTRADA ACTUAL', 'ENTRADA DETECTADA', 'MUESTRAS');
  console.log('-'.repeat(70));

  for (const s of sucs.rows) {
    const suc = s.sucursal_id;
    // Primera marca de cada empleado por día.
    const r = await pool.query(
      `SELECT min(hora) AS primera
       FROM checadas WHERE sucursal_id=$1
       GROUP BY empleado_codigo, fecha`, [suc]
    );
    if (!r.rows.length) { console.log(suc.padEnd(20), 'sin datos'); continue; }

    // Bucket por múltiplo de 30 min más cercano.
    const conteo = new Map();
    for (const row of r.rows) {
      const m = /^(\d{1,2}):(\d{2})/.exec(row.primera || '');
      if (!m) continue;
      const minutos = (+m[1]) * 60 + (+m[2]);
      const bucket = Math.round(minutos / 30) * 30;
      conteo.set(bucket, (conteo.get(bucket) || 0) + 1);
    }
    if (!conteo.size) { console.log(suc.padEnd(20), 'sin horas válidas'); continue; }

    // Moda (bucket más frecuente).
    let mejor = null, max = -1;
    for (const [b, n] of conteo) { if (n > max) { max = n; mejor = b; } }
    const entrada = `${pad(Math.floor(mejor / 60))}:${pad(mejor % 60)}`;

    const actual = await pool.query(
      'SELECT entrada FROM horarios_sucursal WHERE sucursal_id=$1 AND area_id IS NULL LIMIT 1', [suc]
    );
    console.log(suc.padEnd(20), (actual.rows[0]?.entrada || '—').padEnd(14), entrada.padEnd(17), `${max}/${r.rows.length}`);

    if (APLICAR) {
      await pool.query(
        'UPDATE horarios_sucursal SET entrada=$2 WHERE sucursal_id=$1 AND area_id IS NULL', [suc, entrada]
      );
    }
  }
  console.log('-'.repeat(70));
  console.log(APLICAR ? '✔ Entradas aplicadas.' : '(solo lectura — corre con --aplicar para guardar)');
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
