import { pool } from '../db';
import * as hd from './horario-deducido';
import { salidasHabitualesCache } from './presencia';
import { asistenciaPersonas } from './asistencia-personas';
import { incidenciasEnRango, tipoIncidencia } from '../incidencias';

/**
 * UBICACIÓN DE MI EQUIPO — quién está en cada RELOJ ahora mismo (29/09/2026).
 *
 * Alimenta la sección animada de Horarios y checadas. Se parece a
 * `presencia.ts` (quién está en cada PLAZA), pero la pregunta es otra: en qué
 * reloj está cada quien, y si está trabajando o comiendo. Corporativo tiene dos
 * relojes —entrada/salida y desayuno/comida— y RH quiere ver a la gente pasar
 * de uno a otro.
 *
 * ══ LA REGLA DE CADA PERSONA ══
 *
 * Con sus marcas de HOY, ya colapsadas (las duplicadas invierten la paridad:
 * ver presencia.ts):
 *
 *   · Impar  → está dentro. Si su última marca fue en el reloj de comida, ya
 *              regresó de comer: vuelve a su edificio (el reloj de su entrada).
 *              Si ya pasó su hora habitual de salida + 90 min, es `sin_salida`
 *              (entró y no se leyó su salida), no una presencia.
 *   · Par    → salió. Pero salir no siempre es irse:
 *              - si la última marca fue en un reloj de comida → `comida`;
 *              - en plazas de un solo reloj, si salió bastante ANTES de su hora
 *                habitual de salida y hace menos de 2 h → `comida` (fue a comer
 *                y va a volver);
 *              - si no, `salio`: terminó su jornada.
 *
 * Los que salieron no se dibujan: van a un contador. Así el dibujo es la foto
 * de AHORA, que es lo que se le pregunta a un mapa.
 */

const MARGEN_SALIDA_MIN = 90;
const RELOJ_MUDO_MIN = 30;
/** Salir más de esto antes de su hora de salida habitual cuenta como pausa, no como fin de jornada. */
const ANTES_DE_SU_SALIDA_MIN = 60;
/** Una pausa de comida no dura más que esto; después ya se fue. */
const PAUSA_MAX_MIN = 120;

export type EstadoEquipo = 'dentro' | 'comida' | 'sin_salida';
export type TipoEscena = 'oficina' | 'comedor' | 'tienda' | 'bodega';

export interface PersonaEquipo {
  codigo: string;
  nombre: string;
  departamento: string | null;
  estado: EstadoEquipo;
  /** Hora de su primera marca del día (su entrada). */
  entrada: string;
  /** Hora de su última marca. */
  ultima: string;
  /** Minutos desde su última marca: para animar a quien acaba de llegar. */
  hace: number;
}

/** Alguien que ya terminó su jornada hoy. */
export interface PersonaSalida {
  codigo: string; sucursalId: string; nombre: string; departamento: string | null;
  entrada: string; salida: string;
  /**
   * SALIÓ ANTES (29/09/2026): cuántos minutos antes de lo que suele durar su
   * jornada se fue. null si salió a su hora (o no hay historia para saberlo).
   */
  antesMin: number | null;
  /** Lo que suele durar su jornada ('9h 30m'), para el aviso. */
  jornadaHabitual: string | null;
  /**
   * JUSTIFICADA (29/09/2026): RH registró hoy una incidencia para esta persona
   * (permiso, vacaciones, "otros" con su nota…). La salida anticipada se sigue
   * viendo, pero ya no cuenta como aviso. null = sin justificar.
   */
  justificacion: string | null;
}

/** Alguien que hoy tenía que trabajar y no se ha presentado. */
export interface PersonaFalta {
  codigo: string; sucursalId: string; nombre: string; departamento: string | null;
  /** A qué hora suele entrar ('08:00'), o sus turnos si rota. */
  entraA: string;
  /** Minutos que lleva de retraso sobre esa hora. */
  retrasoMin: number;
}

