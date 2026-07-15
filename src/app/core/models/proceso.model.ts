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

// Flujo de selección (formato de 4 etapas):
// Filtro inicial → Entrevista Orientación Conductual →
// Aptitudes y Entrevista Técnica (fusionadas) → Psicométricas
// Paleta corporativa sobria (sin tonos "alegres"): carbón + dorado + rojo Mega + estados discretos.
export const ETAPAS: EtapaConfig[] = [
  { id: 'filtro_inicial',   title: 'Filtro Inicial',                    shortLabel: 'Filtro',        icon: '1', color: '#1F4E8C', description: 'Primer contacto y validación mínima por WhatsApp.', slaHoras: 24 },
  { id: 'entrevista_rh',    title: 'Entrevista Orientación Conductual', shortLabel: 'Conductual',    icon: '2', color: '#1A4FB0', description: 'Orientación y competencias conductuales (cuestionario de liderazgo).', slaHoras: 48 },
  { id: 'aptitudes',        title: 'Aptitudes y Entrevista Técnica',    shortLabel: 'Aptitudes',     icon: '3', color: '#2A5A8A', description: 'Pruebas de aptitudes por vacante y validación técnica con el jefe directo.', slaHoras: 48 },
  { id: 'psicometria',      title: 'Psicométricas',                     shortLabel: 'Psicométricas', icon: '4', color: '#3F5C7A', description: 'Personalidad, honestidad, inteligencia y compatibilidad (apoyo, no decisión).', slaHoras: 72 }
];

// Desenlace del proceso: candidatos ya contratados. No es una etapa del flujo
// (no está en ETAPAS ni en FLUJO_LINEAL), pero se muestra como filtro aparte.
export const ETAPA_CONTRATADO: EtapaConfig = {
  id: 'contratado',
  title: 'Contratados',
  shortLabel: 'Contratados',
  icon: '✓',
  color: '#1F7A4C',
  description: 'Candidatos que completaron el proceso y ya fueron contratados.'
};

// Los ids 'nuevo', 'entrevista_jefe', 'documental', 'oferta', 'dictamen',
// 'contratado' y 'rechazado' ya NO son etapas visibles del flujo. Se conservan
// como constantes (no se borran de ID_ETAPAS) para no romper datos históricos
// ni el código que aún los referencia; la migración de etapa.ts/layout.ts
// reubica a los candidatos viejos en la etapa vigente equivalente.
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

