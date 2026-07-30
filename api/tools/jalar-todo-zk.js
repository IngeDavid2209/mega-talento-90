// Jala empleados + checadas de VARIOS checadores ZKTeco (SOLO LECTURA) y los
// carga a Postgres.
// Uso:  npm run jalar         (lee tools/targets.json y DATABASE_URL del .env)
// La lista de relojes se toma de:
//   1) env TARGETS (JSON): [{"ip","suc"}]   — si se define, tiene prioridad
//   2) tools/targets.json                    — lista fija por sucursal (default)
//
// ⚠️ LECTURA VERIFICADA — por qué NO se usa getAttendances() de la librería.
// `node-zklib` trunca los logs grandes de forma NO DETERMINISTA y no avisa:
// resuelve la promesa con datos parciales y un campo `err` que este script
// ignoraba. Medido contra los relojes reales: 8-Esquinas devolvía
// 3,273 / 32,735 / 49,103 / 49,936 registros en corridas distintas, al azar.
// O sea que este importador ha estado cargando fracciones y reportando éxito.
// El detalle del bug y la corrección están en tools/lector-zk.js.
//
try { require('dotenv').config(); } catch { /* dotenv opcional */ }
const ZKLib = require('node-zklib');
const { Pool } = require('pg');
const { leerChecadas, leerUsuarios } = require('./lector-zk');

const PORT = parseInt(process.env.ZK_PORT || '4370', 10);
// Reintentos cuando la lectura no cuadra con lo que el reloj declara.
// Calibrados contra los equipos reales: con pausa de 2.5 s un reloj falló 5 de
// 5 intentos; con 4 s pasó en el segundo.
const INTENTOS = parseInt(process.env.ZK_INTENTOS || '8', 10) || 8;
const PAUSA_MS = parseInt(process.env.ZK_PAUSA_MS || '4000', 10) || 4000;
// --dry-run: lee y verifica pero NO escribe en la base. Para probar sin riesgo.
const DRY_RUN = process.argv.includes('--dry-run');

// node-zklib lanza OBJETOS, no Error: sin esto los fallos salen como
// "[object Object]" y no se distingue un reloj apagado de un bug propio.
function motivo(e) {
  if (!e) return 'error desconocido';
  if (typeof e === 'string') return e;
  if (e.message) return e.message;
  if (e.err && e.err.message) return e.err.message;
  if (e.code) return `${e.code}${e.address ? ' ' + e.address : ''}`;
  try { return JSON.stringify(e); } catch { return String(e); }
}
const TODOS = process.env.TARGETS ? JSON.parse(process.env.TARGETS) : require('./targets.json');
// Los marcados con "pendiente": true se saltan a propósito: son relojes que no
// responden o que todavía no se sabe a qué sucursal pertenecen. Intentarlos cada
// 5 minutos solo llenaría el log de errores y taparía los problemas reales.
// Con --incluir-pendientes se prueban (útil después de revivir un equipo).
const INCLUIR_PENDIENTES = process.argv.includes('--incluir-pendientes');
const TARGETS = INCLUIR_PENDIENTES ? TODOS : TODOS.filter((t) => !t.pendiente);
const PENDIENTES = TODOS.filter((t) => t.pendiente);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

if (!Array.isArray(TARGETS) || !TARGETS.length) {
  console.error('No hay relojes que jalar: define TARGETS o edita tools/targets.json.');
  process.exit(1);
}

const pad = n => String(n).padStart(2, '0');
function fmt(d) {
  const y = d.getFullYear(), mo = pad(d.getMonth() + 1), da = pad(d.getDate());
  const h = pad(d.getHours()), mi = pad(d.getMinutes()), s = pad(d.getSeconds());
  return { fecha: `${y}-${mo}-${da}`, hora: `${h}:${mi}:${s}`, fechaHora: `${y}-${mo}-${da}T${h}:${mi}:${s}` };
}