export interface EscenaEquipo {
  /** Serie del reloj, o `plaza:<sucursal>` si sus marcas no traen serie. */
  id: string;
  serie: string | null;
  sucursalId: string;
  alias: string;
  /**
   * Los relojes que forman la escena. Casi siempre uno; en corporativo son dos
   * —entrada/salida y desayuno/comida— y es UN SOLO lugar (29/09/2026, RH): se
   * pintan juntos, y quien checa en el de comida sale en su rincón "En comida".
   */
  relojes: string[];
  tipo: TipoEscena;
  relojMudo: boolean;
  segundosSinSenal: number | null;
  personas: PersonaEquipo[];
  /** Ya terminaron su jornada hoy (su última marca fue aquí). */
  salieron: number;
  /** Entraron y ya pasó su hora de salida sin marca de salida. */
  sinSalida: number;
  /** Los que ya se fueron, con aviso si salieron antes de su jornada. */
  salidas: PersonaSalida[];
  /** Los que hoy tenían que venir y no han checado (en rojo). */
  faltan: PersonaFalta[];
  /** Cuántos tienen hoy su día de descanso (según la regla de descansos). */
  descansan: number;
}

export interface EquipoAhora {
  fecha: string;
  hora: string;
  totales: {
    dentro: number; comida: number; salieron: number; sinSalida: number;
    /** Salieron antes de lo que dura su jornada. */
    salieronAntes: number;
    /** Tenían que venir y no se han presentado. */
    faltan: number;
  };
  escenas: EscenaEquipo[];
}

/**
 * SALIÓ ANTES: se compara lo que trabajó hoy (de su primera a su última
 * checada) contra lo que SUELE DURAR SU JORNADA, no contra una hora fija de
 * salida. Así no se le avisa de más a quien rota turnos o entra tarde: quien
 * entra 14:00 y sale 22:00 cumplió, aunque "la salida de la plaza" sea 18:00.
 * Menos de esto antes no se avisa (checar unos minutos antes es ruido).
 */
const SALIO_ANTES_MIN = 30;
/** NO SE PRESENTÓ: se espera esto después de su hora de entrada antes de marcarlo. */
const MARGEN_FALTA_MIN = 30;

const dd = (n: number) => String(n).padStart(2, '0');
const aHoras = (m: number) => `${Math.floor(m / 60)}h ${dd(Math.round(m % 60))}m`;
const aHHMM = (m: number) => `${dd(Math.floor(m / 60))}:${dd(m % 60)}`;

const esComedor = (texto: string) => /comida|desayuno|comedor/i.test(texto || '');

function tipoDe(sucursalId: string, alias: string): TipoEscena {
  // "RD" (el reloj .196, 29/09/2026) sigue dibujándose como oficina: antes lo
  // decía su nombre, "Sin identificar (oficinas)"; con "RD" caería en tienda.
  if (sucursalId === 'reloj-196') return 'oficina';
  const t = `${sucursalId} ${alias}`;
  if (esComedor(t)) return 'comedor';
  if (/cedis|bodega|almac/i.test(t)) return 'bodega';
  if (/corporativo|oficina/i.test(t)) return 'oficina';
  return 'tienda';
}

/**
 * @param fresco  true = sin la caché de 5 min de la asistencia: se usa justo
 *   después de justificar a alguien, para que salga de la lista al momento.
 */
