import { Component, inject, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { CandidateService } from '../../core/services/candidate';
import {
  calcularResultadoLiderazgo, ResultadoCuestionario
} from '../../core/models/cuestionario-liderazgo.model';
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

  completos: FilaEval[] = [];   // ya contestaron las 12 (filtrado por búsqueda)
  termino = '';

  // Totales globales (sin filtrar)
  totalCompletos = 0;
  totalEnProgreso = 0;
  promedio = 0;    // % promedio de los que completaron

  private unsub: any;

  ngOnInit() {
    this.unsub = this.candidateService.listenToCandidates(datos => {
      this.ngZone.run(() => {
        this.todos = datos;
        this.clasificar();
        this.cargando = false;
      });
    });
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

    const t = this.termino.trim().toLowerCase();
    const coincide = (c: any) => !t
      || (c.nombre || '').toLowerCase().includes(t)
      || (c.puesto || '').toLowerCase().includes(t)
      || (c.ciudad || c.sucursal || '').toLowerCase().includes(t);

    this.completos = completos
      .filter(f => coincide(f.c))
      .sort((a, b) => b.r.porcentaje - a.r.porcentaje);
  }

  // ====== Acciones ======

  abrirExpediente(f: FilaEval) {
    this.router.navigate(['/app/expediente', f.c.id]);
  }

  exportarExcel() {
    const datos = this.todos
      .map(c => ({ c, r: calcularResultadoLiderazgo(c.cuestionarioLiderazgo) }))
      .filter(f => f.r.contestadas === f.r.total && f.r.total > 0)
      .sort((a, b) => b.r.porcentaje - a.r.porcentaje)
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
