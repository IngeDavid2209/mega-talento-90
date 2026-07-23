import { Component, inject, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import * as XLSX from 'xlsx';
import { ChecadorService, ResultadoImportacion } from '../../core/services/checador.service';
import {
  AreaChecador, HorarioArea, Checada, Empleado,
  TIPOS_CHECADA, DIAS_SEMANA, aFechaLocal
} from '../../core/models/checador.model';
import { parsearTextoChecadas, parsearFilasExcel } from '../../core/models/parser-attlog';
import { CENTROS_CHECADOR, centroChecadorPorId } from '../../core/models/sucursales.model';
import { ToastService } from '../../core/services/toast.service';
import { subirACloudinary } from '../../core/services/cloudinary';
import { AsistenciaResumenComponent } from '../asistencia-resumen/asistencia-resumen';
import { SucursalSelectComponent } from '../ui/sucursal-select/sucursal-select';

type Tab = 'checadas' | 'horarios' | 'areas' | 'empleados';

/** Un empleado agrupado dentro de un día, con sus marcas y estado de retardo. */
interface GrupoEmpleado {
  empleadoCodigo: string;
  empleadoNombre: string;
  areaId?: string;
  marcas: Checada[];
  primera: string;
  ultima: string;
  retardo: boolean | null;   // null = sin horario aplicable para comparar
  minutosRetardo: number;
}

/** Las checadas de un día, agrupadas por empleado. */
interface GrupoDia {
  fecha: string;
  diaLabel: string;
  empleados: GrupoEmpleado[];
}

@Component({
  selector: 'app-horarios',
  standalone: true,
  imports: [CommonModule, FormsModule, AsistenciaResumenComponent, SucursalSelectComponent],
  templateUrl: './horarios.html',
  styleUrl: './horarios.css'
})
export class HorariosComponent implements OnInit, OnDestroy {
  private checador = inject(ChecadorService);
  private ngZone = inject(NgZone);
  private toast = inject(ToastService);

  // Catálogos / constantes para la vista (incluye centros internos como Corporativo)
  SUCURSALES = CENTROS_CHECADOR;
  DIAS_SEMANA = DIAS_SEMANA;
  TIPOS_CHECADA = TIPOS_CHECADA;

  tabActiva: Tab = 'checadas';

  // Filtros compartidos
  sucursalFiltro = CENTROS_CHECADOR[0]?.id || '';
  desde = '';
  hasta = '';

  // Datos en vivo
  areas: AreaChecador[] = [];
  horarios: HorarioArea[] = [];
  empleados: Empleado[] = [];

  // Checadas cargadas bajo demanda
  gruposChecadas: GrupoDia[] = [];
  cargandoChecadas = false;
  importando = false;
  importResumen: ResultadoImportacion | null = null;

  // Modales de edición (null = cerrado)
  areaEdit: AreaChecador | null = null;
  horarioEdit: HorarioArea | null = null;
  empleadoEdit: Empleado | null = null;

  private unsubAreas: any;
  private unsubHorarios: any;
  private unsubEmpleados: any;

  ngOnInit() {
    // Rango por defecto: últimos 15 días.
    const hoy = new Date();
    const hace15 = new Date();
    hace15.setDate(hoy.getDate() - 14);
    this.hasta = aFechaLocal(hoy);
    this.desde = aFechaLocal(hace15);

    this.unsubAreas = this.checador.escucharAreas(lista => {
      this.ngZone.run(() => this.areas = lista);
    });
    this.unsubHorarios = this.checador.escucharHorarios(lista => {
      this.ngZone.run(() => this.horarios = lista);
    });
    this.unsubEmpleados = this.checador.escucharEmpleados(lista => {
      this.ngZone.run(() => this.empleados = lista);
    });

    this.ajustarRangoYCargar();
  }

  ngOnDestroy() {
    if (this.unsubAreas) this.unsubAreas();
    if (this.unsubHorarios) this.unsubHorarios();
    if (this.unsubEmpleados) this.unsubEmpleados();
  }

  cambiarTab(t: Tab) {
    this.tabActiva = t;
  }

  // ===================== Listados filtrados por sucursal =====================

  get areasFiltradas(): AreaChecador[] {
    return this.areas.filter(a => !this.sucursalFiltro || a.sucursalId === this.sucursalFiltro);
  }
  get horariosFiltrados(): HorarioArea[] {
    return this.horarios.filter(h => !this.sucursalFiltro || h.sucursalId === this.sucursalFiltro);
  }
  get empleadosFiltrados(): Empleado[] {
    return this.empleados.filter(e => !this.sucursalFiltro || e.sucursalId === this.sucursalFiltro);
  }

  /** Áreas de una sucursal (para los selects de los modales). */
  areasDeSucursal(sucursalId: string): AreaChecador[] {
    return this.areas.filter(a => a.sucursalId === sucursalId);
  }

  // ===================== CHECADAS =====================

  async cargarChecadas() {
    if (!this.sucursalFiltro || !this.desde || !this.hasta) {
      this.gruposChecadas = [];
      return;
    }
    this.cargandoChecadas = true;
    try {
      const lista = await this.checador.getChecadas(this.sucursalFiltro, this.desde, this.hasta);
      this.gruposChecadas = this.agrupar(lista);
    } catch (e: any) {
      console.error('Error al cargar checadas:', e);
      if (e?.code === 'failed-precondition') {
        this.toast.error('Falta crear el índice de Firestore (sucursalId + fecha). Abre la consola del navegador (F12): Firebase incluye ahí el enlace para crearlo con un clic.', 'Índice pendiente');
      } else {
        this.toast.error('No se pudieron cargar las checadas.');
      }
      this.gruposChecadas = [];
    } finally {
      this.cargandoChecadas = false;
    }
  }

  onSucursalChange() {
    this.importResumen = null;
    this.ajustarRangoYCargar();
  }

  /** Ajusta el rango de la lista principal a los últimos 30 días CON DATOS de la sucursal. */
  async ajustarRangoYCargar() {
    if (!this.sucursalFiltro) { this.gruposChecadas = []; return; }
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
    this.cargarChecadas();
  }

  /** Selección del archivo del reloj (.dat/.txt/.csv o Excel). */
  onArchivoSeleccionado(event: any) {
    const file: File | undefined = event.target.files?.[0];
    if (!file) return;

    if (!this.sucursalFiltro) {
      this.toast.alerta('Primero elige una sucursal para asociar las checadas.');
      event.target.value = '';
      return;
    }

    const nombre = file.name.toLowerCase();
    const esExcel = nombre.endsWith('.xlsx') || nombre.endsWith('.xls');
    const reader = new FileReader();

    reader.onload = () => {
      this.ngZone.run(async () => {
        this.importando = true;
        try {
          const parseo = esExcel
            ? this.parsearExcel(reader.result as ArrayBuffer)
            : parsearTextoChecadas(reader.result as string);

          if (!parseo.filas.length) {
            this.toast.alerta(`No se encontraron checadas válidas en el archivo (${parseo.ignoradas} líneas ignoradas).`);
            return;
          }

          const empleados = this.empleados.length ? this.empleados : await this.checador.getEmpleados();
          const res = await this.checador.importarChecadas(this.sucursalFiltro, parseo.filas, empleados);
          this.importResumen = res;
          this.toast.exito(`Importación lista: ${res.nuevas} nuevas, ${res.duplicadas} duplicadas, ${res.sinEmpleado} sin empleado.`);
          await this.cargarChecadas();
        } catch (e: any) {
          console.error('Error al importar checadas:', e);
          this.toast.error('No se pudo importar el archivo. Revisa que sea el export del reloj (attlog.dat, CSV o Excel).');
        } finally {
          this.importando = false;
          event.target.value = '';
        }
      });
    };
    reader.onerror = () => this.toast.error('No se pudo leer el archivo.');

    if (esExcel) reader.readAsArrayBuffer(file);
    else reader.readAsText(file);
  }

  private parsearExcel(buffer: ArrayBuffer) {
    const data = new Uint8Array(buffer);
    const wb = XLSX.read(data, { type: 'array', cellDates: true });
    const hoja = wb.Sheets[wb.SheetNames[0]];
    const matriz = XLSX.utils.sheet_to_json(hoja, { header: 1, raw: true, defval: '' }) as any[][];
    return parsearFilasExcel(matriz);
  }

  exportarExcel() {
    const filas: any[] = [];
    for (const dia of this.gruposChecadas) {
      for (const emp of dia.empleados) {
        filas.push({
          'Fecha': dia.fecha,
          'Día': dia.diaLabel,
          'Código': emp.empleadoCodigo,
          'Empleado': emp.empleadoNombre || '(sin registrar)',
          'Área': emp.areaId ? this.nombreArea(emp.areaId) : '',
          'Primera marca': emp.primera,
          'Última marca': emp.ultima,
          'Marcas': emp.marcas.length,
          'Estado': emp.retardo === null ? 'Sin horario' : (emp.retardo ? `Retardo (+${emp.minutosRetardo} min)` : 'A tiempo')
        });
      }
    }
    if (!filas.length) {
      this.toast.alerta('No hay checadas para exportar en este rango.');
      return;
    }
    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(filas), 'Checadas');
    const suc = this.nombreSucursal(this.sucursalFiltro).replace(/\s+/g, '_');
    XLSX.writeFile(libro, `Checadas_${suc}_${this.desde}_a_${this.hasta}.xlsx`);
  }

  // ------- Agrupado y retardos -------

  private agrupar(lista: Checada[]): GrupoDia[] {
    const porFecha = new Map<string, Map<string, Checada[]>>();
    for (const c of lista) {
      if (!porFecha.has(c.fecha)) porFecha.set(c.fecha, new Map());
      const m = porFecha.get(c.fecha)!;
      if (!m.has(c.empleadoCodigo)) m.set(c.empleadoCodigo, []);
      m.get(c.empleadoCodigo)!.push(c);
    }

    const dias: GrupoDia[] = [];
    // Fechas de menor a mayor (más antigua arriba).
    const fechas = Array.from(porFecha.keys()).sort((a, b) => (a < b ? -1 : 1));
    for (const fecha of fechas) {
      const empMap = porFecha.get(fecha)!;
      const empleados: GrupoEmpleado[] = [];
      for (const [codigo, marcas] of empMap) {
        marcas.sort((a, b) => (a.fechaHora < b.fechaHora ? -1 : 1));
        const primera = marcas[0];
        const ultima = marcas[marcas.length - 1];
        const areaId = marcas.find(m => m.areaId)?.areaId;

        let retardo: boolean | null = null;
        let minutosRetardo = 0;
        const hor = this.horarioAplicable(primera.sucursalId, areaId, fecha);
        if (hor) {
          // Retardo diario = minutos EXACTOS de tardanza desde la hora de entrada
          // (9:03 con entrada 9:00 = 3 min). La tolerancia de 15 min es TOTAL por
          // semana (mié→mar); se acumula en el detalle del empleado.
          const base = this.minutos(hor.entrada);
          const primeraMin = this.minutos(primera.hora);
          if (base >= 0 && primeraMin >= 0) {
            minutosRetardo = Math.max(0, primeraMin - base);
            retardo = minutosRetardo > 0;
          }
        }

        empleados.push({
          empleadoCodigo: codigo,
          empleadoNombre: primera.empleadoNombre || '',
          areaId,
          marcas,
          primera: primera.hora,
          ultima: ultima.hora,
          retardo,
          minutosRetardo
        });
      }
      empleados.sort((a, b) =>
        (a.empleadoNombre || a.empleadoCodigo).localeCompare(b.empleadoNombre || b.empleadoCodigo));
      dias.push({ fecha, diaLabel: this.etiquetaDia(fecha), empleados });
    }
    return dias;
  }

  /** Horario que aplica: primero el del área, luego el general de la sucursal. */
  private horarioAplicable(sucursalId: string, areaId: string | undefined, fecha: string): HorarioArea | null {
    const dow = new Date(fecha + 'T00:00:00').getDay();
    const activos = this.horarios.filter(h =>
      h.activo && h.sucursalId === sucursalId && Array.isArray(h.dias) && h.dias.includes(dow));
    if (!activos.length) return null;
    if (areaId) {
      const delArea = activos.find(h => h.areaId === areaId);
      if (delArea) return delArea;
    }
    const general = activos.find(h => !h.areaId);
    return general || activos[0];
  }

  /** Minutos desde medianoche de una hora 'HH:mm[:ss]'. -1 si no parsea. */
  private minutos(hhmm: string): number {
    const m = /^(\d{1,2}):(\d{2})/.exec(hhmm || '');
    if (!m) return -1;
    return (+m[1]) * 60 + (+m[2]);
  }

  private etiquetaDia(fecha: string): string {
    const d = new Date(fecha + 'T00:00:00');
    return d.toLocaleDateString('es-MX', { weekday: 'short', day: '2-digit', month: 'short' });
  }

  // ===================== ÁREAS (CRUD) =====================

  nuevaArea() {
    this.areaEdit = {
      sucursalId: this.sucursalFiltro || CENTROS_CHECADOR[0].id,
      nombre: '', ipChecador: '', deviceId: '', activo: true
    };
  }
  editarArea(a: AreaChecador) {
    this.areaEdit = { ...a };
  }
  async guardarAreaModal() {
    if (!this.areaEdit) return;
    if (!this.areaEdit.nombre.trim() || !this.areaEdit.sucursalId) {
      this.toast.alerta('El área necesita nombre y sucursal.');
      return;
    }
    try {
      await this.checador.guardarArea(this.areaEdit);
      this.toast.exito('Área guardada.');
      this.areaEdit = null;
    } catch (e) {
      console.error(e);
      this.toast.error('No se pudo guardar el área.');
    }
  }
  async borrarArea(a: AreaChecador) {
    const ok = await this.toast.confirmar({
      titulo: 'Eliminar área',
      mensaje: `¿Eliminar el área "${a.nombre}"? Las checadas ya importadas no se borran.`,
      destructivo: true, textoConfirmar: 'Eliminar'
    });
    if (!ok || !a.id) return;
    try {
      await this.checador.eliminarArea(a.id);
      this.toast.exito('Área eliminada.');
    } catch (e) {
      console.error(e);
      this.toast.error('No se pudo eliminar el área.');
    }
  }

  // ===================== HORARIOS (CRUD) =====================

  nuevoHorario() {
    this.horarioEdit = {
      sucursalId: this.sucursalFiltro || CENTROS_CHECADOR[0].id,
      areaId: '',
      nombre: '',
      dias: [1, 2, 3, 4, 5],
      entrada: '09:00',
      inicioComida: '',
      finComida: '',
      salida: '18:00',
      toleranciaMin: 10,
      activo: true
    };
  }
  editarHorario(h: HorarioArea) {
    this.horarioEdit = { ...h, dias: [...(h.dias || [])] };
  }
  toggleDia(d: number) {
    if (!this.horarioEdit) return;
    const i = this.horarioEdit.dias.indexOf(d);
    if (i === -1) this.horarioEdit.dias.push(d);
    else this.horarioEdit.dias.splice(i, 1);
  }
  diaActivo(d: number): boolean {
    return !!this.horarioEdit && this.horarioEdit.dias.includes(d);
  }
  async guardarHorarioModal() {
    if (!this.horarioEdit) return;
    const h = this.horarioEdit;
    if (!h.nombre.trim() || !h.sucursalId || !h.entrada || !h.salida) {
      this.toast.alerta('El horario necesita nombre, sucursal, entrada y salida.');
      return;
    }
    if (!h.dias.length) {
      this.toast.alerta('Elige al menos un día de la semana.');
      return;
    }
    try {
      // areaId '' → guardar como horario general (sin área).
      await this.checador.guardarHorario({ ...h, areaId: h.areaId || undefined });
      this.toast.exito('Horario guardado.');
      this.horarioEdit = null;
    } catch (e) {
      console.error(e);
      this.toast.error('No se pudo guardar el horario.');
    }
  }
  async borrarHorario(h: HorarioArea) {
    const ok = await this.toast.confirmar({
      titulo: 'Eliminar horario',
      mensaje: `¿Eliminar el horario "${h.nombre}"?`,
      destructivo: true, textoConfirmar: 'Eliminar'
    });
    if (!ok || !h.id) return;
    try {
      await this.checador.eliminarHorario(h.id);
      this.toast.exito('Horario eliminado.');
    } catch (e) {
      console.error(e);
      this.toast.error('No se pudo eliminar el horario.');
    }
  }

  // ===================== EMPLEADOS (CRUD) =====================

  subiendoFoto = false;

  nuevoEmpleado() {
    this.empleadoEdit = {
      sucursalId: this.sucursalFiltro || CENTROS_CHECADOR[0].id,
      codigoChecador: '', nombre: '', puesto: '', fotoUrl: '', activo: true
    };
  }
  editarEmpleado(e: Empleado) {
    this.empleadoEdit = { ...e };
  }

  /** Detalle de un empleado (modal), con SU PROPIO rango, agrupado por SEMANA (mié→mar). */
  empleadoDetalle: {
    nombre: string; codigo: string; sucursalId: string; fotoUrl: string; areaId?: string;
    desde: string; hasta: string; cargando: boolean;
    presupuesto: number; acumuladoTotal: number; diasConRetardo: number; diasRegistrados: number; semanasExcedidas: number;
    semanas: {
      inicio: string; label: string; acumulado: number; excedido: boolean;
      dias: { fecha: string; diaLabel: string; entrada: string; comida: string; salida: string; retardoMin: number }[];
    }[];
  } | null = null;

  /** Inicio de la semana (miércoles) que contiene a la fecha dada. */
  private inicioSemana(fecha: string): Date {
    const d = new Date(fecha + 'T00:00:00');
    const off = (d.getDay() - 3 + 7) % 7; // días transcurridos desde el miércoles
    d.setDate(d.getDate() - off);
    return d;
  }
  private etiquetaSemana(inicio: Date): string {
    const fin = new Date(inicio); fin.setDate(inicio.getDate() + 6);
    const f = (x: Date) => x.toLocaleDateString('es-MX', { weekday: 'short', day: '2-digit', month: 'short' });
    return `${f(inicio)} → ${f(fin)}`;
  }

  /** Segundos desde medianoche de 'HH:mm:ss'. */
  private minSeg(hhmmss: string): number {
    const m = /^(\d{1,2}):(\d{2}):?(\d{2})?/.exec(hhmmss || '');
    if (!m) return -1;
    return (+m[1]) * 3600 + (+m[2]) * 60 + (+(m[3] || 0));
  }

  /**
   * Separa las marcas de un día en entrada / comida / salida. Primero COLAPSA
   * las marcas a menos de 2 min entre sí (doble-checada del mismo evento), que
   * es lo que ensuciaba la "comida".
   */
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

  /** Abre el detalle de un empleado. Su rango arranca igual al de la lista pero es independiente. */
  abrirDetalle(emp: GrupoEmpleado) {
    this.empleadoDetalle = {
      nombre: emp.empleadoNombre || '(sin registrar)',
      codigo: emp.empleadoCodigo,
      sucursalId: this.sucursalFiltro,
      fotoUrl: this.fotoDe(emp.empleadoCodigo),
      areaId: emp.areaId,
      desde: this.desde, hasta: this.hasta, cargando: true,
      presupuesto: 15, acumuladoTotal: 0, diasConRetardo: 0, diasRegistrados: 0, semanasExcedidas: 0, semanas: []
    };
    this.cargarDetalle();
  }

  /** Abre el detalle directamente desde un empleado del listado (pestaña Checadas). */
  abrirDetalleEmp(e: Empleado) {
    this.empleadoDetalle = {
      nombre: e.nombre || '(sin registrar)',
      codigo: e.codigoChecador,
      sucursalId: e.sucursalId,
      fotoUrl: e.fotoUrl || '',
      areaId: undefined,
      desde: this.desde, hasta: this.hasta, cargando: true,
      presupuesto: 15, acumuladoTotal: 0, diasConRetardo: 0, diasRegistrados: 0, semanasExcedidas: 0, semanas: []
    };
    this.cargarDetalle();
  }

  /** Carga (o recarga al cambiar fechas) las checadas del empleado en su rango. */
  async cargarDetalle() {
    const d = this.empleadoDetalle;
    if (!d) return;
    d.cargando = true;
    try {
      const checadas = await this.checador.getChecadas(d.sucursalId, d.desde, d.hasta, d.codigo);
      const porFecha = new Map<string, Checada[]>();
      for (const c of checadas) {
        if (!porFecha.has(c.fecha)) porFecha.set(c.fecha, []);
        porFecha.get(c.fecha)!.push(c);
      }
      const hor = this.horarioAplicable(d.sucursalId, d.areaId, d.hasta);
      const base = hor ? this.minutos(hor.entrada) : -1;
      const presupuesto = hor?.toleranciaMin ?? 15;

      // Día por día (retardo = minutos exactos desde la entrada) agrupado por semana (mié→mar).
      const porSemana = new Map<string, any>();
      let acumTotal = 0, conRet = 0, diasReg = 0;
      for (const f of Array.from(porFecha.keys()).sort()) {
        const marcas = porFecha.get(f)!.sort((a, b) => (a.fechaHora < b.fechaHora ? -1 : 1));
        const des = this.desglosarDia(marcas);
        let rm = 0;
        const pMin = this.minutos(des.entrada);
        if (base >= 0 && pMin >= 0) rm = Math.max(0, pMin - base);
        acumTotal += rm; diasReg++;
        if (rm > 0) conRet++;

        const claveIni = aFechaLocal(this.inicioSemana(f));
        if (!porSemana.has(claveIni)) {
          porSemana.set(claveIni, {
            inicio: claveIni, label: this.etiquetaSemana(this.inicioSemana(f)),
            acumulado: 0, excedido: false, dias: []
          });
        }
        const sem = porSemana.get(claveIni);
        sem.acumulado += rm;
        sem.dias.push({ fecha: f, diaLabel: this.etiquetaDia(f), entrada: des.entrada, comida: des.comida, salida: des.salida, retardoMin: rm });
      }

      const semanas = Array.from(porSemana.values()).sort((a, b) => (a.inicio < b.inicio ? -1 : 1));
      let semExc = 0;
      for (const s of semanas) { s.excedido = s.acumulado > presupuesto; if (s.excedido) semExc++; }

      d.semanas = semanas;
      d.acumuladoTotal = acumTotal;
      d.diasConRetardo = conRet;
      d.diasRegistrados = diasReg;
      d.semanasExcedidas = semExc;
      d.presupuesto = presupuesto;
    } catch (e) {
      console.error(e);
      this.toast.error('No se pudo cargar el detalle del empleado.');
    } finally {
      d.cargando = false;
    }
  }
  cerrarDetalle() { this.empleadoDetalle = null; }

  /** Foto de un empleado (por código, en la sucursal filtrada) para las tarjetas de checadas. */
  fotoDe(codigo: string): string {
    const e = this.empleados.find(x =>
      x.sucursalId === this.sucursalFiltro && String(x.codigoChecador).trim() === String(codigo).trim());
    return e?.fotoUrl || '';
  }

  /** Iniciales para el avatar cuando el empleado no tiene foto. */
  iniciales(nombre: string): string {
    if (!nombre) return '?';
    return nombre.trim().split(/\s+/).slice(0, 2).map(p => p.charAt(0).toUpperCase()).join('');
  }

  /** Sube la foto del empleado a Cloudinary y la guarda en el registro en edición. */
  async onFotoEmpleado(event: any) {
    const file: File | undefined = event.target.files?.[0];
    if (!file || !this.empleadoEdit) return;
    if (file.size > 5_000_000) {
      this.toast.alerta('La foto supera los 5 MB. Usa una más ligera.');
      event.target.value = '';
      return;
    }
    this.subiendoFoto = true;
    try {
      const url = await subirACloudinary(file, 'empleados');
      this.empleadoEdit.fotoUrl = url;
      this.toast.exito('Foto lista.');
    } catch (e) {
      console.error(e);
      this.toast.error('No se pudo subir la foto.');
    } finally {
      this.subiendoFoto = false;
      event.target.value = '';
    }
  }
  async guardarEmpleadoModal() {
    if (!this.empleadoEdit) return;
    const e = this.empleadoEdit;
    if (!e.nombre.trim() || !e.codigoChecador.trim() || !e.sucursalId) {
      this.toast.alerta('El empleado necesita nombre, código del reloj y sucursal.');
      return;
    }
    try {
      await this.checador.guardarEmpleado(e);
      this.toast.exito('Empleado guardado.');
      this.empleadoEdit = null;
    } catch (err) {
      console.error(err);
      this.toast.error('No se pudo guardar el empleado.');
    }
  }
  async borrarEmpleado(e: Empleado) {
    const ok = await this.toast.confirmar({
      titulo: 'Eliminar empleado',
      mensaje: `¿Eliminar a "${e.nombre}"? Las checadas ya importadas conservan su nombre.`,
      destructivo: true, textoConfirmar: 'Eliminar'
    });
    if (!ok || !e.id) return;
    try {
      await this.checador.eliminarEmpleado(e.id);
      this.toast.exito('Empleado eliminado.');
    } catch (err) {
      console.error(err);
      this.toast.error('No se pudo eliminar el empleado.');
    }
  }

  // ===================== Helpers de presentación =====================

  nombreSucursal(id: string): string {
    const s = centroChecadorPorId(id);
    if (!s) return id || '—';
    return s.direccion ? `${s.ciudad} · ${s.direccion.split(',')[0]}` : s.ciudad;
  }
  nombreArea(id: string): string {
    return this.areas.find(a => a.id === id)?.nombre || '—';
  }
  diasLabel(dias: number[]): string {
    if (!dias?.length) return '—';
    return dias.slice().sort((a, b) => a - b).map(d => DIAS_SEMANA[d]).join(' · ');
  }
  tipoLabel(tipo?: number): string {
    if (tipo === undefined || tipo === null) return '';
    return TIPOS_CHECADA[tipo] || `Tipo ${tipo}`;
  }
  cerrarModales() {
    this.areaEdit = null;
    this.horarioEdit = null;
    this.empleadoEdit = null;
  }
}
