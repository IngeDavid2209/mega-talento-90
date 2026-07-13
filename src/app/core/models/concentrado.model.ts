// =====================================================================
// CONCENTRADO DE MEJORES CANDIDATOS POR PUESTO
// Calcula, por candidato, DOS señales objetivas y automáticas:
//   A) Evaluación  → qué tan bien salió en el PROCESO (entrevista, aptitudes,
//                    técnica, psicométricas). Es lo que RH calificó en la app.
//   B) Trayectoria → qué tan sólido es su HISTORIAL (experiencia, estabilidad,
//                    escolaridad, motivos de salida). Se deriva de la Solicitud
//                    Electrónica, sin que nadie la lea a mano.
// Ambas se normalizan a 0-100 y NO inventan datos: si una etapa no se ha
// evaluado o el candidato no llenó la solicitud, se marca como no disponible.
// Reutiliza la lógica de puntaje ya existente en proceso.model y
// cuestionario-liderazgo.model para no duplicar reglas de negocio.
// =====================================================================

import {
  CHECKLIST_JEFE, PSICOMETRIA_ITEMS,
  APTITUDES_POR_TIPO, EstadoCheck,
  progresoChecklist, calcularPuntajeRubrica, UMBRAL_APROBACION_APTITUDES
} from './proceso.model';
import { calcularResultadoLiderazgo } from './cuestionario-liderazgo.model';

// ---------------------------------------------------------------------
// SEÑAL A · EVALUACIÓN (el proceso / la entrevista)
// ---------------------------------------------------------------------

export interface SubEtapaEval {
  key: 'conductual' | 'aptitudes' | 'tecnica' | 'psicometria';
  label: string;
  puntaje: number;      // 0-100
  evaluada: boolean;    // ¿RH ya la calificó? Si no, no cuenta en el promedio
  peso: number;         // importancia relativa en el puntaje global
}

export interface PuntajeEvaluacion {
  score: number;            // 0-100 ponderado sobre las etapas YA evaluadas
  etapasEvaluadas: number;  // cuántas de las 5 tienen datos
  totalEtapas: number;      // 5
  aptitudesAprobado: boolean; // supera el umbral duro (70)
  sinEvaluar: boolean;      // no hay ninguna etapa calificada aún
  subetapas: SubEtapaEval[];
}

/** ¿El reclutador ya tocó este checklist? (algún valor distinto de 'gris'). */
function checklistTocado(record: Record<string, EstadoCheck> | undefined): boolean {
  if (!record) return false;
  return Object.values(record).some(v => !!v && v !== 'gris');
}

export function calcularEvaluacion(candidato: any): PuntajeEvaluacion {
  const tipo = (candidato?.tipoVacante || 'operativo') as keyof typeof APTITUDES_POR_TIPO;
  const aptitudesItems = APTITUDES_POR_TIPO[tipo] || APTITUDES_POR_TIPO['operativo'];

  const conductual = calcularResultadoLiderazgo(candidato?.cuestionarioLiderazgo);
  const aptitudes = calcularPuntajeRubrica(candidato?.rubricaAptitudes, aptitudesItems);
  const tecnica = progresoChecklist(candidato?.jefeChecklist, CHECKLIST_JEFE);
  const psico = progresoChecklist(candidato?.psicometriaChecklist, PSICOMETRIA_ITEMS);

  const subetapas: SubEtapaEval[] = [
    { key: 'conductual',  label: 'Conductual',        puntaje: conductual.porcentaje, evaluada: conductual.contestadas > 0, peso: 0.25 },
    { key: 'aptitudes',   label: 'Aptitudes',         puntaje: aptitudes.puntaje,    evaluada: aptitudes.calificadas > 0, peso: 0.30 },
    { key: 'tecnica',     label: 'Entrevista técnica', puntaje: tecnica.pct,         evaluada: checklistTocado(candidato?.jefeChecklist), peso: 0.25 },
    { key: 'psicometria', label: 'Psicométricas',     puntaje: psico.pct,            evaluada: checklistTocado(candidato?.psicometriaChecklist), peso: 0.10 }
  ];

  const evaluadas = subetapas.filter(s => s.evaluada);
  const pesoTotal = evaluadas.reduce((a, s) => a + s.peso, 0);
  const score = pesoTotal > 0
    ? Math.round(evaluadas.reduce((a, s) => a + s.puntaje * s.peso, 0) / pesoTotal)
    : 0;

  return {
    score,
    etapasEvaluadas: evaluadas.length,
    totalEtapas: subetapas.length,
    aptitudesAprobado: aptitudes.calificadas === aptitudes.total && aptitudes.puntaje >= UMBRAL_APROBACION_APTITUDES,
    sinEvaluar: evaluadas.length === 0,
    subetapas
  };
}

