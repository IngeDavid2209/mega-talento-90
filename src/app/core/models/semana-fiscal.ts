/**
 * SEMANA FISCAL.
 *
 * RH cuenta el año en semanas: "vamos en la 40 de 52". Es la semana del
 * CALENDARIO (ISO 8601: de lunes a domingo; la semana 1 es la que contiene el
 * primer jueves del año), que es la que traen los calendarios y la que RH usa.
 *
 * ══ POR QUÉ NO SE CUENTA DESDE EL 1 DE ENERO (29/09/2026) ══
 *
 * La primera versión numeraba las semanas de NÓMINA (jueves→miércoles) desde
 * la que contenía el 1 de enero, y el lunes 28/09/2026 decía "39". RH corrigió:
 * vamos en la 40. En 2026 el 1 de enero cayó en jueves y la semana 1 del
 * calendario empezó el lunes 29 de diciembre, así que las dos cuentas quedaban
 * desfasadas una semana todo el año.
 *
 * La pantalla trabaja con la semana de nómina (jueves→miércoles), que cruza dos
 * semanas del calendario. Se le da el número de la semana del calendario del
 * LUNES que contiene: la de nómina del jue 24 al mié 30 de septiembre contiene
 * el lunes 28, que es la semana 40. Así el número no cambia a media semana de
 * nómina, y coincide con el calendario de lunes a miércoles.
 *
 * El año trae 52 semanas; algunos traen 53 (2026 sí, 2025 no): se calcula.
 */

const DIA_MS = 86400000;

function aIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Inicio (a mediodía, para no pelear con horarios de verano) de la semana de nómina que contiene a `d`. */
function inicioDeSemana(d: Date, diaInicio: number): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);
  x.setDate(x.getDate() - ((x.getDay() - diaInicio + 7) % 7));
  return x;
}

/** Semana ISO 8601 de una fecha: { semana, anio }. */
function semanaIso(d: Date): { semana: number; anio: number } {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);
  // El jueves de su semana decide el año: así funciona la norma.
  x.setDate(x.getDate() + 4 - (x.getDay() || 7));
  const anio = x.getFullYear();
  const enero1 = new Date(anio, 0, 1, 12);
  return { semana: Math.floor(Math.round((x.getTime() - enero1.getTime()) / DIA_MS) / 7) + 1, anio };
}

/** Cuántas semanas ISO trae un año: la del 28 de diciembre siempre es la última. */
function semanasDelAnio(anio: number): number {
  return semanaIso(new Date(anio, 11, 28, 12)).semana;
}

export interface SemanaFiscal {
  numero: number;
  anio: number;
  /** Cuántas semanas trae ese año (52, a veces 53). */
  total: number;
  /** 'yyyy-MM-dd' del primer y último día de la semana de NÓMINA. */
  inicio: string;
  fin: string;
}

export function semanaFiscal(fechaIso: string, diaInicio = 4): SemanaFiscal {
  const f = new Date(fechaIso + 'T12:00:00');
  const ini = inicioDeSemana(f, diaInicio);
  const fin = new Date(ini); fin.setDate(ini.getDate() + 6);
  // El lunes que cae dentro de esta semana de nómina.
  const lunes = new Date(ini); lunes.setDate(ini.getDate() + ((1 - diaInicio + 7) % 7));
  const { semana, anio } = semanaIso(lunes);
  return { numero: semana, anio, total: semanasDelAnio(anio), inicio: aIso(ini), fin: aIso(fin) };
}