// Orden lineal para el stepper (las 4 etapas vigentes del proceso)
export const FLUJO_LINEAL: string[] = [
  ID_ETAPAS.FILTRO,
  ID_ETAPAS.RH,
  ID_ETAPAS.APTITUDES,
  ID_ETAPAS.PSICOMETRIA
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

/** Tipos de vacante base para los presets de aptitudes. */
export type TipoAptitud = 'operativo' | 'administrativo' | 'ventas' | 'jefatura';

export const TIPOS_APTITUD: { key: TipoAptitud; label: string }[] = [
  { key: 'operativo',      label: 'Operativo' },
  { key: 'administrativo', label: 'Administrativo' },
  { key: 'ventas',         label: 'Ventas' },
  { key: 'jefatura',       label: 'Jefatura' }
];

/**
 * Resuelve las aptitudes que se deben calificar para un candidato/puesto.
 * Prioridad: aptitudes CUSTOM del puesto → preset del `tipo` → preset operativo.
 * `custom` son las aptitudes propias del puesto (colección `puestos`);
 * `tipo` es el tipo de vacante (del candidato o del puesto) para el fallback.
 */
export function resolverAptitudes(
  custom: AptitudItem[] | undefined,
  tipo: string | undefined
): AptitudItem[] {
  if (Array.isArray(custom) && custom.length) return custom;
  const t = (tipo || 'operativo') as string;
  return APTITUDES_POR_TIPO[t] || APTITUDES_POR_TIPO['operativo'];
}

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

// 4. PSICOMETRÍA — Pruebas estándar (checklist LEGADO, previo al rediseño)
// Se conserva sólo para leer expedientes viejos; los nuevos usan las 3 pruebas de abajo.
export const PSICOMETRIA_ITEMS: ItemChecklist[] = [
  { key: 'personalidad',   label: 'Personalidad laboral',  icon: '🧠', obligatorio: true },
  { key: 'honestidad',     label: 'Honestidad/confiable',  icon: '🔒', obligatorio: true },
  { key: 'inteligencia',   label: 'Inteligencia general',  icon: '💡', obligatorio: false },
  { key: 'estiloTrabajo',  label: 'Estilo de trabajo',     icon: '⚙️', obligatorio: false },
  { key: 'liderazgo',      label: 'Liderazgo (si aplica)', icon: '🏆', obligatorio: false }
];

// =====================================================================
// 4-BIS. PSICOMÉTRICAS — IntegriTEST · StabiliTEST · HR Avatar
// Sólo se capturan puntajes/resultados. Cada prueba trae su propia escala.
// =====================================================================

/** IntegriTEST — recomendación de contratación (5 niveles). */
export type IntegritestNivel =
  | 'recomendado' | 'aclaracion' | 'marginal' | 'no_recomendado' | 'sin_resultados';

/** StabiliTEST — nivel de riesgo. */
export type StabilitestNivel = 'riesgo_bajo' | 'riesgo_alto' | 'sin_resultados';

/** Un nivel seleccionable con su etiqueta y la clase de color semáforo. */
export interface NivelPsico {
  key: string;
  label: string;
  clase: 'nivel-verde' | 'nivel-verde-claro' | 'nivel-amarillo' | 'nivel-naranja' | 'nivel-rojo' | 'nivel-navy' | 'nivel-negro';
}

export const INTEGRITEST_NIVELES: NivelPsico[] = [
  { key: 'recomendado',    label: 'Recomendado',            clase: 'nivel-verde' },
  { key: 'aclaracion',     label: 'Se requiere aclaración', clase: 'nivel-verde-claro' },
  { key: 'marginal',       label: 'Marginal',               clase: 'nivel-amarillo' },
  { key: 'no_recomendado', label: 'No recomendado',         clase: 'nivel-rojo' },
  { key: 'sin_resultados', label: 'Sin resultados',         clase: 'nivel-navy' }
];

export const STABILITEST_NIVELES: NivelPsico[] = [
  { key: 'riesgo_bajo',    label: 'Riesgo bajo',    clase: 'nivel-verde' },
  { key: 'riesgo_alto',    label: 'Riesgo alto',    clase: 'nivel-amarillo' },
  { key: 'sin_resultados', label: 'Sin resultados', clase: 'nivel-negro' }
];

/** Resultado de las 3 pruebas que se guarda en el candidato. */
export interface PsicoTests {
  integritest?: IntegritestNivel | '';
  stabilitest?: StabilitestNivel | '';
  hrAvatar?: number | null;   // 0-100
}

export interface HrAvatarInterp { label: string; clase: NivelPsico['clase']; }

/** Interpreta el puntaje 0-100 de HR Avatar en una banda con color. */
export function interpretarHrAvatar(score: number | null | undefined): HrAvatarInterp {
  if (score == null || isNaN(score)) return { label: 'Sin resultados', clase: 'nivel-navy' };
  if (score >= 80) return { label: 'Alto',        clase: 'nivel-verde' };
  if (score >= 65) return { label: 'Medio-alto',  clase: 'nivel-verde-claro' };
  if (score >= 50) return { label: 'Medio',       clase: 'nivel-amarillo' };
  if (score >= 35) return { label: 'Marginal',    clase: 'nivel-naranja' };
  return { label: 'Bajo', clase: 'nivel-rojo' };
}

export type RiesgoPsico = 'sin_riesgo' | 'bajo_riesgo' | 'alto_riesgo';

/** Deriva el riesgo global (para el dictamen) a partir de las 3 pruebas. */
export function riesgoPsicometrico(t: PsicoTests | undefined): RiesgoPsico {
  if (!t) return 'sin_riesgo';
  // Alto riesgo: cualquier señal crítica
  if (t.integritest === 'no_recomendado') return 'alto_riesgo';
  if (t.stabilitest === 'riesgo_alto') return 'alto_riesgo';
  if (typeof t.hrAvatar === 'number' && t.hrAvatar < 35) return 'alto_riesgo';
  // Bajo riesgo: señales intermedias que ameritan revisar
  if (t.integritest === 'marginal' || t.integritest === 'aclaracion') return 'bajo_riesgo';
  if (typeof t.hrAvatar === 'number' && t.hrAvatar < 65) return 'bajo_riesgo';
  return 'sin_riesgo';
}

/** ¿RH ya capturó al menos una prueba con resultado real? */
export function psicoTocado(t: PsicoTests | undefined): boolean {
  if (!t) return false;
  return (!!t.integritest && t.integritest !== 'sin_resultados')
      || (!!t.stabilitest && t.stabilitest !== 'sin_resultados')
      || (typeof t.hrAvatar === 'number' && !isNaN(t.hrAvatar));
}

/** Etapa completa: IntegriTEST y StabiliTEST resueltos (aunque sea "sin resultados"). */
export function psicoCompleto(t: PsicoTests | undefined): boolean {
  return !!t && !!t.integritest && !!t.stabilitest;
}

/** Progreso 0-100: cuántas de las 3 pruebas tienen resultado real. */
export function progresoPsico(t: PsicoTests | undefined): { hechos: number; total: number; pct: number } {
  const total = 3;
  if (!t) return { hechos: 0, total, pct: 0 };
  let hechos = 0;
  if (t.integritest && t.integritest !== 'sin_resultados') hechos++;
  if (t.stabilitest && t.stabilitest !== 'sin_resultados') hechos++;
  if (typeof t.hrAvatar === 'number' && !isNaN(t.hrAvatar)) hechos++;
  return { hechos, total, pct: Math.round((hechos / total) * 100) };
}

/** Puntaje 0-100 de la etapa (promedio de las pruebas capturadas) para el concentrado. */
export function puntajePsico(t: PsicoTests | undefined): { puntaje: number; evaluada: boolean } {
  if (!t) return { puntaje: 0, evaluada: false };
  const mapInteg: Record<string, number> = { recomendado: 100, aclaracion: 75, marginal: 50, no_recomendado: 15 };
  const mapStab: Record<string, number> = { riesgo_bajo: 100, riesgo_alto: 30 };
  const vals: number[] = [];
  if (t.integritest && mapInteg[t.integritest] != null) vals.push(mapInteg[t.integritest]);
  if (t.stabilitest && mapStab[t.stabilitest] != null) vals.push(mapStab[t.stabilitest]);
  if (typeof t.hrAvatar === 'number' && !isNaN(t.hrAvatar)) vals.push(Math.max(0, Math.min(100, t.hrAvatar)));
  if (!vals.length) return { puntaje: 0, evaluada: false };
  return { puntaje: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length), evaluada: true };
}

