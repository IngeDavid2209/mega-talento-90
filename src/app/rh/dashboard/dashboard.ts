import { Component, inject, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { AsistenciaResumenComponent } from '../asistencia-resumen/asistencia-resumen';
// "¿Qué pasó hoy?": quién se postuló y quién cambió de fase. Componente aparte
// porque se pide al API por su cuenta y no depende de la carga del panel.
import { NovedadesDiaComponent } from '../novedades/novedades';
import { CandidateService } from '../../core/services/candidate';
import { ETAPAS, ID_ETAPAS } from '../../core/models/proceso.model';
import { normalizarCiudad, normalizarPuesto } from '../../core/models/normalizacion.model';
import { CapitalHumanoService } from '../../core/services/capital-humano.service';
import { KpiService } from '../../core/services/kpi.service';
import {
  nivelSeguimiento, diasSinSeguimiento, esActivoEnProceso,
  SEGUIMIENTO_AVISO_DIAS, SEGUIMIENTO_CRITICO_DIAS, NivelSeguimiento
} from '../../core/models/seguimiento.model';
import { RequisicionesService, ResumenRequisiciones, Requisicion } from '../../core/services/requisiciones.service';
import { centroChecadorPorId } from '../../core/models/sucursales.model';
import { esReingreso, seLePregunto, detalleReingreso } from '../../core/models/reingreso.model';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, AsistenciaResumenComponent, NovedadesDiaComponent],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css'
})
export class DashboardComponent implements OnInit, OnDestroy {
  private candidateService = inject(CandidateService);
  private ngZone = inject(NgZone);
  private router = inject(Router);
  private kpi = inject(KpiService);
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

  // KPI de tiempo por fase (a partir del historial de transiciones)
  fasesProceso: {
    id: string; title: string; color: string; n: number; avgHoras: number; slaHoras: number;
    label: string; metaLabel: string; dentro: boolean; pct: number; conDatos: boolean;
  }[] = [];
  kpiFasesTotal = 0;

  // Fuentes
  fuentes: { nombre: string; total: number; contratados: number; efectividad: number }[] = [];

  // Desglose por zona (ciudad) y por puesto
  porZona: { nombre: string; total: number; activos: number; contratados: number; pct: number; candidatos: any[] }[] = [];
  porPuesto: { nombre: string; total: number; activos: number; contratados: number; pct: number; candidatos: any[] }[] = [];

  // Mapa "texto tal como se capturó" -> grupo canónico, que devuelve el bot.
  // Vacío mientras no responda: entonces se usa la normalización local, que
  // une menos pero nunca deja la pantalla en blanco.
  private mapaPuesto: Record<string, string | null> = {};
  private mapaZona: Record<string, string | null> = {};
  // Textos que el bot dictamino que NO contestan la pregunta ("Cualquiera",
  // "Si", un nombre, un correo). Se juntan todos en el mismo cubo en vez de
  // darle un renglon a cada uno: un renglon por cada no-respuesta ensucia el
  // tablero sin informar nada.
  private invalidoPuesto = new Set<string>();
  private invalidoZona = new Set<string>();
  // Los grupos que SI son una vacante abierta. Lo que no este aqui es gente
  // que se postulo a algo que no tenemos, y va en su propia seccion: mezclarlo
  // con las vacantes hace que una familia como "Sistemas" se lea como si
  // fuera un puesto que existe.
  private vacantesAbiertas = new Set<string>();

  // Se postularon a algo que no tenemos abierto.
  sinVacante: { nombre: string; total: number; activos: number; contratados: number; pct: number; candidatos: any[] }[] = [];

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

  // Handle del listener de Firestore para poder cerrarlo al salir de la vista.
  // Sin esto se acumulaba un onSnapshot a TODA la colección en cada visita al
  // dashboard (nunca se liberaban), degradando la app progresivamente.
  private unsubscribeFn: (() => void) | null = null;

  // ── Requisiciones abiertas ────────────────────────────────────────
  //
  // El panel ya decía cuánta gente hay en proceso, pero no cuánta gente están
  // PIDIENDO las sucursales. Sin eso, "8 en aptitudes" no dice si vamos bien o
  // mal: depende de si hay 2 requisiciones esperando o 20.
  private requisicionesService = inject(RequisicionesService);
  requis: ResumenRequisiciones | null = null;
  requisError = false;

