// =====================================================================
// MODELO MAESTRO DEL PROCESO DE SELECCIÓN MEGADULCES
// Centraliza etapas, checklists, competencias STAR y KPIs.
// Cambiar aquí impacta todo el sistema de forma consistente.
// =====================================================================

export type EstadoCheck = 'gris' | 'amarillo' | 'verde' | 'rojo';

export interface EtapaConfig {
  id: string;
  title: string;
  shortLabel: string;
  icon: string;
  color: string;       // accent color hex
  description: string;
  slaHoras?: number;   // tiempo máximo de respuesta esperado en esta etapa
}

// Flujo completo según prompt del director:
// Filtro inicial → Entrevista RH → Aptitudes → Psicometría →
// Entrevista técnica/Jefe → Documental → Dictamen → Contratado → Onboarding
// Plus la columna "No Viable" como descarte transversal.
// Paleta corporativa sobria (sin tonos "alegres"): carbón + dorado + rojo Mega + estados discretos.
export const ETAPAS: EtapaConfig[] = [
  { id: 'nuevo',            title: 'Solicitud',            shortLabel: 'Solicitud',   icon: '1',  color: '#475569', description: 'Solicitud recibida del formulario público.', slaHoras: 24 },
  { id: 'filtro_inicial',   title: 'Filtro Inicial',       shortLabel: 'Filtro',      icon: '2',  color: '#1F4E8C', description: 'Primer contacto y validación mínima por WhatsApp.', slaHoras: 24 },
  { id: 'entrevista_rh',    title: 'Entrevista RH',        shortLabel: 'RH',          icon: '3',  color: '#1A4FB0', description: 'Trayectoria, estabilidad y competencias conductuales (STAR).', slaHoras: 48 },
  { id: 'aptitudes',        title: 'Pruebas Aptitudes',    shortLabel: 'Aptitudes',   icon: '4',  color: '#2A5A8A', description: 'Pruebas prácticas según vacante (operativo / administrativo / ventas / jefatura).', slaHoras: 48 },
  { id: 'psicometria',      title: 'Psicometría',          shortLabel: 'Psicometría', icon: '5',  color: '#3F5C7A', description: 'Personalidad, honestidad, inteligencia y compatibilidad (apoyo, no decisión).', slaHoras: 72 },
  { id: 'entrevista_jefe',  title: 'Entrevista Técnica',   shortLabel: 'Jefe',        icon: '6',  color: '#8C6D1F', description: 'Validación técnica con el jefe directo del área.', slaHoras: 72 },
  { id: 'documental',       title: 'Validación Documental',shortLabel: 'Documental',  icon: '7',  color: '#A26209', description: 'INE, CURP, RFC, NSS, comprobante, acta, constancias.', slaHoras: 24 },
  { id: 'oferta',           title: 'Oferta',               shortLabel: 'Oferta',      icon: '8',  color: '#6B3D02', description: 'Validación pre-ingreso: oferta aceptada, aprobación del jefe, fecha, contrato.', slaHoras: 48 },
  { id: 'dictamen',         title: 'Dictamen Final',       shortLabel: 'Dictamen',    icon: '9',  color: '#25231F', description: 'Hoja resumen multiárea: contratar, bolsa o rechazar.', slaHoras: 24 },
  { id: 'contratado',       title: 'Contratado',           shortLabel: 'Contratado',  icon: '✓',  color: '#1F7A4C', description: 'Ingreso formal, alta, onboarding y permanencia inicial.' },
  { id: 'rechazado',        title: 'No Viable',            shortLabel: 'No viable',   icon: '—',  color: '#8A867E', description: 'Descartado con motivo documentado.' }
];

export const ID_ETAPAS = {
  NUEVO: 'nuevo',
  FILTRO: 'filtro_inicial',
  RH: 'entrevista_rh',
  APTITUDES: 'aptitudes',
  PSICOMETRIA: 'psicometria',
  JEFE: 'entrevista_jefe',
  DOCUMENTAL: 'documental',
  OFERTA: 'oferta',
  DICTAMEN: 'dictamen',
  CONTRATADO: 'contratado',
  RECHAZADO: 'rechazado'
} as const;

// Orden lineal para el stepper (excluye "rechazado" que es transversal)
export const FLUJO_LINEAL: string[] = [
  ID_ETAPAS.NUEVO,
  ID_ETAPAS.FILTRO,
  ID_ETAPAS.RH,
  ID_ETAPAS.APTITUDES,
  ID_ETAPAS.PSICOMETRIA,
  ID_ETAPAS.JEFE,
  ID_ETAPAS.DOCUMENTAL,
  ID_ETAPAS.OFERTA,
  ID_ETAPAS.DICTAMEN,
  ID_ETAPAS.CONTRATADO
];