// ---------------------------------------------------------------------
// SEÑAL B · TRAYECTORIA (el CV / la solicitud electrónica)
// ---------------------------------------------------------------------

export type BanderaMotivo = 'positivo' | 'neutral' | 'negativo' | 'sin-dato';

export interface PuntajeTrayectoria {
  disponible: boolean;      // ¿llenó la solicitud electrónica?
  score: number;            // 0-100
  aniosExperiencia: number; // años totales estimados
  numEmpleos: number;
  mesesPromedioPorEmpleo: number;
  escolaridadLabel: string;
  rotacionAlta: boolean;    // cambió de trabajo muy seguido
  banderasNegativas: number; // motivos de salida problemáticos detectados
  motivos: { empresa: string; motivo: string; bandera: BanderaMotivo }[];
}

const ESCOLARIDAD_PUNTOS: Record<string, number> = {
  primaria: 30, secundaria: 45, bachillerato: 60,
  tecnico: 75, licenciatura: 90, posgrado: 100
};
const ESCOLARIDAD_LABEL: Record<string, string> = {
  primaria: 'Primaria', secundaria: 'Secundaria', bachillerato: 'Bachillerato',
  tecnico: 'Carrera técnica', licenciatura: 'Licenciatura', posgrado: 'Posgrado'
};

// Palabras clave para clasificar el motivo de salida (texto libre del candidato).
const MOTIVO_NEGATIVO = ['despido', 'despedido', 'despidieron', 'corrido', 'corrieron', 'conflicto', 'problema', 'problemas', 'robo', 'falta', 'faltas', 'incapacidad conflicto', 'liquidado por', 'mala', 'no me gusto', 'no me gustó', 'demanda'];
const MOTIVO_POSITIVO = ['mejor oferta', 'mejor sueldo', 'crecimiento', 'crecer', 'fin de contrato', 'termino de contrato', 'término de contrato', 'proyecto terminado', 'cambio de residencia', 'estudios', 'escuela', 'personal', 'familiar', 'cierre', 'reduccion', 'reducción', 'temporal', 'oportunidad'];

