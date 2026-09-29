import { pool } from '../db';
import * as hd from './horario-deducido';
import { salidasHabitualesCache } from './presencia';

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

export interface EscenaEquipo {
  /** Serie del reloj, o `plaza:<sucursal>` si sus marcas no traen serie. */
  id: string;
  serie: string | null;
  sucursalId: string;
  alias: string;
  tipo: TipoEscena;
  relojMudo: boolean;
  segundosSinSenal: number | null;
  personas: PersonaEquipo[];
  /** Ya terminaron su jornada hoy (su última marca fue aquí). */
  salieron: number;
  /** Entraron y ya pasó su hora de salida sin marca de salida. */
  sinSalida: number;
}

export interface EquipoAhora {
  fecha: string;
  hora: string;
  totales: { dentro: number; comida: number; salieron: number; sinSalida: number };
  escenas: EscenaEquipo[];
}

const dd = (n: number) => String(n).padStart(2, '0');
const aHHMM = (m: number) => `${dd(Math.floor(m / 60))}:${dd(m % 60)}`;

const esComedor = (texto: string) => /comida|desayuno|comedor/i.test(texto || '');

function tipoDe(sucursalId: string, alias: string): TipoEscena {
  const t = `${sucursalId} ${alias}`;
  if (esComedor(t)) return 'comedor';
  if (/cedis|bodega|almac/i.test(t)) return 'bodega';
  if (/corporativo|oficina/i.test(t)) return 'oficina';
  return 'tienda';
}

export async function equipoAhora(): Promise<EquipoAhora> {
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

  const porFicha = new Map<string, any>();
  for (const f of fichas) porFicha.set(`${f.sucursal_id}|${String(f.codigo_checador).trim()}`, f);

  // Una escena por reloj; y una por plaza para las marcas que no traen serie
  // (importadas de archivo o del sistema de RH).
  const escenas = new Map<string, EscenaEquipo>();
  const relojesDePlaza = new Map<string, string[]>();
  for (const r of relojes) {
    const seg = r.seg == null ? null : Number(r.seg);
    escenas.set(r.serie, {
      id: r.serie, serie: r.serie, sucursalId: r.sucursal_id,
      alias: r.alias || r.sucursal_id, tipo: tipoDe(r.sucursal_id, r.alias || ''),
      relojMudo: seg == null || seg > RELOJ_MUDO_MIN * 60, segundosSinSenal: seg,
      personas: [], salieron: 0, sinSalida: 0,
    });
    if (!relojesDePlaza.has(r.sucursal_id)) relojesDePlaza.set(r.sucursal_id, []);
    relojesDePlaza.get(r.sucursal_id)!.push(r.serie);
  }
  const escenaDePlaza = (sucursalId: string): EscenaEquipo => {
    // El reloj "de trabajo" de la plaza: el primero que no es comedor.
    const series = relojesDePlaza.get(sucursalId) || [];
    const principal = series.find((s) => escenas.get(s)!.tipo !== 'comedor') || series[0];
    if (principal) return escenas.get(principal)!;
    const id = `plaza:${sucursalId}`;
    if (!escenas.has(id)) {
      escenas.set(id, {
        id, serie: null, sucursalId, alias: sucursalId, tipo: tipoDe(sucursalId, ''),
        relojMudo: false, segundosSinSenal: null, personas: [], salieron: 0, sinSalida: 0,
      });
    }
    return escenas.get(id)!;
  };
  const escenaDeSerie = (serie: string, sucursalId: string) =>
    (serie && escenas.get(serie)) || escenaDePlaza(sucursalId);
  const comedorDePlaza = (sucursalId: string) =>
    (relojesDePlaza.get(sucursalId) || []).map((s) => escenas.get(s)!).find((e) => e.tipo === 'comedor') || null;

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
    // Su edificio: donde entró, salvo que su primera marca haya sido en el comedor.
    const edificio = escPrimera.tipo === 'comedor' ? escenaDePlaza(m.sucursal_id) : escPrimera;
    const hace = Math.max(0, minutoAhora - ultima.min);
    const impar = minsColapsados.length % 2 === 1;

    let estado: EstadoEquipo | 'salio';
    let escena: EscenaEquipo;
    if (impar) {
      if (salida != null && minutoAhora > salida + MARGEN_SALIDA_MIN) estado = 'sin_salida';
      else estado = 'dentro';
      // Regresó de comer por el reloj del comedor: está de vuelta en su edificio.
      escena = escUltima.tipo === 'comedor' ? edificio : escUltima;
    } else if (escUltima.tipo === 'comedor') {
      estado = hace <= PAUSA_MAX_MIN ? 'comida' : 'salio';
      escena = escUltima;
    } else if (salida != null && ultima.min < salida - ANTES_DE_SU_SALIDA_MIN && hace <= PAUSA_MAX_MIN) {
      // Plaza de un solo reloj: salió a media jornada y hace poco → está comiendo.
      estado = 'comida';
      escena = comedorDePlaza(m.sucursal_id) || escUltima;
    } else {
      estado = 'salio';
      escena = escUltima;
    }

    if (estado === 'salio') { escena.salieron++; continue; }
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

  const lista = [...escenas.values()];
  for (const e of lista) {
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
    },
    escenas: lista,
  };
}
