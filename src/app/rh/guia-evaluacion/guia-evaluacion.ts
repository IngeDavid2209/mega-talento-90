import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  ESTILOS_LIDERAZGO, NIVELES_LIKERT, CUESTIONARIO_LIDERAZGO, EstiloLiderazgo
} from '../../core/models/cuestionario-liderazgo.model';

interface MarcadorEstilo {
  id: EstiloLiderazgo;
  t: number;            // preocupación por la TAREA (6-30)
  r: number;            // preocupación por las RELACIONES (6-30)
  color: string;
  anchor: 'start' | 'middle' | 'end';
  dx: number;           // desplazamiento de la etiqueta
  dy: number;
}

/**
 * GUÍA DE EVALUACIÓN DE LIDERAZGO (rúbrica).
 *
 * Página de referencia (no ligada a ningún candidato) que explica CÓMO se
 * sacan los puntos de la Evaluación de Liderazgo: el Grid Gerencial de Blake &
 * Mouton con los 5 estilos, la escala Likert, las dos dimensiones y los niveles
 * por porcentaje. Los números salen del mismo modelo que usa el sistema para
 * calificar (cuestionario-liderazgo.model.ts), así que siempre coinciden.
 */
@Component({
  selector: 'app-guia-evaluacion',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './guia-evaluacion.html',
  styleUrl: './guia-evaluacion.css'
})
export class GuiaEvaluacionComponent {
  ESTILOS = ESTILOS_LIDERAZGO;
  NIVELES_LIKERT = NIVELES_LIKERT;

  totalPreguntas = CUESTIONARIO_LIDERAZGO.length;                 // 12
  preguntasTarea = CUESTIONARIO_LIDERAZGO.filter(p => p.dimension === 'tarea').length;       // 6
  preguntasRelaciones = CUESTIONARIO_LIDERAZGO.filter(p => p.dimension === 'relaciones').length; // 6
  puntajeMax = CUESTIONARIO_LIDERAZGO.length * 5;                 // 60

  // ── Geometría del Grid (viewBox 0 0 360 340) ────────────────────
  readonly VALS = [6, 12, 18, 24, 30];
  private readonly L = 62;    // borde izquierdo del área de graficado
  private readonly Rr = 332;  // borde derecho
  private readonly T = 26;    // borde superior
  private readonly B = 296;   // borde inferior

  gx(v: number): number { return this.L + ((v - 6) / 24) * (this.Rr - this.L); }
  gy(v: number): number { return this.B - ((v - 6) / 24) * (this.B - this.T); }

  // Los 5 estilos ubicados en el grid (coordenadas del modelo Blake-Mouton).
  marcadores: MarcadorEstilo[] = [
    { id: 'club-campestre', t: 6,  r: 30, color: '#0ea5e9', anchor: 'start',  dx: 12, dy: 5 },
    { id: 'equipo',         t: 30, r: 30, color: '#16a34a', anchor: 'end',    dx: -12, dy: 5 },
    { id: 'punto-medio',    t: 18, r: 18, color: '#f59e0b', anchor: 'middle', dx: 0,  dy: -14 },
    { id: 'empobrecido',    t: 6,  r: 6,  color: '#64748b', anchor: 'start',  dx: 12, dy: 5 },
    { id: 'autocratico',    t: 30, r: 6,  color: '#6366f1', anchor: 'end',    dx: -12, dy: 5 },
  ];

  // Rangos de cada EJE (dimensión) según clasificarEstilo(): bajo/medio/alto.
  rangosEje = [
    { nivel: 'Bajo',  rango: '6 – 12',  clase: 'bajo' },
    { nivel: 'Medio', rango: '13 – 21', clase: 'medio' },
    { nivel: 'Alto',  rango: '22 – 30', clase: 'alto' },
  ];

  // Niveles globales por PORCENTAJE (mismos cortes que calcularResultadoLiderazgo).
  nivelesGlobales = [
    { nivel: 'Destacado',           rango: '83% – 100%',     clase: 'destacado',           desc: 'Perfil sólido en ambas dimensiones.' },
    { nivel: 'Sólido',              rango: '66% – 82%',      clase: 'solido',              desc: 'Cumple la mayoría de las conductas esperadas.' },
    { nivel: 'En desarrollo',       rango: '50% – 65%',      clase: 'en-desarrollo',       desc: 'Requiere fortalecimiento.' },
    { nivel: 'Requiere desarrollo', rango: 'menos de 50%',   clase: 'requiere-desarrollo', desc: 'Áreas de oportunidad importantes.' },
  ];

  // Orden en que se muestran las tarjetas de estilo debajo del grid.
  ordenEstilos: EstiloLiderazgo[] = ['equipo', 'autocratico', 'club-campestre', 'punto-medio', 'empobrecido'];

  colorDe(id: EstiloLiderazgo): string {
    return this.marcadores.find(m => m.id === id)?.color || '#94a3b8';
  }
}
