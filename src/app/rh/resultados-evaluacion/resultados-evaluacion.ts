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
import * as XLSX from 'xlsx-js-style';

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
    // Exporta exactamente lo que se está viendo (búsqueda + filtro + orden),
    // con diseño corporativo: banner de título, encabezado navy, bordes,
    // filas alternadas, % como número y colores por nivel.
    const encabezados = [
      'Nombre', 'Teléfono', 'Puesto', 'Ciudad / Sucursal', 'Puntaje',
      'Puntaje máximo', 'Porcentaje', 'Orientación a la tarea',
      'Orientación a las relaciones', 'Estilo', 'Nivel', 'Fecha'
    ];
    const niveles = this.completos.map(f => f.r.nivel);
    const filas = this.completos.map(f => [
      f.c.nombre || '',
      (f.c.telefono || '').toString(),
      f.c.puesto || '',
      f.c.ciudad || f.c.sucursal || '',
      f.r.puntaje,
      f.r.puntajeMax,
      f.r.porcentaje / 100,               // fracción → se muestra como %
      f.r.puntajeTarea,
      f.r.puntajeRelaciones,
      f.r.estiloInfo.nombre,
      this.nivelLabel(f.r.nivel),
      this.formatearFecha(f.c.ultimaActividadCuestionario),
    ]);

    const NCOL = encabezados.length;
    const partes: string[] = [];
    if (this.filtro === 'aptos') partes.push('Más aptos');
    else if (this.filtro === 'noAptos') partes.push('Menos aptos');
    else if (this.filtro === 'practicantes') partes.push('Practicantes');
    if (this.ciudadSel) partes.push(this.ciudadSel);
    if (this.puestoSel) partes.push(this.puestoSel);
    const filtroTxt = partes.length ? partes.join(' · ') : 'Todos';
    const fechaGen = new Date().toLocaleDateString('es-MX', {
      day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
    const subtitulo = `Filtro: ${filtroTxt} · ${this.completos.length} candidato(s) · Generado ${fechaGen}`;

    const aoa: any[][] = [
      ['MEGA DULCES DE LOS ALTOS · Resultados de la evaluación de liderazgo'],
      [subtitulo],
      encabezados,
      ...filas
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);

    // Paleta / bordes
    const NAVY = '1A2F4E', WHITE = 'FFFFFF';
    const bd = { style: 'thin', color: { rgb: 'D9DEE7' } };
    const bordes = { top: bd, bottom: bd, left: bd, right: bd };
    const fill = (rgb: string) => ({ patternType: 'solid', fgColor: { rgb } });
    const nivelColor: Record<string, { bg: string; fg: string }> = {
      'destacado':            { bg: 'E6F2EC', fg: '0D4A2A' },
      'solido':               { bg: 'E0F2FE', fg: '0369A1' },
      'en-desarrollo':        { bg: 'F9EFD6', fg: '6B3D02' },
      'requiere-desarrollo':  { bg: 'FEE2E2', fg: 'B91C1C' },
      'sin-evaluar':          { bg: 'EEF2F8', fg: '4A5568' },
    };
    const colsNumericas = new Set([4, 5, 6, 7, 8]);

    for (let r = 0; r < aoa.length; r++) {
      for (let c = 0; c < NCOL; c++) {
        const ref = XLSX.utils.encode_cell({ r, c });
        if (!ws[ref]) ws[ref] = { t: 's', v: '' };
        if (r === 0) {
          ws[ref].s = { font: { bold: true, sz: 14, color: { rgb: WHITE } }, fill: fill(NAVY), alignment: { horizontal: 'left', vertical: 'center' }, border: { bottom: { style: 'medium', color: { rgb: 'E5A300' } } } };
        } else if (r === 1) {
          ws[ref].s = { font: { italic: true, sz: 10, color: { rgb: 'D9E2EF' } }, fill: fill(NAVY), alignment: { horizontal: 'left', vertical: 'center' } };
        } else if (r === 2) {
          ws[ref].s = { font: { bold: true, sz: 11, color: { rgb: WHITE } }, fill: fill(NAVY), alignment: { horizontal: 'center', vertical: 'center', wrapText: true }, border: bordes };
        } else {
          const filaDatos = r - 3;
          const zebra = filaDatos % 2 === 1;
          if (c === 10) {
            const nc = nivelColor[niveles[filaDatos]] || nivelColor['sin-evaluar'];
            ws[ref].s = { font: { bold: true, sz: 10, color: { rgb: nc.fg } }, fill: fill(nc.bg), alignment: { horizontal: 'center', vertical: 'center' }, border: bordes };
          } else {
            ws[ref].s = {
              font: { sz: 10, color: { rgb: '1A2F4E' } },
              fill: fill(zebra ? 'F4F6FA' : 'FFFFFF'),
              alignment: { horizontal: colsNumericas.has(c) ? 'center' : 'left', vertical: 'center' },
              border: bordes
            };
          }
          if (c === 6) ws[ref].z = '0%'; // porcentaje como número con formato %
        }
      }
    }

    // Anchos, alturas, celdas combinadas y autofiltro.
    // La fila de encabezado (índice 2) va más alta para que quepan los títulos
    // de dos líneas ("Orientación a la tarea", etc.) sin cortarse.
    ws['!cols'] = [28, 13, 20, 16, 9, 11, 12, 15, 16, 22, 17, 13].map(wch => ({ wch }));
    ws['!rows'] = [{ hpt: 30 }, { hpt: 18 }, { hpt: 40 }];
    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: NCOL - 1 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: NCOL - 1 } },
    ];
    const ultimaFila = 3 + this.completos.length; // fila Excel (1-based) del último dato
    ws['!autofilter'] = { ref: `A3:${XLSX.utils.encode_col(NCOL - 1)}${ultimaFila}` };

    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, ws, 'Evaluaciones');
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
