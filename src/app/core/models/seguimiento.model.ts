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