  async cargarRequisiciones() {
    try {
      this.requis = await this.requisicionesService.resumen();
    } catch {
      // El panel completo no se cae por esto: se muestra el aviso y ya.
      this.requisError = true;
    }
  }

  irARequisiciones() { this.router.navigate(['/app/requisiciones']); }

  /** "Vencida hace 2 días" / "Para hoy" / "Faltan 3 días" */
  urgenciaRequis(r: Requisicion): string {
    const d = r.diasParaFecha;
    if (d === null) return `${r.diasEsperando} día(s) esperando`;
    if (d < 0) return `Vencida hace ${Math.abs(d)} día(s)`;
    if (d === 0) return 'Para hoy';
    if (d === 1) return 'Para mañana';
    return `Faltan ${d} día(s)`;
  }

  /** El id de sucursal no se le enseña a nadie: se traduce al nombre real. */
  sucursalRequis(id: string | null): string {
    if (!id) return 'sin sucursal';
    const s = centroChecadorPorId(id);
    return s ? `${s.ciudad}${s.direccion ? ' · ' + s.direccion.split(',')[0] : ''}` : id;
  }

  nivelRequis(r: Requisicion): string {
    const d = r.diasParaFecha;
    if (d === null) return r.diasEsperando > 7 ? 'atencion' : 'bien';
    if (d < 0) return 'tarde';
    if (d <= 1) return 'atencion';
    return 'bien';
  }

