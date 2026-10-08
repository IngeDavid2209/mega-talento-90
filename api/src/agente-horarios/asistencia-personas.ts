import { pool } from '../db';
import * as hd from './horario-deducido';
import { cargarConfig } from './config';
import { esPromotora } from './tipos';
import { incidenciasEnRango, tipoIncidencia } from '../incidencias';

/** 'HH:mm' → minutos desde medianoche. */
function minutosDeHHMM(hhmm: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

/**
 * ASISTENCIA POR PERSONA, con las reglas del horario deducido.
 *
 * Es lo que alimenta la pantalla de Asistencia. Antes esos números se calculaban
 * EN EL NAVEGADOR (`asistencia-resumen.ts`) comparando cada entrada contra el
 * horario configurado de la sucursal, sin bolsa semanal y sin distinguir un día
 * de una sola marca. El resultado era medible: Ana #105 aparecía con **251
 * minutos de retardo en un solo día** y Antonio #50 con **207 minutos y cero
 * horas trabajadas** —Antonio había checado UNA vez, así que ni siquiera se
 * sabía si esa marca era su entrada—.
 *
 * Aquí se calcula en el servidor y con las reglas que sí resisten:
 *
 *   1. El horario sale de las checadas de CADA PERSONA, no de la sucursal.
 *   2. El retardo se acumula contra una bolsa de 15 min por semana
 *      (miércoles→martes) y solo cuenta el EXCEDENTE.
 *   3. Un día con UNA sola marca no genera retardo: no se sabe si es la entrada
 *      o la salida. Es el 20% de los días-persona.
 *   4. Una falta es un día laboral DE ESA PERSONA sin ninguna marca. Sus días
 *      laborales se deducen de sus semanas, no se asumen de lunes a sábado.
 *   5. Lo que RH confirmó en `horarios_confirmados` MANDA sobre la deducción.
 *
 * Y cada persona viene con `usable` y `marcas`: un retardo con una marca alta NO
 * se puede llevar a nómina —el número existe, pero la pregunta que contesta no
 * está contestada—. Ese es el punto de todo el módulo: **un número mal calculado
 * que se ve igual que uno bien calculado es peor que no tener nada.**
 *
 * SOLO LECTURA.
 */

/** Ventana de silencio a partir de la cual se considera que alguien ya no viene. */
const DIAS_EX = Math.max(0, parseInt(process.env.AGENTE_DIAS_EX || '21', 10) || 21);
/**
 * DOS VENTANAS, Y ES LA DECISIÓN MÁS IMPORTANTE DE ESTE ARCHIVO.
 *
 * El horario de una persona NO se puede deducir del periodo que se está viendo:
 * si RH aprieta "Hoy", un solo día no alcanza (se necesitan 5 días con entrada y
 * salida) y TODOS saldrían como "sin datos", con cero retardo. La pantalla se
 * volvería inútil justo en la consulta más común.
 *
 * Así que se leen dos rangos distintos:
 *   · el horario se deduce de los últimos `VENTANA_HORARIO_DIAS` días —la
 *     historia de la persona, que es donde vive su costumbre—;
 *   · el retardo se mide SOLO en el rango que se pidió.
 *
 * Es lo que haría un humano: "su horario es 09:30, según lo que hace siempre;
 * hoy llegó 09:40, son 10 minutos".
 */
const VENTANA_HORARIO_DIAS = Math.max(7, parseInt(process.env.ASISTENCIA_VENTANA_HORARIO_DIAS || '28', 10) || 28);

/** Resta días a una fecha 'yyyy-MM-dd' (a mediodía UTC, para no cruzar husos). */
function menosDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  return new Date(d.getTime() - dias * 86400000).toISOString().slice(0, 10);
}
/** El día siguiente de 'yyyy-MM-dd'. */
function siguienteDia(fecha: string): string {
  return menosDias(fecha, -1);
}
/** Proporción de días con UNA marca a partir de la cual es crónico. */
const UMBRAL_UNA_MARCA = 0.7;
const DATO_VALIDO = `fecha::date > '2023-01-01'`;

export type Gravedad = 'alta' | 'media' | 'info' | 'ok';

export interface Marca {
  codigo: string;
  gravedad: Gravedad;
  detalle: string;
  opciones?: (string | null)[];
  impacto?: Array<{ turno: string; retardoRealMin: number | null; diasConRetardo: number | null }>;
  turnoActual?: string | null;
  turnosActuales?: (string | null)[];
}

export interface DiaVista extends hd.DiaMedido {
  comida: string;         // 'HH:MM – HH:MM' o '—'
  horasNetas: string;     // 'Hh MMm' o '—'
  /** Con qué lo justificó RH, cuando el día quedó en `justificado`. */
  justificacion?: string;
  /** Minutos que duró el desayuno, o null si ese día no hubo. */
  desayunoMin?: number | null;
  /**
   * Minutos por encima del tope. Se manda SIEMPRE que haya exceso, aunque no
   * llegue al umbral de alerta: el umbral decide qué molesta al jefe, no qué ve
   * RH. Un exceso de 3 min no merece alerta y sí merece verse.
   */
  desayunoExcesoMin?: number | null;
  /** Horas netas del día en MINUTOS (lo que se suma). null si no hubo jornada. */
  netasMin?: number | null;
  /** El desayuno de ese día NO se descontó (corporativo, con comida aparte). */
  desayunoPagado?: boolean;
  /** Minutos de horas extra que usó ese día (ya sumados en `netasMin`). */
  horasExtraUsadasMin?: number;
  /** Incidencias capturadas por RH que cubren este día. */
  incidencias?: IncidenciaDia[];
  // ── Contra el horario que RH le asignó (solo si tiene uno) ──
  /** Minutos de comida de ese día (las pausas sin contar el desayuno). */
  comidaMin?: number | null;
  /** Minutos que se pasó de la comida de su horario. */
  comidaExcesoMin?: number | null;
  /** Minutos que se fue ANTES de la salida de su horario. */
  salidaAntesMin?: number | null;
  /** Lo que su horario pide trabajar ese día, en minutos (0 si no le toca). */
  esperadoMin?: number | null;
}

/** Una incidencia de RH, tal como se pinta en la celda del día. */
export interface IncidenciaDia {
  id: string;
  tipo: string;
  codigo: string;
  etiqueta: string;
  nota: string;
  /** "Uso de horas extra": minutos que se suman a las horas del día. */
  minutos?: number | null;
}

