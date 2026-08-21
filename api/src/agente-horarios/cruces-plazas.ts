import { pool } from '../db';

/**
 * QUIÉN CHECÓ EN OTRA PLAZA.
 *
 * ══ POR QUÉ NO SE PUEDE HACER POR CÓDIGO ══
 *
 * Los códigos del reloj se repiten entre plazas: el #17 de Morelia Madero y el
 * #17 de Morelia Abastos son personas DISTINTAS, y la base lo asume así —la
 * llave de `empleados` es (sucursal_id, codigo_checador)—. Por eso una marca de
 * alguien en el reloj de otra plaza no se ve como una anomalía: entra
 * limpiamente como si fuera del homónimo de allá. Es invisible por definición.
 *
 * La única llave que cruza equipos es el NOMBRE. Se compara normalizado (sin
 * acentos, sin puntuación, palabras ORDENADAS) para que "GARCIA TAPIA LUCIA" y
 * "LUCIA GARCIA TAPIA" sean la misma persona, y se exigen DOS palabras: con
 * "Lupita" o "Delicias" el empate es casualidad, y no se puede señalar a nadie
 * con una casualidad.
 *
 * ══ LO QUE SE EXCLUYE A PROPÓSITO ══
 *
 * Oficinas tiene DOS relojes —entrada/salida (.80) y comida (.81)— más el .196.
 * Son la MISMA SEDE: la gente marca en los dos todos los días, y eso no es una
 * anomalía, es el diseño. Medido el 20/08/2026: 35 personas cruzan ahí a diario
 * con un patrón limpio (07:45→18:00 en el de jornada, 10:07→15:33 en el de
 * comida). Contarlas haría que este apartado gritara 35 nombres cada día, y un
 * tablero que grita todos los días deja de mirarse. Van agrupadas por SEDE.
 *
 * ══ NO TODO CRUCE ES LO MISMO, Y AHÍ ESTÁ EL VALOR ══
 *
 * De los 11 casos reales al 20/08/2026, tres clases con consecuencias opuestas:
 *
 *   · `jornada_partida` — cubren dos tiendas y su día quedó cortado: Brenda
 *     entra 08:06 en Vicente Guerrero y sale 16:09 en Abastos. Esto NO es una
 *     falta: es la razón por la que hoy aparecen con "una sola marca" en cada
 *     plaza y caen en el bote de días no medibles. Detectarlo permite armar su
 *     jornada real en vez de descartarla.
 *   · `traslape` — dos JORNADAS que se pisan: Claudia con 06:56→16:56 en
 *     corporativo y 08:21→15:06 en Zamora Canindo, el mismo día. Nadie está en
 *     dos ciudades a la vez: o checan por ella, o su código lo usa otra persona.
 *     Exige que las DOS estancias tengan ventana real (2+ marcas).
 *   · `marca_ajena` — una marca SUELTA en la plaza de otro, a media jornada
 *     propia: César marca 09:23 en Abastos con su día corriendo 08:07→17:08 en
 *     Vicente Guerrero. Es la pregunta original —se checó en otra área— y a
 *     propósito NO se llama imposible: las dos plazas son de Morelia y pudo ir y
 *     volver. Acusar de más hace que la lista entera se descarte la primera vez
 *     que alguien demuestra que fue por un pedido.
 *   · `ruta_promotora` — Daniela (Totis) hace 8-Esquinas 10:00→11:59 y PH
 *     12:56→14:59 casi a diario. Es su trabajo. Se marca aparte para que no
 *     ensucie la lista, no se esconde.
 *
 * Un detector que devolviera las tres cosas revueltas obligaría a RH a
 * reclasificar 11 casos a mano cada semana, y acabaría sin usarse.
 */

/** Relojes que son la MISMA sede física: cruzarse entre ellos es normal. */
const MISMA_SEDE: Record<string, string> = {
  'corporativo': 'oficinas',
  'corporativo-comida': 'oficinas',
  'reloj-196': 'oficinas',
};
export const sedeDe = (sucursalId: string): string => MISMA_SEDE[sucursalId] || sucursalId;

/**
 * Hueco máximo entre dos estancias para leerlas como UNA jornada partida. Con
 * más que esto ya no es "se movió de tienda": son dos presencias sueltas y se
 * reportan como tal, sin inventarle una jornada continua.
 */
