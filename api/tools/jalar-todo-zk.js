// Jala empleados + checadas de VARIOS checadores ZKTeco (SOLO LECTURA) y los
// manda a la API.
//
// ⚠️ ESTE SCRIPT YA NO ES LA FORMA DE TENER LA ASISTENCIA EN VIVO.
//
// Antes se dejaba corriendo en bucle cada 5 minutos en una PC de sucursal, con
// el DATABASE_URL de producción en un `.env`. Eso tenía tres problemas: cada
// corrida baja el LOG COMPLETO de cada reloj (8-Esquinas son ~50 mil registros,
// ≈2 MB) y con 8 relojes eso no cierra de forma confiable en 5 minutos; solo
// funcionaba mientras alguien dejara la ventana abierta; y ponía las
// credenciales de la base en cada plaza.
//
// Ahora hay un servicio de verdad: api/agente/ (stream en vivo + backfill
// horario + cola local que sobrevive a los cortes de internet). Este script se
// queda como herramienta de BACKFILL manual: para recuperar historia, para
// probar un reloj recién revivido, o para una plaza donde todavía no se
// instaló el agente.
//
// Uso:
//   npm run jalar                   manda a la API (INGESTA_URL + INGESTA_TOKEN)
//   npm run jalar -- --dry-run      lee y verifica, no manda nada
//   npm run jalar -- --directo      escribe a Postgres como antes (necesita DATABASE_URL)
//   npm run jalar -- --incluir-pendientes
//
// La lista de relojes se toma de:
//   1) la tabla `relojes` de la API, si hay INGESTA_URL + INGESTA_TOKEN
//   2) env TARGETS (JSON): [{"ip","suc"}]
//   3) tools/targets.json
//
// ⚠️ LECTURA VERIFICADA — por qué NO se usa getAttendances() de la librería.
// `node-zklib` trunca los logs grandes de forma NO DETERMINISTA y no avisa:
// resuelve la promesa con datos parciales y un campo `err` que este script
// ignoraba. Medido contra los relojes reales: 8-Esquinas devolvía
// 3,273 / 32,735 / 49,103 / 49,936 registros en corridas distintas, al azar.
// El detalle del bug está en tools/lector-zk.js y la verificación en
// tools/lectura-verificada.js — compartida con el agente, para que la regla no
// se divida en dos copias que después divergen.
//
try { require('dotenv').config(); } catch { /* dotenv opcional */ }
const {
  leerVerificado, normalizarChecadas, normalizarUsuarios, motivo, serieCoincide,
} = require('./lectura-verificada');

// --dry-run: lee y verifica pero NO escribe ni manda. Para probar sin riesgo.
const DRY_RUN = process.argv.includes('--dry-run');
// --directo: el modo viejo, escribiendo a Postgres. Se conserva por si la API
// no está disponible y hay que recuperar historia a mano.
const DIRECTO = process.argv.includes('--directo');

const INGESTA_URL = (process.env.INGESTA_URL || process.env.API_URL || '').replace(/\/$/, '');
const INGESTA_TOKEN = process.env.INGESTA_TOKEN || '';
// Se parte en lotes para no chocar con el límite del cuerpo HTTP ni dejar la
// API sin aire con 50 mil filas en una sola transacción.
const TAM_LOTE = parseInt(process.env.INGESTA_LOTE || '500', 10) || 500;

if (!DIRECTO && !DRY_RUN && (!INGESTA_URL || !INGESTA_TOKEN)) {
  console.error('Falta INGESTA_URL y/o INGESTA_TOKEN en el .env.');
  console.error('  · Para mandar a la API:  INGESTA_URL=https://…  INGESTA_TOKEN=…');
  console.error('  · Para el modo viejo escribiendo a Postgres:  npm run jalar -- --directo');
  process.exit(1);
}

let pool = null;
if (DIRECTO && !DRY_RUN) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
}