export interface PersonaAsistencia {
  codigo: string;
  nombre: string;
  nombreCompleto: string;
  departamento: string | null;
  /** Media jornada (~4 h deducidas): se agrupa aparte en el reporte. */
  esPracticante: boolean;
  puesto: string;
  fotoUrl: string;
  registrado: boolean;          // está en `empleados`
  activo: boolean | null;
  tipo: hd.HorarioDeducido['tipo'];
  horario: string | null;
  turnos: (string | null)[];
  horarioConfirmado: boolean;
  costumbre: string | null;
  desfaseMin: number | null;
  salida: string | null;
  dispersionMin: number | null;
  diasLaborales: number[];
  diasUsados: number;          // dias con entrada Y salida en la ventana del horario
  diasEnRango: number;         // dias con alguna marca dentro del rango pedido
  silencioDias: number | null;
  pctUnaMarca: number;
  // ── Los números de la tarjeta ──
  retardoRealMin: number;
  atrasoBrutoMin: number;
  absorbidoMin: number;
  diasConRetardo: number;
  diasEvaluados: number;
  faltas: number;
  /** Faltas que RH ya justificó y por eso NO se cuentan arriba. */
  faltasJustificadas: number;
  diasNoMedibles: number;       // días de una sola marca
  diasAtipicos: number;
  horasTrabajadas: number;
  /** La misma suma, en minutos exactos: la de arriba viene redondeada a 0.1 h. */
  minutosTrabajados: number;
  /** Cuántos días del periodo tienen alguna incidencia de RH. */
  diasConIncidencia: number;
  /**
   * Sus incidencias como PERIODOS. Van aparte de los días porque quien estuvo de
   * vacaciones la semana entera no checó, y sin marcas no tiene días que medir:
   * sin esta lista su incidencia no tendría dónde verse.
   */
  incidencias: Array<IncidenciaDia & { desde: string; hasta: string }>;
  /** Minutos de desayuno por encima del tope, sumados en el periodo. */
  desayunoExcesoMin: number;
  /** En cuántos días se pasó (aunque fuera por poco). */
  diasDesayunoExcedido: number;
  pctATiempo: number | null;
  semanas: Array<hd.SemanaMedida & { dias: DiaVista[]; minutosTrabajados: number }>;
  marcas: Marca[];
  usable: boolean;
  bloqueadoPor: string[];
  /** El horario completo que RH le asignó, o null si se mide con el deducido. */
  horarioAsignado: HorarioAsignado | null;
  /** Lo que su horario pide trabajar en el periodo (null sin horario asignado). */
  minutosEsperados: number | null;
}

/**
 * EL HORARIO DE CADA PERSONA, ASIGNADO POR RH (06/10/2026).
 *
 * Vive en `horarios_confirmados`, la misma tabla que ya mandaba sobre la
 * deducción, con la salida, la comida y el sábado agregados. Cuando una fila
 * tiene `salida`, es un horario completo y es SU horario: contra él se miden el
 * retardo, la tolerancia, las faltas (qué días trabaja), la salida antes, la
 * comida y las horas que debe. Sin `salida` es una confirmación vieja del bot
 * (solo la hora de entrada) y se comporta como siempre.
 */
export interface HorarioAsignado {
  entrada: string;
  salida: string;
  comidaMin: number;
  sabado: boolean;
  sabadoEntrada: string | null;
  sabadoSalida: string | null;
  asignadoPor: string | null;
  actualizadoEn: string | null;
}

export interface AsistenciaPersonas {
  sucursalId: string;
  desde: string;
  hasta: string;
  /** Desde cuándo se leyó para DEDUCIR el horario (ver VENTANA_HORARIO_DIAS). */
  desdeHorario: string;
  ventanaHorarioDias: number;
  bolsaSemanalMin: number;
  corteSemana: string;
  /**
   * El día en que ABRE la semana de nómina (0=domingo … 4=jueves).
   *
   * Se manda para que la pantalla pueda alinear su filtro al MISMO corte con
   * el que se acumula la tolerancia. Sin este número el front no tenía de
   * dónde sacarlo: su atajo de "7 días" hacía `hoy − 6`, así que la semana
   * empezaba el día en que alguien picaba el botón —un viernes, si se picaba
   * en viernes— y el acumulado salía cortado por delante.
   */
  diaInicioSemana: number;
  diasExTrabajador: number;
  /**
   * Desde cuántos minutos de exceso el desayuno es una IRREGULARIDAD (la misma
   * vara que la alerta). La pantalla la usa para pintar la fila en rojo: con
   * 1 min, media plaza saldría marcada y el rojo dejaría de significar algo.
   */
  desayunoAlertaMin: number;
  /** false = sucursal sin hora límite: no se mide retardo (solo faltas). */
  mideRetardo: boolean;
  resumen: {
    personas: number;
    usables: number;
    conPendiente: number;
    fijos: number;
    rotativos: number;
    sinPatron: number;
    sinDatos: number;
    horarioAmbiguo: number;
    horarioConfirmado: number;
    soloUnaMarca: number;
    exTrabajadores: number;
    fueraDelPadron: number;
    retardoRealMin: number;
    retardoRealUsableMin: number;
    atrasoBrutoMin: number;
    absorbidoMin: number;
    faltas: number;
  /** Faltas que RH ya justificó y por eso NO se cuentan arriba. */
  faltasJustificadas: number;
    diasNoMedibles: number;
    horasTrabajadas: number;
    /** Minutos de desayuno por encima del tope, sumados en toda la plaza. */
    desayunoExcesoMin: number;
    diasDesayunoExcedido: number;
  };
  personas: PersonaAsistencia[];
}

// ──────────────────────────────────────────────────────────────────
// Lectura
// ──────────────────────────────────────────────────────────────────

/** Un día-persona con todas sus horas, tal como salen de `checadas`. */
async function diasPorPersona(sucursalId: string, desde: string, hasta: string) {
  const { rows } = await pool.query(
    `SELECT empleado_codigo, max(empleado_nombre) AS nombre_reloj, fecha,
            array_agg(hora ORDER BY hora) AS horas
       FROM checadas
      WHERE sucursal_id = $1 AND ${DATO_VALIDO} AND fecha >= $2 AND fecha <= $3
      GROUP BY empleado_codigo, fecha
      ORDER BY empleado_codigo, fecha`,
    [sucursalId, desde, hasta]
  );
  return rows;
}

/**
 * Silencio y proporción histórica de días con UNA marca. Se calculan sobre TODO
 * el historial, no sobre el rango: si alguien lleva dos meses sin venir, eso no
 * se ve mirando solo la última semana. Y el silencio se mide contra el último
 * día con dato DE SU SUCURSAL, nunca contra hoy: los relojes se descargan a
 * ritmos distintos y medir contra hoy convierte "no se ha bajado el reloj" en
 * "toda la sucursal renunció" (ese error ya marcó 77 de 162 personas una vez).
 */
async function contexto(sucursalId: string) {
  const { rows: sil } = await pool.query(
    `WITH lim AS (
       SELECT max(fecha::date) AS fin FROM checadas
        WHERE sucursal_id = $1 AND ${DATO_VALIDO}
     )
     SELECT empleado_codigo,
            (SELECT fin FROM lim) - max(fecha::date) AS silencio
       FROM checadas
      WHERE sucursal_id = $1 AND ${DATO_VALIDO}
      GROUP BY empleado_codigo`,
    [sucursalId]
  );
  const silencio = new Map<string, number>();
  for (const r of sil) silencio.set(String(r.empleado_codigo).trim(), Number(r.silencio));

  const { rows: una } = await pool.query(
    `WITH d AS (
       SELECT empleado_codigo, fecha, count(*)::int AS marcas
         FROM checadas WHERE sucursal_id = $1 AND ${DATO_VALIDO}
        GROUP BY empleado_codigo, fecha
     )
     SELECT empleado_codigo, count(*)::int AS dias,
            count(*) FILTER (WHERE marcas = 1)::int AS con_una
       FROM d GROUP BY empleado_codigo`,
    [sucursalId]
  );
  const unaMarca = new Map<string, { dias: number; conUna: number }>();
  for (const r of una) unaMarca.set(String(r.empleado_codigo).trim(), { dias: r.dias, conUna: r.con_una });

  // Las promotoras SÍ se traen, con su marca. No se filtran en el SQL a
  // propósito: si una promotora llegara a checar y su código no estuviera en
  // este padrón, el análisis la reportaría como "código que checa sin estar dado
  // de alta" — cambiaríamos un ruido por otro. Se traen para poder ponerle
  // nombre a su código, y se saltan más abajo, al armar la lista de personas.
  const { rows: emps } = await pool.query(
    `SELECT codigo_checador, nombre, nombre_completo, departamento, puesto, foto_url, activo, es_promotora
       FROM empleados WHERE sucursal_id = $1`,
    [sucursalId]
  );
  const padron = new Map<string, any>();
  for (const r of emps) padron.set(String(r.codigo_checador).trim(), r);

  return { silencio, unaMarca, padron };
}