function clasificarMotivo(texto: string): BanderaMotivo {
  const t = (texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  if (!t) return 'sin-dato';
  if (MOTIVO_NEGATIVO.some(k => t.includes(k))) return 'negativo';
  if (MOTIVO_POSITIVO.some(k => t.includes(k))) return 'positivo';
  return 'neutral';
}

/** Meses entre dos fechas "YYYY-MM"; "actual"/vacío en fin = hasta hoy. */
function mesesEntre(inicio: string, fin: string, hoy: Date): number {
  const parse = (s: string): { y: number; m: number } | null => {
    const m = (s || '').match(/(\d{4})[-/](\d{1,2})/);
    if (!m) return null;
    return { y: +m[1], m: +m[2] };
  };
  const a = parse(inicio);
  if (!a) return 0;
  const finNorm = (fin || '').toLowerCase();
  const b = (finNorm.includes('actual') || !finNorm.trim())
    ? { y: hoy.getFullYear(), m: hoy.getMonth() + 1 }
    : parse(fin);
  if (!b) return 0;
  const meses = (b.y - a.y) * 12 + (b.m - a.m);
  return meses > 0 ? meses : 0;
}

export function calcularTrayectoria(candidato: any, hoy: Date = new Date()): PuntajeTrayectoria {
  const sol = candidato?.solicitudElectronica;
  const vacia: PuntajeTrayectoria = {
    disponible: false, score: 0, aniosExperiencia: 0, numEmpleos: 0,
    mesesPromedioPorEmpleo: 0, escolaridadLabel: '—', rotacionAlta: false,
    banderasNegativas: 0, motivos: []
  };
  if (!sol) return vacia;

  const experiencia: any[] = Array.isArray(sol.experiencia) ? sol.experiencia : [];
  const empleosReales = experiencia.filter(e => (e?.empresa || '').trim() || (e?.puesto || '').trim());

  let mesesTotales = 0;
  const motivos: PuntajeTrayectoria['motivos'] = [];
  empleosReales.forEach(e => {
    mesesTotales += mesesEntre(e.fechaInicio, e.fechaFin, hoy);
    motivos.push({
      empresa: (e.empresa || 'Empleo').trim(),
      motivo: (e.motivoSalida || '').trim(),
      bandera: clasificarMotivo(e.motivoSalida)
    });
  });

  const numEmpleos = empleosReales.length;
  const aniosExperiencia = Math.round((mesesTotales / 12) * 10) / 10;
  const mesesPromedio = numEmpleos > 0 ? Math.round(mesesTotales / numEmpleos) : 0;

  // --- Sub-puntajes 0-100 ---
  // Experiencia: 5+ años = tope.
  const pExp = Math.min(100, Math.round((aniosExperiencia / 5) * 100));
  // Estabilidad: permanencia promedio por empleo. 1 solo empleo = neutral.
  let pEstab: number;
  if (numEmpleos <= 1) pEstab = mesesPromedio >= 12 ? 80 : 60;
  else if (mesesPromedio >= 24) pEstab = 100;
  else if (mesesPromedio >= 12) pEstab = 70;
  else if (mesesPromedio >= 6) pEstab = 45;
  else pEstab = 20;
  const rotacionAlta = numEmpleos >= 3 && mesesPromedio < 12;
  // Escolaridad
  const nivel = (sol.escolaridad?.nivelMaximo || '') as string;
  const pEsc = ESCOLARIDAD_PUNTOS[nivel] ?? 40;
  const escolaridadLabel = ESCOLARIDAD_LABEL[nivel] || 'Sin especificar';
  // Motivos de salida
  const conMotivo = motivos.filter(m => m.bandera !== 'sin-dato');
  const negativas = motivos.filter(m => m.bandera === 'negativo').length;
  const positivas = conMotivo.filter(m => m.bandera === 'positivo').length;
  let pMotivo = 60; // neutral por defecto
  if (conMotivo.length > 0) {
    pMotivo = Math.round(((positivas * 100 + (conMotivo.length - positivas - negativas) * 60) / conMotivo.length));
    pMotivo = Math.max(0, pMotivo - negativas * 25);
  }

  const score = Math.round(pExp * 0.35 + pEstab * 0.30 + pEsc * 0.20 + pMotivo * 0.15);

  return {
    disponible: true,
    score: Math.max(0, Math.min(100, score)),
    aniosExperiencia, numEmpleos, mesesPromedioPorEmpleo: mesesPromedio,
    escolaridadLabel, rotacionAlta, banderasNegativas: negativas, motivos
  };
}

// ---------------------------------------------------------------------
// FILA DEL CONCENTRADO (candidato ya puntuado)
// ---------------------------------------------------------------------

export interface FilaConcentrado {
  candidato: any;
  evaluacion: PuntajeEvaluacion;
  trayectoria: PuntajeTrayectoria;
}

export function puntuarCandidato(candidato: any, hoy: Date = new Date()): FilaConcentrado {
  return {
    candidato,
    evaluacion: calcularEvaluacion(candidato),
    trayectoria: calcularTrayectoria(candidato, hoy)
  };
}

/**
 * Ordena por Evaluación (lo más confiable). Desempata por:
 *   1) más etapas evaluadas (más vetado),
 *   2) mejor trayectoria,
 *   3) menos días sin seguimiento (más fresco).
 * `diasSinSeg` se inyecta para no acoplar este módulo al de seguimiento.
 */
export function compararFilas(
  a: FilaConcentrado, b: FilaConcentrado,
  diasSinSeg: (c: any) => number
): number {
  if (b.evaluacion.score !== a.evaluacion.score) return b.evaluacion.score - a.evaluacion.score;
  if (b.evaluacion.etapasEvaluadas !== a.evaluacion.etapasEvaluadas) return b.evaluacion.etapasEvaluadas - a.evaluacion.etapasEvaluadas;
  if (b.trayectoria.score !== a.trayectoria.score) return b.trayectoria.score - a.trayectoria.score;
  return diasSinSeg(a.candidato) - diasSinSeg(b.candidato);
}
