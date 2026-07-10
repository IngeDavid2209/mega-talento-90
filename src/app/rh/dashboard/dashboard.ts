import { Component, inject, OnInit, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { CandidateService } from '../../core/services/candidate';
import { ETAPAS, ID_ETAPAS } from '../../core/models/proceso.model';
import { normalizarCiudad, normalizarPuesto } from '../../core/models/normalizacion.model';
import { CapitalHumanoService } from '../../core/services/capital-humano.service';
import {
  nivelSeguimiento, diasSinSeguimiento, esActivoEnProceso,
  SEGUIMIENTO_AVISO_DIAS, SEGUIMIENTO_CRITICO_DIAS, NivelSeguimiento
} from '../../core/models/seguimiento.model';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css'
})
export class DashboardComponent implements OnInit {
  private candidateService = inject(CandidateService);
  private ngZone = inject(NgZone);
  private router = inject(Router);
  // Público para que el template use displayName() en las listas desplegables
  capitalHumano = inject(CapitalHumanoService);

  ETAPAS = ETAPAS;
  ID_ETAPAS = ID_ETAPAS;

  cargando = true;
  candidatos: any[] = [];
  candidatosRecientes: any[] = [];

  // Ventana de "Solicitudes recientes" (cambiar aquí si se quiere otro período)
  private readonly DIAS_RECIENTES = 30;

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

  // Desglose por zona (ciudad) y por puesto
  porZona: { nombre: string; total: number; activos: number; contratados: number; pct: number; candidatos: any[] }[] = [];
  porPuesto: { nombre: string; total: number; activos: number; contratados: number; pct: number; candidatos: any[] }[] = [];

  // Filas desplegadas (drill-down) en cada panel
  zonaAbierta = new Set<string>();
  puestoAbierto = new Set<string>();

  // Candidatos activos sin seguimiento (abandonados) — alimenta el banner de alerta
  sinSeguimiento: any[] = [];
  sinSeguimientoAvisos = 0;
  sinSeguimientoCriticos = 0;
  mostrarSinSeguimiento = false;
  readonly AVISO_DIAS = SEGUIMIENTO_AVISO_DIAS;
  readonly CRITICO_DIAS = SEGUIMIENTO_CRITICO_DIAS;

  async ngOnInit() {
    this.candidateService.listenToCandidates(datos => {
      this.ngZone.run(() => {
        this.candidatos = datos;
        this.calcularKpis();
        this.cargando = false;
      });
    });

    // Backfill único del índice de teléfonos: protege contra repostulación a
    // los candidatos que ya existían antes de crear el índice. Se corre una
    // sola vez por navegador de RH (guarda en localStorage).
    this.backfillIndiceTelefonos();
  }

  private async backfillIndiceTelefonos() {
    const CLAVE = 'backfillTelefonos_v1';
    try {
      if (localStorage.getItem(CLAVE)) return;
      const n = await this.candidateService.backfillTelefonos();
      localStorage.setItem(CLAVE, new Date().toISOString());
      console.info(`Índice de teléfonos actualizado: ${n} registros.`);
    } catch (e) {
      console.warn('No se pudo actualizar el índice de teléfonos:', e);
    }
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

    // Desglose por zona (ciudad) y por puesto — con etiquetas normalizadas
    // para unir variantes equivalentes (p.ej. "Cajero (a)" y "Cajero(a)").
    this.porZona = this.agruparPor(c => normalizarCiudad(c.ciudad || c.sucursal), 'Sin ciudad');
    this.porPuesto = this.agruparPor(c => normalizarPuesto(c.puesto), 'Sin puesto');

    this.calcularSinSeguimiento(ahora);
  }

  /**
   * Candidatos ACTIVOS que llevan días sin que RH los toque. Ordena primero los
   * más abandonados. Alimenta el banner de alerta que presiona a dar seguimiento.
   */
  private calcularSinSeguimiento(ahora: Date) {
    const lista = this.candidatos
      .filter(c => esActivoEnProceso(c) && nivelSeguimiento(c, ahora) !== 'ok')
      .sort((a, b) => diasSinSeguimiento(b, ahora) - diasSinSeguimiento(a, ahora));
    this.sinSeguimiento = lista;
    this.sinSeguimientoCriticos = lista.filter(c => nivelSeguimiento(c, ahora) === 'critico').length;
    this.sinSeguimientoAvisos = lista.length - this.sinSeguimientoCriticos;
    // Si ya no queda nada pendiente, colapsa el detalle
    if (lista.length === 0) this.mostrarSinSeguimiento = false;
  }

  toggleSinSeguimiento() {
    this.mostrarSinSeguimiento = !this.mostrarSinSeguimiento;
  }

  diasSinSeguimiento(c: any): number { return diasSinSeguimiento(c); }
  nivelSeguimiento(c: any): NivelSeguimiento { return nivelSeguimiento(c); }

  /**
   * Agrupa los candidatos por una clave (zona o puesto) y cuenta total,
   * activos (en proceso) y contratados. El pct es relativo al grupo más
   * grande para que las barras se lean bien. Ordena de mayor a menor volumen.
   */
  private agruparPor(claveFn: (c: any) => string, fallback: string) {
    const map = new Map<string, { total: number; activos: number; contratados: number; candidatos: any[] }>();
    this.candidatos.forEach(c => {
      const clave = claveFn(c) || fallback;
      if (!map.has(clave)) map.set(clave, { total: 0, activos: 0, contratados: 0, candidatos: [] });
      const o = map.get(clave)!;
      o.total++;
      o.candidatos.push(c);
      if (c.status === ID_ETAPAS.CONTRATADO) o.contratados++;
      else if (c.status !== ID_ETAPAS.RECHAZADO) o.activos++;
    });
    const arr = Array.from(map.entries()).map(([nombre, v]) => ({ nombre, ...v, pct: 0 }));
    const max = arr.reduce((m, x) => Math.max(m, x.total), 0);
    arr.forEach(x => {
      x.pct = max > 0 ? Math.round((x.total / max) * 100) : 0;
      // Candidatos del grupo, más recientes primero
      x.candidatos.sort((a: any, b: any) => {
        const da = a.createdAt?.toDate?.() || new Date(a.createdAt || 0);
        const db = b.createdAt?.toDate?.() || new Date(b.createdAt || 0);
        return db.getTime() - da.getTime();
      });
    });
    return arr.sort((a, b) => b.total - a.total);
  }

  toggleZona(nombre: string) {
    if (this.zonaAbierta.has(nombre)) this.zonaAbierta.delete(nombre);
    else this.zonaAbierta.add(nombre);
  }

  togglePuesto(nombre: string) {
    if (this.puestoAbierto.has(nombre)) this.puestoAbierto.delete(nombre);
    else this.puestoAbierto.add(nombre);
  }

  abrirExpediente(c: any) {
    this.router.navigate(['/app/expediente', c.id]);
  }

  getInitials(nombre: string): string {
    if (!nombre) return '?';
    return nombre.trim().split(/\s+/).slice(0, 2).map(p => p.charAt(0).toUpperCase()).join('');
  }

  getColorEtapa(id: string): string {
    return ETAPAS.find(e => e.id === id)?.color || '#94a3b8';
  }

  getNombreEtapa(id: string): string {
    return ETAPAS.find(e => e.id === id)?.title || id || 'Sin estatus';
  }

  formatearFecha(timestamp: any): string {
    if (!timestamp) return 'S/F';
    const d = typeof timestamp.toDate === 'function' ? timestamp.toDate() : new Date(timestamp);
    return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
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
}
