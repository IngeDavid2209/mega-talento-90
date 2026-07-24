import { Component, inject, OnInit, OnDestroy, OnChanges, SimpleChanges, Input, Output, EventEmitter, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import * as XLSX from 'xlsx';
import { ChecadorService, RevisionDia, EstadoRevision } from '../../core/services/checador.service';
import { Checada, Empleado, HorarioArea, aFechaLocal } from '../../core/models/checador.model';
import { CENTROS_CHECADOR, centroChecadorPorId } from '../../core/models/sucursales.model';
import { ToastService } from '../../core/services/toast.service';
import { SucursalSelectComponent } from '../ui/sucursal-select/sucursal-select';

/** Un día del empleado, ya desglosado en entrada / comida / salida y su retardo. */
interface DiaAsistencia {
  fecha: string; diaLabel: string;
  entrada: string; comida: string; salida: string; horasNetas: string; retardoMin: number;
  falta: boolean;              // día laboral sin ninguna checada
  justificacion: string;       // capturada por RH (se guarda en la base)
  estado: EstadoRevision;      // verificación: pendiente/verificada/aprobada/rechazada
}
/** Una semana (miércoles → martes) con su acumulado vs la tolerancia. */
interface SemanaAsistencia {
  inicio: string; label: string; acumulado: number; excedido: boolean; dias: DiaAsistencia[];
}
/** Un empleado con todo su periodo desglosado. */
interface EmpleadoAsistencia {
  codigo: string; nombre: string; fotoUrl: string; puesto: string; registrado: boolean;
  acumuladoTotal: number; semanasExcedidas: number; diasConRetardo: number; diasRegistrados: number;
  faltas: number; horasTrabajadas: number; presupuesto: number; semanas: SemanaAsistencia[];
}

/**
 * Vista consolidada de asistencia para el dashboard: se elige sucursal y un
 * rango (Desde/Hasta) y se muestra a TODOS los empleados de esa sucursal con su
 * desglose día por día (entrada/comida/salida/retardo), agrupado por semana.
 * Hace UNA sola llamada de checadas por rango y agrupa localmente.
 */
@Component({
  selector: 'app-asistencia-resumen',
  standalone: true,
  imports: [CommonModule, FormsModule, SucursalSelectComponent],
  templateUrl: './asistencia-resumen.html',
  styleUrl: './asistencia-resumen.css'
})
export class AsistenciaResumenComponent implements OnInit, OnDestroy, OnChanges {
  private checador = inject(ChecadorService);
  private ngZone = inject(NgZone);
  private toast = inject(ToastService);

  /** Si se pasa desde fuera, manda la sucursal (y se oculta el selector propio). */
  @Input() sucursalIdExterna?: string;
  /** Oculta el selector de sucursal propio (cuando lo controla la página padre). */
  @Input() ocultarSucursal = false;
  /** Muestra el botón "Importar archivo del reloj" en la barra (lo maneja el padre). */
  @Input() permitirImportar = false;
  /** Estado de importación (para el texto del botón). */
  @Input() importando = false;
  /** Cambiar este número fuerza una recarga (p. ej. tras una importación). */
  @Input() recargarToken = 0;
  /** Emite el evento del <input file> para que el padre procese el archivo. */
  @Output() archivo = new EventEmitter<Event>();

  SUCURSALES = CENTROS_CHECADOR;

  // Catálogos para el detalle
  ESTADOS: { v: EstadoRevision; l: string }[] = [
    { v: 'pendiente', l: 'Pendiente' },
    { v: 'verificada', l: 'Verificada' },
    { v: 'aprobada', l: 'Aprobada' },
    { v: 'rechazada', l: 'Rechazada' }
  ];
  JUSTIFICACIONES = ['Cita Médica', 'Tráfico', 'Personal', 'Permiso', 'Incapacidad', 'No Registrada'];

  sucursalFiltro = CENTROS_CHECADOR[0]?.id || '';
  desde = '';
  hasta = '';

  private empleados: Empleado[] = [];
  private horarios: HorarioArea[] = [];

  lista: EmpleadoAsistencia[] = [];
  cargando = false;

  // Detalle (modal) del empleado seleccionado
  detalle: EmpleadoAsistencia | null = null;

  // Datos para las gráficas laterales
  dist = { aTiempo: 0, retardo: 0, falta: 0 };
  semanasChart: { label: string; corto: string; min: number }[] = [];

  private unsubEmpleados: any;
  private unsubHorarios: any;

  ngOnInit() {
    const hoy = new Date();
    const hace30 = new Date();
    hace30.setDate(hoy.getDate() - 29);
    this.hasta = aFechaLocal(hoy);
    this.desde = aFechaLocal(hace30);

    if (this.sucursalIdExterna) this.sucursalFiltro = this.sucursalIdExterna;

    this.unsubEmpleados = this.checador.escucharEmpleados(lista => {
      this.ngZone.run(() => { this.empleados = lista; if (!this.cargando) this.reconstruirDesdeCache(); });
    });
    this.unsubHorarios = this.checador.escucharHorarios(lista => {
      this.ngZone.run(() => { this.horarios = lista; if (!this.cargando) this.reconstruirDesdeCache(); });
    });

    this.ajustarRangoYCargar();
  }

  ngOnChanges(cambios: SimpleChanges) {
    // La página padre cambió la sucursal: sincroniza y recarga.
    if (cambios['sucursalIdExterna'] && !cambios['sucursalIdExterna'].firstChange) {
      const nueva = this.sucursalIdExterna || '';
      if (nueva && nueva !== this.sucursalFiltro) {
        this.sucursalFiltro = nueva;
        this.ajustarRangoYCargar();
      }
    }
    // El padre pidió recargar (p. ej. tras importar un archivo).
    if (cambios['recargarToken'] && !cambios['recargarToken'].firstChange) {
      this.ajustarRangoYCargar();
    }
  }

  // ---- KPIs del periodo ----
  get retardoAcumulado(): number { return this.lista.reduce((s, e) => s + e.acumuladoTotal, 0); }
  get faltasTotales(): number { return this.lista.reduce((s, e) => s + e.faltas, 0); }

  ngOnDestroy() {
    if (this.unsubEmpleados) this.unsubEmpleados();
    if (this.unsubHorarios) this.unsubHorarios();
  }

  get empleadosFiltrados(): Empleado[] {
    return this.empleados.filter(e => e.sucursalId === this.sucursalFiltro);
  }

  onSucursalChange() { this.ajustarRangoYCargar(); }

  /** Ajusta el rango a los últimos 30 días CON datos de la sucursal, luego carga. */
  async ajustarRangoYCargar() {
    if (!this.sucursalFiltro) { this.lista = []; return; }
    try {
      const r = await this.checador.getRangoChecadas(this.sucursalFiltro);
      if (r.max) {
        const max = new Date(r.max + 'T00:00:00');
        const desde = new Date(max); desde.setDate(max.getDate() - 29);
        const min = r.min ? new Date(r.min + 'T00:00:00') : desde;
        this.hasta = aFechaLocal(max);
        this.desde = aFechaLocal(desde < min ? min : desde);
      }
    } catch { /* si falla, se queda el rango por defecto */ }
    this.cargar();
  }

  private ultimasChecadas: Checada[] = [];

  async cargar() {
    if (!this.sucursalFiltro || !this.desde || !this.hasta) { this.lista = []; return; }
    this.cargando = true;
    try {
      this.ultimasChecadas = await this.checador.getChecadas(this.sucursalFiltro, this.desde, this.hasta);
      this.lista = this.construir(this.ultimasChecadas);
      this.computarGraficas();
    } catch (e) {
      console.error('Error al cargar asistencia:', e);
      this.toast.error('No se pudieron cargar las checadas.');
      this.lista = [];
    } finally {
      this.cargando = false;
    }
  }

  /** Recalcula la vista con las checadas ya en memoria (al llegar empleados/horarios frescos). */
  private reconstruirDesdeCache() {
    if (this.ultimasChecadas.length || this.empleadosFiltrados.length) {
      this.lista = this.construir(this.ultimasChecadas);
      this.computarGraficas();
    }
  }

  /** Agrega los datos de las gráficas laterales a partir de la lista ya calculada. */
  private computarGraficas() {
    const dist = { aTiempo: 0, retardo: 0, falta: 0 };
    const semMap = new Map<string, { label: string; corto: string; min: number; ini: string }>();
    for (const e of this.lista) {
      for (const s of e.semanas) {
        if (!semMap.has(s.inicio)) {
          const corto = s.label.split('→')[0].trim().replace('Semana:', '').trim();
          semMap.set(s.inicio, { label: s.label, corto, min: 0, ini: s.inicio });
        }
        semMap.get(s.inicio)!.min += s.acumulado;
        for (const d of s.dias) {
          if (d.falta) dist.falta++;
          else if (d.retardoMin > 0) dist.retardo++;
          else dist.aTiempo++;
        }
      }
    }
    this.dist = dist;
    this.semanasChart = Array.from(semMap.values())
      .sort((a, b) => (a.ini < b.ini ? -1 : 1))
      .map(s => ({ label: s.label, corto: s.corto, min: s.min }));
  }

  // ------- Construcción del desglose -------

  private construir(checadas: Checada[]): EmpleadoAsistencia[] {
    // Agrupa las marcas por código de empleado.
    const porCodigo = new Map<string, Checada[]>();
    for (const c of checadas) {
      const cod = String(c.empleadoCodigo).trim();
      if (!porCodigo.has(cod)) porCodigo.set(cod, []);
      porCodigo.get(cod)!.push(c);
    }

    // Base de empleados: los registrados en la sucursal + los que aparecen en
    // las checadas pero no están dados de alta (para no perderlos).
    const registrados = this.empleadosFiltrados;
    const codigosRegistrados = new Set(registrados.map(e => String(e.codigoChecador).trim()));
    const filas: EmpleadoAsistencia[] = [];

    for (const e of registrados) {
      const cod = String(e.codigoChecador).trim();
      filas.push(this.calcularEmpleado(cod, e.nombre, e.fotoUrl || '', e.puesto || '', true, porCodigo.get(cod) || []));
    }
    for (const [cod, marcas] of porCodigo) {
      if (codigosRegistrados.has(cod)) continue;
      const nombre = marcas.find(m => m.empleadoNombre)?.empleadoNombre || '';
      filas.push(this.calcularEmpleado(cod, nombre, '', '', false, marcas));
    }

    // Primero los que tienen retardo (mayor acumulado arriba), luego el resto por nombre.
    filas.sort((a, b) => {
      if ((b.acumuladoTotal > 0 ? 1 : 0) !== (a.acumuladoTotal > 0 ? 1 : 0)) {
        return (b.acumuladoTotal > 0 ? 1 : 0) - (a.acumuladoTotal > 0 ? 1 : 0);
      }
      if (b.acumuladoTotal !== a.acumuladoTotal) return b.acumuladoTotal - a.acumuladoTotal;
      return (a.nombre || a.codigo).localeCompare(b.nombre || b.codigo);
    });
    return filas;
  }

  private calcularEmpleado(
    codigo: string, nombre: string, fotoUrl: string, puesto: string,
    registrado: boolean, marcas: Checada[]
  ): EmpleadoAsistencia {
    const areaId = marcas.find(m => m.areaId)?.areaId;
    const hor = this.horarioAplicable(this.sucursalFiltro, areaId, this.hasta);
    const base = hor ? this.minutos(hor.entrada) : -1;
    const presupuesto = hor?.toleranciaMin ?? 15;

    const porFecha = new Map<string, Checada[]>();
    for (const c of marcas) {
      if (!porFecha.has(c.fecha)) porFecha.set(c.fecha, []);
      porFecha.get(c.fecha)!.push(c);
    }

    // Semanas (mié→mar) que tienen al menos una checada. Dentro de cada una se
    // muestran los 6 días LABORALES (se salta el domingo); un día laboral sin
    // ninguna marca se marca como "Falta".
    const semanasConDatos = new Set<string>();
    for (const f of porFecha.keys()) semanasConDatos.add(aFechaLocal(this.inicioSemana(f)));

    const desdeD = new Date(this.desde + 'T00:00:00');
    const hastaD = new Date(this.hasta + 'T00:00:00');

    const porSemana = new Map<string, SemanaAsistencia>();
    let acumTotal = 0, conRet = 0, diasReg = 0, faltas = 0, segTrab = 0;
    for (const claveIni of Array.from(semanasConDatos).sort()) {
      const inicio = new Date(claveIni + 'T00:00:00');
      const dias: DiaAsistencia[] = [];
      let acumSem = 0;
      for (let i = 0; i < 7; i++) {
        const dd = new Date(inicio); dd.setDate(inicio.getDate() + i);
        if (dd.getDay() === 0) continue;                 // domingo = descanso, no se muestra
        if (dd < desdeD || dd > hastaD) continue;        // fuera del rango consultado
        const f = aFechaLocal(dd);
        const marcasDia = porFecha.get(f);
        if (marcasDia && marcasDia.length) {
          marcasDia.sort((a, b) => (a.fechaHora < b.fechaHora ? -1 : 1));
          const des = this.desglosarDia(marcasDia);
          let rm = 0;
          const pMin = this.minutos(des.entrada);
          if (base >= 0 && pMin >= 0) rm = Math.max(0, pMin - base);
          acumTotal += rm; diasReg++; acumSem += rm;
          if (rm > 0) conRet++;
          // Horas del día: brutas (salida − entrada) y netas (menos la comida).
          const eSeg = this.minSeg(des.entrada), sSeg = this.minSeg(des.salida);
          let netasStr = '—';
          if (eSeg >= 0 && sSeg > eSeg) {
            const bruto = sSeg - eSeg;
            segTrab += bruto;
            let neto = bruto;
            const cm = /(\d{1,2}:\d{2}:?\d{0,2})\s*[–-]\s*(\d{1,2}:\d{2}:?\d{0,2})/.exec(des.comida || '');
            if (cm) { const a = this.minSeg(cm[1]), b = this.minSeg(cm[2]); if (b > a) neto -= (b - a); }
            netasStr = this.formatHoras(neto);
          }
          dias.push({ fecha: f, diaLabel: this.etiquetaDia(f), entrada: des.entrada, comida: des.comida, salida: des.salida, horasNetas: netasStr, retardoMin: rm, falta: false, justificacion: '', estado: 'pendiente' });
        } else {
          // Día laboral sin checada = Falta (no suma minutos de retardo).
          faltas++;
          dias.push({ fecha: f, diaLabel: this.etiquetaDia(f), entrada: '—', comida: '—', salida: '—', horasNetas: '—', retardoMin: 0, falta: true, justificacion: '', estado: 'pendiente' });
        }
      }
      if (!dias.length) continue;
      porSemana.set(claveIni, { inicio: claveIni, label: this.etiquetaSemana(inicio), acumulado: acumSem, excedido: false, dias });
    }

    const semanas = Array.from(porSemana.values()).sort((a, b) => (a.inicio < b.inicio ? -1 : 1));
    let semExc = 0;
    for (const s of semanas) { s.excedido = s.acumulado > presupuesto; if (s.excedido) semExc++; }

    return {
      codigo, nombre: nombre || '(sin registrar)', fotoUrl, puesto, registrado,
      acumuladoTotal: acumTotal, semanasExcedidas: semExc, diasConRetardo: conRet,
      diasRegistrados: diasReg, faltas, horasTrabajadas: Math.round(segTrab / 360) / 10,
      presupuesto, semanas
    };
  }

  // ------- Helpers de cálculo (mismos criterios que el módulo Horarios) -------

  private horarioAplicable(sucursalId: string, areaId: string | undefined, fecha: string): HorarioArea | null {
    const dow = new Date(fecha + 'T00:00:00').getDay();
    const activos = this.horarios.filter(h =>
      h.activo && h.sucursalId === sucursalId && Array.isArray(h.dias) && h.dias.includes(dow));
    if (!activos.length) return null;
    if (areaId) {
      const delArea = activos.find(h => h.areaId === areaId);
      if (delArea) return delArea;
    }
    return activos.find(h => !h.areaId) || activos[0];
  }

  private minutos(hhmm: string): number {
    const m = /^(\d{1,2}):(\d{2})/.exec(hhmm || '');
    if (!m) return -1;
    return (+m[1]) * 60 + (+m[2]);
  }
  private minSeg(hhmmss: string): number {
    const m = /^(\d{1,2}):(\d{2}):?(\d{2})?/.exec(hhmmss || '');
    if (!m) return -1;
    return (+m[1]) * 3600 + (+m[2]) * 60 + (+(m[3] || 0));
  }

  /** Separa las marcas en entrada / comida / salida, colapsando dobles-checadas (<2 min). */
  private desglosarDia(marcas: Checada[]): { entrada: string; comida: string; salida: string } {
    const horas = marcas.map(m => m.hora).filter(Boolean).sort();
    const limpio: string[] = [];
    for (const h of horas) {
      const prev = limpio[limpio.length - 1];
      if (!prev || (this.minSeg(h) - this.minSeg(prev)) >= 120) limpio.push(h);
    }
    const entrada = limpio[0] || '—';
    const salida = limpio.length > 1 ? limpio[limpio.length - 1] : '—';
    let comida = '—';
    const medio = limpio.slice(1, -1);
    if (medio.length >= 2) comida = `${medio[0]} – ${medio[medio.length - 1]}`;
    else if (medio.length === 1) comida = medio[0];
    return { entrada, comida, salida };
  }

  private inicioSemana(fecha: string): Date {
    const d = new Date(fecha + 'T00:00:00');
    const off = (d.getDay() - 3 + 7) % 7; // días desde el miércoles
    d.setDate(d.getDate() - off);
    return d;
  }
  private etiquetaSemana(inicio: Date): string {
    const fin = new Date(inicio); fin.setDate(inicio.getDate() + 6);
    const f = (x: Date) => x.toLocaleDateString('es-MX', { weekday: 'short', day: '2-digit', month: 'short' });
    return `${f(inicio)} → ${f(fin)}`;
  }
  private etiquetaDia(fecha: string): string {
    const d = new Date(fecha + 'T00:00:00');
    return d.toLocaleDateString('es-MX', { weekday: 'short', day: '2-digit', month: 'short' });
  }

  // ------- Presentación / acciones -------

  nombreSucursal(id: string): string {
    const s = centroChecadorPorId(id);
    if (!s) return id || '—';
    return s.direccion ? `${s.ciudad} · ${s.direccion.split(',')[0]}` : s.ciudad;
  }
  iniciales(nombre: string): string {
    if (!nombre) return '?';
    return nombre.trim().split(/\s+/).slice(0, 2).map(p => p.charAt(0).toUpperCase()).join('');
  }

  get totalConRetardo(): number { return this.lista.filter(e => e.acumuladoTotal > 0).length; }
  get horasTotales(): number { return Math.round(this.lista.reduce((s, e) => s + e.horasTrabajadas, 0)); }

  // Detalle en modal: al abrir, carga las revisiones (justificación/estado) del empleado.
  async abrir(e: EmpleadoAsistencia) {
    this.detalle = e;
    try {
      const revs = await this.checador.getRevisiones(this.sucursalFiltro, e.codigo, this.desde, this.hasta);
      const map = new Map(revs.map(r => [r.fecha, r]));
      for (const s of e.semanas) for (const d of s.dias) {
        const r = map.get(d.fecha);
        d.justificacion = r?.justificacion || '';
        d.estado = (r?.estado as EstadoRevision) || 'pendiente';
      }
    } catch (err) { console.warn('No se pudieron cargar las revisiones:', err); }
  }
  cerrar() { this.detalle = null; }

  /** Guarda (upsert) la justificación/estado de un día. */
  async guardarRevisionDia(d: DiaAsistencia) {
    if (!this.detalle) return;
    try {
      await this.checador.guardarRevision({
        sucursalId: this.sucursalFiltro, empleadoCodigo: this.detalle.codigo,
        fecha: d.fecha, justificacion: d.justificacion || '', estado: d.estado
      });
    } catch (err) {
      console.error(err);
      this.toast.error('No se pudo guardar la revisión.');
    }
  }

  estadoLabel(e: EstadoRevision): string { return this.ESTADOS.find(x => x.v === e)?.l || e; }

  /** Segundos → 'Hh Mm'. */
  private formatHoras(seg: number): string {
    if (seg <= 0) return '—';
    const h = Math.floor(seg / 3600), m = Math.floor((seg % 3600) / 60);
    return `${h}h ${String(m).padStart(2, '0')}m`;
  }

  // % de días a tiempo (para la barra de la tarjeta)
  pctATiempo(e: EmpleadoAsistencia): number {
    if (!e.diasRegistrados) return 0;
    return Math.round(((e.diasRegistrados - e.diasConRetardo) / e.diasRegistrados) * 100);
  }

  // ---- Gráficas: dona de distribución (conic-gradient) y barras por semana ----
  get distTotal(): number { return this.dist.aTiempo + this.dist.retardo + this.dist.falta; }
  distPct(n: number): number { return this.distTotal ? Math.round((n / this.distTotal) * 100) : 0; }
  get donutStyle(): string {
    const t = this.distTotal || 1;
    const a = (this.dist.aTiempo / t) * 100;
    const r = (this.dist.retardo / t) * 100;
    return `conic-gradient(var(--green) 0 ${a}%, var(--red) ${a}% ${a + r}%, var(--gold) ${a + r}% 100%)`;
  }
  get barMax(): number { return Math.max(1, ...this.semanasChart.map(s => s.min)); }
  barPct(min: number): number { return Math.round((min / this.barMax) * 100); }

  exportarExcel() {
    const filas: any[] = [];
    for (const e of this.lista) {
      for (const s of e.semanas) {
        for (const d of s.dias) {
          filas.push({
            'Empleado': e.nombre, 'Código': e.codigo, 'Puesto': e.puesto,
            'Semana': s.label, 'Fecha': d.fecha, 'Día': d.diaLabel,
            'Entrada': d.entrada, 'Comida': d.comida, 'Salida': d.salida, 'Horas netas': d.horasNetas,
            'Retardo (min)': d.falta ? 0 : d.retardoMin,
            'Estado': d.falta ? 'Falta' : (d.retardoMin > 0 ? 'Retardo' : 'A tiempo')
          });
        }
      }
    }
    if (!filas.length) { this.toast.alerta('No hay asistencia para exportar en este rango.'); return; }
    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(filas), 'Asistencia');
    const suc = this.nombreSucursal(this.sucursalFiltro).replace(/\s+/g, '_');
    XLSX.writeFile(libro, `Asistencia_${suc}_${this.desde}_a_${this.hasta}.xlsx`);
  }
}
