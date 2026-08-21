import { pool } from '../db';
import * as hd from './horario-deducido';

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
  diasNoMedibles: number;       // días de una sola marca
  diasAtipicos: number;
  horasTrabajadas: number;
  pctATiempo: number | null;
  semanas: Array<hd.SemanaMedida & { dias: DiaVista[] }>;
  marcas: Marca[];
  usable: boolean;
  bloqueadoPor: string[];
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
    diasNoMedibles: number;
    horasTrabajadas: number;
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
  try {
    const { rows } = await pool.query(
      `SELECT empleado_codigo, turnos FROM horarios_confirmados WHERE sucursal_id = $1`,
      [sucursalId]
    );
    for (const r of rows) {
      const t: string[] = Array.isArray(r.turnos) ? r.turnos : String(r.turnos || '').split(',');
      mapa.set(String(r.empleado_codigo).trim(), t.map((x) => String(x).trim()).filter(Boolean));
    }
  } catch {
    // tabla ausente: sin confirmaciones.
  }
  return mapa;
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
function detalleDia(marcasCrudas: string[]): { comida: string; netasMin: number | null; brutasMin: number | null } {
  const mins = hd.colapsarDuplicadas(
    marcasCrudas.map((x) => hd.aMinutos(x)).filter((x): x is number => x !== null)
  );
  if (mins.length < 2) return { comida: '—', netasMin: null, brutasMin: null };
  const brutas = mins[mins.length - 1] - mins[0];
  const medio = mins.slice(1, -1);

  const tramos: string[] = [];
  let fuera = 0;
  for (let i = 0; i < medio.length; i += 2) {
    if (i + 1 < medio.length) {
      tramos.push(`${hd.aHora(medio[i])} – ${hd.aHora(medio[i + 1])}`);
      fuera += medio[i + 1] - medio[i];
    } else {
      // Impar: la última salida no tiene regreso. Se enseña, no se descuenta.
      tramos.push(hd.aHora(medio[i]) as string);
    }
  }

  return {
    comida: tramos.length ? tramos.join(' · ') : '—',
    netasMin: Math.max(0, brutas - fuera),
    brutasMin: brutas,
  };
}

// ──────────────────────────────────────────────────────────────────
// El cálculo
// ──────────────────────────────────────────────────────────────────

