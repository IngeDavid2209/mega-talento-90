/**
 * SEMANA FISCAL — el calendario de semanas de NÓMINA de la empresa.
 *
 * ══ LA REGLA (29/09/2026, confirmada por RH) ══
 *
 *   · La semana es la de nómina: de JUEVES a MIÉRCOLES.
 *   · El año tiene SIEMPRE 52 semanas.
 *   · La fuente es el reporte de RH (ReporteSemMD): "SEM 33" = del jue 06/08/26
 *     al mié 12/08/26 (api/tools/reportes-sem33.json). La del 5 al 11 de
 *     noviembre de 2026 es la 46.
 *
 * Contando hacia atrás, la semana 1 del ciclo 2026 fue la del jueves 25 al
 * miércoles 31 de diciembre de 2025, y de ahí se cuentan ciclos de 52 semanas
 * (364 días): la 52 de 2026 es del 17 al 23 de diciembre, y la 1 del ciclo 2027
 * empezaría el jueves 24 de diciembre de 2026 (⚠️ sin confirmar con RH).
 *
 * Historia, para no volver a equivocarse:
 *   · 1ª versión: semana de nómina contada desde la que contiene el 1 de enero
 *     → el 28/09 decía 39.
 *   · 2ª versión: número ISO (lunes a domingo) → decía 40 y 53 semanas.
 *   · 3ª versión (29/09): "la del 24 al 30 de septiembre es la 41", dicho de
 *     palabra → todo quedó UNA semana adelantado.
 *   · 10/11/2026: RH reporta que la 47 es la 46. Cuadra con sus PDF de la
 *     semana 33: el 24 al 30 de septiembre es la 40. Ancla corrida al 25/12/2025.
 *
 * Si RH mueve el inicio de un ciclo (p. ej. para cuadrar con el año), basta con
 * cambiar ANCLA_SEMANA_1.
 */

const DIA_MS = 86400000;
/** Jueves en que empezó la semana 1 del ciclo 2026. */
const ANCLA_SEMANA_1 = '2025-12-25';
const ANIO_DEL_ANCLA = 2026;
const SEMANAS_POR_ANIO = 52;

function aIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Inicio (a mediodía, para no pelear con horarios de verano) de la semana de nómina que contiene a `d`. */
function inicioDeSemana(d: Date, diaInicio: number): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);
  x.setDate(x.getDate() - ((x.getDay() - diaInicio + 7) % 7));
  return x;
}

export interface SemanaFiscal {
  numero: number;
  /** El ciclo (año de nómina) al que pertenece la semana. */
  anio: number;
  /** Siempre 52. */
  total: number;
  /** 'yyyy-MM-dd' del primer y último día de la semana de nómina. */
  inicio: string;
  fin: string;
}

export function semanaFiscal(fechaIso: string, diaInicio = 4): SemanaFiscal {
  const f = new Date(fechaIso + 'T12:00:00');
  const ini = inicioDeSemana(f, diaInicio);
  const fin = new Date(ini); fin.setDate(ini.getDate() + 6);
  const ancla = new Date(ANCLA_SEMANA_1 + 'T12:00:00');
  const semanas = Math.round((ini.getTime() - ancla.getTime()) / (7 * DIA_MS));
  const ciclo = Math.floor(semanas / SEMANAS_POR_ANIO);
  const numero = semanas - ciclo * SEMANAS_POR_ANIO + 1;
  return { numero, anio: ANIO_DEL_ANCLA + ciclo, total: SEMANAS_POR_ANIO, inicio: aIso(ini), fin: aIso(fin) };
}