/**
 * Horarios confirmados por RH. La tabla es opcional (puede no estar migrada
 * todavía): si no existe, no es un error, simplemente no hay confirmaciones.
 */
async function confirmados(sucursalId: string) {
  const mapa = new Map<string, string[]>();
  const asignados = new Map<string, HorarioAsignado>();
  try {
    const { rows } = await pool.query(
      `SELECT * FROM horarios_confirmados WHERE sucursal_id = $1`,
      [sucursalId]
    );
    for (const r of rows) {
      const cod = String(r.empleado_codigo).trim();
      const t: string[] = Array.isArray(r.turnos) ? r.turnos : String(r.turnos || '').split(',');
      const turnos = t.map((x) => String(x).trim()).filter(Boolean);
      mapa.set(cod, turnos);
      // Horario completo (con salida): es SU horario. Ver HorarioAsignado.
      if (r.salida && turnos.length === 1) {
        asignados.set(cod, {
          entrada: turnos[0],
          salida: String(r.salida),
          comidaMin: Number(r.comida_min) || 0,
          sabado: !!r.sabado,
          sabadoEntrada: r.sabado_entrada || null,
          sabadoSalida: r.sabado_salida || null,
          asignadoPor: r.confirmado_por || null,
          actualizadoEn: r.actualizado_en ? new Date(r.actualizado_en).toISOString() : null,
        });
      }
    }
  } catch {
    // tabla ausente: sin confirmaciones.
  }
  return { turnos: mapa, asignados };
}

// ──────────────────────────────────────────────────────────────────
// Presentación del día (comida y horas netas)
// ──────────────────────────────────────────────────────────────────