// Las entradas SIN `ip` se descartan: targets.json lleva un bloque de
// documentacion al principio (JSON no admite comentarios) y sin este filtro se
// contaba como un reloj mas, salia como "undefined (undefined)" y engordaba el
// marcador de fallos con algo que no es un reloj.
async function cargarTargets() {
  if (INGESTA_URL && INGESTA_TOKEN) {
    try {
      const res = await fetch(`${INGESTA_URL}/checador/ingesta/relojes`, {
        headers: { 'X-Agente-Token': INGESTA_TOKEN },
      });
      if (res.ok) {
        const relojes = await res.json();
        console.log(`  (padrón de la API: ${relojes.length} relojes)`);
        return relojes.map((r) => ({
          ip: r.ip, suc: r.sucursalId, serie: r.serie, commKey: r.commKey,
          pendiente: r.pendiente, nota: r.nota,
        })).filter((t) => t.ip);
      }
      console.log(`  (la API contestó ${res.status} al pedir el padrón; se usa targets.json)`);
    } catch (e) { console.log(`  (no se pudo leer el padrón de la API: ${motivo(e)})`); }
  }
  const crudo = process.env.TARGETS ? JSON.parse(process.env.TARGETS) : require('./targets.json');
  return crudo.filter((t) => t && typeof t.ip === 'string' && t.ip.trim());
}

// Los marcados con "pendiente": true se saltan a propósito: son relojes que no
// responden o que todavía no se sabe a qué sucursal pertenecen. Intentarlos cada
// vez solo llenaría el log de errores y taparía los problemas reales.
// Con --incluir-pendientes se prueban (útil después de revivir un equipo).
const INCLUIR_PENDIENTES = process.argv.includes('--incluir-pendientes');

// ── Envío a la API ────────────────────────────────────────────────────
async function mandarLote(cuerpo) {
  const res = await fetch(`${INGESTA_URL}/checador/ingesta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agente-Token': INGESTA_TOKEN },
    body: JSON.stringify(cuerpo),
  });
  const txt = await res.text();
  let json = null;
  try { json = JSON.parse(txt); } catch { /* respuesta no-JSON */ }
  if (res.status === 409) {
    throw new Error(json?.mensaje || `la serie ${cuerpo.serie} no está en el padrón de relojes. ` +
      'Corre `node tools/registrar-relojes.js` primero.');
  }
  if (res.status === 202) return { pausado: true, ...json };
  if (!res.ok) throw new Error(`la API contestó ${res.status}: ${txt.slice(0, 200)}`);
  return json || {};
}

async function enviarPorApi(lectura, filas, usuarios) {
  if (!lectura.serie) {
    throw new Error('el reloj no dio número de serie, y la ingesta identifica por serie. ' +
      'Usa --directo para este equipo, o revisa su firmware.');
  }
  let aceptadas = 0, duplicadas = 0, pausado = false;
  for (let i = 0; i < filas.length; i += TAM_LOTE) {
    const grupo = filas.slice(i, i + TAM_LOTE);
    const r = await mandarLote({
      serie: lectura.serie,
      ip: lectura.ip,
      origen: 'agente',
      agenteVersion: 'jalar-todo-zk',
      agenteHost: require('os').hostname(),
      infoReloj: {
        logCounts: lectura.info?.logCounts,
        userCounts: lectura.info?.userCounts,
        horaReloj: lectura.horaReloj ? lectura.horaReloj.toISOString() : undefined,
      },
      // El padrón va SOLO en el primer lote: mandarlo 100 veces no agrega nada
      // y multiplica los upserts de `empleados`.
      usuarios: i === 0 ? usuarios : undefined,
      checadas: grupo,
      // `completa` solo en el ÚLTIMO lote: es lo que le dice a la API que ya
      // llegó todo el log y puede recalcular logs_en_base contra logs_en_reloj.
      completa: i + TAM_LOTE >= filas.length,
    });
    if (r.pausado) { pausado = true; break; }
    aceptadas += r.aceptadas || 0;
    duplicadas += r.duplicadas || 0;
  }
  // Un reloj sin checadas también tiene que reportarse: el lote vacío ES el
  // latido, y sin él ese equipo se vería "mudo" aunque esté perfecto.
  if (!filas.length) {
    const r = await mandarLote({
      serie: lectura.serie, ip: lectura.ip, origen: 'agente',
      agenteVersion: 'jalar-todo-zk', agenteHost: require('os').hostname(),
      infoReloj: { logCounts: lectura.info?.logCounts, userCounts: lectura.info?.userCounts },
      usuarios, checadas: [], completa: true,
    });
    pausado = !!r.pausado;
  }
  return { aceptadas, duplicadas, pausado };
}

// ── Escritura directa a Postgres (modo viejo, --directo) ──────────────
async function escribirDirecto(suc, filas, usuarios, serie) {
  for (const u of usuarios) {
    // El nombre del reloj solo RELLENA, no pisa: si RH corrige "Franciscomtz"
    // a "Francisco Martinez" en el portal, la siguiente corrida no se lo
    // deshace en silencio.
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
      [suc, u.codigo, u.nombre]
    );
  }
  const nombres = new Map(usuarios.map((u) => [u.codigo, u.nombre]));
  let nc = 0;
  for (let i = 0; i < filas.length; i += 200) {
    const grupo = filas.slice(i, i + 200);
    const vals = [], params = [];
    grupo.forEach((c, j) => {
      const b = j * 10;
      vals.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},now())`);
      // dedup_key con SERIE cuando se conoce: sin ella, los dos relojes de
      // corporativo (.80 entrada/salida y .81 comida) se comen las checadas uno
      // del otro cuando caen en el mismo segundo.
      const clave = serie ? `${serie}__${c.codigo}__${c.fechaHora}` : `${suc}__${c.codigo}__${c.fechaHora}`;
      params.push(suc, c.codigo, nombres.get(c.codigo) || null, c.fechaHora, c.fecha, c.hora,
                  null, clave, serie || null);
    });
    const r = await pool.query(
      `INSERT INTO checadas (sucursal_id, empleado_codigo, empleado_nombre, fecha_hora, fecha, hora,
                             tipo, dedup_key, serie_reloj, recibido_en)
       VALUES ${vals.join(',')} ON CONFLICT (dedup_key) DO NOTHING`, params);
    nc += r.rowCount || 0;
  }
  return nc;
}

