import { Component, inject, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { CandidateService } from '../../core/services/candidate';
import { PuestosService, Puesto } from '../../core/services/puestos.service';
import { ID_ETAPAS, ETAPAS } from '../../core/models/proceso.model';
import { normalizarPuesto } from '../../core/models/normalizacion.model';
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