/** Segundos → 'Hh MMm'. */
function formatHoras(min: number): string {
  if (min <= 0) return '—';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

/**
 * La comida y las horas netas de un día, a partir de sus marcas ya colapsadas.
 * La primera y la última marca son la jornada; las de en medio son salidas y
 * regresos, y lo que se descuenta es el tiempo FUERA.
 *
 * ══ SE DESCUENTAN LOS HUECOS DE A PARES, NO DEL PRIMERO AL ÚLTIMO ══
 *
 * Antes se tomaba `medio[0] → medio[último]` como un solo bloque de comida. Con
 * dos marcas de en medio da igual, y por eso nunca se notó: casi todas las
 * plazas tienen un solo reloj y la gente marca cuatro veces al día.
 *
 * Pero en oficinas hay DOS descansos (desayuno y comida) y por lo tanto seis
 * marcas. Medido con un día real de Fernanda —07:45, 10:07, 10:27, 15:17, 15:44,
 * 18:00—, la regla vieja daba una "comida" de 5 h 37 min y 4 h 38 min
 * trabajadas; los descansos reales suman 47 min y trabajó 9 h 28 min. Le
 * descontaba media jornada por irse a desayunar.
 *
 * Salió al fundir el reloj de comida de oficinas dentro de corporativo (antes
 * eran dos plazas y sus marcas nunca se veían juntas), pero el error no era de
 * esa fusión: cualquier persona con seis marcas en un solo reloj ya lo tenía.
 *
 * Una marca de en medio SIN pareja no se descuenta: no se sabe si salió y no
 * regresó o si el lector no leyó el regreso, y descontar hasta el final del día
 * sería inventar. Se muestra para que se vea que está ahí.
 */
interface DetalleDia {
  comida: string;
  netasMin: number | null;
  brutasMin: number | null;
  desayunoMin: number | null;
  desayunoExcesoMin: number | null;
  /** El desayuno se contó como trabajado (no se descontó de las netas). */
  desayunoPagado: boolean;
  /** Minutos de pausa que NO son el desayuno (la comida), o null si no hubo. */
  comidaMin: number | null;
  /** Primera y última marca del día, en minutos (la jornada). */
  entradaMin: number | null;
  salidaMin: number | null;
}

/**
 * ══ EL DESAYUNO DE CORPORATIVO NO SE DESCUENTA (25/09/2026) ══
 *
 * Política de RH: en corporativo se checa dos veces a media jornada —el
 * desayuno de 25-30 min y la comida— y las horas netas descuentan SOLO la
 * comida. En las demás plazas hay una sola pausa y es la comida.
 *
 * El desayuno se "paga" solo si el día trae OTRA pausa emparejada además de él.
 * Con una sola pausa no se sabe cuál de las dos fue, y se descuenta: la
 * alternativa es pagar una comida entera por una marca que no se leyó.
 *
 * Lo que excede el tope NO se descuenta aquí: se sigue viendo como exceso de
 * desayuno (columna y alerta). Descontarlo en silencio sería cobrar dos veces
 * una misma falta —la alerta y la hora—, y esa decisión es de RH.
 */
export function detalleDia(
  marcasCrudas: string[],
  desayuno?: { topeMin: number; hastaMin: number; maxPlausibleMin: number; cuentaComoJornada: boolean }
): DetalleDia {
  const vacio: DetalleDia = {
    comida: '—', netasMin: null, brutasMin: null, desayunoMin: null, desayunoExcesoMin: null,
    desayunoPagado: false, comidaMin: null, entradaMin: null, salidaMin: null,
  };
  const mins = hd.colapsarDuplicadas(
    marcasCrudas.map((x) => hd.aMinutos(x)).filter((x): x is number => x !== null)
  );
  if (mins.length < 2) return vacio;
  const brutas = mins[mins.length - 1] - mins[0];
  const medio = mins.slice(1, -1);

  const tramos: string[] = [];
  let fuera = 0;
  // El desayuno es la PRIMERA pausa emparejada que empieza antes del corte. Se
  // identifica igual que en reglas.ts::reglaDesayunoExcedido — si estas dos
  // dejaran de coincidir, la pantalla y la alerta dirían cosas distintas del
  // mismo día, que es la peor forma de perder la confianza en un reporte.
  let desayunoMin: number | null = null;
  let pausas = 0;
  // Con una sola pausa, es la comida: el desayuno solo existe si hay dos.
  // Mismo criterio que reglas.ts::reglaDesayunoExcedido (08/10/2026).
  const hayDosPausas = Math.floor(medio.length / 2) >= 2;
  for (let i = 0; i < medio.length; i += 2) {
    if (i + 1 < medio.length) {
      tramos.push(`${hd.aHora(medio[i])} – ${hd.aHora(medio[i + 1])}`);
      fuera += medio[i + 1] - medio[i];
      pausas++;
      if (desayuno && hayDosPausas && desayunoMin == null && medio[i] < desayuno.hastaMin) {
        const dur = medio[i + 1] - medio[i];
        // El mismo techo que en reglas.ts: si no es creíble como desayuno, no se
        // reporta como tal. Si aquí se mostrara y allá no, la pantalla acusaría
        // de algo que la alerta no sostiene.
        if (dur <= desayuno.maxPlausibleMin) desayunoMin = dur;
      }
    } else {
      // Impar: la última salida no tiene regreso. Se enseña, no se descuenta.
      tramos.push(hd.aHora(medio[i]) as string);
    }
  }

  const desayunoPagado = !!desayuno?.cuentaComoJornada && desayunoMin != null && pausas >= 2;
  // La comida es lo que estuvo fuera SIN contar el desayuno.
  const comidaMin = pausas && fuera - (desayunoMin ?? 0) > 0 ? fuera - (desayunoMin ?? 0) : null;
  if (desayunoPagado) fuera -= desayunoMin!;

  return {
    comida: tramos.length ? tramos.join(' · ') : '—',
    netasMin: Math.max(0, brutas - fuera),
    brutasMin: brutas,
    desayunoMin,
    desayunoExcesoMin:
      desayuno && desayunoMin != null ? Math.max(0, desayunoMin - desayuno.topeMin) : null,
    desayunoPagado,
    comidaMin,
    entradaMin: mins[0],
    salidaMin: mins[mins.length - 1],
  };
}

// ──────────────────────────────────────────────────────────────────
// El cálculo
// ──────────────────────────────────────────────────────────────────

/**
 * JUSTIFICANTES APROBADOS: (codigo → fechas excusadas).
 *
 * ══ HASTA HOY EL JUSTIFICANTE NO SERVÍA DE NADA ══
 *
 * `asistencia_revision` guardaba la justificación y su estado desde que se
 * escribió la pantalla, pero NADIE la leía para calcular: este archivo ni la
 * consultaba. O sea que RH podía anotar "vacaciones" en un día y la falta
 * seguía ahí, contada en los KPIs y en la pestaña de Faltas. Era una nota al
 * margen disfrazada de justificante.
 *
 * Se exige `estado = 'aprobada'`: escribir el texto no basta. 'pendiente' y
 * 'verificada' son pasos intermedios, y que un día deje de contar es una
 * decisión firmada, no un borrador.
 *
 * Y se exige que la justificación sea de las que EXCUSAN. "Tráfico" explica un
 * retardo pero no borra el día; vacaciones, incapacidad y permiso sí: la
 * persona no debía estar ahí.
 */
const JUSTIFICAN_AUSENCIA = ['vacaciones', 'incapacidad', 'permiso'];

async function justificantes(
  sucursalId: string, desde: string, hasta: string,
): Promise<Map<string, Map<string, string>>> {
  const { rows } = await pool.query<{ empleado_codigo: string; fecha: string; justificacion: string }>(
    `SELECT empleado_codigo, fecha, justificacion
       FROM asistencia_revision
      WHERE sucursal_id = $1 AND fecha BETWEEN $2 AND $3
        AND estado = 'aprobada' AND justificacion IS NOT NULL`,
    [sucursalId, desde, hasta]);
  const out = new Map<string, Map<string, string>>();
  for (const r of rows) {
    const texto = String(r.justificacion || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (!JUSTIFICAN_AUSENCIA.some((j) => texto.includes(j))) continue;
    const cod = String(r.empleado_codigo).trim();
    if (!out.has(cod)) out.set(cod, new Map());
    out.get(cod)!.set(r.fecha, r.justificacion);
  }
  return out;
}

export async function asistenciaPersonas(
  { sucursalId, desde, hasta, soloPromotoras = false }:
    { sucursalId: string; desde: string; hasta: string; soloPromotoras?: boolean }
): Promise<AsistenciaPersonas> {
  // En un checador de COMIDA la gente solo marca su desayuno/comida (un rato
  // corto), NO una jornada. Ahí "salida − entrada" ronda las 4 h y confundiría
  // a cualquiera de sistemas/oficina con un practicante. La detección de
  // practicante NO aplica en esos relojes.
  const esRelojDeComida = /comida|desayuno/i.test(sucursalId);

  // El tope de desayuno sale de la MISMA config que usa el detector de alertas
  // (corporativo 25, el resto 30). Duplicarlo aquí con un número a mano haría
  // que la pantalla y la alerta discreparan en cuanto RH ajustara uno de los dos.
  const cfg = await cargarConfig(sucursalId);
  const desayunoCfg = cfg.reglasActivas?.desayuno_excedido && cfg.desayunoTopeMin > 0
    ? {
        topeMin: cfg.desayunoTopeMin,
        hastaMin: minutosDeHHMM(cfg.desayunoHastaHora) ?? 13 * 60,
        maxPlausibleMin: cfg.desayunoMaxPlausibleMin,
        cuentaComoJornada: !!cfg.desayunoCuentaComoJornada,
      }
    : undefined;

  // La ventana del HORARIO nunca es más corta que la del rango (ver
  // VENTANA_HORARIO_DIAS): si RH pide "Hoy", el horario sale de su último mes.
  const desdeHorario = [desde, menosDias(hasta, VENTANA_HORARIO_DIAS - 1)]
    .sort()[0];

  const [filas, ctx, conf, excusas, incidencias] = await Promise.all([
    // Una sola lectura, la más ancha; el rango se recorta en memoria.
    diasPorPersona(sucursalId, desdeHorario, hasta),
    contexto(sucursalId),
    confirmados(sucursalId),
    justificantes(sucursalId, desde, hasta),
    incidenciasEnRango(sucursalId, desde, hasta),
  ]);

  // (código → fecha → incidencias). Una incidencia es un PERIODO; aquí se
  // abre en días, recortado al rango, para pegarla a cada celda.
  const incPorDia = new Map<string, Map<string, IncidenciaDia[]>>();
  for (const inc of incidencias) {
    const t = tipoIncidencia(inc.tipo);
    const item: IncidenciaDia = {
      id: inc.id, tipo: inc.tipo, codigo: t?.codigo || 'OTR',
      etiqueta: t?.etiqueta || inc.tipo, nota: inc.nota, minutos: inc.minutos,
    };
    if (!incPorDia.has(inc.empleadoCodigo)) incPorDia.set(inc.empleadoCodigo, new Map());
    const porFecha = incPorDia.get(inc.empleadoCodigo)!;
    const ini = inc.desde > desde ? inc.desde : desde;
    const fin = inc.hasta < hasta ? inc.hasta : hasta;
    for (let f = ini; f <= fin; f = siguienteDia(f)) {
      if (!porFecha.has(f)) porFecha.set(f, []);
      porFecha.get(f)!.push(item);
    }
  }

  // Días-persona, agrupados por código. `dias` es la historia (para deducir el
  // horario) y `enRango` es lo que se mide y se muestra.
  const porCodigo = new Map<string, {
    nombreReloj: string;
    dias: hd.DiaCrudo[];        // ventana ancha
    enRango: hd.DiaCrudo[];     // solo el rango pedido
    horas: Map<string, string[]>;
  }>();
  for (const r of filas) {
    const cod = String(r.empleado_codigo).trim();
    if (!porCodigo.has(cod)) {
      porCodigo.set(cod, { nombreReloj: r.nombre_reloj || '', dias: [], enRango: [], horas: new Map() });
    }
    const p = porCodigo.get(cod)!;
    const dia = { fecha: r.fecha as string, marcas: r.horas as string[] };
    p.dias.push(dia);
    if (dia.fecha >= desde && dia.fecha <= hasta) {
      p.enRango.push(dia);
      p.horas.set(dia.fecha, r.horas);
    }
  }

  /**
   * Todas las fechas del rango. Hacen falta porque `checadas` solo tiene los días
   * en que alguien checó: un día AUSENTE de la consulta es justo el que hay que
   * evaluar como falta (o como descanso, si no es día laboral de esa persona).
   */
  const fechasDelRango: string[] = [];
  for (let f = desde; f <= hasta; f = siguienteDia(f)) fechasDelRango.push(f);

  // Base: TODOS los del padrón de la sucursal (para poder ver faltas de quien no
  // checó nada) + los códigos que checan sin estar dados de alta.
  const codigos = new Set<string>([...ctx.padron.keys(), ...porCodigo.keys()]);

  const personas: PersonaAsistencia[] = [];

  for (const cod of codigos) {
    const emp = ctx.padron.get(cod);
    // Las promotoras no se miden con esta vara: no son personal de piso y no
    // checan en el reloj de la sucursal, así que aparecían con falta todos los
    // días. Un tablero que grita todos los días deja de mirarse.
    //
    // Y quien está dado de baja del padrón tampoco: su ficha sigue existiendo
    // —la repone la ingesta porque el reloj lo trae enrolado— pero ya no trabaja
    // aquí, así que contarle faltas es inventar un pendiente. `activo === false`
    // es una decisión de RH; `null` es un código del reloj sin ficha, y ese SÍ se
    // mide: es alguien marcando sin estar en el padrón, justo lo que hay que ver.
    // El MISMO cálculo, con el filtro al revés según a quién se esté mirando.
    //
    // Promotoría pidió su propia pantalla de asistencia, igual a la de planta
    // pero con su gente. Copiar el cálculo para ellas habría dejado dos reglas
    // que se separan en el primer ajuste; esto es un interruptor sobre el mismo
    // recorrido: `soloPromotoras` cambia a QUIÉN se salta, y nada más.
    //
    // Ojo con el código SIN ficha (`emp` undefined): en la vista de planta SÍ se
    // mide —es alguien marcando sin estar en el padrón, justo lo que hay que
    // ver—, pero en la de promotoras no se puede saber si le toca, así que se
    // salta. Meterlo ahí lo contaría dos veces entre las dos pantallas.
    // Un solo predicado para las dos vistas: si aqui y alla se decidiera
    // distinto, una persona podria salir en ambas o en ninguna.
    const promotora = esPromotora(emp);
    if (soloPromotoras) {
      if (!emp || !promotora || emp.activo === false) continue;
    } else if (emp && (promotora || emp.activo === false)) continue;
    const datos = porCodigo.get(cod);
    const dias = datos?.dias || [];
    const turnosConf = conf.turnos.get(cod) || null;
    const asig = conf.asignados.get(cod) || null;

    const opciones: hd.OpcionesHorario = { minDias: 5 };
    if (turnosConf && turnosConf.length === 1) opciones.bloqueConocido = turnosConf[0];
    // Con horario asignado, sus días de trabajo son los de su horario (lunes a
    // viernes, y el sábado si le toca), no los que se deducen de sus semanas.
    const laboralesAsig = asig ? [1, 2, 3, 4, 5, ...(asig.sabado ? [6] : [])] : null;
    if (turnosConf && turnosConf.length > 1) opciones.bloquesConocidos = turnosConf;

    const u = ctx.unaMarca.get(cod);
    const pctUna = u && u.dias ? u.conUna / u.dias : 0;
    const silencio = ctx.silencio.has(cod) ? ctx.silencio.get(cod)! : null;

    // ── 1) El HORARIO sale de la ventana ancha (su historia) ──
    const ho = hd.deducirHorario(dias, opciones);

    // ── 2) Los días a MEDIR son los del rango, más los que faltan ──
    // Los días sin ninguna marca no vienen de la base: se agregan aquí, porque un
    // día sin marcas es exactamente el que puede ser una falta.
    //
    // Pero solo dentro del periodo en que la persona demostrablemente trabajaba:
    //   · desde su primera checada (para no inventarle faltas a quien acaba de
    //     entrar, antes de su alta);
    //   · hasta el fin del rango si sigue viniendo, o hasta su última checada si
    //     lleva `DIAS_EX` días en silencio (para no seguir acumulándole faltas a
    //     quien ya se fue: ese error, sin corte, genera cientos de faltas de gente
    //     que no está y sepulta las de quien sí trabaja).
    const conMarca = new Set(datos?.enRango.map((d) => d.fecha) || []);
    const primeraChecada = dias.length ? dias[0].fecha : null;
    const ultimaChecada = dias.length ? dias[dias.length - 1].fecha : null;
    const seFue = silencio !== null && silencio >= DIAS_EX;
    const piso = primeraChecada && primeraChecada > desde ? primeraChecada : desde;
    const techo = seFue && ultimaChecada && ultimaChecada < hasta ? ultimaChecada : hasta;

    const diasAMedir: hd.DiaCrudo[] = (datos?.enRango || []).slice();
    if (datos && datos.enRango.length) {
      for (const f of fechasDelRango) {
        if (conMarca.has(f) || f < piso || f > techo) continue;
        diasAMedir.push({ fecha: f, marcas: [] });
      }
      diasAMedir.sort((x, y) => x.fecha.localeCompare(y.fecha));
    }

    // ── 3) El RETARDO se mide solo en el rango, contra ese horario ──
    const turnoPorFecha = ho.tipo === 'rotativo'
      ? hd.deducirTurnos(
          diasAMedir,
          turnosConf && turnosConf.length > 1
            ? turnosConf.map((x) => hd.aMinutos(x)).filter((x): x is number => x !== null)
            : ho.bloques,
          opciones)
      : null;
    // Si el periodo empieza a media semana, los días de esa semana que quedaron
    // ANTES del periodo también gastan descansos: quien descansó el domingo y
    // se mira desde el lunes ya no tiene un descanso libre para el martes.
    const ausenciasPrevias = new Map<string, number>();
    if (primeraChecada) {
      const conMarcaHist = new Set(dias.map((d) => d.fecha));
      const clave = hd.inicioSemana(desde);
      let n = 0;
      for (let f = clave; f < desde; f = siguienteDia(f)) {
        if (f >= primeraChecada && !conMarcaHist.has(f)) n++;
      }
      if (n) ausenciasPrevias.set(clave, n);
    }

    // "Horario distinto" de RH: ese día se mide contra la hora que capturó.
    const horarioDelDia = new Map<string, number>();
    for (const [f, incs] of incPorDia.get(cod) || []) {
      for (const i of incs) if (i.tipo === 'horario_distinto' && i.minutos != null) horarioDelDia.set(f, Number(i.minutos));
    }

    // SIN HORARIO (01/10/2026): quien casi siempre checa UNA vez al día (el
    // vendedor que entra y se va a ruta) no deja deducir horario. Antes, sin
    // horario no se armaba NINGÚN día y salía en 0 aunque el reloj tuviera sus
    // checadas: RH veía "0" y en el equipo sí había marcas. Ahora sus días se
    // arman igual —con sus checadas, horas y faltas— y solo el RETARDO queda
    // apagado, porque no hay contra qué medirlo.
    // El sábado de su horario puede entrar a otra hora: se mide como un
    // "horario del día", salvo que RH haya capturado uno distinto ese sábado.
    if (asig && asig.sabado && asig.sabadoEntrada && asig.sabadoEntrada !== asig.entrada) {
      const sab = hd.aMinutos(asig.sabadoEntrada);
      if (sab !== null) {
        for (const f of fechasDelRango) if (hd.diaSemana(f) === 6 && !horarioDelDia.has(f)) horarioDelDia.set(f, sab);
      }
    }
    // Con horario asignado, la entrada es la suya aunque no haya historia para
    // deducir nada (alguien que acaba de entrar ya tiene horario).
    const entradaUsar = asig ? hd.aMinutos(asig.entrada) : ho.entradaMin;
    const sinHorario = entradaUsar === null;
    const re = hd.retardosPorSemana(diasAMedir, {
      ...opciones,
      horarioDelDia: sinHorario ? null : horarioDelDia,
      entradaMin: sinHorario ? 0 : entradaUsar,
      turnoPorFecha: sinHorario || asig ? null : turnoPorFecha,
      diasLaborales: laboralesAsig || ho.diasLaborales,
      ausenciasPrevias,
      medirRetardo: !sinHorario && cfg.medirRetardo !== false,
    });
    if (sinHorario) {
      for (const s of re.semanas) for (const d of s.dias) d.referencia = null;
      re.diasEvaluados = 0;
    }

    // ── LAS MARCAS: por qué este número puede no ser de fiar ──
    const marcas: Marca[] = [];

    if (asig) {
      marcas.push({
        codigo: 'horario_confirmado', gravedad: 'ok',
        detalle: `RH le asignó su horario: ${asig.entrada} a ${asig.salida}, comida ${asig.comidaMin} min` +
          (asig.sabado ? `, sábado ${asig.sabadoEntrada || asig.entrada} a ${asig.sabadoSalida || asig.salida}` : ', sin sábado') +
          '. Manda sobre la deducción.',
      });
    } else if (turnosConf) {
      marcas.push({
        codigo: 'horario_confirmado', gravedad: 'ok',
        detalle: `RH confirmó ${turnosConf.join(' y ')}: manda sobre la deducción.`,
      });
    }
    if (silencio !== null && silencio >= DIAS_EX) {
      marcas.push({
        codigo: 'ex_trabajador', gravedad: 'alta',
        detalle: `${silencio} días sin aparecer${emp && emp.activo ? ', y sigue ACTIVO en el padrón' : ''}. No preguntar por su horario.`,
      });
    }
    if (pctUna >= UMBRAL_UNA_MARCA && (u?.dias || 0) >= 20) {
      marcas.push({
        codigo: 'solo_una_marca', gravedad: 'alta',
        detalle: `${u!.conUna} de ${u!.dias} días con UNA sola marca (${Math.round(pctUna * 100)}%). Con una marca no se sabe si es entrada o salida: su retardo no es calculable.`,
      });
    }
    // Con horario asignado no hace falta deducir nada: ni pocos días ni falta de
    // patrón le quitan validez a su número.
    if (ho.tipo === 'sin_datos' && !asig) {
      marcas.push({
        codigo: 'sin_datos', gravedad: 'alta',
        detalle: `${ho.diasUsados} día(s) con entrada y salida en el rango; se necesitan 5.`,
      });
    }
    if (ho.tipo === 'sin_patron' && !asig) {
      marcas.push({ codigo: 'sin_patron', gravedad: 'alta', detalle: ho.motivo || 'sin patrón reconocible' });
    }
    // Solo para un FIJO: en un rotativo la mediana global no es un horario, es el
    // punto medio entre dos turnos (la duda de un rotativo es por turno).
    // Sin hora límite, preguntar "¿su horario es 8:00 u 8:30?" no sirve de
    // nada: esas dudas solo cambian un retardo que aquí no se mide.
    const conHorario = cfg.medirRetardo !== false;
    if (conHorario && ho.bloqueAmbiguo && !turnosConf && ho.tipo === 'fijo') {
      const cr = hd.aMinutos(ho.entradaCruda);
      const ops = [hd.aHora(hd.bloqueDeCostumbre(cr)), hd.aHora(hd.bloqueMasCercano(cr))];
      marcas.push({
        codigo: 'horario_ambiguo', gravedad: 'media',
        detalle: ho.motivo || '',
        opciones: ops,
        // El impacto se mide sobre el RANGO que se está viendo, no sobre la
        // ventana del horario: tiene que cuadrar con el número de la tarjeta.
        // (La pantalla de confirmación del bot lo mide sobre sus 28 días, y por
        // eso ahí las cifras son mayores: es la misma regla, otra ventana.)
        impacto: ops.filter((t): t is string => !!t).map((t) => hd.impactoDeOpcion(diasAMedir, t)),
      });
    }
    if (ho.tipo === 'rotativo' && !asig) {
      marcas.push({
        codigo: 'rotativo', gravedad: 'info',
        detalle: `Trabaja ${ho.turnos.length} turnos (${ho.turnos.join(', ')}). Cada día se mide contra el suyo.`,
      });
      for (const g of (ho.grupos || []).filter((x) => conHorario && x.ambiguo && !turnosConf)) {
        const ops = [hd.aHora(hd.bloqueDeCostumbre(g.centroMin)), hd.aHora(hd.bloqueMasCercano(g.centroMin))];
        marcas.push({
          codigo: 'turno_ambiguo', gravedad: 'media',
          detalle: `Su turno de ~${g.centro} puede ser ${ops[0]} o ${ops[1]} (${g.dias} días).`,
          opciones: ops,
          turnoActual: g.turno,
          turnosActuales: ho.turnos,
          impacto: ops.filter((t): t is string => !!t).map((t) =>
            hd.impactoDeOpcion(diasAMedir, t, { base: ho.turnos.filter((x): x is string => !!x), original: g.turno })),
        });
      }
    }
    if (re && re.atipicos > 0) {
      marcas.push({
        codigo: 'dias_atipicos', gravedad: 'media',
        detalle: `${re.atipicos} día(s) muy lejos de su horario: marca errónea o turno especial. Cuentan, pero revisar antes de usarlos.`,
      });
    }
    if (re && re.marcasFaltantes > 0) {
      marcas.push({
        codigo: 'marcas_faltantes', gravedad: 'info',
        detalle: `${re.marcasFaltantes} día(s) con una sola marca en el rango: no generan retardo porque no se sabe si esa marca es la entrada o la salida.`,
      });
    }
    if (!emp) {
      marcas.push({
        codigo: 'fuera_del_padron', gravedad: 'media',
        detalle: 'Este código checa pero no está en el padrón de empleados: sus marcas no se pueden atribuir a nadie.',
      });
    }

    // ── Semanas con la comida y las horas netas de cada día ──
    let minTrabajados = 0;
    // Los días que RH ya justificó dejan de ser falta. Se descuentan aquí y no
    // en horario-deducido a propósito: ese módulo es la REGLA (puro cálculo, sin
    // base de datos) y el justificante es una DECISIÓN de RH. Mezclarlos haría
    // que la regla dependiera de quién firmó qué.
    const excusadas = excusas.get(cod) || new Map<string, string>();
    const incDeEl = incPorDia.get(cod) || new Map<string, IncidenciaDia[]>();
    let faltasJustificadas = 0;
    // Días que el cálculo tomó como descanso pero RH marcó "falta injustificada":
    // manda RH, y vuelven a ser falta.
    let faltasForzadas = 0;
    let desayunoExcesoMin = 0;
    let diasDesayunoExcedido = 0;
    let diasConIncidencia = 0;
    // Retardo que una incidencia (permiso, vacaciones…) dejó sin efecto.
    let excusadoReal = 0, excusadoAtraso = 0, diasRetardoExcusados = 0;
    // Lo que su horario asignado pide trabajar en el periodo.
    let esperados = 0;
    const semanas = (re?.semanas || []).map((s) => {
      let minSemana = 0;
      let excReal = 0, excAtraso = 0;
      const diasVista = s.dias.map((d): DiaVista => {
        const det = detalleDia(datos?.horas.get(d.fecha) || [], desayunoCfg);
        const incs = incDeEl.get(d.fecha) || [];
        // USO DE HORAS EXTRA: los minutos que usó ese día se SUMAN a lo que
        // trabajó (29/09/2026). Si faltó el día completo usando horas, esas
        // horas son las de su jornada.
        const extraUsadas = incs.filter((i) => i.tipo === 'horas_extra')
          .reduce((t, i) => t + (Number(i.minutos) || 0), 0);
        const netas = (det.netasMin || 0) + extraUsadas;
        if (netas) { minTrabajados += netas; minSemana += netas; }
        if (det.desayunoExcesoMin) { desayunoExcesoMin += det.desayunoExcesoMin; diasDesayunoExcedido++; }
        if (incs.length) diasConIncidencia++;
        // La incidencia que excusa (vacaciones, incapacidad…) manda sobre el
        // justificante viejo de texto libre: es la que RH capturó por tipo.
        const incExcusa = incs.find((i) => tipoIncidencia(i.tipo)?.excusaFalta);
        const justificacion = incExcusa?.etiqueta || excusadas.get(d.fecha);
        // Solo se excusa la FALTA. Un día con marcas ya se midió y su retardo
        // no lo borra un justificante de ausencia: la persona sí vino.
        // Contra su horario asignado: lo que pedía ese día, si se fue antes y si
        // se pasó de la comida. Sin horario asignado no se calcula nada de esto.
        let esperadoMin: number | null = null, salidaAntesMin: number | null = null, comidaExcesoMin: number | null = null;
        if (asig) {
          const sab = hd.diaSemana(d.fecha) === 6;
          const leToca = (laboralesAsig as number[]).includes(hd.diaSemana(d.fecha));
          const ent = hd.aMinutos(sab ? asig.sabadoEntrada || asig.entrada : asig.entrada);
          const sal = hd.aMinutos(sab ? asig.sabadoSalida || asig.salida : asig.salida);
          const comPermitida = sab ? 0 : asig.comidaMin;
          esperadoMin = leToca && ent !== null && sal !== null ? Math.max(0, sal - ent - comPermitida) : 0;
          if (leToca && sal !== null && det.salidaMin !== null && det.netasMin !== null) salidaAntesMin = Math.max(0, sal - det.salidaMin);
          if (leToca && comPermitida > 0 && det.comidaMin !== null) comidaExcesoMin = Math.max(0, det.comidaMin - comPermitida);
        }
        const extra = {
          comida: det.comida,
          horasNetas: formatHoras(netas),
          netasMin: netas || det.netasMin,
          horasExtraUsadasMin: extraUsadas || undefined,
          desayunoMin: det.desayunoMin,
          desayunoExcesoMin: det.desayunoExcesoMin,
          desayunoPagado: det.desayunoPagado,
          incidencias: incs,
          comidaMin: det.comidaMin,
          comidaExcesoMin,
          salidaAntesMin,
          esperadoMin,
        };
        if (justificacion && d.estado === 'falta') {
          faltasJustificadas++;
          // Un día excusado (vacaciones, incapacidad…) no se le pide trabajar.
          return { ...d, estado: 'justificado' as hd.EstadoDia, justificacion, ...extra, esperadoMin: asig ? 0 : null };
        }
        if (esperadoMin) esperados += esperadoMin;
        // ══ LA INCIDENCIA TAMBIÉN VALE CUANDO SÍ CHECÓ ══
        // Un permiso para llegar tarde, o unas vacaciones que se capturaron
        // después de que la persona pasó a checar, dejan sin efecto el retardo
        // de ese día: RH ya decidió sobre él. No importa cuándo se capturó la
        // incidencia —el cálculo la lee cada vez—, así que una capturada
        // semanas después corrige los números de esas semanas.
        if (justificacion && (d.estado === 'retardo' || d.estado === 'absorbido')) {
          excReal += d.retardoRealMin; excAtraso += d.atrasoMin;
          if (d.retardoRealMin > 0) diasRetardoExcusados++;
          return {
            ...d, estado: 'a_tiempo' as hd.EstadoDia, justificacion,
            atrasoMin: 0, absorbidoMin: 0, retardoRealMin: 0, ...extra,
          };
        }
        if (d.estado === 'descanso' && !d.marcas && incs.some((i) => i.tipo === 'falta_injustificada')) {
          faltasForzadas++;
          return { ...d, estado: 'falta' as hd.EstadoDia, descansoPorAusencia: false, ...extra };
        }
        return { ...d, ...extra };
      });
      excusadoReal += excReal; excusadoAtraso += excAtraso;
      return {
        ...s, dias: diasVista, minutosTrabajados: minSemana,
        retardoRealMin: Math.max(0, s.retardoRealMin - excReal),
        atrasoMin: Math.max(0, s.atrasoMin - excAtraso),
      };
    });

    const bloqueantes = marcas.filter((m) => m.gravedad === 'alta');
    const diasEvaluados = re?.diasEvaluados ?? 0;

    // ── ¿PRACTICANTE? ──
    // Media jornada: el turno DEDUCIDO (salida − entrada) ronda las 4 h. Se usa
    // el horario deducido, no el día seleccionado, así que funciona hasta en
    // "Hoy" (se saca del historial de la persona). Umbral generoso (2 h a 5 h20)
    // para cubrir practicantes de 4 h y de 5 h sin marcar de más a un turno
    // completo con salida temprana ocasional.
    const entMin = asig ? hd.aMinutos(asig.entrada) : ho.entrada ? hd.aMinutos(ho.entrada) : null;
    const salMin = asig ? hd.aMinutos(asig.salida) : ho.salida ? hd.aMinutos(ho.salida) : null;
    let jornadaMin: number | null = entMin != null && salMin != null ? salMin - entMin : null;
    if (jornadaMin != null && jornadaMin < 0) jornadaMin += 24 * 60;   // por si cruza medianoche
    const esPracticante = !esRelojDeComida
      && jornadaMin != null && jornadaMin >= 120 && jornadaMin <= 320;

    personas.push({
      codigo: cod,
      esPracticante,
      nombre: (emp && emp.nombre) || datos?.nombreReloj || cod,
      // Para el reporte calcado: nombre completo y departamento vienen del padrón
      // de RH (sembrado de los reportes). Si no hay, cae al nombre del reloj.
      nombreCompleto: (emp && emp.nombre_completo) || (emp && emp.nombre) || datos?.nombreReloj || cod,
      departamento: (emp && emp.departamento && String(emp.departamento).trim().toUpperCase()) || null,
      puesto: (emp && emp.puesto) || '',
      fotoUrl: (emp && emp.foto_url) || '',
      registrado: !!emp,
      activo: emp ? emp.activo : null,
      tipo: ho.tipo,
      horario: asig ? asig.entrada : ho.entrada,
      turnos: asig ? [asig.entrada] : ho.turnos,
      horarioConfirmado: !!turnosConf,
      costumbre: ho.entradaCruda,
      desfaseMin: ho.desfaseMin,
      salida: asig ? asig.salida : ho.salida,
      dispersionMin: ho.dispersionMin,
      diasLaborales: laboralesAsig || ho.diasLaborales,
      diasUsados: ho.diasUsados,
      diasEnRango: datos?.enRango.length ?? 0,
      silencioDias: silencio,
      pctUnaMarca: Math.round(pctUna * 100),
      retardoRealMin: Math.max(0, (re?.retardoRealMin ?? 0) - excusadoReal),
      atrasoBrutoMin: Math.max(0, (re?.atrasoMin ?? 0) - excusadoAtraso),
      absorbidoMin: re?.absorbidoMin ?? 0,
      diasConRetardo: Math.max(0, (re?.diasConRetardo ?? 0) - diasRetardoExcusados),
      diasEvaluados,
      // La falta justificada no cuenta: es el punto de todo esto.
      faltas: Math.max(0, (re?.faltas ?? 0) - faltasJustificadas + faltasForzadas),
      faltasJustificadas,
      diasNoMedibles: re?.marcasFaltantes ?? 0,
      diasAtipicos: re?.atipicos ?? 0,
      horasTrabajadas: Math.round(minTrabajados / 6) / 10,
      minutosTrabajados: minTrabajados,
      diasConIncidencia,
      incidencias: incidencias
        .filter((i) => i.empleadoCodigo === cod)
        .map((i) => {
          const t = tipoIncidencia(i.tipo);
          return {
            id: i.id, tipo: i.tipo, codigo: t?.codigo || 'OTR', etiqueta: t?.etiqueta || i.tipo,
            nota: i.nota, minutos: i.minutos, desde: i.desde, hasta: i.hasta,
          };
        }),
      desayunoExcesoMin,
      diasDesayunoExcedido,
      // Sobre los días que SÍ se pudieron evaluar: si no hay ninguno, no es 0%,
      // es que no hay respuesta (null). Un 0% falso parece el peor empleado.
      pctATiempo: diasEvaluados
        ? Math.round(((diasEvaluados - Math.max(0, (re?.diasConRetardo ?? 0) - diasRetardoExcusados)) / diasEvaluados) * 100)
        : null,
      semanas,
      marcas,
      usable: bloqueantes.length === 0,
      bloqueadoPor: bloqueantes.map((m) => m.codigo),
      horarioAsignado: asig,
      minutosEsperados: asig ? esperados : null,
    });
  }

  // Primero lo que hay que ATENDER, no el retardo más alto: el retardo más alto
  // suele ser de alguien cuyo horario está sin confirmar.
  const orden = (p: PersonaAsistencia) => (p.usable ? 2 : 0) + (p.marcas.some((m) => m.gravedad === 'media') ? 1 : 0);
  personas.sort((a, b) =>
    orden(a) - orden(b) ||
    b.retardoRealMin - a.retardoRealMin ||
    (a.nombre || a.codigo).localeCompare(b.nombre || b.codigo));

  const usables = personas.filter((p) => p.usable);
  const tieneMarca = (p: PersonaAsistencia, cod: string) => p.marcas.some((m) => m.codigo === cod);

  return {
    sucursalId, desde, hasta,
    desdeHorario, ventanaHorarioDias: VENTANA_HORARIO_DIAS,
    bolsaSemanalMin: hd.BOLSA_SEMANAL_MIN,
    corteSemana: 'jueves a miércoles',
    diaInicioSemana: hd.DIA_INICIO_SEMANA,
    diasExTrabajador: DIAS_EX,
    desayunoAlertaMin: cfg.desayunoAlertaMin,
    mideRetardo: cfg.medirRetardo !== false,
    resumen: {
      personas: personas.length,
      usables: usables.length,
      conPendiente: personas.filter((p) => p.marcas.some((m) => m.gravedad === 'alta' || m.gravedad === 'media')).length,
      fijos: personas.filter((p) => p.tipo === 'fijo').length,
      rotativos: personas.filter((p) => p.tipo === 'rotativo').length,
      sinPatron: personas.filter((p) => p.tipo === 'sin_patron').length,
      sinDatos: personas.filter((p) => p.tipo === 'sin_datos').length,
      horarioAmbiguo: personas.filter((p) => tieneMarca(p, 'horario_ambiguo') || tieneMarca(p, 'turno_ambiguo')).length,
      horarioConfirmado: personas.filter((p) => p.horarioConfirmado).length,
      soloUnaMarca: personas.filter((p) => tieneMarca(p, 'solo_una_marca')).length,
      exTrabajadores: personas.filter((p) => tieneMarca(p, 'ex_trabajador')).length,
      fueraDelPadron: personas.filter((p) => !p.registrado).length,
      retardoRealMin: personas.reduce((s, p) => s + p.retardoRealMin, 0),
      retardoRealUsableMin: usables.reduce((s, p) => s + p.retardoRealMin, 0),
      atrasoBrutoMin: personas.reduce((s, p) => s + p.atrasoBrutoMin, 0),
      absorbidoMin: personas.reduce((s, p) => s + p.absorbidoMin, 0),
      faltas: personas.reduce((s, p) => s + p.faltas, 0),
      // Se reportan aparte: "3 faltas" con 5 justificadas no es lo mismo que
      // "3 faltas" a secas, y el numero de arriba ya las descuenta.
      faltasJustificadas: personas.reduce((s, p) => s + p.faltasJustificadas, 0),
      diasNoMedibles: personas.reduce((s, p) => s + p.diasNoMedibles, 0),
      horasTrabajadas: Math.round(personas.reduce((s, p) => s + p.horasTrabajadas, 0)),
      desayunoExcesoMin: personas.reduce((s, p) => s + p.desayunoExcesoMin, 0),
      diasDesayunoExcedido: personas.reduce((s, p) => s + p.diasDesayunoExcedido, 0),
    },
    personas,
  };
}
