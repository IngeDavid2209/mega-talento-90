import { Component, inject, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { CandidateService } from '../../core/services/candidate';
import { PuestosService, Puesto } from '../../core/services/puestos.service';
import { ID_ETAPAS, ETAPAS } from '../../core/models/proceso.model';
import { normalizarPuesto, normalizarCiudad } from '../../core/models/normalizacion.model';
import {
  FilaConcentrado, puntuarCandidato, compararFilas
} from '../../core/models/concentrado.model';
import { diasSinSeguimiento, nivelSeguimiento, NivelSeguimiento } from '../../core/models/seguimiento.model';

interface GrupoPuesto {
  nombre: string;             // nombre canónico del puesto (vacante activa)
  vacante: Puesto;
  filas: FilaConcentrado[];   // candidatos ya rankeados
  total: number;
}

interface GrupoCiudad {
  ciudad: string;
  filas: FilaConcentrado[];
  total: number;
}

@Component({
  selector: 'app-concentrado',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './concentrado.html',
  styleUrl: './concentrado.css'
})
export class ConcentradoComponent implements OnInit, OnDestroy {
  private candidateService = inject(CandidateService);
  private puestosService = inject(PuestosService);
  private ngZone = inject(NgZone);
  private router = inject(Router);

  ETAPAS = ETAPAS;

  cargando = true;
  candidatos: any[] = [];
  vacantesActivas: Puesto[] = [];

  grupos: GrupoPuesto[] = [];
  // Candidatos que quedaron fuera porque su puesto no tiene vacante activa
  excluidosSinVacante = 0;
  totalConsiderados = 0;

  // ---- KPIs (panel superior) ----
  funnel: { label: string; n: number }[] = [];
  funnelMax = 1;

  // Detalle de una etapa del embudo (candidatos en esa etapa)
  etapaAbierta: number | null = null;
  etapaNombre = '';
  candidatosEtapa: any[] = [];
  private consideradosCache: any[] = [];
  tiempoPromedio = 0;                        // días promedio en proceso
  calidadPorPuesto: { nombre: string; score: number }[] = [];
  calidadMax = 1;
  estado = { enProceso: 0, contratados: 0, descartados: 0 };
  estadoTotal = 0;

  // Top candidatos (tarjetas) y resto
  topCandidatos: FilaConcentrado[] = [];
  topRestantes = 0;
  private readonly TOP_TARJETAS = 8;

  // Listado de abajo agrupado por ciudad
  gruposCiudad: GrupoCiudad[] = [];
  ciudadesExpandidas = new Set<string>();
  topPorCiudad = 8;

  // Cuántos mostrar por puesto (Top N). El resto queda plegado.
  topPorPuesto = 5;
  puestosExpandidos = new Set<string>();

  fechaReporte = new Date();
  // Texto formateado con Intl nativo (el locale es-MX no está registrado en
  // Angular, así que el pipe `date:'...':'es-MX'` tronaría en runtime).
  fechaReporteTexto = this.fechaReporte.toLocaleDateString('es-MX', {
    day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });

  private unsubCand: any;
  private unsubPuestos: any;

  ngOnInit() {
    this.unsubCand = this.candidateService.listenToCandidates(datos => {
      this.ngZone.run(() => {
        this.candidatos = datos;
        this.recalcular();
        this.cargando = false;
      });
    });
    this.unsubPuestos = this.puestosService.listar(
      lista => this.ngZone.run(() => {
        this.vacantesActivas = lista.filter(p => p.activo);
        this.recalcular();
      }),
      () => this.ngZone.run(() => { this.cargando = false; })
    );
  }

  ngOnDestroy() {
    if (this.unsubCand) this.unsubCand();
    if (this.unsubPuestos) this.unsubPuestos();
  }

  private recalcular() {
    if (!this.vacantesActivas.length) { this.grupos = []; return; }
    const hoy = new Date();

    // Candidatos considerados: vivos y NO rechazados (incluye contratados).
    const considerados = this.candidatos.filter(c => c.status !== ID_ETAPAS.RECHAZADO);

    // Índice de puestos con vacante activa, por nombre canónico.
    const clavesActivas = new Map<string, Puesto>();
    for (const v of this.vacantesActivas) {
      clavesActivas.set(normalizarPuesto(v.nombre), v);
    }

    const buckets = new Map<string, FilaConcentrado[]>();
    let excluidos = 0;
    for (const c of considerados) {
      const clave = normalizarPuesto(c.puesto);
      if (!clavesActivas.has(clave)) { excluidos++; continue; }
      if (!buckets.has(clave)) buckets.set(clave, []);
      buckets.get(clave)!.push(puntuarCandidato(c, hoy));
    }
    this.excluidosSinVacante = excluidos;

    const dias = (c: any) => {
      const d = diasSinSeguimiento(c);
      return d < 0 ? 0 : d;
    };

    this.grupos = Array.from(clavesActivas.entries())
      .map(([clave, vacante]) => {
        const filas = (buckets.get(clave) || []).sort((a, b) => compararFilas(a, b, dias));
        return { nombre: vacante.nombre, vacante, filas, total: filas.length };
      })
      // Puestos con candidatos primero, luego los que no tienen ninguno.
      .sort((a, b) => b.total - a.total || a.nombre.localeCompare(b.nombre));

    this.totalConsiderados = considerados.length;
    this.calcularKpis(considerados, hoy, dias);
  }

  /** Calcula el panel de KPIs (embudo, tiempo, calidad por puesto, estado). */
  private calcularKpis(considerados: any[], hoy: Date, dias: (c: any) => number) {
    this.consideradosCache = considerados;
    // Embudo: cuántos han ALCANZADO cada etapa (usando el status actual como
    // proxy del avance máximo). Recibidos = todos; Contratados = solo contratados.
    const idx = (status: string) =>
      status === ID_ETAPAS.CONTRATADO ? ETAPAS.length : ETAPAS.findIndex(e => e.id === status);
    const reached = (k: number) => considerados.filter(c => idx(c.status) >= k).length;
    const contratados = considerados.filter(c => c.status === ID_ETAPAS.CONTRATADO).length;
    this.funnel = [
      { label: 'Recibidos', n: considerados.length },
      { label: ETAPAS[1]?.shortLabel || 'Conductual', n: reached(1) },
      { label: ETAPAS[2]?.shortLabel || 'Aptitudes', n: reached(2) },
      { label: ETAPAS[3]?.shortLabel || 'Psicom.', n: reached(3) },
      { label: 'Contratados', n: contratados }
    ];
    this.funnelMax = Math.max(1, this.funnel[0].n);

    // Tiempo promedio en proceso (días desde el alta).
    let suma = 0, cuenta = 0;
    for (const c of considerados) {
      if (!c.createdAt) continue;
      const f = typeof c.createdAt.toDate === 'function' ? c.createdAt.toDate() : new Date(c.createdAt);
      const d = Math.floor((hoy.getTime() - f.getTime()) / 86400000);
      if (d >= 0) { suma += d; cuenta++; }
    }
    this.tiempoPromedio = cuenta ? Math.round(suma / cuenta) : 0;

    // Calidad por puesto: promedio de evaluación (solo evaluados) de los 4 puestos con más candidatos.
    this.calidadPorPuesto = this.grupos.filter(g => g.total > 0).slice(0, 4).map(g => {
      const evs = g.filas.filter(f => !f.evaluacion.sinEvaluar);
      const score = evs.length ? Math.round(evs.reduce((a, f) => a + f.evaluacion.score, 0) / evs.length) : 0;
      return { nombre: g.nombre, score };
    });
    this.calidadMax = Math.max(1, ...this.calidadPorPuesto.map(c => c.score));

    // Estado de candidatos (todos, no solo considerados).
    const enProceso = this.candidatos.filter(c => c.status !== ID_ETAPAS.CONTRATADO && c.status !== ID_ETAPAS.RECHAZADO).length;
    const descartados = this.candidatos.filter(c => c.status === ID_ETAPAS.RECHAZADO).length;
    const contratadosAll = this.candidatos.filter(c => c.status === ID_ETAPAS.CONTRATADO).length;
    this.estado = { enProceso, contratados: contratadosAll, descartados };
    this.estadoTotal = enProceso + contratadosAll + descartados;

    // Top candidatos (tarjetas): los mejores de todos los puestos.
    const todas = this.grupos.flatMap(g => g.filas);
    const rankeadas = todas.slice().sort((a, b) => compararFilas(a, b, dias));
    this.topCandidatos = rankeadas.slice(0, this.TOP_TARJETAS);
    this.topRestantes = Math.max(0, todas.length - this.topCandidatos.length);

    // Listado de abajo agrupado por ciudad/sucursal.
    const porCiudad = new Map<string, FilaConcentrado[]>();
    for (const f of rankeadas) {
      const ciudad = normalizarCiudad(f.candidato.ciudad || f.candidato.sucursal) || 'Sin ciudad';
      if (!porCiudad.has(ciudad)) porCiudad.set(ciudad, []);
      porCiudad.get(ciudad)!.push(f);
    }
    this.gruposCiudad = Array.from(porCiudad.entries())
      .map(([ciudad, filas]) => ({ ciudad, filas, total: filas.length }))
      .sort((a, b) => b.total - a.total || a.ciudad.localeCompare(b.ciudad));
  }

  filasVisiblesCiudad(g: GrupoCiudad): FilaConcentrado[] {
    return this.ciudadesExpandidas.has(g.ciudad) ? g.filas : g.filas.slice(0, this.topPorCiudad);
  }
  hayMasCiudad(g: GrupoCiudad): boolean {
    return g.filas.length > this.topPorCiudad && !this.ciudadesExpandidas.has(g.ciudad);
  }
  toggleCiudad(ciudad: string) {
    if (this.ciudadesExpandidas.has(ciudad)) this.ciudadesExpandidas.delete(ciudad);
    else this.ciudadesExpandidas.add(ciudad);
  }

  /** Abre la lista de candidatos que están en (o han alcanzado) la etapa del embudo. */
  abrirEtapa(i: number) {
    const idx = (status: string) =>
      status === ID_ETAPAS.CONTRATADO ? ETAPAS.length : ETAPAS.findIndex(e => e.id === status);
    let filtro: (c: any) => boolean;
    if (i === 0) filtro = () => true;                                   // Recibidos
    else if (i === this.funnel.length - 1) filtro = c => c.status === ID_ETAPAS.CONTRATADO; // Contratados
    else filtro = c => idx(c.status) >= i;                              // alcanzaron esta etapa
    this.candidatosEtapa = this.consideradosCache
      .filter(filtro)
      .sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
    this.etapaAbierta = i;
    this.etapaNombre = this.funnel[i]?.label || '';
  }
  cerrarEtapa() { this.etapaAbierta = null; this.candidatosEtapa = []; }

  abrirExpedienteId(c: any) { this.router.navigate(['/app/expediente', c.id]); }

  // Ancho de barra del embudo (%).
  funnelPct(n: number): number { return Math.max(6, Math.round((n / this.funnelMax) * 100)); }
  // Altura de barra de calidad (%).
  calidadPct(score: number): number { return Math.max(4, Math.round((score / this.calidadMax) * 100)); }

  /** Dona de estado (conic-gradient). */
  get estadoDonut(): string {
    const t = this.estadoTotal || 1;
    const a = (this.estado.enProceso / t) * 100;
    const b = (this.estado.contratados / t) * 100;
    return `conic-gradient(var(--ink) 0 ${a}%, var(--green) ${a}% ${a + b}%, var(--red) ${a + b}% 100%)`;
  }

  /** Color del gauge por puntaje. */
  scoreColorVar(score: number, sinEvaluar = false): string {
    if (sinEvaluar) return 'var(--border-med)';
    if (score >= 80) return 'var(--green)';
    if (score >= 60) return 'var(--gold)';
    return 'var(--red)';
  }
  /** Anillo del gauge (conic-gradient) para la tarjeta. */
  gaugeStyle(score: number, sinEvaluar = false): string {
    const col = this.scoreColorVar(score, sinEvaluar);
    const pct = sinEvaluar ? 0 : score;
    return `conic-gradient(${col} ${pct}%, var(--surface2) 0)`;
  }

  // ====== UI helpers ======
  filasVisibles(g: GrupoPuesto): FilaConcentrado[] {
    if (this.puestosExpandidos.has(g.nombre)) return g.filas;
    return g.filas.slice(0, this.topPorPuesto);
  }

  hayMas(g: GrupoPuesto): boolean {
    return g.filas.length > this.topPorPuesto && !this.puestosExpandidos.has(g.nombre);
  }

  toggleExpandir(nombre: string) {
    if (this.puestosExpandidos.has(nombre)) this.puestosExpandidos.delete(nombre);
    else this.puestosExpandidos.add(nombre);
  }

  totalCandidatosEnConcentrado(): number {
    return this.grupos.reduce((a, g) => a + g.total, 0);
  }

  abrirExpediente(f: FilaConcentrado) {
    this.router.navigate(['/app/expediente', f.candidato.id]);
  }

  esContratado(f: FilaConcentrado): boolean {
    return f.candidato.status === ID_ETAPAS.CONTRATADO;
  }

  nombreEtapa(status: string): string {
    if (status === ID_ETAPAS.CONTRATADO) return 'Contratado';
    return ETAPAS.find(e => e.id === status)?.shortLabel
      || ETAPAS.find(e => e.id === status)?.title
      || 'En proceso';
  }

  colorEtapa(status: string): string {
    if (status === ID_ETAPAS.CONTRATADO) return 'var(--green)';
    return ETAPAS.find(e => e.id === status)?.color || 'var(--slate)';
  }

  /** Clase de color para el número de puntaje (verde/ámbar/rojo). */
  claseScore(score: number, sinEvaluar = false): string {
    if (sinEvaluar) return 'sin-dato';
    if (score >= 80) return 'alto';
    if (score >= 60) return 'medio';
    return 'bajo';
  }

  seguimiento(c: any): NivelSeguimiento { return nivelSeguimiento(c); }
  dias(c: any): number { const d = diasSinSeguimiento(c); return d < 0 ? 0 : d; }

  getInitials(nombre: string): string {
    if (!nombre) return '?';
    return nombre.trim().split(/\s+/).slice(0, 2).map(p => p.charAt(0).toUpperCase()).join('');
  }

  imprimir() {
    window.print();
  }
}