// ── Un reloj ──────────────────────────────────────────────────────────
async function jalarUno(t) {
  // Si la lectura no es verificablemente completa, esto LANZA y no se escribe
  // ni una fila. Antes se cargaba lo que hubiera llegado.
  const lectura = await leerVerificado(t.ip, { commKey: t.commKey, log: (m) => console.log(m) });
  if (lectura.intentos > 1) console.log(`    (cuadró en el intento ${lectura.intentos})`);

  // La serie que contesta debe ser la que el padrón espera. Si no lo es, la IP
  // cambió de dueño y jalarla metería las marcas bajo la sucursal equivocada.
  if (t.serie && lectura.serie && !serieCoincide(t.serie, lectura.serie)) {
    throw new Error(`ESTA IP YA NO ES ESE RELOJ: el padrón espera ${t.serie} y contesta ` +
      `${lectura.serie}. Corre tools/diagnostico-red.js --barrer para reencontrarlo.`);
  }

  const usuarios = normalizarUsuarios(lectura.users);
  const filas = normalizarChecadas(lectura.logs);
  const dias = [...new Set(filas.map((f) => f.fecha))].sort();
  const base = {
    ne: usuarios.length, totalChecadas: filas.length, esperadas: lectura.esperadas,
    serie: lectura.serie, desfaseSeg: lectura.horaReloj
      ? Math.round((lectura.horaReloj.getTime() - Date.now()) / 1000) : null,
    desde: dias[0] || null, hasta: dias[dias.length - 1] || null,
  };

  if (DRY_RUN) return { ...base, nc: 0, modo: 'dry-run' };
  if (DIRECTO) return { ...base, nc: await escribirDirecto(t.suc, filas, usuarios, lectura.serie), modo: 'directo' };

  const r = await enviarPorApi(lectura, filas, usuarios);
  return { ...base, nc: r.aceptadas, pausado: r.pausado, modo: 'api' };
}