// =====================================================================
// CHECKLISTS POR ETAPA
// =====================================================================

export interface ItemChecklist { key: string; label: string; icon: string; obligatorio: boolean; }

// 1. FILTRO INICIAL — Datos mínimos validados por WhatsApp
export const CHECKLIST_FILTRO: ItemChecklist[] = [
  { key: 'interes',         label: 'Sigue interesado',      icon: '✋', obligatorio: true },
  { key: 'zonaResidencia',  label: 'Zona viable',           icon: '📍', obligatorio: true },
  { key: 'horario',         label: 'Acepta horario',        icon: '🕒', obligatorio: true },
  { key: 'sueldo',          label: 'Acepta sueldo/rango',   icon: '💵', obligatorio: true },
  { key: 'experiencia',     label: 'Experiencia mínima',    icon: '🛠️', obligatorio: true },
  { key: 'salidaPrevia',    label: 'Motivo salida anterior',icon: '🔄', obligatorio: false },
  { key: 'docsPreliminar',  label: 'Documentación básica',  icon: '📄', obligatorio: false }
];

// 2. ENTREVISTA RH — Competencias conductuales (STAR)
export const COMPETENCIAS_STAR: ItemChecklist[] = [
  { key: 'responsabilidad',  label: 'Responsabilidad',         icon: '⚖️', obligatorio: true },
  { key: 'trabajoEquipo',    label: 'Trabajo en equipo',       icon: '🤝', obligatorio: true },
  { key: 'honestidad',       label: 'Honestidad',              icon: '🛡️', obligatorio: true },
  { key: 'adaptabilidad',    label: 'Adaptabilidad',           icon: '🔀', obligatorio: true },
  { key: 'resolucion',       label: 'Resolución de problemas', icon: '🧩', obligatorio: true },
  { key: 'presion',          label: 'Tolerancia a presión',    icon: '🔥', obligatorio: true },
  { key: 'servicio',         label: 'Servicio al cliente',     icon: '🎯', obligatorio: false },
  { key: 'liderazgo',        label: 'Liderazgo (si aplica)',   icon: '🏆', obligatorio: false }
];

// 3. PRUEBAS DE APTITUDES — Rúbrica por nivel, calificada por el reclutador
// Cada aptitud tiene un criterio observable; cada nivel pesa: 4/3/2/1
// El puntaje final se normaliza a 0-100 y el sistema decide si aprueba (umbral 70).

export type NivelRubrica = 'excelente' | 'bueno' | 'regular' | 'bajo';

export interface NivelConfig {
  id: NivelRubrica;
  label: string;
  peso: number;       // 4-1
  color: string;      // tono CSS para el botón seleccionado
}

export const NIVELES_RUBRICA: NivelConfig[] = [
  { id: 'excelente', label: 'Excelente', peso: 4, color: '#047857' },
  { id: 'bueno',     label: 'Bueno',     peso: 3, color: '#0E7490' },
  { id: 'regular',   label: 'Regular',   peso: 2, color: '#B45309' },
  { id: 'bajo',      label: 'Bajo',      peso: 1, color: '#B91C1C' }
];

export interface AptitudItem {
  key: string;
  label: string;
  criterio: string;   // descripción observable que ayuda al reclutador a calificar
}

