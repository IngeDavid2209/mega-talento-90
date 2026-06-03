// =====================================================================
// CUESTIONARIO DE EVALUACIÓN DE LIDERAZGO
// Modelos interaccionistas del liderazgo · Conducta orientada a la
// tarea y conducta orientada a las relaciones · Mega Dulces.
//
// 12 preguntas con escala Likert 1-5. Se evalúa al candidato durante
// la entrevista conductual marcando una opción por cada afirmación.
// =====================================================================

export interface PreguntaLiderazgo {
  num: number;
  texto: string;
  /** "tarea" o "relaciones": permite calcular sub-puntajes si se quiere */
  dimension: 'tarea' | 'relaciones';
}

export interface NivelLikert {
  valor: number;   // 1..5
  etiquetaCorta: string;
  etiquetaLarga: string;
}

export const NIVELES_LIKERT: NivelLikert[] = [
  { valor: 1, etiquetaCorta: 'Nunca',            etiquetaLarga: 'Nunca se comporta de esa manera' },
  { valor: 2, etiquetaCorta: 'Rara vez',         etiquetaLarga: 'Rara vez se comporta de esa manera' },
  { valor: 3, etiquetaCorta: 'De vez en cuando', etiquetaLarga: 'De vez en cuando se comporta de esa manera' },
  { valor: 4, etiquetaCorta: 'Frecuentemente',   etiquetaLarga: 'Frecuentemente se comporta de esa manera' },
  { valor: 5, etiquetaCorta: 'Siempre',          etiquetaLarga: 'Siempre se comporta de esa manera' }
];

// Distribución 6 + 6 para que cada dimensión sume mínimo 6 (todas en 1) y máximo 30 (todas en 5).
// Esto encaja con el Grid Gerencial Blake-Mouton: ejes 6-30 en ambas dimensiones.
export const CUESTIONARIO_LIDERAZGO: PreguntaLiderazgo[] = [
  { num: 1,  dimension: 'tarea',      texto: 'Promueve buenas y duraderas opiniones, ideas, sentimientos e información con el fin de facilitar el funcionamiento del grupo.' },
  { num: 2,  dimension: 'relaciones', texto: 'Anima con entusiasmo a todos los miembros del grupo para que participen, está abierto a sus ideas y les hace saber que aprecia sus contribuciones al grupo.' },
  { num: 3,  dimension: 'tarea',      texto: 'Solicita hechos, información, opiniones, ideas y sentimientos a los demás miembros con el fin de ayudar a la discusión del grupo.' },
  { num: 4,  dimension: 'tarea',      texto: 'Ayuda a que los miembros se comuniquen entre sí por medio de buenas habilidades de comunicación y se asegura de que cada uno entienda lo que dicen los demás.' },
  { num: 5,  dimension: 'tarea',      texto: 'Dirige al grupo planificando cómo abordar el trabajo, llamando la atención sobre las tareas que hay que realizar y asignando responsabilidades a diferentes miembros del grupo.' },
  { num: 6,  dimension: 'relaciones', texto: 'Bromea y sugiere formas interesantes de realizar el trabajo con el fin de reducir la tensión en el grupo y hacer más divertido trabajar juntos.' },
  { num: 7,  dimension: 'relaciones', texto: 'Reconoce los logros alcanzados por los miembros del grupo y les felicita por su buen desempeño. Así los anima a seguir trabajando bien.' },
  { num: 8,  dimension: 'relaciones', texto: 'Se preocupa por conocer los problemas o dificultades que tienen los miembros del grupo y les apoya para encontrar soluciones cuando es necesario.' },
  { num: 9,  dimension: 'tarea',      texto: 'Fomenta que todos los miembros del grupo participen dando sus ideas y opiniones antes de tomar decisiones importantes.' },
  { num: 10, dimension: 'relaciones', texto: 'Establece comunicación clara, abierta y respetuosa con los miembros del grupo, escuchándolos y compartiendo la información necesaria.' },
  { num: 11, dimension: 'tarea',      texto: 'Delega tareas de acuerdo con las habilidades y capacidades de cada integrante, dándoles la confianza y el apoyo necesario para que las realicen bien.' },
  { num: 12, dimension: 'relaciones', texto: 'Motiva al grupo a mantener una actitud positiva y comprometida, incluso en situaciones difíciles o cuando los resultados no son los esperados.' }
];

export type RespuestasCuestionario = Record<number, number>; // { [numPregunta]: valor 1-5 }

/** Los 5 estilos clásicos del Grid Gerencial de Blake y Mouton */
export type EstiloLiderazgo =
  | 'equipo'        // alta tarea + alta relaciones (30,30)
  | 'autocratico'   // alta tarea + baja relaciones (30,6)
  | 'club-campestre'// baja tarea + alta relaciones (6,30)
  | 'punto-medio'   // tarea y relaciones medias (18,18)
  | 'empobrecido'   // baja tarea + baja relaciones (6,6)
  | 'sin-evaluar';

export interface EstiloInfo {
  id: EstiloLiderazgo;
  nombre: string;
  coordenada: string;   // "30,30", etc.
  resumen: string;
}

