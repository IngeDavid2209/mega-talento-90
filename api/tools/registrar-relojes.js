// api/tools/registrar-relojes.js
//
// MIGRA tools/targets.json A LA TABLA `relojes`, cambiando la llave de IP a
// NÚMERO DE SERIE.
//
// Se corre UNA VEZ (y cada que aparezca un reloj nuevo) desde una máquina que
// alcance a la vez los relojes (LAN) y la base (DATABASE_URL) — o sea, una PC
// del corporativo. NO es lo que corre en las sucursales: el agente de
// api/agente/ no necesita credenciales de Postgres.
//
// Uso:
//   node tools/registrar-relojes.js --dry-run     (enseña qué haría)
//   node tools/registrar-relojes.js
//   node tools/registrar-relojes.js --ip 192.168.0.80
//
// QUÉ HACE CON LOS QUE NO RESPONDEN
//
// Los registra igual, con una serie PROVISIONAL `SIN-SERIE:<ip>` y en pausa.
// Suena raro registrar un reloj que no contesta, y es a propósito: si Morelia
// Abastos no está en la tabla, no sale en el semáforo, y un reloj que no sale
// en el semáforo es un reloj del que nadie se acuerda. Ahí lleva sin importarse
// desde siempre. En rojo, al menos se ve.
//
// Cuando ese equipo por fin conteste, este mismo script lee su serie real,
// crea la fila buena y borra la provisional (arrastrando su latido).

try { require('dotenv').config(); } catch { /* dotenv opcional */ }
const { Pool } = require('pg');
const { conectar, cerrar, leerSerie, limpiarSerie, motivo, PUERTO_DEFAULT } = require('./lectura-verificada');

const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes('--dry-run');
const soloIp = (() => { const i = ARGS.indexOf('--ip'); return i >= 0 ? ARGS[i + 1] : null; })();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const TARGETS = require('./targets.json')
  .filter((t) => t && typeof t.ip === 'string' && t.ip.trim());

/** Serie provisional para un equipo que todavía no se puede identificar. */
const seriePendiente = (ip) => `SIN-SERIE:${ip}`;
const esProvisional = (s) => String(s || '').startsWith('SIN-SERIE:');

/**
 * Alias legible: la primera oración de la nota, que es donde está el dato útil
 * ("Oficinas (entrada y salida)", "Morelia Madero", "Canindo"). Las notas de
 * targets.json son evidencia real —verificaciones de padrón hechas a mano el
 * 05/08/2026— y se conservan completas en `relojes.nota`.
 */
function aliasDe(t) {
  const nota = String(t.nota || '').trim();
  const primera = nota.split(/(?<=\.)\s/)[0] || '';
  const limpia = primera.replace(/^(NUEVO|PENDIENTE,?\s*(NO JALAR|NO RESPONDE)?)[:,.]?\s*/i, '').trim();
  const corto = limpia.replace(/\.$/, '');
  return (corto && corto.length <= 60 ? corto : t.suc) || t.suc;
}

async function upsert(fila) {
  if (DRY_RUN) return;
  await pool.query(
    `INSERT INTO relojes (serie, sucursal_id, alias, ip, puerto, modo, activo, pendiente, nota)
     VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7,$8)
     ON CONFLICT (serie) DO UPDATE SET
       sucursal_id = EXCLUDED.sucursal_id,
       alias       = COALESCE(relojes.alias, EXCLUDED.alias),
       ip          = EXCLUDED.ip,
       puerto      = EXCLUDED.puerto,
       -- modo y pendiente NO se pisan: son decisiones que RH ya tomó desde el
       -- portal, y volver a correr el seed no debe deshacerlas.
       nota        = COALESCE(relojes.nota, EXCLUDED.nota)`,
    [fila.serie, fila.suc, fila.alias, fila.ip, fila.puerto || PUERTO_DEFAULT,
     fila.modo || 'agente', fila.pendiente === true, fila.nota || null]
  );
}

/**
 * Retira las filas que son ESTE MISMO reloj escrito de otra forma.
 *
 * Son dos casos:
 *   1. La provisional `SIN-SERIE:<ip>` que se creo cuando el equipo no
 *      contestaba. Al aparecer su serie real, sobra.
 *   2. Una fila de la MISMA IP cuya serie es la real con basura en los
 *      extremos. Paso el 20/08/2026 con Morelia Abastos: el equipo cierra el
 *      `~SerialNumber` unas veces con NUL y otras con '=', y el registro quedo
 *      guardado como `3266161700253=`. Con la serie sucia en el padron, el
 *      agente reporta la limpia y la ingesta la rechaza por serie desconocida:
 *      la plaza no baja nada y no sale ningun error. Ya se corrigio la lectura
 *      (ver `limpiarSerie` en lectura-verificada.js); esto limpia lo que quedo
 *      guardado antes de la correccion.
 *
 * En los dos casos el latido se muda a la fila buena antes de borrar: es el
 * unico registro de cuando se le vio por ultima vez.
 */
