// api/tools/registrar-relojes-hr.js
//
// DA DE ALTA EL PADRÓN DE RELOJES tomando la identidad de la base de origen
// (servidor_245 · `hr`), que es la que sí está hablando con los equipos.
//
// ══ POR QUÉ NO SE LEEN LOS RELOJES DIRECTO ══
//
// Se intentó (tools/registrar-relojes.js, por TCP 4370). Los 10 equipos
// contestan `CMD_ACK_UNAUTH` (commandId 2005) al saludo. Como el sistema de
// origen los está sondeando cada pocos minutos —y un ZKTeco acepta UNA sola
// sesión— pelearle el puerto solo lograría que los dos leyeran a medias.
// La identidad (serie, IP, modelo, deriva) ya está en `hr.attendance_devices`.
//
// ══ DE DÓNDE SALE LA SUCURSAL ══
//
// `hr` NO tiene la plaza: `site_code` viene NULL en los 10 equipos y en los 417
// empleados. La única evidencia que liga cada IP con su sucursal es el padrón
// verificado a mano el 05/08/2026 (tools/targets.json), donde cada IP se
// confirmó comparando el padrón DEL RELOJ contra el de la sucursal, nombre por
// nombre. Esa evidencia se conserva en `relojes.nota`.
//
// NUNCA se inventa una sucursal: una IP sin evidencia entra en pausa.
//
// Uso:
//   node tools/registrar-relojes-hr.js --dry-run
//   node tools/registrar-relojes-hr.js

try { require('dotenv').config(); } catch { /* dotenv opcional */ }
const { Pool } = require('pg');

const DRY_RUN = process.argv.includes('--dry-run');
const origen = new Pool({ connectionString: process.env.HR_DB_URL, ssl: false, connectionTimeoutMillis: 8000 });
const nuestra = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// IP → sucursal, según targets.json. Se lee del archivo para no duplicar la
// evidencia: si mañana se corrige ahí, se corrige aquí.
const EVIDENCIA = new Map(
  require('./targets.json')
    .filter((t) => t && typeof t.ip === 'string' && t.ip.trim())
    .map((t) => [t.ip.trim(), t])
);

/** Alias legible del equipo, para el semáforo. */
const ALIAS = {
  '192.168.0.80': 'Oficinas · entrada y salida',
  '192.168.0.81': 'Oficinas · desayuno y comida',
  '192.168.0.153': 'CEDIS',
  '192.168.0.196': 'Sin identificar (oficinas)',
  '192.168.32.215': 'Morelia Madero',
  '192.168.40.12': '8-Esquinas',
  '192.168.42.37': 'La Piedad Abastos',
  '192.168.44.12': 'Yurécuaro Centro',
  '192.168.50.12': 'Zamora Canindo',
  '192.168.54.10': 'Zamora Catedral',
};

(async () => {
  const { rows: equipos } = await origen.query(
    `SELECT serial_number, ip_address, port, comm_key, model, firmware,
            record_count, clock_drift_seconds, last_seen_at
       FROM hr.attendance_devices ORDER BY ip_address`
  );
  console.log(`\n──── Padrón desde hr.attendance_devices · ${equipos.length} equipos ` +
              `${DRY_RUN ? '(DRY RUN) ' : ''}────\n`);

  let altas = 0, pausados = 0;
  for (const eq of equipos) {
    const ip = eq.ip_address;
    const ev = EVIDENCIA.get(ip);
    const suc = ev?.suc || 'SIN-IDENTIFICAR';
    // En pausa si targets.json lo marcó pendiente, o si el slug no es una
    // sucursal de verdad. Un reloj en pausa SÍ aparece en el semáforo (para que
    // no se olvide) pero sus checadas NO entran a `checadas`.
    const pendiente = !ev || ev.pendiente === true || /^(SIN-IDENTIFICAR|REVISAR-NUMERACION|SUCURSAL-PH)$/.test(suc);

    const nota = [
      `Identidad tomada de hr.attendance_devices (${eq.model || '?'} · fw ${eq.firmware || '?'}).`,
      ev?.nota ? `Verificación 05/08/2026: ${ev.nota}` : 'SIN evidencia de plaza en targets.json: no se le asigna sucursal.',
    ].join(' ');

    if (!DRY_RUN) {
      await nuestra.query(
        `INSERT INTO relojes (serie, sucursal_id, alias, ip, puerto, modo, comm_key, activo, pendiente, nota)
         VALUES ($1,$2,$3,$4,$5,'agente',$6,TRUE,$7,$8)
         ON CONFLICT (serie) DO UPDATE SET
           sucursal_id = EXCLUDED.sucursal_id,
           alias       = COALESCE(relojes.alias, EXCLUDED.alias),
           ip          = EXCLUDED.ip,
           puerto      = EXCLUDED.puerto,
           comm_key    = EXCLUDED.comm_key,
           nota        = COALESCE(relojes.nota, EXCLUDED.nota)`,
        [eq.serial_number, suc, ALIAS[ip] || suc, ip, eq.port || 4370,
         eq.comm_key ?? null, pendiente, nota]
      );
      // La deriva del reloj ya medida por el origen se copia al latido: es el
      // dato que hace que un retardo sea real o inventado.
      await nuestra.query(
        `INSERT INTO relojes_estado (serie, logs_en_reloj, desfase_reloj_seg, ip_vista, ultima_senal)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (serie) DO UPDATE SET
           logs_en_reloj = EXCLUDED.logs_en_reloj,
           desfase_reloj_seg = EXCLUDED.desfase_reloj_seg,
           ip_vista = EXCLUDED.ip_vista`,
        [eq.serial_number, eq.record_count ?? null, eq.clock_drift_seconds ?? null, ip, eq.last_seen_at || null]
      );
    }

    altas++;
    if (pendiente) pausados++;
    const deriva = eq.clock_drift_seconds;
    console.log(
      `  ${pendiente ? '⏸' : '✅'} ${String(suc).padEnd(26)} ${String(ip).padEnd(16)} ${eq.serial_number}` +
      (deriva != null && Math.abs(deriva) > 120 ? `  ⚠ deriva ${deriva}s` : '')
    );
  }

  console.log(`\n  ${altas} relojes en el padrón · ${pausados} en pausa (no aplican checadas).`);
  const derivados = equipos.filter((e) => e.clock_drift_seconds != null && Math.abs(e.clock_drift_seconds) > 120);
  if (derivados.length) {
    console.log(`\n  ⚠ ${derivados.length} reloj(es) con la hora corrida más de 2 min:`);
    for (const d of derivados) console.log(`     ${d.ip_address} · ${d.clock_drift_seconds}s`);
    console.log('     Con la hora mal, la tolerancia del horario se aplica sobre una hora falsa');
    console.log('     y RH ve retardos que no existen. Se corrige EN EL EQUIPO.');
  }
  if (DRY_RUN) console.log('\n  (DRY RUN: no se escribió nada.)');

  await origen.end(); await nuestra.end();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