export const APTITUDES_POR_TIPO: Record<string, AptitudItem[]> = {
  operativo: [
    { key: 'atencion',     label: 'Atención al detalle',         criterio: 'Detecta errores en producto, empaque o etiquetado sin necesidad de que se le indique.' },
    { key: 'rapidez',      label: 'Rapidez de ejecución',        criterio: 'Completa las tareas dentro del tiempo esperado y mantiene el ritmo.' },
    { key: 'seguimiento',  label: 'Seguimiento de instrucciones',criterio: 'Ejecuta paso a paso lo solicitado, sin omitir ni improvisar fuera de protocolo.' },
    { key: 'orden',        label: 'Orden y limpieza',            criterio: 'Mantiene su espacio y herramientas organizados durante y después de la tarea.' }
  ],
  administrativo: [
    { key: 'excel',        label: 'Manejo de Excel',             criterio: 'Usa fórmulas, filtros, ordenamientos y formato condicional sin asistencia.' },
    { key: 'analisis',     label: 'Capacidad de análisis',       criterio: 'Interpreta datos, detecta patrones y propone conclusiones claras.' },
    { key: 'redaccion',    label: 'Redacción y ortografía',      criterio: 'Comunica por escrito de forma clara, ordenada y sin errores ortográficos básicos.' },
    { key: 'organizacion', label: 'Organización del trabajo',    criterio: 'Planea, prioriza y entrega tareas dentro de los plazos acordados.' }
  ],
  ventas: [
    { key: 'negociacion',  label: 'Negociación',                 criterio: 'Maneja objeciones de precio, condiciones y cierra acuerdos beneficiosos.' },
    { key: 'comunicacion', label: 'Comunicación con el cliente', criterio: 'Se expresa con claridad, empatía y adapta el mensaje al perfil del cliente.' },
    { key: 'objeciones',   label: 'Manejo de objeciones',        criterio: 'Convierte un "no" inicial en una oportunidad de venta o seguimiento.' },
    { key: 'servicio',     label: 'Servicio al cliente',         criterio: 'Genera una experiencia positiva incluso ante quejas o devoluciones.' }
  ],
  jefatura: [
    { key: 'liderazgo',    label: 'Liderazgo de equipo',         criterio: 'Inspira, dirige y mantiene cohesionado a un equipo de trabajo.' },
    { key: 'decisiones',   label: 'Toma de decisiones',          criterio: 'Decide con criterio bajo presión, asume responsabilidad de los resultados.' },
    { key: 'planeacion',   label: 'Planeación y organización',   criterio: 'Define objetivos, asigna recursos y establece rutas de acción claras.' },
    { key: 'conflictos',   label: 'Resolución de conflictos',    criterio: 'Maneja tensiones del equipo y mantiene el ambiente productivo.' }
  ]
};

export const UMBRAL_APROBACION_APTITUDES = 70; // 0-100

/** Calcula puntaje normalizado 0-100 a partir de la rúbrica del candidato */
export function calcularPuntajeRubrica(
  rubrica: Record<string, NivelRubrica> | undefined,
  aptitudes: AptitudItem[]
): { puntaje: number; aprobado: boolean; calificadas: number; total: number; desglose: Record<NivelRubrica, number> } {
  const desglose: Record<NivelRubrica, number> = { excelente: 0, bueno: 0, regular: 0, bajo: 0 };
  if (!rubrica || aptitudes.length === 0) {
    return { puntaje: 0, aprobado: false, calificadas: 0, total: aptitudes.length, desglose };
  }
  let suma = 0;
  let calificadas = 0;
  aptitudes.forEach(a => {
    const nivel = rubrica[a.key];
    if (!nivel) return;
    const config = NIVELES_RUBRICA.find(n => n.id === nivel);
    if (!config) return;
    suma += config.peso;
    calificadas++;
    desglose[nivel]++;
  });
  // Normalización: suma actual / (peso máximo * total aptitudes) * 100
  const maxPosible = 4 * aptitudes.length;
  const puntaje = maxPosible > 0 ? Math.round((suma / maxPosible) * 100) : 0;
  const aprobado = calificadas === aptitudes.length && puntaje >= UMBRAL_APROBACION_APTITUDES;
  return { puntaje, aprobado, calificadas, total: aptitudes.length, desglose };
}

// 4. PSICOMETRÍA — Pruebas estándar
export const PSICOMETRIA_ITEMS: ItemChecklist[] = [
  { key: 'personalidad',   label: 'Personalidad laboral',  icon: '🧠', obligatorio: true },
  { key: 'honestidad',     label: 'Honestidad/confiable',  icon: '🔒', obligatorio: true },
  { key: 'inteligencia',   label: 'Inteligencia general',  icon: '💡', obligatorio: false },
  { key: 'estiloTrabajo',  label: 'Estilo de trabajo',     icon: '⚙️', obligatorio: false },
  { key: 'liderazgo',      label: 'Liderazgo (si aplica)', icon: '🏆', obligatorio: false }
];

// 5. ENTREVISTA TÉCNICA / JEFE DIRECTO
export const CHECKLIST_JEFE: ItemChecklist[] = [
  { key: 'casosPracticos',   label: 'Casos prácticos',       icon: '📝', obligatorio: true },
  { key: 'situacionales',    label: 'Preguntas situacionales', icon: '💬', obligatorio: true },
  { key: 'tecnicaArea',      label: 'Validación técnica',    icon: '🔧', obligatorio: true },
  { key: 'expectativas',     label: 'Expectativas alineadas',icon: '🎯', obligatorio: true },
  { key: 'compatibilidad',   label: 'Compatibilidad equipo', icon: '👥', obligatorio: true }
];