const HUECO_JORNADA_MIN = 240;

/** Palabras de 3+ letras, ordenadas: el nombre como llave de persona. */
export function claveNombre(nombre: string | null | undefined): string {
  return String(nombre || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .sort()
    .join(' ');
}

/** ¿Sirve este nombre para cruzar plazas? Con una sola palabra, no. */
export function nombreUsable(clave: string): boolean {
  return !!clave && clave.split(' ').length >= 2;
}

export type ClaseCruce = 'traslape' | 'marca_ajena' | 'jornada_partida' | 'ruta_promotora' | 'sueltas';

export interface EstanciaCruce {
  sucursalId: string;
  codigo: string;
  primera: string;      // 'HH:mm'
  ultima: string;       // 'HH:mm'
  marcas: number;
}
export interface DiaCruce {
  fecha: string;
  estancias: EstanciaCruce[];
  clase: ClaseCruce;
  /** Minutos entre el fin de una estancia y el inicio de la siguiente. Negativo = se enciman. */
  huecoMin: number | null;
}
export interface AltaPersona { sucursalId: string; codigo: string; nombre: string; esPromotora: boolean; }
export interface PersonaCruce {
  nombre: string;
  clave: string;
  esPromotora: boolean;
  /** Dónde está dada de alta (plaza + su código en cada una). */
  altas: AltaPersona[];
  /** Su clase más grave en el periodo: es lo que ordena la lista. */
  clase: ClaseCruce;
  dias: DiaCruce[];
  diasCruzados: number;
  traslapes: number;
  /** Días en que su marca cayó en la plaza ajena a media jornada propia. */
  marcasAjenas: number;
  ultimoDia: string;
}
export interface CrucesPlazas {
  desde: string; hasta: string;
  /** Cuántas personas están de alta en dos sedes (con o sin cruce de marcas). */
  enDosSedes: number;
  personas: PersonaCruce[];
  resumen: { personas: number; dias: number; traslapes: number; marcasAjenas: number; jornadasPartidas: number; rutas: number };
}

const hhmm = (h: string) => String(h || '').slice(0, 5);
const aMin = (h: string) => {
  const [hh, mm] = hhmm(h).split(':').map(Number);
  return Number.isFinite(hh) && Number.isFinite(mm) ? hh * 60 + mm : null;
};

/**
 * Clasifica un día con estancias en dos o más sedes.
 *
 * Se ordenan por hora de entrada y se mira el hueco entre una y la siguiente:
 * si se encima, nadie pudo estar en las dos; si no, o es una jornada que se
 * movió de tienda, o son dos presencias sin relación.
 */
export function clasificarDia(estancias: EstanciaCruce[], esPromotora: boolean): { clase: ClaseCruce; huecoMin: number | null } {
  const orden = estancias.slice().sort((a, b) => (aMin(a.primera) ?? 0) - (aMin(b.primera) ?? 0));

  // El hueco más chico entre una estancia y la siguiente. Negativo = se enciman.
  let peorHueco: number | null = null;
  for (let i = 1; i < orden.length; i++) {
    const finAnterior = aMin(orden[i - 1].ultima);
    const inicio = aMin(orden[i].primera);
    if (finAnterior === null || inicio === null) continue;
    const hueco = inicio - finAnterior;
    if (peorHueco === null || hueco < peorHueco) peorHueco = hueco;
  }

  // UNA ESTANCIA DE UNA SOLA MARCA NO ES UNA ESTANCIA.
  //
  // Con una marca sola, `primera` y `ultima` son la misma hora: no hay ventana de
  // presencia, hay un instante. Si ese instante cae dentro de la jornada de la
  // otra plaza, la resta da un traslape enorme y parece imposible —a César le
  // salían −465 min con una marca de 09:23 en Abastos contra 08:07→17:08 en
  // Vicente Guerrero—. Pero las dos plazas están en Morelia: pudo ir y volver.
  // Llamarlo imposible es acusar de más, y una lista que acusa de más se descarta
  // completa la primera vez que alguien demuestra que fue por un pedido.
  //
  // Ese caso tiene su propia clase, y es justo la pregunta original: se CHECÓ en
  // el reloj de otra área mientras su jornada corría en la suya.
  const conVentana = orden.filter((e) => e.marcas >= 2 && aMin(e.ultima)! > aMin(e.primera)!);
  const seEnciman = (a: EstanciaCruce, b: EstanciaCruce) =>
    aMin(a.primera)! < aMin(b.ultima)! && aMin(b.primera)! < aMin(a.ultima)!;

  // 1) Dos jornadas de verdad que se pisan: nadie está en dos plazas a la vez.
  for (let i = 0; i < conVentana.length; i++) {
    for (let j = i + 1; j < conVentana.length; j++) {
      if (sedeDe(conVentana[i].sucursalId) === sedeDe(conVentana[j].sucursalId)) continue;
      if (seEnciman(conVentana[i], conVentana[j])) return { clase: 'traslape', huecoMin: peorHueco };
    }
  }

  // 2) Una ruta de promotora explica estar en dos plazas el mismo día (no estar en
  //    las dos a la misma hora, que ya se descartó arriba).
  if (esPromotora) return { clase: 'ruta_promotora', huecoMin: peorHueco };

  // 3) Marca suelta en la plaza ajena, con su jornada corriendo en otra.
  const instantes = orden.filter((e) => !conVentana.includes(e));
  for (const s of instantes) {
    const hora = aMin(s.primera);
    if (hora === null) continue;
    const dentro = conVentana.some((e) =>
      sedeDe(e.sucursalId) !== sedeDe(s.sucursalId) &&
      hora >= aMin(e.primera)! && hora <= aMin(e.ultima)!);
    if (dentro) return { clase: 'marca_ajena', huecoMin: peorHueco };
  }

  // 4) Dos estancias pegadas: cubrió dos tiendas y su día quedó cortado.
  if (peorHueco !== null && peorHueco >= 0 && peorHueco <= HUECO_JORNADA_MIN) {
    return { clase: 'jornada_partida', huecoMin: peorHueco };
  }
  return { clase: 'sueltas', huecoMin: peorHueco };
}

/** La clase más grave de un conjunto de días. Es la que le pone cara a la fila. */
const GRAVEDAD: ClaseCruce[] = ['traslape', 'marca_ajena', 'jornada_partida', 'sueltas', 'ruta_promotora'];
export function claseMasGrave(clases: ClaseCruce[]): ClaseCruce {
  for (const c of GRAVEDAD) if (clases.includes(c)) return c;
  return 'sueltas';
}

export async function crucesEntrePlazas(
  { desde, hasta }: { desde: string; hasta: string }
): Promise<CrucesPlazas> {
  // 1) El padrón completo, de todas las plazas. Es la única forma de saber que
  //    dos códigos de dos relojes son la misma persona.
  const padron = await pool.query<{
    sucursal_id: string; codigo_checador: string; nombre: string; es_promotora: boolean;
  }>(
    `SELECT sucursal_id, codigo_checador,
            COALESCE(NULLIF(btrim(nombre_completo), ''), nombre) AS nombre,
            es_promotora
       FROM empleados
      WHERE nombre IS NOT NULL AND btrim(nombre) <> ''`
  );

  const porClave = new Map<string, AltaPersona[]>();
  for (const e of padron.rows) {
    const clave = claveNombre(e.nombre);
    if (!nombreUsable(clave)) continue;
    if (!porClave.has(clave)) porClave.set(clave, []);
    porClave.get(clave)!.push({
      sucursalId: e.sucursal_id,
      codigo: String(e.codigo_checador).trim(),
      nombre: e.nombre,
      esPromotora: !!e.es_promotora,
    });
  }

  // 2) Solo quienes están de alta en DOS SEDES distintas (no dos relojes de la
  //    misma sede: ahí cruzarse es lo normal).
  const candidatos = [...porClave.entries()]
    .filter(([, altas]) => new Set(altas.map((a) => sedeDe(a.sucursalId))).size > 1);

  if (!candidatos.length) {
    return { desde, hasta, enDosSedes: 0, personas: [], resumen: { personas: 0, dias: 0, traslapes: 0, marcasAjenas: 0, jornadasPartidas: 0, rutas: 0 } };
  }

  // 3) Sus marcas del periodo, en UNA sola consulta: una por persona serían 48
  //    idas a la base cada vez que alguien abre la pestaña.
  const pares = candidatos.flatMap(([, altas]) => altas.map((a) => [a.sucursalId, a.codigo]));
  const marcas = await pool.query<{
    sucursal_id: string; empleado_codigo: string; fecha: string;
    primera: string; ultima: string; n: string;
  }>(
    `SELECT c.sucursal_id, c.empleado_codigo, c.fecha,
            MIN(c.hora) AS primera, MAX(c.hora) AS ultima, COUNT(*) AS n
       FROM checadas c
       JOIN (SELECT * FROM unnest($3::text[], $4::text[]) AS t(suc, cod)) p
         ON p.suc = c.sucursal_id AND p.cod = c.empleado_codigo
      WHERE c.fecha BETWEEN $1 AND $2
      GROUP BY c.sucursal_id, c.empleado_codigo, c.fecha`,
    [desde, hasta, pares.map((p) => p[0]), pares.map((p) => p[1])]
  );

  // Índice (sucursal|codigo) → fecha → estancia.
  const porPar = new Map<string, Map<string, EstanciaCruce>>();
  for (const m of marcas.rows) {
    const k = `${m.sucursal_id}|${String(m.empleado_codigo).trim()}`;
    if (!porPar.has(k)) porPar.set(k, new Map());
    porPar.get(k)!.set(m.fecha, {
      sucursalId: m.sucursal_id,
      codigo: String(m.empleado_codigo).trim(),
      primera: hhmm(m.primera),
      ultima: hhmm(m.ultima),
      marcas: Number(m.n) || 0,
    });
  }

  const personas: PersonaCruce[] = [];
  for (const [clave, altas] of candidatos) {
    // Día → estancias que tuvo ese día, de todas sus altas.
    const porDia = new Map<string, EstanciaCruce[]>();
    for (const a of altas) {
      const dias = porPar.get(`${a.sucursalId}|${a.codigo}`);
      if (!dias) continue;
      for (const [fecha, est] of dias) {
        if (!porDia.has(fecha)) porDia.set(fecha, []);
        porDia.get(fecha)!.push(est);
      }
    }

    const esPromotora = altas.some((a) => a.esPromotora);
    const dias: DiaCruce[] = [];
    for (const [fecha, estancias] of porDia) {
      // El cruce es entre SEDES. Dos estancias en los dos relojes de oficinas
      // son un solo lugar y no cuentan.
      if (new Set(estancias.map((e) => sedeDe(e.sucursalId))).size < 2) continue;
      const { clase, huecoMin } = clasificarDia(estancias, esPromotora);
      dias.push({ fecha, estancias, clase, huecoMin });
    }
    if (!dias.length) continue;

    dias.sort((a, b) => (a.fecha < b.fecha ? 1 : -1));   // el más reciente primero
    personas.push({
      nombre: altas[0].nombre,
      clave,
      esPromotora,
      altas: altas.slice().sort((a, b) => a.sucursalId.localeCompare(b.sucursalId)),
      clase: claseMasGrave(dias.map((d) => d.clase)),
      dias,
      diasCruzados: dias.length,
      traslapes: dias.filter((d) => d.clase === 'traslape').length,
      marcasAjenas: dias.filter((d) => d.clase === 'marca_ajena').length,
      ultimoDia: dias[0].fecha,
    });
  }

  // Primero lo que hay que explicar (traslapes), luego lo que hay que arreglar
  // (jornadas partidas), y al final las rutas de promotora, que son normales.
  const rango = (c: ClaseCruce) => GRAVEDAD.indexOf(c);
  personas.sort((a, b) =>
    rango(a.clase) - rango(b.clase) ||
    b.traslapes - a.traslapes ||
    b.marcasAjenas - a.marcasAjenas ||
    b.diasCruzados - a.diasCruzados ||
    a.nombre.localeCompare(b.nombre, 'es'));

  return {
    desde, hasta,
    enDosSedes: candidatos.length,
    personas,
    resumen: {
      personas: personas.length,
      dias: personas.reduce((t, p) => t + p.diasCruzados, 0),
      traslapes: personas.reduce((t, p) => t + p.traslapes, 0),
      marcasAjenas: personas.reduce((t, p) => t + p.marcasAjenas, 0),
      jornadasPartidas: personas.filter((p) => p.clase === 'jornada_partida').length,
      rutas: personas.filter((p) => p.clase === 'ruta_promotora').length,
    },
  };
}
