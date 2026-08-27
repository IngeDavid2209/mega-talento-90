import { pool } from '../db';
import * as hd from './horario-deducido';

/**
 * QUIÉN ESTÁ EN CADA PLAZA AHORA MISMO.
 *
 * Alimenta el mapa en vivo. La pregunta parece trivial —"marcas impares = está
 * adentro"— y tiene dos trampas que la vuelven falsa si se contesta a lo bruto.
 *
 * ══ TRAMPA 1: LAS MARCAS DUPLICADAS INVIERTEN LA PARIDAD ══
 *
 * Los lectores devuelven la misma marca dos veces seguidas con frecuencia
 * (07:03:22 y 07:03:25). Si se cuentan en crudo, esa persona pasa de impar a
 * par y se reporta como que YA SE FUE estando presente. Medido el 27/08/2026
 * sobre 212 días-persona: 31 traían duplicados y a **26 les cambiaba la
 * respuesta**, o sea uno de cada ocho mal contado. Por eso se colapsa con la
 * misma regla que usa el resto del módulo (`hd.colapsarDuplicadas`) y no con
 * una copia local que podría separarse de ella.
 *
 * ══ TRAMPA 2: "SU ÚLTIMA MARCA ES VIEJA" NO SIGNIFICA QUE SE FUE ══
 *
 * Fue mi primera hipótesis y estaba mal. Quien entra a las 07:30 y no sale a
 * desayunar tiene UNA marca en todo el día: a las 14:00 lleva 390 minutos sin
 * tocar el reloj y está en su puesto. Descartarlo por "lleva mucho sin marcar"
 * vaciaría el mapa a media jornada.
 *
 * Lo que sí delata una salida no leída es que YA PASÓ SU HORA HABITUAL DE
 * SALIDA. Y esa hora no se supone: el módulo la deduce por persona de sus
 * propias semanas (`horario-deducido`). Así que a partir de esa hora + margen,
 * la persona no se cuenta como presente; se reporta aparte como
 * `sin_salida`, que es lo que de verdad es: un dato incompleto, no una
 * presencia.
 *
 * La regla del módulo aplica igual aquí: **la pantalla nunca debe parecer al
 * día cuando no lo está**. Un mapa que dice "32 personas" cuando la mitad se
 * fue sin marcar es peor que no tener mapa.
 */

/** Margen sobre la salida deducida antes de dar por no leída la salida. */
const MARGEN_SALIDA_MIN = 90;

/** Si el reloj de la plaza lleva esto sin señal, su conteo no es de fiar. */
const RELOJ_MUDO_MIN = 30;

export type EstadoPresencia = 'dentro' | 'salio' | 'sin_salida';

export interface PersonaPresente {
  codigo: string;
  nombre: string;
  /** Hora de su PRIMERA marca del día ('HH:MM'). */
  desde: string;
  /** Hora de su última marca ('HH:MM'). */
  ultima: string;
  marcas: number;
  estado: EstadoPresencia;
  /** Su hora habitual de salida, deducida. null si no se pudo deducir. */
  salidaHabitual: string | null;
  esPromotora: boolean;
}

export interface PlazaPresencia {
  sucursalId: string;
  dentro: number;
  salieron: number;
  /** Marcaron entrada, ya pasó su hora de salida y no hay marca de salida. */
  sinSalida: number;
  /** Segundos sin señal del reloj de esa plaza (null si no tiene reloj). */
  segundosSinSenal: number | null;
  /** true si el reloj lleva rato mudo: el conteo puede estar viejo. */
  relojMudo: boolean;
  personas: PersonaPresente[];
}

export interface Presencia {
  /** Fecha y hora local de México con la que se calculó. */
  fecha: string;
  hora: string;
  totalDentro: number;
  totalSinSalida: number;
  plazas: PlazaPresencia[];
}

const dosDigitos = (n: number) => String(n).padStart(2, '0');
const aHHMM = (min: number) => `${dosDigitos(Math.floor(min / 60))}:${dosDigitos(min % 60)}`;