/** Progreso de la etapa Psicométricas con compatibilidad hacia el checklist viejo. */
export function progresoPsicoDeCandidato(c: any): { hechos: number; total: number; pct: number } {
  const t = c?.psicoTests as PsicoTests | undefined;
  if (psicoTocado(t)) return progresoPsico(t);
  // Expedientes previos al rediseño: caer al checklist legado
  const est = c?.psicometriaChecklist as Record<string, EstadoCheck> | undefined;
  if (est && Object.values(est).some(v => v && v !== 'gris')) {
    return progresoChecklist(est, PSICOMETRIA_ITEMS);
  }
  return progresoPsico(t);
}

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

// 6-BIS. PORTAFOLIO DE DOCUMENTOS DEL EXPEDIENTE
// Espacios por tipo de documento donde RH sube/consulta los archivos del
// candidato (incluye el contrato ya firmado). "obligatorio" solo marca cuáles
// se esperan; no bloquea nada.
export interface DocExpedienteSlot { key: string; label: string; obligatorio: boolean; }
export const DOCUMENTOS_EXPEDIENTE: DocExpedienteSlot[] = [
  { key: 'cv',              label: 'Currículum vitae',        obligatorio: true },
  { key: 'ine',             label: 'INE',                     obligatorio: true },
  { key: 'curp',            label: 'CURP',                    obligatorio: true },
  { key: 'rfc',             label: 'RFC',                     obligatorio: true },
  { key: 'nss',             label: 'NSS',                     obligatorio: true },
  { key: 'comprobante',     label: 'Comprobante de domicilio',obligatorio: true },
  { key: 'acta',            label: 'Acta de nacimiento',      obligatorio: true },
  { key: 'banco',           label: 'Cuenta bancaria',         obligatorio: true },
  { key: 'avisoPrivacidad', label: 'Aviso de privacidad',     obligatorio: true },
  { key: 'licencia',        label: 'Licencia de manejo',      obligatorio: false },
  { key: 'contrato',        label: 'Contrato firmado',        obligatorio: false }
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
