import { Component, inject, OnInit, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CandidateService } from '../../core/services/candidate';
import { ETAPAS, ID_ETAPAS } from '../../core/models/proceso.model';

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
  porZona: { nombre: string; total: number; activos: number; contratados: number; pct: number }[] = [];
  porPuesto: { nombre: string; total: number; activos: number; contratados: number; pct: number }[] = [];

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

    // Desglose por zona (ciudad) y por puesto
    this.porZona = this.agruparPor(c => (c.ciudad || c.sucursal || '').toString().trim(), 'Sin ciudad');
    this.porPuesto = this.agruparPor(c => (c.puesto || '').toString().trim(), 'Sin puesto');
  }

  /**
   * Agrupa los candidatos por una clave (zona o puesto) y cuenta total,
   * activos (en proceso) y contratados. El pct es relativo al grupo más
   * grande para que las barras se lean bien. Ordena de mayor a menor volumen.
   */
  private agruparPor(claveFn: (c: any) => string, fallback: string) {
    const map = new Map<string, { total: number; activos: number; contratados: number }>();
    this.candidatos.forEach(c => {
      const clave = claveFn(c) || fallback;
      if (!map.has(clave)) map.set(clave, { total: 0, activos: 0, contratados: 0 });
      const o = map.get(clave)!;
      o.total++;
      if (c.status === ID_ETAPAS.CONTRATADO) o.contratados++;
      else if (c.status !== ID_ETAPAS.RECHAZADO) o.activos++;
    });
    const arr = Array.from(map.entries()).map(([nombre, v]) => ({ nombre, ...v, pct: 0 }));
    const max = arr.reduce((m, x) => Math.max(m, x.total), 0);
    arr.forEach(x => (x.pct = max > 0 ? Math.round((x.total / max) * 100) : 0));
    return arr.sort((a, b) => b.total - a.total);
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