  async ngOnInit() {
    this.cargarRequisiciones();
    this.unsubscribeFn = this.candidateService.listenToCandidates(datos => {
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

    // KPI de tiempo por fase (historial de transiciones).
    this.cargarKpiFases();
  }

  /** Carga el KPI de tiempo por fase y lo cruza con las etapas y su SLA. */
  async cargarKpiFases() {
    try {
      const r = await this.candidateService.getKpiFases();
      const porEtapa = new Map(r.fases.map(f => [f.etapa, f]));
      this.fasesProceso = ETAPAS.map(e => {
        const f = porEtapa.get(e.id);
        const avg = f?.avgHoras || 0;
        const sla = (e as any).slaHoras || 0;
        return {
          id: e.id, title: e.title, color: e.color,
          n: f?.n || 0, avgHoras: avg, slaHoras: sla,
          label: this.formatHoras(avg), metaLabel: this.formatHoras(sla),
          dentro: !f || avg <= sla, conDatos: !!f,
          pct: sla > 0 ? Math.min(100, Math.round((avg / sla) * 100)) : 0
        };
      });
      this.kpiFasesTotal = r.total;
    } catch (e) {
      console.warn('No se pudo cargar el KPI de fases:', e);
    }
  }

  /** Horas → etiqueta legible (min / h / días). */
  formatHoras(h: number): string {
    if (!h || h <= 0) return '—';
    if (h < 1) return `${Math.round(h * 60)} min`;
    if (h < 48) return `${Math.round(h)} h`;
    return `${(h / 24).toFixed(1)} d`;
  }

  ngOnDestroy() {
    if (this.unsubscribeFn) { this.unsubscribeFn(); this.unsubscribeFn = null; }
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
    this.porZona = this.agruparPor(c => this.grupoZona(c.ciudad || c.sucursal), 'Sin ciudad');
    this.porPuesto = this.agruparPor(c => this.grupoPuesto(c.puesto), 'Sin puesto');
    this.separarSinVacante();

    this.calcularSinSeguimiento(ahora);
    this.calcularReingresos();

    // Y en segundo plano, que el bot una las variantes de escritura.
    void this.afinarAgrupacion();
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
   * El grupo de un puesto/ciudad: primero lo que dijo el bot, y si de ahí no
   * vino nada, la normalización local de siempre.
   *
   * El fallback importa: si el bot está caído o todavía no contesta, el
   * tablero se ve como antes en vez de quedarse vacío. Y un null del mapa
   * significa "no supe clasificarlo", no "agrúpalo con los demás": se
   * conserva la etiqueta original para no inventar un dato.
   */
  private grupoPuesto(raw: any): string {
    const t = (raw || '').toString().trim();
    if (this.mapaPuesto[t]) return this.mapaPuesto[t] as string;
    if (this.invalidoPuesto.has(t)) return 'Sin puesto';
    return normalizarPuesto(t);
  }

  private grupoZona(raw: any): string {
    const t = (raw || '').toString().trim();
    if (this.mapaZona[t]) return this.mapaZona[t] as string;
    if (this.invalidoZona.has(t)) return 'Sin ciudad';
    return normalizarCiudad(t);
  }

  /**
   * Le pide al bot que una las variantes de escritura y vuelve a agrupar.
   *
   * Se hace DESPUÉS de pintar, no antes: el tablero aparece de inmediato con
   * la normalización local y se reacomoda solo cuando llega el mapa. Si el
   * bot falla, no pasa nada — no se toca lo que ya se ve.
   */
  /**
   * Separa "candidatos por puesto" de "se postularon a algo que no tenemos".
   *
   * Mientras el bot no conteste, vacantesAbiertas esta vacio y NO se separa
   * nada: se prefiere una lista junta a mandar a la seccion equivocada gente
   * que si tiene vacante. Y "Sin puesto" se queda arriba: no es que no
   * tengamos la vacante, es que esa persona no dijo cual queria.
   */
  // ====== YA TRABAJARON CON NOSOTROS ======
  //
  // Lo pidió Capital Humano tras un caso concreto: alguien que estuvo unas
  // semanas en Yurécuaro se volvió a postular y solo se detectó porque una
  // persona lo reconoció. Un reingreso no es malo por sí solo —hay quien se fue
  // bien y vuelve— pero hay que MIRARLO antes de avanzarlo, no enterarse
  // después.
  //
  // La regla de quién cuenta como reingreso vive en core/models/reingreso.model
  // y la comparte con el expediente: dos copias terminarían diciendo cosas
  // distintas de la misma persona.
  reingresos: any[] = [];
  // Cuántos NUNCA contestaron la pregunta. Se muestra a fuerza: sin ese
  // denominador, "3 reingresos" se lee como "solo 3 ex-empleados se
  // postularon", cuando la verdad es "3 de los 77 a los que preguntamos".
  sinPreguntar = 0;

  private calcularReingresos() {
    this.reingresos = this.candidatos
      .filter(c => esReingreso(c.reingreso))
      .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
    this.sinPreguntar = this.candidatos.filter(c => !seLePregunto(c.reingreso)).length;
  }

  /** Lo que contestó, listo para leer. */
  detalleReingreso(c: any): string { return detalleReingreso(c?.reingreso); }

  private separarSinVacante() {
    if (!this.vacantesAbiertas.size) { this.sinVacante = []; return; }
    const abierto = (n: string) => this.vacantesAbiertas.has(n) || n === 'Sin puesto';
    this.sinVacante = this.porPuesto.filter(g => !abierto(g.nombre));
    this.porPuesto = this.porPuesto.filter(g => abierto(g.nombre));
    // Las barras se releen contra el grupo mas grande de CADA lista, si no la
    // seccion chica sale con todas las barras en un hilo.
    for (const lista of [this.porPuesto, this.sinVacante]) {
      const max = lista.reduce((m, x) => Math.max(m, x.total), 0);
      lista.forEach(x => { x.pct = max > 0 ? Math.round((x.total / max) * 100) : 0; });
    }
  }
  private async afinarAgrupacion() {
    const puestos = Array.from(new Set(this.candidatos.map(c => (c.puesto || '').toString().trim()).filter(Boolean)));
    const zonas = Array.from(new Set(this.candidatos.map(c => (c.ciudad || c.sucursal || '').toString().trim()).filter(Boolean)));
    if (!puestos.length && !zonas.length) return;
    try {
      const [p, z] = await Promise.all([
        puestos.length ? this.kpi.agrupar('puesto', puestos) : Promise.resolve({ mapa: {}, invalidos: [], vacantes: [], pendientes: 0 }),
        zonas.length ? this.kpi.agrupar('zona', zonas) : Promise.resolve({ mapa: {}, invalidos: [], vacantes: [], pendientes: 0 }),
      ]);
      this.mapaPuesto = p.mapa || {};
      this.mapaZona = z.mapa || {};
      this.invalidoPuesto = new Set(p.invalidos || []);
      this.invalidoZona = new Set(z.invalidos || []);
      this.vacantesAbiertas = new Set(p.vacantes || []);
      this.porZona = this.agruparPor(c => this.grupoZona(c.ciudad || c.sucursal), 'Sin ciudad');
      this.porPuesto = this.agruparPor(c => this.grupoPuesto(c.puesto), 'Sin puesto');
      this.separarSinVacante();
    } catch (e) {
      console.warn('[dashboard] no se pudo afinar la agrupación; se deja la local', e);
    }
  }
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