export async function equipoAhora(fresco = false): Promise<EquipoAhora> {
  // Hora de México desde Postgres: la API corre en UTC (ver presencia.ts).
  const { rows: [ahora] } = await pool.query(
    `SELECT to_char((now() AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS fecha,
            EXTRACT(HOUR FROM now() AT TIME ZONE 'America/Mexico_City')::int * 60
          + EXTRACT(MINUTE FROM now() AT TIME ZONE 'America/Mexico_City')::int AS minuto`);
  const fecha: string = ahora.fecha;
  const minutoAhora = Number(ahora.minuto);

  const [{ rows: relojes }, { rows: marcas }, { rows: fichas }, salidas] = await Promise.all([
    pool.query(
      `SELECT r.serie, r.sucursal_id, r.alias,
              EXTRACT(EPOCH FROM (now() - e.ultima_senal))::int AS seg
         FROM relojes r LEFT JOIN relojes_estado e ON e.serie = r.serie
        WHERE r.activo AND NOT r.pendiente
        ORDER BY r.sucursal_id, r.alias`),
    // Cada marca con su reloj, en orden: hace falta saber DÓNDE fue la primera
    // (su edificio) y dónde la última (dónde está ahora).
    pool.query(
      `SELECT sucursal_id, empleado_codigo,
              array_agg(hora ORDER BY hora) AS horas,
              array_agg(COALESCE(serie_reloj, '') ORDER BY hora) AS series
         FROM checadas WHERE fecha = $1
        GROUP BY sucursal_id, empleado_codigo`, [fecha]),
    pool.query(
      `SELECT sucursal_id, codigo_checador,
              COALESCE(NULLIF(btrim(nombre_completo), ''), nombre) AS nombre,
              departamento, es_promotora, activo
         FROM empleados WHERE eliminado_en IS NULL`),
    salidasHabitualesCache(fecha),
  ]);
  const [jornadas, asistenciaHoy] = await Promise.all([
    jornadasHabitualesCache(fecha),
    asistenciaDeHoyCache(fecha, [...new Set((relojes as any[]).map((r) => r.sucursal_id))], fresco),
  ]);
  // Las incidencias de HOY, para saber qué salida anticipada ya está justificada.
  // (Las faltas justificadas ya las quita el cálculo de asistencia.)
  const justificadas = new Map<string, string>();
  await Promise.all([...new Set((relojes as any[]).map((r) => r.sucursal_id))].map(async (suc) => {
    try {
      for (const i of await incidenciasEnRango(suc, fecha, fecha)) {
        // Una falta injustificada o una amonestación no justifican nada.
        if (i.tipo === 'falta_injustificada' || i.tipo === 'amonestacion' || i.tipo === 'horario_distinto') continue;
        const t = tipoIncidencia(i.tipo);
        justificadas.set(`${suc}|${i.empleadoCodigo}`, `${t?.etiqueta || i.tipo}${i.nota ? ': ' + i.nota : ''}`);
      }
    } catch { /* sin incidencias, nada justificado */ }
  }));

  const porFicha = new Map<string, any>();
  for (const f of fichas) porFicha.set(`${f.sucursal_id}|${String(f.codigo_checador).trim()}`, f);

  // Una escena por reloj; y una por plaza para las marcas que no traen serie
  // (importadas de archivo o del sistema de RH).
  // ══ UN LUGAR = UNA ESCENA ══
  // El reloj de desayuno/comida está en el MISMO edificio que el de entrada y
  // salida de su plaza: no es otro lugar, es otro reloj. Se funde con el
  // principal. Solo tiene escena propia si su plaza no tiene otro reloj.
  const escenas = new Map<string, EscenaEquipo>();
  /** serie → la escena donde se pinta. */
  const escenaPorSerie = new Map<string, EscenaEquipo>();
  /** Series de relojes de comida: una marca ahí es una pausa, no una entrada. */
  const seriesComedor = new Set<string>();
  const principalDePlaza = new Map<string, EscenaEquipo>();

  const seg = (r: any) => (r.seg == null ? null : Number(r.seg));
  const mudo = (s: number | null) => s == null || s > RELOJ_MUDO_MIN * 60;
  for (const r of relojes) if (esComedor(`${r.sucursal_id} ${r.alias || ''}`)) seriesComedor.add(r.serie);
  // Primero los relojes de trabajo…
  for (const r of relojes.filter((x: any) => !seriesComedor.has(x.serie))) {
    const e: EscenaEquipo = {
      id: r.serie, serie: r.serie, sucursalId: r.sucursal_id,
      alias: r.alias || r.sucursal_id, relojes: [r.alias || r.serie],
      tipo: tipoDe(r.sucursal_id, r.alias || ''),
      relojMudo: mudo(seg(r)), segundosSinSenal: seg(r),
      personas: [], salieron: 0, sinSalida: 0, salidas: [], faltan: [], descansan: 0,
    };
    escenas.set(e.id, e);
    escenaPorSerie.set(r.serie, e);
    if (!principalDePlaza.has(r.sucursal_id)) principalDePlaza.set(r.sucursal_id, e);
  }
  // …y los de comida se funden con el principal de su plaza.
  for (const r of relojes.filter((x: any) => seriesComedor.has(x.serie))) {
    const principal = principalDePlaza.get(r.sucursal_id);
    if (principal) {
      principal.relojes.push(r.alias || r.serie);
      // "Oficinas · entrada y salida" + "Oficinas · desayuno y comida" → "Oficinas".
      principal.alias = principal.alias.split(' · ')[0];
      // Si cualquiera de sus relojes está mudo, lo que se ve puede estar viejo.
      if (mudo(seg(r))) principal.relojMudo = true;
      escenaPorSerie.set(r.serie, principal);
    } else {
      const e: EscenaEquipo = {
        id: r.serie, serie: r.serie, sucursalId: r.sucursal_id,
        alias: r.alias || r.sucursal_id, relojes: [r.alias || r.serie], tipo: 'comedor',
        relojMudo: mudo(seg(r)), segundosSinSenal: seg(r),
        personas: [], salieron: 0, sinSalida: 0, salidas: [], faltan: [], descansan: 0,
      };
      escenas.set(e.id, e);
      escenaPorSerie.set(r.serie, e);
      principalDePlaza.set(r.sucursal_id, e);
    }
  }
  const escenaDePlaza = (sucursalId: string): EscenaEquipo => {
    const p = principalDePlaza.get(sucursalId);
    if (p) return p;
    // Marcas sin serie (importadas de archivo o del sistema de RH) de una
    // plaza sin reloj registrado: escena propia de la plaza.
    const id = `plaza:${sucursalId}`;
    if (!escenas.has(id)) {
      const e: EscenaEquipo = {
        id, serie: null, sucursalId, alias: sucursalId, relojes: [], tipo: tipoDe(sucursalId, ''),
        relojMudo: false, segundosSinSenal: null, personas: [], salieron: 0, sinSalida: 0, salidas: [], faltan: [], descansan: 0,
      };
      escenas.set(id, e);
      principalDePlaza.set(sucursalId, e);
    }
    return escenas.get(id)!;
  };
  const escenaDeSerie = (serie: string, sucursalId: string) =>
    (serie && escenaPorSerie.get(serie)) || escenaDePlaza(sucursalId);

  for (const m of marcas) {
    const cod = String(m.empleado_codigo).trim();
    const ficha = porFicha.get(`${m.sucursal_id}|${cod}`);
    // Promotoras y bajas no son personal de piso de este reloj (ver asistencia).
    if (ficha && (ficha.es_promotora || ficha.activo === false)) continue;

    // Colapsar duplicadas conservando de qué reloj vino cada marca.
    const pares = (m.horas as string[])
      .map((h, i) => ({ min: hd.aMinutos(h), serie: (m.series as string[])[i] || '' }))
      .filter((x): x is { min: number; serie: string } => x.min !== null);
    const minsColapsados = hd.colapsarDuplicadas(pares.map((p) => p.min));
    if (!minsColapsados.length) continue;
    const conSerie = minsColapsados.map((min) => pares.find((p) => p.min === min)!);
    const primera = conSerie[0];
    const ultima = conSerie[conSerie.length - 1];

    const salida = salidas.get(`${m.sucursal_id}|${cod}`) ?? null;
    const escUltima = escenaDeSerie(ultima.serie, m.sucursal_id);
    const escPrimera = escenaDeSerie(primera.serie, m.sucursal_id);
    const ultimaEnComedor = seriesComedor.has(ultima.serie);
    // Su edificio: donde entró, salvo que su primera marca haya sido en el comedor.
    const edificio = seriesComedor.has(primera.serie) ? escenaDePlaza(m.sucursal_id) : escPrimera;
    const hace = Math.max(0, minutoAhora - ultima.min);
    const impar = minsColapsados.length % 2 === 1;

    let estado: EstadoEquipo | 'salio';
    let escena: EscenaEquipo;
    if (impar) {
      if (salida != null && minutoAhora > salida + MARGEN_SALIDA_MIN) estado = 'sin_salida';
      else estado = 'dentro';
      // Regresó de comer por el reloj del comedor: está de vuelta en su edificio.
      escena = ultimaEnComedor ? edificio : escUltima;
    } else if (ultimaEnComedor) {
      estado = hace <= PAUSA_MAX_MIN ? 'comida' : 'salio';
      escena = escUltima;
    } else if (salida != null && ultima.min < salida - ANTES_DE_SU_SALIDA_MIN && hace <= PAUSA_MAX_MIN) {
      // Plaza de un solo reloj: salió a media jornada y hace poco → está comiendo.
      estado = 'comida';
      escena = escUltima;
    } else {
      estado = 'salio';
      escena = escUltima;
    }

    if (estado === 'salio') {
      escena.salieron++;
      // ¿Se fue antes de lo que dura su jornada?
      const jornada = jornadas.get(`${m.sucursal_id}|${cod}`) ?? null;
      const trabajo = ultima.min - primera.min;
      const antes = jornada != null && minsColapsados.length >= 2 ? jornada - trabajo : null;
      escena.salidas.push({
        codigo: cod, sucursalId: m.sucursal_id,
        nombre: (ficha && ficha.nombre) || `Código ${cod}`,
        departamento: (ficha && ficha.departamento) || null,
        entrada: aHHMM(primera.min), salida: aHHMM(ultima.min),
        antesMin: antes != null && antes >= SALIO_ANTES_MIN ? Math.round(antes) : null,
        jornadaHabitual: jornada != null ? aHoras(jornada) : null,
        justificacion: justificadas.get(`${m.sucursal_id}|${cod}`) || null,
      });
      continue;
    }
    if (estado === 'sin_salida') escena.sinSalida++;
    escena.personas.push({
      codigo: cod,
      nombre: (ficha && ficha.nombre) || `Código ${cod}`,
      departamento: (ficha && ficha.departamento) || null,
      estado,
      entrada: aHHMM(primera.min),
      ultima: aHHMM(ultima.min),
      hace,
    });
  }

  // ══ NO SE PRESENTARON ══
  // Sale de la MISMA asistencia del reporte, para hoy: ahí ya viven la regla de
  // descansos (los que le tocan en la semana, habituales o tomados en otro día),
  // las incidencias (vacaciones, permisos…) y el corte de quien ya no viene.
  // Un día que el cálculo marca como `falta` hoy es alguien que tenía que venir.
  // Pero el día no ha terminado: solo se le marca cuando ya pasó su hora de
  // entrada (+ margen). Quien entra a las 14:00 no falta a las 10:00.
  for (const [sucursalId, a] of asistenciaHoy) {
    const escena = escenaDePlaza(sucursalId);
    for (const p of a.personas) {
      const dia = p.semanas.flatMap((s) => s.dias).find((d) => d.fecha === fecha);
      if (!dia) continue;
      if (dia.estado === 'descanso') { escena.descansan++; continue; }
      if (dia.estado !== 'falta') continue;
      // Su hora de entrada: la fija, o si rota, la de su turno MÁS TARDE (para
      // no marcar como falta a quien hoy entra en el de la tarde).
      const horas = (p.tipo === 'rotativo' ? p.turnos : [p.horario])
        .map((h) => hd.aMinutos(h)).filter((x): x is number => x !== null);
      if (!horas.length) continue;
      const entraMin = Math.max(...horas);
      if (minutoAhora < entraMin + MARGEN_FALTA_MIN) continue;
      escena.faltan.push({
        codigo: p.codigo, sucursalId, nombre: p.nombreCompleto || p.nombre, departamento: p.departamento,
        entraA: p.tipo === 'rotativo' ? p.turnos.filter(Boolean).join(' / ') : (p.horario as string),
        retrasoMin: minutoAhora - entraMin,
      });
    }
  }

  const lista = [...escenas.values()];
  for (const e of lista) {
    e.faltan.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    e.salidas.sort((a, b) => (b.antesMin ?? -1) - (a.antesMin ?? -1) || a.nombre.localeCompare(b.nombre, 'es'));
    e.personas.sort((a, b) => a.entrada.localeCompare(b.entrada) || a.nombre.localeCompare(b.nombre, 'es'));
  }
  // Primero donde hay más gente; los relojes vacíos al final, pero se muestran:
  // un reloj que no aparece se lee como "no existe", no como "no hay nadie".
  lista.sort((a, b) => b.personas.length - a.personas.length || a.alias.localeCompare(b.alias, 'es'));

  const cuenta = (est: EstadoEquipo) => lista.reduce((t, e) => t + e.personas.filter((p) => p.estado === est).length, 0);
  return {
    fecha,
    hora: aHHMM(minutoAhora),
    totales: {
      dentro: cuenta('dentro'),
      comida: cuenta('comida'),
      salieron: lista.reduce((t, e) => t + e.salieron, 0),
      sinSalida: lista.reduce((t, e) => t + e.sinSalida, 0),
      salieronAntes: lista.reduce((t, e) => t + e.salidas.filter((x) => x.antesMin != null && !x.justificacion).length, 0),
      faltan: lista.reduce((t, e) => t + e.faltan.length, 0),
    },
    escenas: lista,
  };
}