// ──────────────────────────────────────────────────────────────────
// leerVerificado(ip) — lee el reloj y GARANTIZA que la lectura esté completa,
// o lanza. Nunca devuelve datos parciales.
//
// Cómo se verifica: `info.logCounts` sí reporta el total correcto. Se lee ANTES
// y DESPUÉS de bajar las checadas, porque si alguien checa en medio el total
// sube — una lectura válida debe caer entre esos dos valores. Comparar contra un
// solo número daría falsos negativos justo en las horas de entrada y salida.
//
// Y se valida el CONTENIDO, no solo la cantidad: un desalineamiento de bytes
// produce el número correcto de registros con código vacío y fecha 2000-01-01.
// La cantidad cuadra y el dato no sirve.
// ──────────────────────────────────────────────────────────────────
async function leerVerificado(ip) {
  const historial = [];

  for (let intento = 1; intento <= INTENTOS; intento++) {
    // Socket NUEVO en cada intento: reutilizarlo arrastra el buffer a medias.
    const zk = new ZKLib(ip, PORT, 20000, 5000);
    try {
      await zk.createSocket();
      const antes = await zk.getInfo();

      const users = await leerUsuarios(zk);
      const logs = await leerChecadas(zk);

      let despues = antes.logCounts;
      try { despues = (await zk.getInfo()).logCounts; } catch { /* se queda el de antes */ }

      const min = Math.min(antes.logCounts, despues);
      const max = Math.max(antes.logCounts, despues);
      const cantidadOk = logs.length >= min && logs.length <= max;
      const usuariosOk = antes.userCounts === undefined || users.length >= antes.userCounts;

      // Contenido creíble: con código y fecha posterior a 2001 (los relojes sin
      // hora configurada graban 2000-01-01).
      const sanos = logs.filter((x) => {
        const cod = String(x.deviceUserId ?? '').trim();
        const t = new Date(x.recordTime).getTime();
        return cod !== '' && Number.isFinite(t) && t > Date.UTC(2001, 0, 1);
      }).length;
      const contenidoOk = logs.length === 0 || sanos / logs.length >= 0.9;

      historial.push({ intento, dice: antes.logCounts, leidas: logs.length, sanos });

      if (cantidadOk && usuariosOk && contenidoOk) {
        return { users, logs, esperadas: min, intentos: intento };
      }
      const falla = !contenidoOk
        ? `contenido inválido (${sanos}/${logs.length} registros creíbles)`
        : !usuariosOk ? `usuarios incompletos (${users.length} de ${antes.userCounts})`
        : `checadas incompletas (${logs.length} de ${antes.logCounts})`;
      console.log(`    intento ${intento}/${INTENTOS}: ${falla}`);
    } catch (e) {
      const m = motivo(e);
      console.log(`    intento ${intento}/${INTENTOS}: ${m}`);
      // Sin conexión no hay nada que reintentar.
      if (/ETIMEDOUT|EHOSTUNREACH|ECONNREFUSED|TCP CONNECT/i.test(m)) {
        throw new Error(`no se pudo conectar a ${ip}:${PORT} — ${m}`);
      }
    } finally {
      // Siempre cerrar: estos equipos aceptan UNA sesión a la vez y dejarla
      // abierta los vuelve inaccesibles para el siguiente intento.
      await zk.disconnect().catch(() => {});
    }
    if (intento < INTENTOS) await new Promise((r) => setTimeout(r, PAUSA_MS));
  }

  const mejor = Math.max(0, ...historial.map((h) => h.leidas || 0));
  const dice = historial.length ? historial[historial.length - 1].dice : '?';
  throw new Error(
    `lectura INCOMPLETA tras ${INTENTOS} intentos: el reloj reporta ${dice} checadas y ` +
    `la mejor lectura fue ${mejor}. NO se carga nada.`);
}

