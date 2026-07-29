/**
 * Agente de Horarios (Fase 1). Capa agéntica sobre el módulo de checadas:
 * detecta inconsistencias de asistencia y deja BORRADORES para que RH apruebe
 * (nunca aprueba solo — regla 80/20). Ver README.md de esta carpeta.
 */
export { agenteHorariosRouter, agenteCallbackRouter } from './router';
export { detectar } from './detector';
export { analizarDia } from './reglas';
export { cargarConfig, CONFIG_DEFAULT } from './config';
// Fase 3: el agente revisa solo, sin que nadie apriete nada.
export { arrancarCorredor, correrUnaVez, estadoCorredor, ventanas } from './corredor';
// El horario REAL de cada persona, deducido de SUS checadas, y la asistencia que
// alimenta la pantalla. Reemplaza el cálculo que vivía en el navegador contra el
// horario configurado de la sucursal, que está mal en casi todas las plazas.
export * as horarioDeducido from './horario-deducido';
export { asistenciaPersonas } from './asistencia-personas';