export const ESTILOS_LIDERAZGO: Record<EstiloLiderazgo, EstiloInfo> = {
  'equipo': {
    id: 'equipo',
    nombre: 'Liderazgo de Equipo',
    coordenada: '(30, 30)',
    resumen: 'Alto interés tanto por la tarea como por las personas. Líder ideal: logra resultados a través del compromiso y el trabajo en equipo.'
  },
  'autocratico': {
    id: 'autocratico',
    nombre: 'Autoridad-Obediencia',
    coordenada: '(30, 6)',
    resumen: 'Centrado en la tarea, poco interés por las relaciones. Logra eficiencia pero puede generar baja motivación.'
  },
  'club-campestre': {
    id: 'club-campestre',
    nombre: 'Club Campestre',
    coordenada: '(6, 30)',
    resumen: 'Centrado en las personas, descuida la tarea. Buen ambiente pero los resultados pueden quedar pendientes.'
  },
  'punto-medio': {
    id: 'punto-medio',
    nombre: 'Estilo de Punto Medio',
    coordenada: '(18, 18)',
    resumen: 'Equilibrio aceptable entre tarea y personas. Resultados medios sin destacar en ninguna dimensión.'
  },
  'empobrecido': {
    id: 'empobrecido',
    nombre: 'Liderazgo Empobrecido',
    coordenada: '(6, 6)',
    resumen: 'Bajo interés por tarea y personas. Esfuerzo mínimo para no perder el puesto. Estilo poco efectivo.'
  },
  'sin-evaluar': {
    id: 'sin-evaluar',
    nombre: 'Sin evaluar',
    coordenada: '—',
    resumen: 'Aún no se ha completado el cuestionario.'
  }
};

export interface ResultadoCuestionario {
  contestadas: number;
  total: number;
  puntaje: number;       // suma de los valores (12-60)
  puntajeMax: number;    // máximo posible = total * 5
  porcentaje: number;    // 0-100, normalizado
  puntajeTarea: number;       // 6-30 (6 preguntas × 1-5)
  puntajeRelaciones: number;  // 6-30
  estilo: EstiloLiderazgo;
  estiloInfo: EstiloInfo;
  interpretacion: string;
  nivel: 'destacado' | 'solido' | 'en-desarrollo' | 'requiere-desarrollo' | 'sin-evaluar';
}

/**
 * Clasifica el estilo según las coordenadas del Grid Gerencial.
 * Los ejes van de 6 a 30 (6 preguntas × 1-5):
 *   - bajo:  6-12
 *   - medio: 13-21
 *   - alto:  22-30
 */
export function clasificarEstilo(puntajeTarea: number, puntajeRelaciones: number): EstiloLiderazgo {
  const nivel = (p: number): 'bajo' | 'medio' | 'alto' => {
    if (p <= 12) return 'bajo';
    if (p <= 21) return 'medio';
    return 'alto';
  };
  const t = nivel(puntajeTarea);
  const r = nivel(puntajeRelaciones);

  if (t === 'alto' && r === 'alto') return 'equipo';
  if (t === 'alto' && r === 'bajo') return 'autocratico';
  if (t === 'bajo' && r === 'alto') return 'club-campestre';
  if (t === 'bajo' && r === 'bajo') return 'empobrecido';
  return 'punto-medio';
}

/** Calcula el puntaje y la interpretación del cuestionario */
export function calcularResultadoLiderazgo(respuestas: RespuestasCuestionario | undefined): ResultadoCuestionario {
  const r = respuestas || {};
  let suma = 0, sumaTarea = 0, sumaRel = 0, contestadas = 0;

  for (const p of CUESTIONARIO_LIDERAZGO) {
    const v = r[p.num];
    if (v && v >= 1 && v <= 5) {
      suma += v;
      contestadas++;
      if (p.dimension === 'tarea') sumaTarea += v;
      else sumaRel += v;
    }
  }

  const total = CUESTIONARIO_LIDERAZGO.length;
  const puntajeMax = total * 5;
  const porcentaje = contestadas > 0 ? Math.round((suma / puntajeMax) * 100) : 0;

  let nivel: ResultadoCuestionario['nivel'] = 'sin-evaluar';
  let interpretacion = 'Aún no se ha completado el cuestionario.';
  let estilo: EstiloLiderazgo = 'sin-evaluar';

  if (contestadas === total) {
    estilo = clasificarEstilo(sumaTarea, sumaRel);
    if (porcentaje >= 83) {
      nivel = 'destacado';
      interpretacion = `Liderazgo destacado · perfil sólido en ambas dimensiones.`;
    } else if (porcentaje >= 66) {
      nivel = 'solido';
      interpretacion = `Liderazgo sólido · cumple con la mayoría de las conductas esperadas.`;
    } else if (porcentaje >= 50) {
      nivel = 'en-desarrollo';
      interpretacion = `Liderazgo en desarrollo · requiere fortalecimiento.`;
    } else {
      nivel = 'requiere-desarrollo';
      interpretacion = `Requiere desarrollo · áreas de oportunidad importantes.`;
    }
  } else if (contestadas > 0) {
    interpretacion = `Faltan ${total - contestadas} pregunta(s) por contestar.`;
  }

  return {
    contestadas, total, puntaje: suma, puntajeMax, porcentaje,
    puntajeTarea: sumaTarea, puntajeRelaciones: sumaRel,
    estilo, estiloInfo: ESTILOS_LIDERAZGO[estilo],
    interpretacion, nivel
  };
}