async function jalarUno({ ip, suc }) {
  // Si la lectura no es verificablemente completa, esto LANZA y no se escribe
  // ni una fila. Antes se cargaba lo que hubiera llegado.
  const { users, logs, esperadas, intentos } = await leerVerificado(ip);
  if (intentos > 1) console.log(`    (cuadró en el intento ${intentos})`);

  // Empleados
  let ne = 0;
  const mapa = new Map();
  for (const u of users) {
    const codigo = String(u.userId ?? u.uid ?? '').trim();
    if (!codigo) continue;
    const nombre = (u.name || '').trim() || `Empleado ${codigo}`;
    mapa.set(codigo, nombre);
    if (!DRY_RUN) {
      // El nombre del reloj solo RELLENA, no pisa. Antes hacia
      // `SET nombre = EXCLUDED.nombre`, y eso significaba que cada jalado
      // sobrescribia el padron con el nombre crudo del aparato: si RH corrige
      // "Franciscomtz" a "Francisco Martinez" en el portal, la siguiente corrida
      // se lo deshacia en silencio. Medido el 30/07/2026 los 274 nombres
      // comparables eran identicos, asi que hoy no cambia nada — se blinda para
      // que el dia que RH edite uno, el jalado no le borre el trabajo.
      await pool.query(
        `INSERT INTO empleados (sucursal_id, codigo_checador, nombre, activo) VALUES ($1,$2,$3,true)
         ON CONFLICT (sucursal_id, codigo_checador) DO UPDATE
            SET nombre = CASE
                  WHEN empleados.nombre IS NULL
                    OR btrim(empleados.nombre) = ''
                    OR empleados.nombre LIKE 'Empleado %'
                  THEN EXCLUDED.nombre
                  ELSE empleados.nombre
                END`,
        [suc, codigo, nombre]
      );
    }
    ne++;
  }

  // Checadas (dedup + lotes)
  const vistos = new Set(); const filas = [];
  for (const l of logs) {
    const codigo = String(l.deviceUserId ?? l.userId ?? l.uid ?? '').trim();
    const t = l.recordTime instanceof Date ? l.recordTime : new Date(l.recordTime);
    if (!codigo || isNaN(t.getTime())) continue;
    const f = fmt(t);
    const key = `${suc}__${codigo}__${f.fechaHora}`;
    if (vistos.has(key)) continue;
    vistos.add(key);
    filas.push({ codigo, nombre: mapa.get(codigo) || null, ...f, key });
  }
  let nc = 0;
  if (!DRY_RUN) {
    for (let i = 0; i < filas.length; i += 200) {
      const grupo = filas.slice(i, i + 200);
      const vals = [], params = [];
      grupo.forEach((c, j) => {
        const b = j * 8;
        vals.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`);
        params.push(suc, c.codigo, c.nombre, c.fechaHora, c.fecha, c.hora, null, c.key);
      });
      const r = await pool.query(
        `INSERT INTO checadas (sucursal_id, empleado_codigo, empleado_nombre, fecha_hora, fecha, hora, tipo, dedup_key)
         VALUES ${vals.join(',')} ON CONFLICT (dedup_key) DO NOTHING`, params);
      nc += r.rowCount || 0;
    }
  }
  // Rango de fechas: si el reloj tiene meses que la base no, se ve aquí.
  const dias = [...new Set(filas.map((f) => f.fecha))].sort();
  return {
    ne, nc, totalChecadas: filas.length, esperadas,
    desde: dias[0] || null, hasta: dias[dias.length - 1] || null,
  };
}

async function correr() {
  const marca = new Date().toLocaleString('es-MX');
  console.log(`\n──── Jalado ${marca}${DRY_RUN ? '  (DRY RUN: no escribe en la base)' : ''} ────`);
  let ok = 0, fallidos = 0;
  for (const t of TARGETS) {
    console.log(`\n  ${t.suc} (${t.ip})${t.nota ? ' · ' + t.nota : ''}`);
    try {
      const r = await jalarUno(t);
      // Se reporta lo LEÍDO contra lo que el reloj DECLARA, para que una lectura
      // a medias no pueda pasar por buena nunca más.
      console.log(`  ✅ verificado: ${r.totalChecadas} de ${r.esperadas} checadas · ${r.desde || '?'} → ${r.hasta || '?'}`);
      console.log(`     ${r.ne} empleados · ${DRY_RUN ? 'no se escribió (dry run)' : r.nc + ' checadas nuevas en la base'}`);
      ok++;
    } catch (e) {
      fallidos++;
      const m = motivo(e);
      console.log(`  ❌ SE SALTA: ${m}`);
      if (/lectura INCOMPLETA/i.test(m)) {
        console.log('     La conexión funciona; lo que falla es la descarga del log.');
        console.log('     Sube ZK_INTENTOS o córrelo cuando haya menos tráfico en la red.');
      } else if (/no se pudo conectar/i.test(m)) {
        console.log('     Revisa: reloj prendido, cable de red, y que la IP siga siendo esa');
        console.log('     (si el reloj tiene DHCP, pudo cambiar sola).');
      }
    }
  }
  console.log(`\n──── ${ok} de ${TARGETS.length} relojes al día · ${fallidos} con problema ────`);
  if (PENDIENTES.length && !INCLUIR_PENDIENTES) {
    console.log(`\n  ⏸  ${PENDIENTES.length} reloj(es) en pausa, no se intentaron:`);
    PENDIENTES.forEach((t) => console.log(`     ${t.suc} (${t.ip}) — ${String(t.nota).split('.')[0]}`));
    console.log('     Para probarlos: npm run jalar -- --incluir-pendientes');
  }
  return { ok, fallidos };
}

// Modo watch: --loop (o LOOP_MIN=n) repite cada n minutos (default 5) para
// mantener la base "al día". Debe correr en una máquina en la red de los relojes.
const LOOP_MIN = parseInt(process.env.LOOP_MIN || '', 10) || (process.argv.includes('--loop') ? 5 : 0);

(async () => {
  await correr();
  if (LOOP_MIN > 0) {
    console.log(`\n⏱  Modo en vivo: repitiendo cada ${LOOP_MIN} min. Ctrl+C para detener.`);
    setInterval(() => { correr().catch(e => console.error(e)); }, LOOP_MIN * 60 * 1000);
  } else {
    await pool.end();
  }
})().catch(e => { console.error(e); process.exit(1); });