export async function presenciaAhora(): Promise<Presencia> {
  // La fecha y la hora se piden a Postgres en hora de México y no se calculan
  // con `new Date()`: la API corre en UTC y a partir de las 18:00 locales el
  // servidor ya está en el día siguiente. Ese mismo error costó que la última
  // checada del semáforo se guardara seis horas corrida.
  const { rows: [ahora] } = await pool.query(
    `SELECT to_char((now() AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS fecha,
            EXTRACT(HOUR FROM now() AT TIME ZONE 'America/Mexico_City')::int * 60
          + EXTRACT(MINUTE FROM now() AT TIME ZONE 'America/Mexico_City')::int AS minuto`
  );
  const fecha: string = ahora.fecha;
  const minutoAhora: number = Number(ahora.minuto);

  const { rows: marcas } = await pool.query(
    `SELECT sucursal_id, empleado_codigo, array_agg(hora ORDER BY hora) AS horas
       FROM checadas WHERE fecha = $1
      GROUP BY sucursal_id, empleado_codigo`,
    [fecha]
  );

  // Las fichas, para el nombre y para saber quién es promotora. La clave es
  // (plaza + código) porque el MISMO código existe en plazas distintas y es
  // gente distinta: agrupar solo por código mezcla personas.
  const { rows: fichas } = await pool.query(
    `SELECT sucursal_id, codigo_checador,
            COALESCE(NULLIF(btrim(nombre_completo), ''), nombre) AS nombre,
            es_promotora, departamento
       FROM empleados WHERE activo`
  );
  const porFicha = new Map<string, any>();
  for (const f of fichas) porFicha.set(`${f.sucursal_id}|${String(f.codigo_checador).trim()}`, f);

  // La salida habitual de cada quien, deducida de sus propias semanas.
  const salidas = await salidasHabitualesCache(fecha);

  // Estado de los relojes: un conteo viejo tiene que decir que es viejo.
  const { rows: relojes } = await pool.query(
    `SELECT r.sucursal_id, MIN(EXTRACT(EPOCH FROM (now() - e.ultima_senal))::int) AS seg
       FROM relojes r LEFT JOIN relojes_estado e ON e.serie = r.serie
      WHERE r.activo GROUP BY r.sucursal_id`
  );
  const senalPorPlaza = new Map<string, number | null>();
  for (const r of relojes) senalPorPlaza.set(r.sucursal_id, r.seg == null ? null : Number(r.seg));

  const plazas = new Map<string, PlazaPresencia>();
  for (const m of marcas) {
    const cod = String(m.empleado_codigo).trim();
    const mins = hd.colapsarDuplicadas(
      (m.horas as string[]).map((h) => hd.aMinutos(h)).filter((x): x is number => x !== null)
    );
    if (!mins.length) continue;

    const ficha = porFicha.get(`${m.sucursal_id}|${cod}`);
    const salida = salidas.get(`${m.sucursal_id}|${cod}`) ?? null;
    const impar = mins.length % 2 === 1;

    let estado: EstadoPresencia;
    if (!impar) estado = 'salio';
    else if (salida != null && minutoAhora > salida + MARGEN_SALIDA_MIN) estado = 'sin_salida';
    else estado = 'dentro';

    if (!plazas.has(m.sucursal_id)) {
      const seg = senalPorPlaza.has(m.sucursal_id) ? senalPorPlaza.get(m.sucursal_id)! : null;
      plazas.set(m.sucursal_id, {
        sucursalId: m.sucursal_id, dentro: 0, salieron: 0, sinSalida: 0,
        segundosSinSenal: seg,
        relojMudo: seg == null || seg > RELOJ_MUDO_MIN * 60,
        personas: [],
      });
    }
    const p = plazas.get(m.sucursal_id)!;
    if (estado === 'dentro') p.dentro++;
    else if (estado === 'salio') p.salieron++;
    else p.sinSalida++;

    p.personas.push({
      codigo: cod,
      nombre: (ficha && ficha.nombre) || `Código ${cod}`,
      desde: aHHMM(mins[0]),
      ultima: aHHMM(mins[mins.length - 1]),
      marcas: mins.length,
      estado,
      salidaHabitual: salida != null ? aHHMM(salida) : null,
      esPromotora: !!(ficha && ficha.es_promotora),
    });
  }

  const lista = [...plazas.values()];
  for (const p of lista) {
    // Primero quien está dentro, y dentro de eso por hora de entrada: es el
    // orden en que RH lee una lista de presentes.
    const peso = (e: EstadoPresencia) => (e === 'dentro' ? 0 : e === 'sin_salida' ? 1 : 2);
    p.personas.sort((a, b) => peso(a.estado) - peso(b.estado) || a.desde.localeCompare(b.desde));
  }
  lista.sort((a, b) => b.dentro - a.dentro);

  return {
    fecha,
    hora: aHHMM(minutoAhora),
    totalDentro: lista.reduce((s, p) => s + p.dentro, 0),
    totalSinSalida: lista.reduce((s, p) => s + p.sinSalida, 0),
    plazas: lista,
  };
}