async function jubilarDuplicadas(ip, serieReal) {
  const { rows } = await pool.query(
    'SELECT serie FROM relojes WHERE (ip=$1 OR serie=$2) AND serie <> $3', [ip, seriePendiente(ip), serieReal]);
  // Solo las que SON este reloj: la provisional de su IP, o la misma serie con
  // basura. Una fila de otro equipo que comparta IP no se toca desde aqui.
  const sobran = rows.map((r) => r.serie).filter((x) =>
    x === seriePendiente(ip) || limpiarSerie(x) === serieReal);
  if (!sobran.length) return false;
  if (DRY_RUN) return true;
  for (const sobra of sobran) {
    await pool.query(
      `INSERT INTO relojes_estado (serie, ultima_senal, ultima_checada, ip_vista)
       SELECT $2, ultima_senal, ultima_checada, ip_vista FROM relojes_estado WHERE serie=$1
       ON CONFLICT (serie) DO NOTHING`, [sobra, serieReal]
    );
    await pool.query('DELETE FROM relojes WHERE serie=$1', [sobra]);   // cascada borra su estado
  }
  return true;
}

(async () => {
  const objetivos = soloIp ? TARGETS.filter((t) => t.ip === soloIp) : TARGETS;
  if (!objetivos.length) { console.error('No hay relojes que registrar.'); process.exit(1); }

  console.log(`\n──── Registro de relojes ${DRY_RUN ? '(DRY RUN: no escribe) ' : ''}· ${objetivos.length} equipos ────\n`);
  let conSerie = 0, provisionales = 0;

  for (const t of objetivos) {
    const alias = aliasDe(t);
    let zk = null, serie = null, error = null;
    try {
      zk = await conectar(t.ip, { timeoutMs: 8000, commKey: t.commKey });
      serie = await leerSerie(zk);
    } catch (e) { error = motivo(e); }
    finally { await cerrar(zk); }

    if (serie) {
      const jubilado = await jubilarDuplicadas(t.ip, serie);
      await upsert({
        serie, suc: t.suc, alias, ip: t.ip, pendiente: t.pendiente === true,
        nota: t.nota, modo: 'agente',
      });
      conSerie++;
      console.log(`  ✅ ${t.suc.padEnd(26)} ${t.ip.padEnd(16)} serie ${serie}` +
                  (t.pendiente ? '  ⏸ en pausa' : '') +
                  (jubilado ? '  (se retiró una fila repetida de este mismo reloj)' : ''));
    } else {
      const serieProv = seriePendiente(t.ip);
      const { rows } = DRY_RUN ? { rows: [] } : await pool.query(
        'SELECT serie FROM relojes WHERE ip=$1 AND serie <> $2', [t.ip, serieProv]);
      if (rows.length) {
        // Ya tiene fila con serie real; que no conteste ahora es cosa del
        // semáforo, no del padrón. No se le crea una provisional encima.
        console.log(`  ⏭  ${t.suc.padEnd(26)} ${t.ip.padEnd(16)} no contesta, pero ya está registrado como ${rows[0].serie}`);
        continue;
      }
      await upsert({
        serie: serieProv, suc: t.suc, alias, ip: t.ip, pendiente: true, modo: 'agente',
        nota: `SIN IDENTIFICAR (${new Date().toISOString().slice(0, 10)}): no contestó al registrarlo — ${error}. ` +
              `Se registra en pausa para que aparezca en rojo en el semáforo en vez de desaparecer. ` +
              `Nota original: ${t.nota || '(sin nota)'}`,
      });
      provisionales++;
      console.log(`  🔴 ${t.suc.padEnd(26)} ${t.ip.padEnd(16)} sin serie — ${error}`);
    }
  }

  console.log(`\n  ${conSerie} identificados por serie · ${provisionales} provisionales en pausa.`);
  if (provisionales) {
    console.log('  Los provisionales NO se jalan. Vuelve a correr esto cuando el equipo conteste.');
  }
  if (DRY_RUN) console.log('\n  (DRY RUN: no se escribió nada.)');
  await pool.end();
})().catch((e) => { console.error(motivo(e)); process.exit(1); });
