import { Component, inject, OnInit, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CandidateService } from '../../core/services/candidate';
import { ETAPAS, ID_ETAPAS } from '../../core/models/proceso.model';
import { urlWhatsApp } from '../../core/models/puestos.model';
import * as XLSX from 'xlsx';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css'
})
export class DashboardComponent implements OnInit {
  private candidateService = inject(CandidateService);
  private ngZone = inject(NgZone);

  ETAPAS = ETAPAS;
  ID_ETAPAS = ID_ETAPAS;

  cargando = true;
  candidatos: any[] = [];
  candidatosRecientes: any[] = [];
  candidatosFiltrados: any[] = [];
  terminoBusqueda = '';

  // Ventana de "Solicitudes recientes" (cambiar aquí si se quiere otro período)
  private readonly DIAS_RECIENTES = 14;

  // KPIs maestros
  kpiTotal = 0;
  kpiNuevosRecientes = 0;
  kpiActivos = 0;
  kpiContratados = 0;
  kpiContratadosMes = 0;
  kpiTiempoCobertura = 0;          // días promedio creación -> contratado
  kpiTasaAprobados = 0;            // % candidatos no rechazados
  kpiCostoPorContratacion = 0;     // (placeholder)
  kpiRetencion7 = 0;
  kpiRetencion30 = 0;

  // Distribución por etapa
  distribucionEtapas: { id: string; title: string; count: number; icon: string; color: string; pct: number }[] = [];

  // Fuentes
  fuentes: { nombre: string; total: number; contratados: number; efectividad: number }[] = [];

  async ngOnInit() {
    this.candidateService.listenToCandidates(datos => {
      this.ngZone.run(() => {
        this.candidatos = datos;
        this.calcularKpis();
        this.armarTabla();
        this.cargando = false;
      });
    });
  }

  calcularKpis() {
    const ahora = new Date();
    const msVentana = this.DIAS_RECIENTES * 24 * 3600 * 1000;

    this.kpiTotal = this.candidatos.length;
    this.candidatosRecientes = this.candidatos.filter(c => {
      if (!c.createdAt) return false;
      const f = typeof c.createdAt.toDate === 'function' ? c.createdAt.toDate() : new Date(c.createdAt);
      return ahora.getTime() - f.getTime() <= msVentana;
    });
    this.kpiNuevosRecientes = this.candidatosRecientes.length;

    const contratados = this.candidatos.filter(c => c.status === ID_ETAPAS.CONTRATADO);
    const rechazados = this.candidatos.filter(c => c.status === ID_ETAPAS.RECHAZADO);
    this.kpiContratados = contratados.length;
    this.kpiContratadosMes = contratados.filter(c => {
      if (!c.hiredAt) return false;
      const f = typeof c.hiredAt.toDate === 'function' ? c.hiredAt.toDate() : new Date(c.hiredAt);
      return f.getMonth() === ahora.getMonth() && f.getFullYear() === ahora.getFullYear();
    }).length;

    this.kpiActivos = this.candidatos.filter(c =>
      c.status !== ID_ETAPAS.CONTRATADO && c.status !== ID_ETAPAS.RECHAZADO
    ).length;

    // Tiempo de cobertura (días promedio entre createdAt y hiredAt)
    let dias = 0, n = 0;
    contratados.forEach(c => {
      if (!c.createdAt || !c.hiredAt) return;
      const ini = typeof c.createdAt.toDate === 'function' ? c.createdAt.toDate() : new Date(c.createdAt);
      const fin = typeof c.hiredAt.toDate === 'function' ? c.hiredAt.toDate() : new Date(c.hiredAt);
      dias += Math.ceil((fin.getTime() - ini.getTime()) / 86400000);
      n++;
    });
    this.kpiTiempoCobertura = n > 0 ? Math.round(dias / n) : 0;

    // % aprobados (avanzaron sin descarte)
    this.kpiTasaAprobados = this.kpiTotal > 0
      ? Math.round(((this.kpiTotal - rechazados.length) / this.kpiTotal) * 100)
      : 0;

    // Retención 7 y 30 días
    const r7 = this.calcularRetencion(contratados, 7);
    const r30 = this.calcularRetencion(contratados, 30);
    this.kpiRetencion7 = r7;
    this.kpiRetencion30 = r30;

    // Distribución embudo
    this.distribucionEtapas = ETAPAS.map(e => {
      const count = this.candidatos.filter(c => c.status === e.id).length;
      return {
        id: e.id,
        title: e.title,
        icon: e.icon,
        color: e.color,
        count,
        pct: this.kpiTotal > 0 ? Math.round((count / this.kpiTotal) * 100) : 0
      };
    });

    // Efectividad por fuente
    const mapFuentes = new Map<string, { total: number; contratados: number }>();
    this.candidatos.forEach(c => {
      const f = (c.fuente || 'Sin fuente').toString();
      if (!mapFuentes.has(f)) mapFuentes.set(f, { total: 0, contratados: 0 });
      const obj = mapFuentes.get(f)!;
      obj.total++;
      if (c.status === ID_ETAPAS.CONTRATADO) obj.contratados++;
    });
    this.fuentes = Array.from(mapFuentes.entries())
      .map(([nombre, v]) => ({
        nombre,
        total: v.total,
        contratados: v.contratados,
        efectividad: v.total > 0 ? Math.round((v.contratados / v.total) * 100) : 0
      }))
      .sort((a, b) => b.total - a.total);
  }

