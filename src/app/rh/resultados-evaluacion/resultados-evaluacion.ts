import { Component, inject, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { CandidateService } from '../../core/services/candidate';
import {
  calcularResultadoLiderazgo, ResultadoCuestionario, calificaEnEvaluacion
} from '../../core/models/cuestionario-liderazgo.model';
import { normalizarCiudad, normalizarPuesto } from '../../core/models/normalizacion.model';
import { ID_ETAPAS } from '../../core/models/proceso.model';
import * as XLSX from 'xlsx';

interface FilaEval {
  c: any;
  r: ResultadoCuestionario;
}

/**
 * RESULTADOS DE LA EVALUACIÓN DE LIDERAZGO.
 *
 * Lista a los candidatos que YA contestaron la encuesta (las 12 preguntas) con
 * su puntuación, calculada con la MISMA función que usa el resto del sistema
 * (calcularResultadoLiderazgo), así que los números coinciden con el expediente
 * y con la Guía de evaluación.
 */
@Component({
  selector: 'app-resultados-evaluacion',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './resultados-evaluacion.html',
  styleUrl: './resultados-evaluacion.css'
})
export class ResultadosEvaluacionComponent implements OnInit, OnDestroy {
  private candidateService = inject(CandidateService);
  private router = inject(Router);
  private ngZone = inject(NgZone);

  cargando = true;
  private todos: any[] = [];

  completos: FilaEval[] = [];   // ya contestaron las 12 (filtrado por búsqueda + aptitud)
  termino = '';

  /**
   * Filtro por aptitud según el % de la evaluación:
   *   - 'aptos'   → mejores promedios (>= UMBRAL_APTO): sólidos y destacados.
   *   - 'noAptos' → peores promedios (< UMBRAL_APTO): en/requiere desarrollo.
   * El umbral 66 coincide con el corte "sólido" que ya usa el resto del sistema.
   */
  filtro: 'todos' | 'aptos' | 'noAptos' | 'practicantes' = 'todos';
  readonly UMBRAL_APTO = 66;

  // Conteos por categoría (sobre lo que coincide con la búsqueda + ciudad + puesto)
  countAptos = 0;
  countNoAptos = 0;
  countPracticantes = 0;

  // Selectores de ciudad y puesto (vacío = todas/todos). Se combinan con el
  // buscador y el filtro por aptitud.
  ciudadSel = '';
  puestoSel = '';
  ciudades: string[] = [];   // opciones disponibles (candidatos que ya contestaron)
  puestos: string[] = [];

  // Totales globales (sin filtrar)
  totalCompletos = 0;
  totalEnProgreso = 0;
  promedio = 0;    // % promedio de los que completaron

  private unsub: any;
  // Ids que ya intentamos reubicar en esta sesión (evita reintentos en cada
  // emisión del listener en tiempo real).
  private yaReubicados = new Set<string>();

  ngOnInit() {
    this.unsub = this.candidateService.listenToCandidates(datos => {
      this.ngZone.run(() => {
        this.todos = datos;
        this.clasificar();
        this.reubicarCompletadosAFaseConductual();
        this.cargando = false;
      });
    });
  }

  /**
   * Reubica a la 2ª fase (Entrevista Orientación) a los candidatos que YA
   * CALIFICARON en la encuesta (>= umbral) pero siguen en Filtro Inicial (o
   * 'nuevo'). Cubre a quienes la contestaron ANTES de que el avance fuera
   * automático. Los que contestaron pero NO calificaron se quedan en Filtro.
   * Solo AVANZA (nunca retrocede ni toca rechazados/contratados) y es
   * idempotente: una vez movidos, dejan de cumplir la condición.
   */
  private reubicarCompletadosAFaseConductual() {
    for (const c of this.todos) {
      if (!c?.id || this.yaReubicados.has(c.id)) continue;
      const estado = c.status;
      if (estado && estado !== ID_ETAPAS.FILTRO && estado !== ID_ETAPAS.NUEVO) continue;
      const r = calcularResultadoLiderazgo(c.cuestionarioLiderazgo);
      if (!calificaEnEvaluacion(r)) continue; // solo los que califican pasan
      this.yaReubicados.add(c.id);
      this.candidateService
        .updateCandidate(c.id, { status: ID_ETAPAS.RH }, { marcarActividad: false })
        .catch(e => console.warn('No se pudo reubicar a Entrevista Orientación:', c.id, e));
    }
  }

  ngOnDestroy() {
    if (this.unsub) this.unsub();
  }

  clasificar() {
    const conResultado = this.todos.map(c => ({ c, r: calcularResultadoLiderazgo(c.cuestionarioLiderazgo) }));

    const completos = conResultado.filter(f => f.r.contestadas === f.r.total && f.r.total > 0);
    this.totalCompletos = completos.length;
    this.totalEnProgreso = conResultado.filter(f => f.r.contestadas > 0 && f.r.contestadas < f.r.total).length;
    this.promedio = completos.length
      ? Math.round(completos.reduce((a, f) => a + f.r.porcentaje, 0) / completos.length)
      : 0;

    // Opciones de los selectores: todas las ciudades y puestos de quienes
    // contestaron (etiquetas normalizadas para unir variantes equivalentes).
    this.ciudades = Array.from(new Set(completos.map(f => normalizarCiudad(f.c.ciudad || f.c.sucursal))))
      .sort((a, b) => a.localeCompare(b));
    this.puestos = Array.from(new Set(completos.map(f => normalizarPuesto(f.c.puesto))))
      .sort((a, b) => a.localeCompare(b));

    const t = this.termino.trim().toLowerCase();
    const coincide = (c: any) => !t
      || (c.nombre || '').toLowerCase().includes(t)
      || (c.puesto || '').toLowerCase().includes(t)
      || (c.ciudad || c.sucursal || '').toLowerCase().includes(t);

    // Alcance actual: búsqueda + ciudad + puesto. Sobre esto se cuentan los
    // botones y se aplica el filtro por aptitud.
    let scope = completos.filter(f => coincide(f.c));
    if (this.ciudadSel) scope = scope.filter(f => normalizarCiudad(f.c.ciudad || f.c.sucursal) === this.ciudadSel);
    if (this.puestoSel) scope = scope.filter(f => normalizarPuesto(f.c.puesto) === this.puestoSel);

    // Conteos por categoría para mostrarlos en los botones del filtro.
    this.countAptos = scope.filter(f => f.r.porcentaje >= this.UMBRAL_APTO).length;
    this.countNoAptos = scope.length - this.countAptos;
    this.countPracticantes = scope.filter(f => this.esPracticante(f.c)).length;

    // Aplicar el filtro por aptitud seleccionado.
    let lista = scope;
    if (this.filtro === 'aptos') lista = scope.filter(f => f.r.porcentaje >= this.UMBRAL_APTO);
    else if (this.filtro === 'noAptos') lista = scope.filter(f => f.r.porcentaje < this.UMBRAL_APTO);
    else if (this.filtro === 'practicantes') lista = scope.filter(f => this.esPracticante(f.c));

    // "Menos aptos": peor primero (ascendente) para que salten arriba;
    // en el resto, mejor primero (descendente) como siempre.
    const asc = this.filtro === 'noAptos';
    this.completos = lista.sort((a, b) =>
      asc ? a.r.porcentaje - b.r.porcentaje : b.r.porcentaje - a.r.porcentaje);
  }

  /** Cambia el filtro y reordena la lista. */
  setFiltro(f: 'todos' | 'aptos' | 'noAptos' | 'practicantes') {
    this.filtro = f;
    this.clasificar();
  }

  /**
   * Detecta practicantes por el texto del puesto (no hay un campo dedicado en
   * el sistema). Cubre "practicante", "prácticas", "becario" y "pasante".
   */
  private esPracticante(c: any): boolean {
    const p = (c?.puesto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    return p.includes('practic') || p.includes('becari') || p.includes('pasant');
  }

  // ====== Acciones ======

  abrirExpediente(f: FilaEval) {
    this.router.navigate(['/app/expediente', f.c.id]);
  }

  exportarExcel() {
    // Exporta exactamente lo que se está viendo (búsqueda + filtro + orden).
    const datos = this.completos
      .map(f => ({
        'Nombre': f.c.nombre || '',
        'Teléfono': f.c.telefono || '',
        'Puesto': f.c.puesto || '',
        'Ciudad / Sucursal': f.c.ciudad || f.c.sucursal || '',
        'Puntaje': f.r.puntaje,
        'Puntaje máximo': f.r.puntajeMax,
        'Porcentaje': f.r.porcentaje + '%',
        'Orientación a la tarea': f.r.puntajeTarea,
        'Orientación a las relaciones': f.r.puntajeRelaciones,
        'Estilo': f.r.estiloInfo.nombre,
        'Nivel': this.nivelLabel(f.r.nivel),
        'Fecha': this.formatearFecha(f.c.ultimaActividadCuestionario),
      }));
    const hoja = XLSX.utils.json_to_sheet(datos);
    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, hoja, 'Evaluaciones');
    XLSX.writeFile(libro, 'Resultados_Evaluacion_Liderazgo.xlsx');
  }

  // ====== Helpers ======

  nivelLabel(nivel: ResultadoCuestionario['nivel']): string {
    return {
      'destacado': 'Destacado',
      'solido': 'Sólido',
      'en-desarrollo': 'En desarrollo',
      'requiere-desarrollo': 'Requiere desarrollo',
      'sin-evaluar': 'Sin evaluar',
    }[nivel] || '—';
  }

  formatearFecha(timestamp: any): string {
    if (!timestamp) return '—';
    const d = typeof timestamp?.toDate === 'function' ? timestamp.toDate() : new Date(timestamp);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  getInitials(nombre: string): string {
    if (!nombre) return '?';
    return nombre.trim().split(/\s+/).slice(0, 2).map(p => p.charAt(0).toUpperCase()).join('');
  }
}
