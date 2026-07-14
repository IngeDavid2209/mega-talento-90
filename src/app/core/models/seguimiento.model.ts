// =====================================================================
// SEGUIMIENTO DE CANDIDATOS
// Detecta candidatos ACTIVOS que llevan días sin que RH los toque.
// Fuente de verdad única para el banner del dashboard y los badges del
// tablero de etapas. El "toque" se sella en CandidateService.updateCandidate
// (campo `ultimaActividad`); para expedientes viejos que nunca se han tocado
// se usa `createdAt` como respaldo.
// =====================================================================

import { ID_ETAPAS } from './proceso.model';

// Umbrales de días sin seguimiento (decisión de negocio)
export const SEGUIMIENTO_AVISO_DIAS = 2;    // amarillo: empieza a descuidarse
export const SEGUIMIENTO_CRITICO_DIAS = 5;  // rojo: abandonado
export const SEGUIMIENTO_CIERRE_DIAS = 10;  // cierre: se manda a la Papelera

export type NivelSeguimiento = 'ok' | 'aviso' | 'critico';

/** Convierte un valor de fecha (Timestamp de Firestore, Date o string) a Date. */
function aFecha(v: any): Date | null {
  if (!v) return null;
  const d = typeof v.toDate === 'function' ? v.toDate() : new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/** ¿El candidato sigue en proceso? (ni contratado, ni rechazado, ni en papelera) */
export function esActivoEnProceso(c: any): boolean {
  return !!c && !c.deletedAt &&
    c.status !== ID_ETAPAS.CONTRATADO &&
    c.status !== ID_ETAPAS.RECHAZADO;
}

/** Última vez que RH tocó el expediente; si nunca, cae a su fecha de alta. */
export function fechaUltimaActividad(c: any): Date | null {
  return aFecha(c?.ultimaActividad) || aFecha(c?.createdAt);
}

/** Días completos sin seguimiento. Devuelve -1 si no hay fecha base. */
export function diasSinSeguimiento(c: any, ahora: Date = new Date()): number {
  const f = fechaUltimaActividad(c);
  if (!f) return -1;
  const a = new Date(ahora); a.setHours(0, 0, 0, 0);
  const b = new Date(f);     b.setHours(0, 0, 0, 0);
  return Math.max(0, Math.floor((a.getTime() - b.getTime()) / 86400000));
}

/** Nivel de alerta de seguimiento. 'ok' si está al día o si no aplica. */
export function nivelSeguimiento(c: any, ahora: Date = new Date()): NivelSeguimiento {
  if (!esActivoEnProceso(c)) return 'ok';
  const d = diasSinSeguimiento(c, ahora);
  if (d < 0) return 'ok';
  if (d >= SEGUIMIENTO_CRITICO_DIAS) return 'critico';
  if (d >= SEGUIMIENTO_AVISO_DIAS) return 'aviso';
  return 'ok';
}

/**
 * ¿Debe cerrarse (mandarse a la Papelera) por llevar demasiados días sin
 * seguimiento? Solo aplica a candidatos ACTIVOS en proceso.
 */
export function debeCerrarseSeguimiento(c: any, ahora: Date = new Date()): boolean {
  if (!esActivoEnProceso(c)) return false;
  // Protegemos a quien ya está "adentro" del proceso: si el candidato contestó
  // (o al menos empezó) la evaluación de liderazgo, NUNCA se cierra solo.
  if (respondioEvaluacion(c)) return false;
  // Solo auto-cerramos a candidatos que RH YA trabajó al menos una vez (tienen
  // `ultimaActividad`). A los que nunca se han revisado NO los mandamos solos a
  // la Papelera, aunque lleven días desde que se postularon: cerrarlos sería
  // descartar gente que nadie alcanzó a ver. Esos se cierran manualmente.
  if (!aFecha(c?.ultimaActividad)) return false;
  const d = diasSinSeguimiento(c, ahora);
  return d >= SEGUIMIENTO_CIERRE_DIAS;
}

/** ¿El candidato ya contestó (o empezó) la evaluación de liderazgo? */
export function respondioEvaluacion(c: any): boolean {
  const resp = c?.cuestionarioLiderazgo;
  if (!resp || typeof resp !== 'object') return false;
  return Object.values(resp).some((v: any) => typeof v === 'number' && v >= 1 && v <= 5);
}