  /** Retención: contratados que llevan >= N días desde hiredAt y siguen como contratados */
  calcularRetencion(contratados: any[], dias: number): number {
    const hoy = new Date();
    const elegibles = contratados.filter(c => {
      if (!c.hiredAt) return false;
      const f = typeof c.hiredAt.toDate === 'function' ? c.hiredAt.toDate() : new Date(c.hiredAt);
      return (hoy.getTime() - f.getTime()) / 86400000 >= dias;
    });
    if (elegibles.length === 0) return 0;
    const retenidos = elegibles.filter(c => c.status === ID_ETAPAS.CONTRATADO && !c.bajaAt).length;
    return Math.round((retenidos / elegibles.length) * 100);
  }

  armarTabla() {
    this.candidatosRecientes.sort((a: any, b: any) => {
      const da = a.createdAt?.toDate?.() || new Date(a.createdAt || 0);
      const db = b.createdAt?.toDate?.() || new Date(b.createdAt || 0);
      return db.getTime() - da.getTime();
    });
    this.candidatosFiltrados = [...this.candidatosRecientes];
  }

  filtrarCandidatos() {
    const t = this.terminoBusqueda.toLowerCase().trim();
    if (!t) {
      this.candidatosFiltrados = [...this.candidatosRecientes];
      return;
    }
    this.candidatosFiltrados = this.candidatosRecientes.filter((c: any) =>
      (c.nombre || '').toLowerCase().includes(t) ||
      (c.puesto || '').toLowerCase().includes(t) ||
      (c.ciudad || '').toLowerCase().includes(t)
    );
  }

  exportarExcel() {
    const datos = this.candidatosFiltrados.map(c => ({
      'Fecha': this.formatearFecha(c.createdAt),
      'Nombre': c.nombre,
      'Teléfono': c.telefono,
      'Ciudad': c.ciudad || c.sucursal || '',
      'Puesto': c.puesto,
      'Fuente': c.fuente || '',
      'Estatus': this.getNombreEtapa(c.status)
    }));
    const hoja = XLSX.utils.json_to_sheet(datos);
    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, hoja, 'Candidatos');
    XLSX.writeFile(libro, 'Reporte_MegaTalento.xlsx');
  }

  getNombreEtapa(id: string): string {
    return ETAPAS.find(e => e.id === id)?.title || id || 'Sin estatus';
  }

  formatearFecha(timestamp: any): string {
    if (!timestamp) return 'S/F';
    const d = typeof timestamp.toDate === 'function' ? timestamp.toDate() : new Date(timestamp);
    return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  contactarWhatsApp(c: any) {
    window.open(urlWhatsApp(c), '_blank');
  }

  async cambiarEstatus(idCandidato: string, event: any) {
    const nuevo = event.target.value;
    try {
      await this.candidateService.updateCandidate(idCandidato, { status: nuevo });
    } catch (e) {
      console.error('Error al cambiar estatus:', e);
    }
  }

  // Confirmación de borrado con modal propio (no el confirm() del navegador)
  candidatoAEliminar: any = null;
  borrando = false;

  pedirBorrar(c: any) {
    this.candidatoAEliminar = c;
  }

  cancelarBorrar() {
    this.candidatoAEliminar = null;
  }

  async confirmarBorrar() {
    if (!this.candidatoAEliminar) return;
    this.borrando = true;
    try {
      await this.candidateService.eliminarCandidato(this.candidatoAEliminar.id);
      this.candidatoAEliminar = null;
    } catch (e) {
      console.error('Error al eliminar candidato:', e);
    } finally {
      this.borrando = false;
    }
  }

  getInitials(nombre: string): string {
    if (!nombre) return '?';
    return nombre.trim().split(/\s+/).slice(0, 2).map(p => p.charAt(0).toUpperCase()).join('');
  }

  getColorEtapa(id: string): string {
    return ETAPAS.find(e => e.id === id)?.color || '#94a3b8';
  }
}
