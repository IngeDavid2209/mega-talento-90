import { Component, inject, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import * as XLSX from 'xlsx';
import {
  ChecadorService, ResultadoImportacion,
  PersonaAsistencia, SemanaApi, DiaApi
} from '../../core/services/checador.service';
import {
  AreaChecador, HorarioArea, Empleado,
  TIPOS_CHECADA, DIAS_SEMANA, aFechaLocal
} from '../../core/models/checador.model';
import { parsearTextoChecadas, parsearFilasExcel } from '../../core/models/parser-attlog';
import { CENTROS_CON_RELOJ, centroChecadorPorId } from '../../core/models/sucursales.model';
import { ToastService } from '../../core/services/toast.service';
import { subirACloudinary } from '../../core/services/cloudinary';
import { AsistenciaResumenComponent } from '../asistencia-resumen/asistencia-resumen';
import { SucursalSelectComponent } from '../ui/sucursal-select/sucursal-select';

type Tab = 'checadas' | 'horarios' | 'areas' | 'empleados' | 'promotoras';

/**
 * El detalle de asistencia de UNA persona, tal como lo devuelve la API. No se
 * recalcula nada aquí: la regla (horario deducido + bolsa semanal) vive en
 * `api/src/agente-horarios/horario-deducido.ts` y este componente solo pinta.
 */
interface DetalleEmpleado {
  nombre: string; codigo: string; sucursalId: string; fotoUrl: string;
  desde: string; hasta: string; cargando: boolean; error: string;
  /** Su horario, deducido de SUS checadas (o confirmado por RH). */
  persona: PersonaAsistencia | null;
  semanas: SemanaApi[];
  bolsaMin: number;
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
  SUCURSALES = CENTROS_CON_RELOJ;
  DIAS_SEMANA = DIAS_SEMANA;
  TIPOS_CHECADA = TIPOS_CHECADA;

  tabActiva: Tab = 'checadas';

  // Filtros compartidos
  sucursalFiltro = CENTROS_CON_RELOJ[0]?.id || '';
  desde = '';
  hasta = '';

  // Datos en vivo
  areas: AreaChecador[] = [];
  horarios: HorarioArea[] = [];
  empleados: Empleado[] = [];

  importando = false;
  importResumen: ResultadoImportacion | null = null;
  // Se incrementa tras importar para que la vista de asistencia recargue.
  recargaAsistencia = 0;

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
  /**
   * PROMOTORAS APARTE (04/08/2026).
   *
   * No son personal de piso: andan en calle o en punto de venta y no checan en
   * el reloj de la sucursal. Mezcladas con los de planta salían con falta todos
   * los días, y un tablero que grita todos los días deja de mirarse.
   *
   * Por eso la pestaña de Empleados ya solo trae a los de planta y las
   * promotoras viven en la suya. No se borran ni se dan de baja: siguen siendo
   * personal, solo que no se miden con esta vara.
   */
  get empleadosFiltrados(): Empleado[] {
    return this.empleadosDeSucursal.filter(e => !e.esPromotora);
  }

  get promotoras(): Empleado[] {
    return this.empleadosDeSucursal.filter(e => e.esPromotora);
  }

  /** Todos los de la sucursal, promotoras incluidas. */
  private get empleadosDeSucursal(): Empleado[] {
    return this.empleados.filter(e => !this.sucursalFiltro || e.sucursalId === this.sucursalFiltro);
  }

  /** Texto del buscador para pasar a alguien de planta a promotoras. */
  buscarParaPromotora = '';
  moviendo = '';

  /** Candidatos a promotora: los de planta de esta sucursal que empatan la búsqueda. */
  get candidatosAPromotora(): Empleado[] {
    const q = this.buscarParaPromotora.trim().toLowerCase();
    const base = this.empleadosFiltrados;
    if (!q) return base.slice(0, 12);
    return base.filter(e =>
      `${e.nombre} ${e.codigoChecador} ${e.puesto || ''}`.toLowerCase().includes(q)
    ).slice(0, 12);
  }

  /** Mueve a alguien entre planta y promotoras. Es un campo, no un borrado. */
  async marcarPromotora(e: Empleado, esPromotora: boolean) {
    if (!e.id || this.moviendo) return;
    this.moviendo = e.id;
    try {
      await this.checador.guardarEmpleado({ ...e, esPromotora });
      // La lista se refresca sola por el sondeo, pero se refleja al instante
      // para que el clic no se sienta perdido.
      e.esPromotora = esPromotora;
      this.toast.exito(esPromotora
        ? `${e.nombre} pasó a Promotoras y ya no cuenta en la asistencia de piso.`
        : `${e.nombre} volvió a personal de planta.`);
      this.buscarParaPromotora = '';
    } catch (err) {
      console.error(err);
      this.toast.error('No se pudo mover a la persona. Intenta de nuevo.');
    } finally {
      this.moviendo = '';
    }
  }

  /** Áreas de una sucursal (para los selects de los modales). */
  areasDeSucursal(sucursalId: string): AreaChecador[] {
    return this.areas.filter(a => a.sucursalId === sucursalId);
  }

  // ===================== CHECADAS =====================

  onSucursalChange() {
    this.importResumen = null;
    this.ajustarRangoYCargar();
  }

  /**
   * Ajusta el rango a los últimos 30 días CON DATOS de la sucursal. Ya no carga
   * checadas: la lista la pinta `<app-asistencia-resumen>`, que pide los números
   * ya calculados a la API. Este rango es el que hereda el detalle por empleado.
   */
  async ajustarRangoYCargar() {
    if (!this.sucursalFiltro) return;
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
          this.recargaAsistencia++;   // dispara la recarga del dashboard de asistencia
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

  // El export de asistencia lo hace <app-asistencia-resumen>, con los numeros ya
  // calculados por la API (incluida la columna "Numero utilizable"). Aqui vivia
  // un segundo export que armaba el estado del dia comparando la primera marca
  // contra el horario de la sucursal: se borro junto con `agrupar()` y
  // `horarioAplicable()`, que eran la ULTIMA copia local de la regla del retardo.
  // Nada del template los usaba desde que la pestana Checadas se volvio el
  // componente de asistencia.

  private etiquetaDia(fecha: string): string {
    const d = new Date(fecha + 'T00:00:00');
    return d.toLocaleDateString('es-MX', { weekday: 'short', day: '2-digit', month: 'short' });
  }

  // ===================== ÁREAS (CRUD) =====================

  nuevaArea() {
    this.areaEdit = {
      sucursalId: this.sucursalFiltro || CENTROS_CON_RELOJ[0].id,
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
      sucursalId: this.sucursalFiltro || CENTROS_CON_RELOJ[0].id,
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

  nuevoEmpleado(esPromotora = false) {
    this.empleadoEdit = {
      sucursalId: this.sucursalFiltro || CENTROS_CON_RELOJ[0].id,
      codigoChecador: '', nombre: '', puesto: '', fotoUrl: '', activo: true,
      esPromotora
    };
  }
  editarEmpleado(e: Empleado) {
    this.empleadoEdit = { ...e };
  }

  // ══════════════════════════════════════════════════════════════════
  // DETALLE DE ASISTENCIA DE UNA PERSONA
  //
  // El modal existia pero habia quedado huerfano: ningun boton lo abria desde que
  // la pestana Checadas se volvio el componente de asistencia. Y calculaba el
  // retardo aqui mismo, comparando la primera marca contra el horario de la
  // SUCURSAL —el mismo error que inflaba las tarjetas—.
  //
  // Ahora se pide a `GET /checador/agente/asistencia` y se pinta lo que responde:
  // su horario sale de SUS checadas, el retardo se acumula contra la bolsa de 15
  // min por semana y solo cuenta el excedente, y un dia de una sola marca no
  // genera retardo. Este componente ya no sabe calcular retardos, y eso es lo que
  // se buscaba: la regla vive en un solo lugar.
  // ══════════════════════════════════════════════════════════════════
  empleadoDetalle: DetalleEmpleado | null = null;

  /** Abre el detalle de un empleado; hereda el rango de la pantalla y lo puede cambiar. */
  abrirDetalleEmp(e: Empleado) {
    this.empleadoDetalle = {
      nombre: e.nombre || '(sin registrar)',
      codigo: String(e.codigoChecador).trim(),
      sucursalId: e.sucursalId,
      fotoUrl: e.fotoUrl || '',
      desde: this.desde, hasta: this.hasta,
      cargando: true, error: '',
      persona: null, semanas: [], bolsaMin: 15
    };
    this.cargarDetalle();
  }

  /** Carga (o recarga al cambiar fechas) la asistencia del empleado en su rango. */
  async cargarDetalle() {
    const d = this.empleadoDetalle;
    if (!d) return;
    d.cargando = true;
    d.error = '';
    try {
      const r = await this.checador.getAsistencia(d.sucursalId, d.desde, d.hasta);
      d.bolsaMin = r.bolsaSemanalMin;
      const p = r.personas.find(x => String(x.codigo).trim() === d.codigo) || null;
      d.persona = p;
      d.semanas = p?.semanas || [];
      // Se dice cuando la persona no aparece, en vez de mostrar un modal vacio que
      // parece "no tuvo retardos".
      if (!p) d.error = 'Esta persona no tiene checadas en el periodo elegido.';
    } catch (e: any) {
      console.error(e);
      d.error = 'No se pudo cargar la asistencia de esta persona.';
      d.semanas = [];
      d.persona = null;
    } finally {
      d.cargando = false;
    }
  }

  // ── Presentacion del detalle (nada de calculo) ──

  /** Etiqueta de la semana a partir de su miercoles: "Mié 01 jul → Mar 07 jul". */
  etiquetaSemanaDe(inicioIso: string): string {
    const inicio = new Date(inicioIso + 'T00:00:00');
    const fin = new Date(inicio); fin.setDate(inicio.getDate() + 6);
    return `${this.etiquetaDia(inicioIso)} → ${this.etiquetaDia(aFechaLocal(fin))}`;
  }
  etiquetaDiaDe(fecha: string): string { return this.etiquetaDia(fecha); }

  /** Su horario, en una linea: fijo, rotativo o sin deducir. */
  horarioDe(p: PersonaAsistencia | null): string {
    if (!p) return '—';
    if (p.tipo === 'rotativo') return `Rota ${p.turnos.filter(Boolean).join(' · ')}`;
    if (!p.horario) return 'Sin horario deducible';
    return `${p.horario}${p.horarioConfirmado ? ' (confirmado por RH)' : ' (deducido)'}`;
  }

  /** Lo que hay que resolver antes de usar su numero. */
  marcasDe(p: PersonaAsistencia | null) {
    if (!p) return [];
    return p.marcas.filter(m => m.gravedad === 'alta' || m.gravedad === 'media');
  }

  /** Texto del estado de un dia, con el motivo cuando no es medible. */
  estadoDia(dia: DiaApi): string {
    switch (dia.estado) {
      case 'falta': return 'Falta';
      case 'descanso': return 'Descanso';
      case 'marca_faltante': return 'Una sola marca';
      case 'retardo': return `+${dia.retardoRealMin} min`;
      case 'absorbido': return 'Dentro de tolerancia';
      default: return 'A tiempo';
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
