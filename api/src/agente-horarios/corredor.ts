import { pool } from '../db';
import { detectar } from './detector';
import { guardarBorradores, reconciliarBorradores } from './persistencia';

/**
 * EL CORREDOR — el agente trabaja solo.
 *
 * Antes, la detección solo ocurría si una persona entraba a la pantalla, elegía
 * sucursal, elegía fechas y apretaba «Analizar». Si nadie entraba, no pasaba
 * nada: eso no es un agente, es un botón. Este módulo lo pone a revisar las
 * ocho sucursales por su cuenta, cada `AGENTE_CADA_MIN` minutos, dentro del
 * mismo proceso de la API. La pantalla pasa a ser lo que debió ser siempre: el
 * lugar donde RH VE lo que el agente ya encontró.
 *
 * Lo que NO cambia (regla 80/20): el corredor solo deja borradores
 * `sugerida_ia`. No aprueba, no notifica a nadie, no da de baja a nadie. La
 * decisión sigue siendo del humano — solo deja de depender de que el humano se
 * acuerde de pedirla.
 *
 * ══ LAS DOS TRAMPAS QUE HAY QUE ESQUIVAR ══
 *
 * 1. LA VENTANA NO TERMINA HOY, TERMINA EN EL ÚLTIMO DÍA CON DATO DE CADA
 *    SUCURSAL. Los relojes se descargan a ritmos distintos: al 28 de julio de
 *    2026, seis sucursales estaban al día y cedis/corporativo llevaban 11 días
 *    sin bajarse. Si el corredor analizara «hasta hoy», esos 11 días saldrían
 *    como FALTA para las 51 personas de esas dos sucursales — 561 alertas de
 *    gente que sí fue a trabajar, solo porque nadie descargó el reloj. Es el
 *    mismo error que aquí ya marcó 77 de 162 personas como bajas; se mide contra
 *    `max(checadas.fecha)` de la propia sucursal y nunca contra `CURRENT_DATE`.
 *
 * 2. QUIEN YA NO VIENE NO ACUMULA FALTAS. Hay 35 personas con `activo=TRUE` que
 *    dejaron de aparecer hace semanas o meses. Sin corte, cada corrida les
 *    inventa una falta más, para siempre, y entierran a las alertas de quien sí
 *    trabaja. Se resuelve con `excluirSilenciososDias` (ver detector.ts): se
 *    analiza todo lo que la persona trabajó y se corta en su última checada.
 *
 * ══ POR QUÉ HAY BITÁCORA Y HUELLA ══
 *
 * Cada corrida escribe su resultado en `agente_corridas`. No es adorno:
 *   · la pantalla puede decir «revisado solo, hace 12 min» en vez de mentir con
 *     un botón que parece obligatorio;
 *   · la HUELLA (`último dato | número de checadas en la ventana`) permite
 *     SALTAR una sucursal cuyos datos no se movieron, en vez de re-analizar ocho
 *     sucursales cada media hora sin motivo;
 *   · un fallo queda guardado con su mensaje REAL, visible en la pantalla. Un
 *     agente que falla en silencio es peor que no tenerlo, porque nadie revisa a
 *     mano lo que cree que ya está revisado.
 */

// ── Perillas (todas por variable de entorno, nada clavado en el código) ──
const AUTO = (process.env.AGENTE_AUTO || 'on').toLowerCase() !== 'off';
const CADA_MIN = Math.max(5, parseInt(process.env.AGENTE_CADA_MIN || '30', 10) || 30);
const ESPERA_INICIAL_MS = Math.max(0, parseInt(process.env.AGENTE_ESPERA_INICIAL_SEG || '45', 10) || 45) * 1000;
/**
 * Tamaño de la ventana rodante. 45 días cubre de sobra el ciclo de nómina y
 * evita que la primera corrida muerda los 447 días de historia de 8-Esquinas.
 * La historia profunda se analiza a mano desde la pantalla, con rango explícito:
 * automático = ventana rodante, manual = cualquier rango. Lo que quede fuera se
 * REPORTA en `primer_dato`, no se esconde.
 */
const VENTANA_DIAS = Math.max(1, parseInt(process.env.AGENTE_VENTANA_DIAS || '45', 10) || 45);
/** Mismo umbral que usa el bot para ex-trabajadores, para que no discrepen. */
const DIAS_EX = Math.max(0, parseInt(process.env.AGENTE_DIAS_EX || '21', 10) || 21);