// ══ LO QUE SUELE DURAR LA JORNADA DE CADA QUIEN ══
// Mediana de (última − primera checada) en sus últimos 28 días con al menos
// entrada y salida. Cambia de un día a otro, no de un minuto a otro: se guarda
// 30 minutos, igual que las salidas habituales de presencia.ts.
let cacheJornadas: { fecha: string; en: number; datos: Map<string, number> } | null = null;

async function jornadasHabitualesCache(fecha: string): Promise<Map<string, number>> {
  if (cacheJornadas && cacheJornadas.fecha === fecha && Date.now() - cacheJornadas.en < 30 * 60 * 1000) {
    return cacheJornadas.datos;
  }
  const desde = new Date(`${fecha}T12:00:00Z`);
  desde.setUTCDate(desde.getUTCDate() - 28);
  const { rows } = await pool.query(
    `SELECT sucursal_id, empleado_codigo, array_agg(hora ORDER BY hora) AS horas
       FROM checadas WHERE fecha >= $1 AND fecha < $2
      GROUP BY sucursal_id, empleado_codigo, fecha`,
    [desde.toISOString().slice(0, 10), fecha]);
  const porPersona = new Map<string, number[]>();
  for (const r of rows) {
    const mins = hd.colapsarDuplicadas(
      (r.horas as string[]).map((h) => hd.aMinutos(h)).filter((x): x is number => x !== null));
    if (mins.length < 2) continue;         // una sola marca no dice cuánto trabajó
    const k = `${r.sucursal_id}|${String(r.empleado_codigo).trim()}`;
    if (!porPersona.has(k)) porPersona.set(k, []);
    porPersona.get(k)!.push(mins[mins.length - 1] - mins[0]);
  }
  const datos = new Map<string, number>();
  for (const [k, v] of porPersona) {
    if (v.length < 3) continue;            // con menos de tres días no hay costumbre
    v.sort((a, b) => a - b);
    datos.set(k, v[Math.floor(v.length / 2)]);
  }
  cacheJornadas = { fecha, en: Date.now(), datos };
  return datos;
}

