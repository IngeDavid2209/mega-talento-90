import { EstadoIncidencia, BanderaIncidencia } from '../../core/services/checador.service';

/**
 * Cómo se le dice a cada estado y a cada bandera de una incidencia en pantalla.
 * Lo usan la ficha de asistencia y la bandeja de incidencias: si cada una
 * tuviera su copia, "calificada" en una sería "aprobada" en la otra.
 * El flujo vive en api/src/incidencias.ts.
 */
export const ETIQUETA_ESTADO_INC: Record<EstadoIncidencia, string> = {
  capturada: 'Por calificar',
  calificada: 'Calificada',
  rechazada: 'Rechazada',
  cerrada: 'Cerrada en prenómina',
  auditada: 'Auditada',
  anulada: 'Anulada',
};

export const ETIQUETA_BANDERA: Record<BanderaIncidencia, { corta: string; larga: string }> = {
  corrimiento_60: { corta: '≥ 1 h', larga: 'Corre la entrada una hora o más' },
  hd_frecuente:   { corta: 'Frecuente', larga: '3 o más horarios distintos de esta persona en 30 días' },
  autocalificada: { corta: 'Autocalificada', larga: 'La calificó la misma persona que la capturó' },
  sin_nota:       { corta: 'Sin respaldo', larga: 'No trae nota, folio ni motivo' },
  retroactiva:    { corta: 'Tardía', larga: 'Se capturó más de 7 días después' },
};

/** El mensaje que manda la API (p. ej. "la semana ya se cerró"), o el genérico. */
export function mensajeDeError(e: any, porOmision: string): string {
  const m = e?.error?.error;
  return typeof m === 'string' && m.trim() ? m : porOmision;
}