async function correr(TARGETS, PENDIENTES) {
  const marca = new Date().toLocaleString('es-MX');
  const etiqueta = DRY_RUN ? '  (DRY RUN: no manda nada)' : DIRECTO ? '  (modo DIRECTO: escribe a Postgres)' : '';
  console.log(`\n──── Jalado ${marca}${etiqueta} ────`);
  let ok = 0, fallidos = 0;
  for (const t of TARGETS) {
    console.log(`\n  ${t.suc} (${t.ip})${t.nota ? ' · ' + String(t.nota).split('.')[0] : ''}`);
    try {
      const r = await jalarUno(t);
      if (r.pausado) {
        console.log(`  ⏸  el reloj está EN PAUSA en el padrón: se guardó el lote pero no se aplicó.`);
        ok++;
        continue;
      }
      // Se reporta lo LEÍDO contra lo que el reloj DECLARA, para que una lectura
      // a medias no pueda pasar por buena nunca más.
      console.log(`  ✅ verificado: ${r.totalChecadas} de ${r.esperadas} checadas · ${r.desde || '?'} → ${r.hasta || '?'}`);
      console.log(`     serie ${r.serie || '(no la dio)'} · ${r.ne} empleados · ` +
        (DRY_RUN ? 'no se mandó (dry run)' : `${r.nc} checadas nuevas`));
      if (r.desfaseSeg != null && Math.abs(r.desfaseSeg) > 120) {
        console.log(`     ⚠ el reloj va ${r.desfaseSeg > 0 ? 'adelantado' : 'atrasado'} ${Math.abs(r.desfaseSeg)}s ` +
          'contra este equipo: la tolerancia se aplica sobre una hora falsa y salen retardos que no existen.');
      }
      ok++;
    } catch (e) {
      fallidos++;
      const m = motivo(e);
      console.log(`  ❌ SE SALTA: ${m}`);
      if (/lectura INCOMPLETA/i.test(m)) {
        console.log('     La conexión funciona; lo que falla es la descarga del log.');
        console.log('     Sube ZK_INTENTOS o córrelo cuando haya menos tráfico en la red.');
      } else if (/no se pudo conectar/i.test(m)) {
        console.log('     Corre `node tools/diagnostico-red.js --ip ' + t.ip + '` para saber en qué paso se rompe:');
        console.log('     sin ruta, puerto cerrado, otra sesión abierta o contraseña de comunicación.');
      }
    }
  }
  console.log(`\n──── ${ok} de ${TARGETS.length} relojes al día · ${fallidos} con problema ────`);
  if (PENDIENTES.length && !INCLUIR_PENDIENTES) {
    console.log(`\n  ⏸  ${PENDIENTES.length} reloj(es) en pausa, no se intentaron:`);
    PENDIENTES.forEach((t) => console.log(`     ${t.suc} (${t.ip}) — ${String(t.nota || '').split('.')[0]}`));
    console.log('     Para probarlos: npm run jalar -- --incluir-pendientes');
  }
  return { ok, fallidos };
}

// Modo watch: --loop (o LOOP_MIN=n) repite cada n minutos.
//
// ⚠️ Esto NO es "en vivo": cada vuelta baja el log completo de cada reloj. Con
// 8 relojes no cierra en 5 minutos, y lo único que se logra bajando el
// intervalo es encimar corridas. Lo que da inmediatez es api/agente/ (stream).
const LOOP_MIN = parseInt(process.env.LOOP_MIN || '', 10) || (process.argv.includes('--loop') ? 60 : 0);

(async () => {
  const TODOS = await cargarTargets();
  if (!Array.isArray(TODOS) || !TODOS.length) {
    console.error('No hay relojes que jalar: registra el padrón con tools/registrar-relojes.js o edita tools/targets.json.');
    process.exit(1);
  }
  const TARGETS = INCLUIR_PENDIENTES ? TODOS : TODOS.filter((t) => !t.pendiente);
  const PENDIENTES = TODOS.filter((t) => t.pendiente);
  if (!TARGETS.length) {
    console.error('Todos los relojes del padrón están en pausa. Usa --incluir-pendientes si de verdad quieres probarlos.');
    process.exit(1);
  }

  await correr(TARGETS, PENDIENTES);
  if (LOOP_MIN > 0) {
    console.log(`\n⏱  Repitiendo cada ${LOOP_MIN} min. Ctrl+C para detener.`);
    console.log('   Para asistencia EN VIVO instala el servicio: api/agente/ (ver COMO-DEJAR-EN-VIVO.md).');
    setInterval(() => { correr(TARGETS, PENDIENTES).catch((e) => console.error(motivo(e))); }, LOOP_MIN * 60 * 1000);
  } else if (pool) {
    await pool.end();
  }
})().catch((e) => { console.error(motivo(e)); process.exit(1); });