// La asistencia de HOY de cada plaza (para "no se presentaron"). Es el cálculo
// del reporte y lee 28 días por plaza: se guarda 5 minutos. Un error en una
// plaza no tumba la pantalla: esa plaza simplemente no marca faltantes.
let cacheAsistencia: { fecha: string; en: number; datos: Map<string, Awaited<ReturnType<typeof asistenciaPersonas>>> } | null = null;

async function asistenciaDeHoyCache(fecha: string, sucursales: string[], fresco = false) {
  if (!fresco && cacheAsistencia && cacheAsistencia.fecha === fecha && Date.now() - cacheAsistencia.en < 5 * 60 * 1000) {
    return cacheAsistencia.datos;
  }
  const datos = new Map<string, Awaited<ReturnType<typeof asistenciaPersonas>>>();
  await Promise.all(sucursales.map(async (sucursalId) => {
    // La ÚLTIMA SEMANA y no solo hoy: el cálculo solo evalúa los días sin marcas
    // de quien checó al menos una vez en el periodo. Pedido solo "hoy", quien no
    // ha llegado no tiene ningún día que evaluar y nunca salía como falta. Con la
    // semana, quien vino estos días y hoy no aparece sí se evalúa, y la regla de
    // descansos ve la semana completa. Luego solo se mira el día de hoy.
    const d = new Date(`${fecha}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 6);
    try { datos.set(sucursalId, await asistenciaPersonas({ sucursalId, desde: d.toISOString().slice(0, 10), hasta: fecha })); }
    catch (e) { console.warn('[equipo] asistencia de hoy', sucursalId, (e as any)?.message); }
  }));
  cacheAsistencia = { fecha, en: Date.now(), datos };
  return datos;
}