/**
 * Candado a nivel BASE DE DATOS, no a nivel proceso. Si Railway levanta dos
 * réplicas de la API, ambas tendrían su propio temporizador y analizarían lo
 * mismo a la vez: los UPSERT chocarían y `reconciliarBorradores` de una podría
 * borrar lo que la otra acaba de escribir. `pg_try_advisory_lock` no espera: la
 * segunda réplica simplemente no corre este ciclo.
 */
const CANDADO = 918273645;

let corriendo = false;
let temporizador: NodeJS.Timeout | null = null;

const hoyMexico = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

/** Resta días a una fecha 'yyyy-MM-dd' (a mediodía UTC, para no cruzar husos). */
function menosDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  return new Date(d.getTime() - dias * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

/** El mensaje real del error, sin envolverlo en un texto genérico. */
function motivo(e: any): string {
  if (!e) return 'error sin mensaje';
  if (typeof e === 'string') return e;
  return e.message || e.code || JSON.stringify(e).slice(0, 300);
}

export interface Ventana {
  sucursalId: string;
  desde: string;
  hasta: string;
  ultimoDato: string;
  primerDato: string;
  checadasEnVentana: number;
  huella: string;
}

/**
 * Qué tiene que revisar cada sucursal. Una sola consulta: el primer y último día
 * con dato, y cuántas checadas caen en la ventana rodante de esa sucursal.
 *
 * `fecha <= hoy` no es paranoia: la tabla `checadas` la escriben varias
 * aplicaciones y un reloj con la hora mal puesta puede grabar fechas futuras.
 * Una sola de ellas correría la ventana de toda la sucursal hacia adelante y
 * convertiría los días reales en faltas.
 */
export async function ventanas(): Promise<Ventana[]> {
  const { rows } = await pool.query(
    `WITH lim AS (
       SELECT sucursal_id,
              min(fecha) AS primero,
              max(fecha) AS ultimo
         FROM checadas
        WHERE fecha::date > '2023-01-01' AND fecha::date <= $1::date
        GROUP BY sucursal_id
     )
     SELECT l.sucursal_id, l.primero, l.ultimo,
            count(c.*)::int AS en_ventana
       FROM lim l
       LEFT JOIN checadas c
              ON c.sucursal_id = l.sucursal_id
             AND c.fecha >= greatest(l.primero, to_char(l.ultimo::date - ($2::int - 1), 'YYYY-MM-DD'))
             AND c.fecha <= l.ultimo
      GROUP BY l.sucursal_id, l.primero, l.ultimo
      ORDER BY l.sucursal_id`,
    [hoyMexico(), VENTANA_DIAS]
  );
  return rows.map((r) => {
    const ultimoDato = r.ultimo as string;
    const primerDato = r.primero as string;
    const inicioVentana = menosDias(ultimoDato, VENTANA_DIAS - 1);
    const desde = inicioVentana > primerDato ? inicioVentana : primerDato;
    return {
      sucursalId: r.sucursal_id,
      desde, hasta: ultimoDato,
      ultimoDato, primerDato,
      checadasEnVentana: r.en_ventana,
      huella: `${ultimoDato}|${r.en_ventana}`,
    };
  });
}

/** Huella de la última corrida EXITOSA de cada sucursal (para saber qué saltar). */
async function huellasPrevias(): Promise<Map<string, string>> {
  try {
    const { rows } = await pool.query(
      `SELECT sucursal_id, huella FROM agente_corridas WHERE error IS NULL`
    );
    return new Map(rows.map((r) => [r.sucursal_id as string, r.huella as string]));
  } catch (e) {
    // La tabla puede no existir todavía (migración pendiente). No es motivo para
    // no analizar: se corre todo y se avisa.
    console.warn('[agente/corredor] sin bitácora previa:', motivo(e));
    return new Map();
  }
}

async function pendientesDe(sucursalId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int n FROM asistencia_alertas WHERE sucursal_id=$1 AND estado='sugerida_ia'`,
    [sucursalId]
  );
  return rows[0]?.n ?? 0;
}

async function anotar(fila: Record<string, any>) {
  const cols = Object.keys(fila);
  const sets = cols.filter((c) => c !== 'sucursal_id').map((c) => `${c}=EXCLUDED.${c}`);
  await pool.query(
    `INSERT INTO agente_corridas (${cols.join(',')}, corrida_en)
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}, now())
     ON CONFLICT (sucursal_id) DO UPDATE SET ${sets.join(', ')}, corrida_en = now()`,
    cols.map((c) => fila[c])
  );
}

export interface ResultadoSucursal {
  sucursalId: string;
  saltada: boolean;
  desde?: string;
  hasta?: string;
  creadas?: number;
  actualizadas?: number;
  eliminadas?: number;
  pendientes?: number;
  omitidosEx?: number;
  error?: string;
}

/** Revisa UNA sucursal. Nunca lanza: el fallo se devuelve y se anota. */
export async function revisarSucursal(v: Ventana, huellaPrevia?: string, forzar = false): Promise<ResultadoSucursal> {
  const t0 = Date.now();
  const base = {
    sucursal_id: v.sucursalId, desde: v.desde, hasta: v.hasta,
    ultimo_dato: v.ultimoDato, primer_dato: v.primerDato, huella: v.huella,
  };

  if (!forzar && huellaPrevia && huellaPrevia === v.huella) {
    await anotar({ ...base, saltada: true, error: null, duracion_ms: Date.now() - t0,
      pendientes: await pendientesDe(v.sucursalId) }).catch(() => {});
    return { sucursalId: v.sucursalId, saltada: true };
  }

  try {
    const { borradores, resumen } = await detectar({
      sucursalId: v.sucursalId, desde: v.desde, hasta: v.hasta,
      excluirSilenciososDias: DIAS_EX,
    });
    const p = await guardarBorradores(borradores);
    const eliminadas = await reconciliarBorradores(v.sucursalId, v.desde, v.hasta, borradores);
    const pendientes = await pendientesDe(v.sucursalId);

    // ── HANDOFF: aquí PARA el agente. Los borradores quedan en 'sugerida_ia' y
    //    el humano decide. El corredor no aprueba ni avisa a ningún jefe.
    await anotar({
      ...base, saltada: false, error: null,
      empleados: resumen.empleadosAnalizados,
      omitidos_ex: resumen.exTrabajadoresOmitidos,
      creadas: p.creadas, actualizadas: p.actualizadas, eliminadas, pendientes,
      duracion_ms: Date.now() - t0,
    });
    return {
      sucursalId: v.sucursalId, saltada: false, desde: v.desde, hasta: v.hasta,
      creadas: p.creadas, actualizadas: p.actualizadas, eliminadas, pendientes,
      omitidosEx: resumen.exTrabajadoresOmitidos,
    };
  } catch (e) {
    const err = motivo(e);
    console.error(`[agente/corredor] ${v.sucursalId} falló: ${err}`);
    await anotar({ ...base, saltada: false, error: err, duracion_ms: Date.now() - t0 }).catch(() => {});
    return { sucursalId: v.sucursalId, saltada: false, error: err };
  }
}

/**
 * Una pasada completa por todas las sucursales. Secuencial a propósito: son 8
 * sucursales sobre la misma base que atiende al portal en vivo; en paralelo se
 * pelearían por las conexiones del pool y harían más lento lo que la gente sí
 * está esperando en pantalla.
 */
export async function correrUnaVez(opciones: { forzar?: boolean; sucursalId?: string } = {}) {
  if (corriendo) return { ok: false, motivo: 'ya hay una revisión en curso' as const, sucursales: [] };
  corriendo = true;

  const cliente = await pool.connect();
  let conCandado = false;
  try {
    const { rows } = await cliente.query('SELECT pg_try_advisory_lock($1) AS tomado', [CANDADO]);
    conCandado = rows[0]?.tomado === true;
    if (!conCandado) {
      // Otra réplica de la API está corriendo la revisión. Correcto: no duplicar.
      return { ok: false, motivo: 'otra instancia está revisando' as const, sucursales: [] };
    }

    const todas = await ventanas();
    const objetivo = opciones.sucursalId ? todas.filter((v) => v.sucursalId === opciones.sucursalId) : todas;
    if (opciones.sucursalId && !objetivo.length) {
      return { ok: false, motivo: 'esa sucursal no tiene checadas' as const, sucursales: [] };
    }
    const previas = await huellasPrevias();

    const resultados: ResultadoSucursal[] = [];
    for (const v of objetivo) {
      resultados.push(await revisarSucursal(v, previas.get(v.sucursalId), opciones.forzar));
    }

    const revisadas = resultados.filter((r) => !r.saltada && !r.error);
    const fallidas = resultados.filter((r) => r.error);
    const nuevas = revisadas.reduce((a, r) => a + (r.creadas || 0), 0);
    console.log(
      `[agente/corredor] ${revisadas.length} revisada(s) · ${resultados.length - revisadas.length - fallidas.length} sin cambios · ` +
      `${fallidas.length} con error · ${nuevas} alerta(s) nueva(s)`
    );
    return { ok: true, sucursales: resultados };
  } finally {
    if (conCandado) await cliente.query('SELECT pg_advisory_unlock($1)', [CANDADO]).catch(() => {});
    cliente.release();
    corriendo = false;
  }
}

/**
 * Arranca el corredor. Se llama una vez desde index.ts, después del `listen`.
 *
 * La espera inicial existe para no competir con el arranque: si la API acaba de
 * desplegarse, lo primero que tiene que hacer es contestar peticiones, no
 * ponerse a analizar 45 días de ocho sucursales.
 *
 * `AGENTE_AUTO=off` lo apaga sin tocar código — útil si algún día hay que
 * diagnosticar en producción sin que el corredor esté escribiendo debajo.
 */
export function arrancarCorredor() {
  if (!AUTO) {
    console.log('[agente/corredor] APAGADO (AGENTE_AUTO=off). La detección solo correrá a mano.');
    return;
  }
  if (temporizador) return;

  const pasada = () => {
    correrUnaVez().catch((e) => console.error('[agente/corredor] pasada falló:', motivo(e)));
  };

  console.log(
    `[agente/corredor] encendido · cada ${CADA_MIN} min · ventana ${VENTANA_DIAS} días · ` +
    `ex-trabajadores a los ${DIAS_EX} días de silencio · primera pasada en ${ESPERA_INICIAL_MS / 1000}s`
  );
  setTimeout(pasada, ESPERA_INICIAL_MS).unref();
  temporizador = setInterval(pasada, CADA_MIN * 60 * 1000);
  temporizador.unref(); // no impide que el proceso termine si Railway lo reinicia
}

/** Lo que la pantalla necesita para decir «esto se revisó solo, hace X». */
export async function estadoCorredor() {
  let corridas: any[] = [];
  try {
    const { rows } = await pool.query(
      `SELECT * FROM agente_corridas ORDER BY sucursal_id`
    );
    corridas = rows;
  } catch (e) {
    return { auto: AUTO, cadaMin: CADA_MIN, ventanaDias: VENTANA_DIAS, diasEx: DIAS_EX,
             error: `bitácora no disponible: ${motivo(e)}`, sucursales: [] };
  }

  const { rows: pend } = await pool.query(
    `SELECT sucursal_id, count(*)::int n FROM asistencia_alertas
      WHERE estado='sugerida_ia' GROUP BY 1`
  );
  const pendPorSuc = new Map(pend.map((r) => [r.sucursal_id as string, r.n as number]));

  return {
    auto: AUTO, cadaMin: CADA_MIN, ventanaDias: VENTANA_DIAS, diasEx: DIAS_EX,
    corriendo,
    ultimaCorrida: corridas.reduce<string | null>(
      (max, r) => (!max || r.corrida_en > max ? r.corrida_en : max), null
    ),
    pendientesTotal: [...pendPorSuc.values()].reduce((a, b) => a + b, 0),
    sucursales: corridas.map((r) => ({
      sucursalId: r.sucursal_id,
      desde: r.desde, hasta: r.hasta,
      ultimoDato: r.ultimo_dato,
      primerDato: r.primer_dato,
      // Historia que la ventana rodante NO cubre. Se dice, no se esconde: sin
      // esto la pantalla parecería afirmar que revisó todo el historial.
      historiaSinCubrir: !!(r.primer_dato && r.desde && r.primer_dato < r.desde),
      empleados: r.empleados,
      omitidosEx: r.omitidos_ex,
      pendientes: pendPorSuc.get(r.sucursal_id) ?? r.pendientes ?? 0,
      creadas: r.creadas, actualizadas: r.actualizadas, eliminadas: r.eliminadas,
      duracionMs: r.duracion_ms,
      saltada: r.saltada,
      error: r.error,
      corridaEn: r.corrida_en,
    })),
  };
}
