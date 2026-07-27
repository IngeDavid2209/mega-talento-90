/**
 * Agente de Horarios (Fase 1). Capa agéntica sobre el módulo de checadas:
 * detecta inconsistencias de asistencia y deja BORRADORES para que RH apruebe
 * (nunca aprueba solo — regla 80/20). Ver README.md de esta carpeta.
 */
export { agenteHorariosRouter, agenteCallbackRouter } from './router';
export { detectar } from './detector';
export { analizarDia } from './reglas';
export { cargarConfig, CONFIG_DEFAULT } from './config';