export async function asistenciaPersonas(
  { sucursalId, desde, hasta }: { sucursalId: string; desde: string; hasta: string }
): Promise<AsistenciaPersonas> {
  // En un checador de COMIDA la gente solo marca su desayuno/comida (un rato
  // corto), NO una jornada. Ahí "salida − entrada" ronda las 4 h y confundiría
  // a cualquiera de sistemas/oficina con un practicante. La detección de
  // practicante NO aplica en esos relojes.
  const esRelojDeComida = /comida|desayuno/i.test(sucursalId);

  // La ventana del HORARIO nunca es más corta que la del rango (ver
  // VENTANA_HORARIO_DIAS): si RH pide "Hoy", el horario sale de su último mes.
  const desdeHorario = [desde, menosDias(hasta, VENTANA_HORARIO_DIAS - 1)]
    .sort()[0];

  const [filas, ctx, conf] = await Promise.all([
    // Una sola lectura, la más ancha; el rango se recorta en memoria.
    diasPorPersona(sucursalId, desdeHorario, hasta),
    contexto(sucursalId),
    confirmados(sucursalId),
  ]);

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
    if (emp?.es_promotora) continue;
    const datos = porCodigo.get(cod);
    const dias = datos?.dias || [];
    const turnosConf = conf.get(cod) || null;

    const opciones: hd.OpcionesHorario = { minDias: 5 };
    if (turnosConf && turnosConf.length === 1) opciones.bloqueConocido = turnosConf[0];
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
    const re = ho.entradaMin === null ? null : hd.retardosPorSemana(diasAMedir, {
      ...opciones,
      entradaMin: ho.entradaMin,
      turnoPorFecha,
      diasLaborales: ho.diasLaborales,
    });

    // ── LAS MARCAS: por qué este número puede no ser de fiar ──
    const marcas: Marca[] = [];

    if (turnosConf) {
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
    if (ho.tipo === 'sin_datos') {
      marcas.push({
        codigo: 'sin_datos', gravedad: 'alta',
        detalle: `${ho.diasUsados} día(s) con entrada y salida en el rango; se necesitan 5.`,
      });
    }
    if (ho.tipo === 'sin_patron') {
      marcas.push({ codigo: 'sin_patron', gravedad: 'alta', detalle: ho.motivo || 'sin patrón reconocible' });
    }
    // Solo para un FIJO: en un rotativo la mediana global no es un horario, es el
    // punto medio entre dos turnos (la duda de un rotativo es por turno).
    if (ho.bloqueAmbiguo && !turnosConf && ho.tipo === 'fijo') {
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
    if (ho.tipo === 'rotativo') {
      marcas.push({
        codigo: 'rotativo', gravedad: 'info',
        detalle: `Trabaja ${ho.turnos.length} turnos (${ho.turnos.join(', ')}). Cada día se mide contra el suyo.`,
      });
      for (const g of (ho.grupos || []).filter((x) => x.ambiguo && !turnosConf)) {
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
    const semanas = (re?.semanas || []).map((s) => ({
      ...s,
      dias: s.dias.map((d): DiaVista => {
        const det = detalleDia(datos?.horas.get(d.fecha) || []);
        if (det.netasMin) minTrabajados += det.netasMin;
        return { ...d, comida: det.comida, horasNetas: formatHoras(det.netasMin ?? 0) };
      }),
    }));

    const bloqueantes = marcas.filter((m) => m.gravedad === 'alta');
    const diasEvaluados = re?.diasEvaluados ?? 0;

    // ── ¿PRACTICANTE? ──
    // Media jornada: el turno DEDUCIDO (salida − entrada) ronda las 4 h. Se usa
    // el horario deducido, no el día seleccionado, así que funciona hasta en
    // "Hoy" (se saca del historial de la persona). Umbral generoso (2 h a 5 h20)
    // para cubrir practicantes de 4 h y de 5 h sin marcar de más a un turno
    // completo con salida temprana ocasional.
    const entMin = ho.entrada ? hd.aMinutos(ho.entrada) : null;
    const salMin = ho.salida ? hd.aMinutos(ho.salida) : null;
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
      departamento: (emp && emp.departamento) || null,
      puesto: (emp && emp.puesto) || '',
      fotoUrl: (emp && emp.foto_url) || '',
      registrado: !!emp,
      activo: emp ? emp.activo : null,
      tipo: ho.tipo,
      horario: ho.entrada,
      turnos: ho.turnos,
      horarioConfirmado: !!turnosConf,
      costumbre: ho.entradaCruda,
      desfaseMin: ho.desfaseMin,
      salida: ho.salida,
      dispersionMin: ho.dispersionMin,
      diasLaborales: ho.diasLaborales,
      diasUsados: ho.diasUsados,
      diasEnRango: datos?.enRango.length ?? 0,
      silencioDias: silencio,
      pctUnaMarca: Math.round(pctUna * 100),
      retardoRealMin: re?.retardoRealMin ?? 0,
      atrasoBrutoMin: re?.atrasoMin ?? 0,
      absorbidoMin: re?.absorbidoMin ?? 0,
      diasConRetardo: re?.diasConRetardo ?? 0,
      diasEvaluados,
      faltas: re?.faltas ?? 0,
      diasNoMedibles: re?.marcasFaltantes ?? 0,
      diasAtipicos: re?.atipicos ?? 0,
      horasTrabajadas: Math.round(minTrabajados / 6) / 10,
      // Sobre los días que SÍ se pudieron evaluar: si no hay ninguno, no es 0%,
      // es que no hay respuesta (null). Un 0% falso parece el peor empleado.
      pctATiempo: diasEvaluados ? Math.round(((diasEvaluados - (re?.diasConRetardo ?? 0)) / diasEvaluados) * 100) : null,
      semanas,
      marcas,
      usable: bloqueantes.length === 0,
      bloqueadoPor: bloqueantes.map((m) => m.codigo),
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
      diasNoMedibles: personas.reduce((s, p) => s + p.diasNoMedibles, 0),
      horasTrabajadas: Math.round(personas.reduce((s, p) => s + p.horasTrabajadas, 0)),
    },
    personas,
  };
}