/**
 * Hora habitual de salida por (plaza + código), en minutos.
 *
 * Se deduce de las últimas semanas de CADA PERSONA con el mismo módulo que usa
 * la pantalla de asistencia, no del horario de la sucursal: media plantilla no
 * trabaja el turno general, y medir contra un horario que no es el suyo fue
 * justo lo que hacía que la asistencia mintiera antes de que existiera
 * `horario-deducido`.
 */
/**
 * La costumbre de salida cambia de un día para otro, no de un minuto para otro,
 * y calcularla cuesta leer 28 días de checadas (2.3 s de los 2.4 que tardaba
 * todo). El mapa se refresca solo cada minuto, así que sin esta caché serían
 * dos segundos de Postgres por cada refresco de cada persona que tenga la
 * pantalla abierta, para recalcular exactamente lo mismo.
 */
let cacheSalidas: { fecha: string; en: number; datos: Map<string, number> } | null = null;
const CACHE_SALIDAS_MS = 30 * 60 * 1000;

async function salidasHabitualesCache(fecha: string): Promise<Map<string, number>> {
  const ahora = Date.now();
  if (cacheSalidas && cacheSalidas.fecha === fecha && ahora - cacheSalidas.en < CACHE_SALIDAS_MS) {
    return cacheSalidas.datos;
  }
  const datos = await salidasHabituales(fecha);
  cacheSalidas = { fecha, en: ahora, datos };
  return datos;
}

async function salidasHabituales(fecha: string): Promise<Map<string, number>> {
  const desde = new Date(`${fecha}T12:00:00Z`);
  desde.setUTCDate(desde.getUTCDate() - 28);
  const desdeStr = desde.toISOString().slice(0, 10);

  const { rows } = await pool.query(
    `SELECT sucursal_id, empleado_codigo, fecha, array_agg(hora ORDER BY hora) AS horas
       FROM checadas WHERE fecha >= $1 AND fecha < $2
      GROUP BY sucursal_id, empleado_codigo, fecha`,
    [desdeStr, fecha]
  );

  const porPersona = new Map<string, number[]>();
  for (const r of rows) {
    const mins = hd.colapsarDuplicadas(
      (r.horas as string[]).map((h) => hd.aMinutos(h)).filter((x): x is number => x !== null)
    );
    // Un día de una sola marca no dice cuál es la salida: no se sabe si esa
    // marca es la entrada o la salida. Se ignora, igual que en el resto del
    // módulo.
    if (mins.length < 2) continue;
    const k = `${r.sucursal_id}|${String(r.empleado_codigo).trim()}`;
    if (!porPersona.has(k)) porPersona.set(k, []);
    porPersona.get(k)!.push(mins[mins.length - 1]);
  }

  const salidas = new Map<string, number>();
  for (const [k, v] of porPersona) {
    if (v.length < 3) continue;            // con menos de tres días no hay costumbre
    v.sort((a, b) => a - b);
    salidas.set(k, v[Math.floor(v.length / 2)]);   // mediana: la aguanta un día raro
  }
  return salidas;
}