// 6. VALIDACIÓN DOCUMENTAL
export const CHECKLIST_DOCUMENTAL: ItemChecklist[] = [
  { key: 'ine',            label: 'INE',                  icon: '🪪', obligatorio: true },
  { key: 'curp',           label: 'CURP',                 icon: '🆔', obligatorio: true },
  { key: 'rfc',            label: 'RFC',                  icon: '💼', obligatorio: true },
  { key: 'nss',            label: 'NSS',                  icon: '🏥', obligatorio: true },
  { key: 'comprobante',    label: 'Comprobante domicilio',icon: '🏠', obligatorio: true },
  { key: 'acta',           label: 'Acta nacimiento',      icon: '📜', obligatorio: true },
  { key: 'constancias',    label: 'Constancias laborales',icon: '📋', obligatorio: false },
  { key: 'recomendacion',  label: 'Cartas recomendación', icon: '✉️', obligatorio: false },
  { key: 'banco',          label: 'Cuenta bancaria',      icon: '🏦', obligatorio: true },
  { key: 'licencia',       label: 'Licencia (si aplica)', icon: '🚗', obligatorio: false },
  { key: 'avisoPrivacidad',label: 'Aviso de privacidad',  icon: '🔐', obligatorio: true }
];

// 7. OFERTA — Validación pre-ingreso (regla crítica del director)
export const CHECKLIST_OFERTA: ItemChecklist[] = [
  { key: 'ofertaAceptada',  label: 'Oferta aceptada',          icon: '💰', obligatorio: true },
  { key: 'documentacion',   label: 'Documentación completa',   icon: '📄', obligatorio: true },
  { key: 'aprobacionJefe',  label: 'Aprobación del jefe',      icon: '👨‍💼', obligatorio: true },
  { key: 'fechaIngreso',    label: 'Fecha de ingreso',         icon: '📅', obligatorio: true },
  { key: 'confirmacion',    label: 'Confirmación 24h antes',   icon: '📞', obligatorio: true },
  { key: 'contratoListo',   label: 'Contrato preparado',       icon: '📝', obligatorio: true }
];

// 8. CONTRATADO — Ingreso real + permanencia
export const CHECKLIST_CONTRATADO: ItemChecklist[] = [
  { key: 'contratoFirmado',  label: 'Contrato firmado',       icon: '📝', obligatorio: true },
  { key: 'altaAdmin',        label: 'Alta administrativa',    icon: '🏢', obligatorio: true },
  { key: 'altaImss',         label: 'Alta IMSS',              icon: '🛡️', obligatorio: true },
  { key: 'herramientas',     label: 'Uniforme/herramientas',  icon: '👕', obligatorio: true },
  { key: 'induccion',        label: 'Inducción completada',   icon: '📚', obligatorio: true },
  { key: 'primerDia',        label: 'Primer día asistido',    icon: '✅', obligatorio: true }
];

// 9. DICTAMEN FINAL — Resumen multiárea (Hoja del director)
export const AREAS_DICTAMEN = [
  { key: 'rh',           label: 'RH',                  tipo: 'aprobado' },
  { key: 'competencias', label: 'Competencias',        tipo: 'puntaje' },
  { key: 'aptitudes',    label: 'Aptitudes',           tipo: 'puntaje' },
  { key: 'psicometria',  label: 'Psicometría',         tipo: 'riesgo' },
  { key: 'jefe',         label: 'Jefe Directo',        tipo: 'aprobado' },
  { key: 'documentos',   label: 'Documentación',       tipo: 'completo' }
] as const;

export type ResultadoDictamen = 'contratar' | 'bolsa' | 'rechazar';

// =====================================================================
// VALIDADORES DE BLOQUEO
// =====================================================================

/** ¿Tiene todos los obligatorios en VERDE? */
export function checklistCompleto(estado: Record<string, EstadoCheck> | undefined, items: ItemChecklist[]): boolean {
  if (!estado) return false;
  return items.filter(i => i.obligatorio).every(i => estado[i.key] === 'verde');
}

/** Items faltantes para mostrarle al usuario qué le bloquea avanzar */
export function itemsFaltantes(estado: Record<string, EstadoCheck> | undefined, items: ItemChecklist[]): ItemChecklist[] {
  if (!estado) return items.filter(i => i.obligatorio);
  return items.filter(i => i.obligatorio && estado[i.key] !== 'verde');
}

/** Cuántos obligatorios están en verde / total de obligatorios */
export function progresoChecklist(estado: Record<string, EstadoCheck> | undefined, items: ItemChecklist[]): { hechos: number; total: number; pct: number } {
  const obligatorios = items.filter(i => i.obligatorio);
  if (!estado) return { hechos: 0, total: obligatorios.length, pct: 0 };
  const hechos = obligatorios.filter(i => estado[i.key] === 'verde').length;
  return { hechos, total: obligatorios.length, pct: obligatorios.length === 0 ? 100 : Math.round((hechos / obligatorios.length) * 100) };
}
