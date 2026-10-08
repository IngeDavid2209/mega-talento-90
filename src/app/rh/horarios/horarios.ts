import { Component, inject, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import * as XLSX from 'xlsx';
import {
  ChecadorService, ResultadoImportacion, EmpleadoNuevo,
  PersonaAsistencia, SemanaApi, DiaApi
} from '../../core/services/checador.service';
import { VistaAsistencia, ConteosPendientes } from '../asistencia-resumen/asistencia-resumen';
import { CrucesPlazasComponent } from '../cruces-plazas/cruces-plazas';
import {
  AreaChecador, HorarioArea, Empleado,
  TIPOS_CHECADA, DIAS_SEMANA, aFechaLocal
} from '../../core/models/checador.model';
import { parsearTextoChecadas, parsearFilasExcel } from '../../core/models/parser-attlog';
import { CENTROS_CON_RELOJ, centroChecadorPorId } from '../../core/models/sucursales.model';
import { ToastService } from '../../core/services/toast.service';
import { PeriodoAsistenciaService } from '../../core/services/periodo-asistencia.service';
import { NotificacionesService } from '../../core/services/notificaciones.service';
import { subirACloudinary } from '../../core/services/cloudinary';
import { AsistenciaResumenComponent } from '../asistencia-resumen/asistencia-resumen';
import { SucursalSelectComponent } from '../ui/sucursal-select/sucursal-select';
import { UbicacionEquipoComponent } from '../ubicacion-equipo/ubicacion-equipo';
import { PapeleraEmpleadosComponent } from '../papelera-empleados/papelera-empleados';
import { IncidenciasBandejaComponent } from '../incidencias-bandeja/incidencias-bandeja';
import { AuthSession } from '../../core/services/auth-session';

type Tab = 'checadas' | 'tolerancia' | 'faltas' | 'incidencias' | 'cruces' | 'horarios' | 'areas' | 'empleados' | 'equipo' | 'papelera';

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
  imports: [CommonModule, FormsModule, AsistenciaResumenComponent, SucursalSelectComponent, CrucesPlazasComponent, UbicacionEquipoComponent, PapeleraEmpleadosComponent, IncidenciasBandejaComponent],
  templateUrl: './horarios.html',
  styleUrl: './horarios.css'
})
export class HorariosComponent implements OnInit, OnDestroy {
  private checador = inject(ChecadorService);
  private ngZone = inject(NgZone);
  private toast = inject(ToastService);
  private periodo = inject(PeriodoAsistenciaService);
  private auth = inject(AuthSession);
  private notif = inject(NotificacionesService);

  // ══ NUEVOS EN LOS RELOJES (29/09/2026) ═════════════════════════════
  //
  // El agente lee la lista de usuarios de cada reloj CADA HORA y le abre ficha
  // a quien se registró. El reloj solo trae su nombre corto ("Luis"): nombre
  // completo y departamento los pone RH. Este recuadro es el pendiente a la
  // vista, de todas las plazas, con un botón para completar cada ficha, y un
  // aviso del navegador cuando aparece alguien nuevo.
  nuevos: EmpleadoNuevo[] = [];
  verTodosNuevos = false;
  /** El recuadro arranca en la plaza que se está viendo; se puede abrir a todas. */
  nuevosTodasPlazas = false;
  private relojNuevos: any;
  private readonly CLAVE_VISTOS = 'mt90.nuevos-reloj.vistos';

  /** Los que todavía no tienen nombre completo o departamento. */
  get nuevosPendientes(): EmpleadoNuevo[] { return this.nuevos.filter((n) => this.nuevoPendiente(n)); }
  nuevoPendiente(n: EmpleadoNuevo): boolean { return n.sinNombre || n.sinDepartamento || !!n.dadoDeBaja || !!n.enPapelera; }
  get nuevosDePlaza(): EmpleadoNuevo[] { return this.nuevosPendientes.filter((n) => n.sucursalId === this.sucursalFiltro); }
  get nuevosVisibles(): EmpleadoNuevo[] {
    const base = this.nuevosTodasPlazas ? this.nuevos : this.nuevos.filter((n) => n.sucursalId === this.sucursalFiltro);
    return this.verTodosNuevos ? base : base.filter((n) => this.nuevoPendiente(n));
  }

  // ══ POR IDENTIFICAR (07/10/2026) ══
  // Antes solo se veían las altas de los últimos 14 días. RH seguía teniendo
  // gente que "checa pero no está en el sistema": tenían ficha, pero solo con
  // el apodo del reloj ("Donnacho" era Ignacio), o los habían dado de baja y
  // seguían checando. Ahora sale todo el que checó en 30 días y le falta algo.
  async cargarNuevos() {
    try {
      this.nuevos = await this.checador.getPorIdentificar(30);
      this.avisarNuevos();
    } catch { /* sin este recuadro la pantalla sigue sirviendo */ }
  }

  /** "Reactivar" desde el recuadro: el mismo de la tabla, y luego se refresca. */
  async reactivarNuevo(n: EmpleadoNuevo) {
    await this.reactivar(n);
    this.cargarNuevos();
  }

  /** Aviso del navegador, una vez por persona (se recuerda en este navegador). */
  private avisarNuevos() {
    let vistos: string[] = [];
    try { vistos = JSON.parse(localStorage.getItem(this.CLAVE_VISTOS) || '[]'); } catch { vistos = []; }
    const primeraVez = !vistos.length;
    // El aviso es solo para las ALTAS recientes; lo viejo por completar ya está en el recuadro.
    const recientes = this.nuevos.filter((n) => Date.now() - new Date(n.creadoEn).getTime() < 14 * 86400000);
    const claves = recientes.map((n) => `${n.sucursalId}|${n.codigoChecador}`);
    const nuevosDeVerdad = recientes.filter((n) => !vistos.includes(`${n.sucursalId}|${n.codigoChecador}`));
    try { localStorage.setItem(this.CLAVE_VISTOS, JSON.stringify(claves)); } catch { /* sin almacenamiento */ }
    // La primera vez que se abre la pantalla no se avisa de todo lo acumulado:
    // el recuadro ya lo enseña. Solo se avisa de lo que llega después.
    if (primeraVez || !nuevosDeVerdad.length) return;
    const quien = nuevosDeVerdad.slice(0, 3).map((n) => `${n.nombre} (${this.nombreSucursal(n.sucursalId)})`).join(', ');
    this.notif.notificar(
      nuevosDeVerdad.length === 1 ? 'Nueva persona en un reloj' : `${nuevosDeVerdad.length} personas nuevas en los relojes`,
      `${quien}${nuevosDeVerdad.length > 3 ? '…' : ''}. Complétales nombre y departamento.`,
      () => this.cambiarTab('empleados'));
  }

  /** Abre la ficha de un nuevo para completarla. */
  completarNuevo(n: EmpleadoNuevo) {
    this.editarEmpleado({ ...n });
  }

  /** "hace 3 días", "hoy". */
  haceDias(iso: string): string {
    const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    return d <= 0 ? 'hoy' : d === 1 ? 'ayer' : `hace ${d} días`;
  }

  /**
   * "Ubicación de mi equipo" es solo para administradores (29/09/2026). El
   * botón se esconde aquí y la API lo vuelve a validar: esconder un botón no
   * impide llamar a la ruta.
   */
  get esAdmin(): boolean { return this.auth.esAdmin(); }

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
    this.cargarNuevos();
    this.relojNuevos = setInterval(() => this.ngZone.run(() => this.cargarNuevos()), 10 * 60 * 1000);
  }

  ngOnDestroy() {
    clearInterval(this.relojNuevos);
    if (this.unsubAreas) this.unsubAreas();
    if (this.unsubHorarios) this.unsubHorarios();
    if (this.unsubEmpleados) this.unsubEmpleados();
  }

  cambiarTab(t: Tab) {
    this.tabActiva = t;
  }

  // ══ LAS TRES VISTAS DE ASISTENCIA ════════════════════════════════
  //
  // Checadas, Tolerancia y Faltas son PESTAÑAS distintas pero el MISMO
  // componente: `<app-asistencia-resumen>` se queda montado en las tres y solo
  // cambia su `vista`. Si cada pestaña tuviera su propia instancia, saltar entre
  // ellas volvería a pedir la asistencia a la API y perdería el periodo elegido.
  //
  // Antes tolerancia y faltas eran dos franjas plegables encima del reporte:
  // había que abrirlas para ver algo y empujaban el reporte —lo que RH mira
  // todos los días— fuera de la pantalla.

  /** Las pestañas que pinta el componente de asistencia. */
  private readonly TABS_ASISTENCIA: Tab[] = ['checadas', 'tolerancia', 'faltas'];

  get esTabAsistencia(): boolean {
    return this.TABS_ASISTENCIA.includes(this.tabActiva);
  }

  /** La vista que se le pasa al componente (fuera de sus pestañas, 'checadas'). */
  get vistaAsistencia(): VistaAsistencia {
    return this.esTabAsistencia ? (this.tabActiva as VistaAsistencia) : 'checadas';
  }

  /**
   * Los contadores de las pestañas, que los reporta el propio componente al
   * terminar de calcular. Sin ellos, la pestaña se ve igual con 14 personas
   * pendientes que con cero y hay que entrar para saberlo.
   */
  conteos: ConteosPendientes = { rebasados: 0, faltas: 0 };
  onConteos(c: ConteosPendientes) { this.conteos = c; }

  /**
   * CRUCES ENTRE PLAZAS: la única pestaña que NO depende de la sucursal.
   *
   * Un cruce solo existe comparando una plaza contra otra, así que filtrar por
   * una sola no tiene sentido —y dejar el selector puesto haría creer que la
   * lista es de esa plaza y que está incompleta—. Por eso la barra de sucursal
   * se esconde en esta pestaña.
   */
  totalCruces = 0;
  onTotalCruces(n: number) { this.totalCruces = n; }

  /** Incidencias entregadas que esperan calificación (lo reporta la bandeja). */
  incPorCalificar = 0;

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

  /**
   * BUSCADOR DE LA PESTAÑA EMPLEADOS. Busca en el nombre formal, el del reloj,
   * el código, el departamento y el puesto, sin distinguir acentos ni
   * mayúsculas: "garcia" encuentra a "GARCÍA TAPIA LUCIA" y a "Luciagarciatapia".
   * Filtra solo la TABLA; los contadores de arriba siguen siendo de la plaza.
   */
  busquedaEmp = '';

  private sinAcentos(t: string): string {
    return (t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  get empleadosBuscados(): Empleado[] {
    const q = this.sinAcentos(this.busquedaEmp.trim());
    if (!q) return this.empleadosFiltrados;
    const partes = q.split(/\s+/);
    return this.empleadosFiltrados.filter(e => {
      const texto = this.sinAcentos([e.nombreCompleto, e.nombre, e.codigoChecador, e.departamento, e.puesto]
        .filter(Boolean).join(' '));
      return partes.every(p => texto.includes(p));
    });
  }


  // ══ LAS FICHAS DADAS DE BAJA NO SE VEN, PERO SIGUEN AHÍ ══════════
  //
  // El barrido del padrón (api/tools/depurar-padron.js) da de baja a quien no
  // tiene checadas en tres meses y no aparece en el reporte semanal de RH. Eso
  // pone `activo = false`, y hasta ahora el campo era decorativo: la ficha seguía
  // ocupando lugar en la lista, así que la depuración no se notaba en la pantalla
  // —que es donde RH la pidió—.
  //
  // No se filtran y ya: quedan detrás de una línea que dice cuántas son. Borrarlas
  // de la vista sin dejar rastro es como se pierde la pista de una baja mal hecha,
  // y ahí mismo está el botón para reactivar a quien no debía salir.
  mostrarBajas = false;

  /** Todos los de la sucursal, promotoras incluidas, SIN las dadas de baja. */
  private get empleadosDeSucursal(): Empleado[] {
    return this.empleadosDeSucursalTodos.filter(e => e.activo !== false);
  }

  private get empleadosDeSucursalTodos(): Empleado[] {
    return this.empleados.filter(e => !this.sucursalFiltro || e.sucursalId === this.sucursalFiltro);
  }

  /** Alguien regresó de la papelera: se recarga el padrón para que aparezca ya. */
  async alRegresar() {
    try { this.empleados = await this.checador.getEmpleados(); } catch { /* el sondeo lo trae en un momento */ }
  }

  /** Cuántas fichas de esta plaza están dadas de baja. */
  get bajasDeSucursal(): number {
    return this.empleadosDeSucursalTodos.filter(e => e.activo === false).length;
  }

  /** Reactiva una ficha que no debía haber salido del padrón. */
  async reactivar(e: Empleado) {
    if (!e.id || this.moviendo) return;
    const ok = await this.toast.confirmar({
      titulo: 'Reactivar en el padrón',
      mensaje: `¿Volver a poner a "${e.nombre}" como activo? Vuelve a contar en la asistencia.`,
      textoConfirmar: 'Reactivar',
    });
    if (!ok) return;
    this.moviendo = e.id;
    try {
      await this.checador.guardarEmpleado({ ...e, activo: true });
      e.activo = true;
      this.toast.exito(`${e.nombre} volvió al padrón.`);
    } catch (err) {
      console.error(err);
      this.toast.error('No se pudo reactivar. Intenta de nuevo.');
    } finally {
      this.moviendo = '';
    }
  }

  /** Se usa para deshabilitar el botón de la ficha que se está guardando. */
  moviendo = '';

  // El buscador de candidatas y `marcarPromotora` se fueron a
  // src/app/rh/promotoras/: esta pantalla es del personal de PLANTA, y tener
  // aquí la puerta a promotoría era justo lo que RH pidió separar.
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
    // Si ya hay un periodo elegido en la sesión, ese manda: cambiar de plaza no
    // lo reescribe (ver PeriodoAsistenciaService).
    if (this.periodo.elegido) {
      this.desde = this.periodo.desde;
      this.hasta = this.periodo.hasta;
      return;
    }
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

  // ══ ALTA DESDE EL PORTAL, ANTES QUE EN EL RELOJ (08/10/2026) ══
  // Para que no vuelva a pasar lo de "Donnacho": RH da de alta primero aquí, con
  // nombre completo y departamento, y el portal le da el NÚMERO con el que el
  // encargado enrola la huella. Cuando el reloj reporta ese número, la ficha ya
  // está completa: la ingesta solo rellena lo vacío.
  numeroSugerido = '';
  nuevoEmpleado(esPromotora = false) {
    this.empleadoEdit = {
      sucursalId: this.sucursalFiltro || CENTROS_CON_RELOJ[0].id,
      codigoChecador: '', nombre: '', puesto: '', departamento: '', fotoUrl: '', activo: true,
      esPromotora
    };
    this.deptoNuevo = '';
    this.sugerirNumero();
  }

  /** Pone el siguiente número libre de la plaza (solo en un alta nueva). */
  async sugerirNumero() {
    const e = this.empleadoEdit;
    if (!e || e.id || !e.sucursalId) return;
    this.numeroSugerido = '';
    try {
      const r = await this.checador.numeroReloj(e.sucursalId);
      if (this.empleadoEdit === e) { this.numeroSugerido = r.siguiente; e.codigoChecador = r.siguiente; }
    } catch { /* sin sugerencia, RH lo escribe */ }
  }
  editarEmpleado(e: Empleado) {
    // `departamento` siempre viaja (aunque sea vacío): así la API distingue
    // "lo quitaron" de "esta llamada no lo trae" y no lo pisa por accidente.
    this.empleadoEdit = { ...e, departamento: (e.departamento || '').trim().toUpperCase() };
    this.deptoNuevo = '';
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
      desde: this.periodo.desde || this.desde, hasta: this.periodo.hasta || this.hasta,
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

  /**
   * Cómo se llama esta persona en pantalla: el nombre formal si lo hay.
   *
   * La lista mostraba `nombre`, que es el apodo del reloj —"Paula", "Dayan",
   * "Luciagarciatapia"—. Sirve para identificarla en el equipo, no para una
   * pantalla de RH. El formal viene de los reportes semanales; hoy lo tienen 366
   * de 518 fichas activas, así que la caída al apodo no es un caso raro.
   */
  nombreDe(e: Empleado): string {
    return (e.nombreCompleto || '').trim() || e.nombre;
  }

  /** ¿Vale la pena enseñar también el del reloj? Solo si dice otra cosa. */
  apodoDistinto(e: Empleado): boolean {
    const formal = (e.nombreCompleto || '').trim();
    if (!formal || !e.nombre) return false;
    const pega = (t: string) => t.toLowerCase().normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, '');
    return pega(formal) !== pega(e.nombre);
  }

  /**
   * Los departamentos que ya existen en el padrón, para sugerirlos al editar.
   * Se sugieren y no se imponen: si RH escribe uno nuevo, se crea. Pero escribir
   * "Compras" cuando ya existe "COMPRAS" partiría la sección en dos, y la lista
   * es lo que lo evita (la API además los guarda en mayúsculas).
   */
  get departamentosConocidos(): { nombre: string; n: number }[] {
    // Los de la SUCURSAL de la ficha que se edita, no los de todas las plazas.
    const suc = this.empleadoEdit?.sucursalId || this.sucursalFiltro;
    const m = new Map<string, number>();
    for (const e of this.empleados) {
      if (e.sucursalId !== suc || e.activo === false || e.esPromotora) continue;
      const d = (e.departamento || '').trim().toUpperCase();
      if (d) m.set(d, (m.get(d) || 0) + 1);
    }
    const actual = (this.empleadoEdit?.departamento || '').trim().toUpperCase();
    if (actual && actual !== this.NUEVO_DEPTO && !m.has(actual)) m.set(actual, 1);
    return [...m.entries()].map(([nombre, n]) => ({ nombre, n })).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  }
  readonly NUEVO_DEPTO = '__nuevo__';
  /** El nombre del departamento nuevo, cuando en la lista se elige "+ Nuevo". */
  deptoNuevo = '';

  /** Cuántas fichas de la plaza no tienen departamento (caen en SIN DEPARTAMENTO). */
  get sinDepartamento(): number {
    return this.empleadosFiltrados.filter(e => !(e.departamento || '').trim()).length;
  }

  /** Cuántas fichas de la plaza siguen sin nombre formal. */
  get sinNombreFormal(): number {
    return this.empleadosFiltrados.filter(e => !(e.nombreCompleto || '').trim()).length;
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
    const esAlta = !e.id;
    // En un alta, el nombre del reloj puede quedar vacío: se usa el completo.
    if (esAlta && !String(e.nombre || '').trim()) e.nombre = String(e.nombreCompleto || '').trim();
    if (!e.nombre.trim() || !e.codigoChecador.trim() || !e.sucursalId) {
      this.toast.alerta('El empleado necesita nombre, código del reloj y sucursal.');
      return;
    }
    // Un alta va COMPLETA: sin nombre completo y departamento es justo la ficha
    // que después nadie reconoce en el reporte.
    if (esAlta && (!String(e.nombreCompleto || '').trim() || !String(e.departamento || '').trim())) {
      this.toast.alerta('Para dar de alta pon su nombre completo y su departamento: así se le reconoce en el reporte desde el primer día.');
      return;
    }
    // ¿El número ya es de alguien en esa plaza? Un alta con ese número
    // reemplazaría su ficha.
    if (esAlta) {
      try {
        const r = await this.checador.numeroReloj(e.sucursalId, e.codigoChecador.trim());
        if (r.ocupadoPor) {
          if (r.ocupadoPor.activo) {
            this.toast.alerta(`El número ${e.codigoChecador} ya es de ${r.ocupadoPor.nombre} en esta plaza. Usa el ${r.siguiente}, que está libre.`);
            return;
          }
          const ok = await this.toast.confirmar({
            titulo: 'Ese número ya se usó',
            mensaje: `El número ${e.codigoChecador} era de ${r.ocupadoPor.nombre}, que está ${r.ocupadoPor.enPapelera ? 'en la papelera' : 'dada de baja'}. ` +
              `Si es la misma persona que regresa, continúa. Si es alguien nuevo, mejor usa el ${r.siguiente}.`,
            textoConfirmar: 'Es la misma persona',
          });
          if (!ok) return;
        }
      } catch { /* si no se pudo revisar, se sigue como antes */ }
    }
    // "+ Nuevo departamento": se guarda lo que se escribió.
    if (e.departamento === this.NUEVO_DEPTO) {
      if (!this.deptoNuevo.trim()) { this.toast.alerta('Escribe el nombre del departamento nuevo.'); return; }
      e.departamento = this.deptoNuevo.trim().toUpperCase();
    }
    try {
      await this.checador.guardarEmpleado(e);
      this.toast.exito(esAlta
        ? `Listo. Enrola su huella en el reloj de ${this.nombreSucursal(e.sucursalId)} con el número ${e.codigoChecador}.`
        : 'Empleado guardado.');
      this.cargarNuevos();
      this.empleadoEdit = null;
    } catch (err) {
      console.error(err);
      this.toast.error('No se pudo guardar el empleado.');
    }
  }
  /**
   * DAR DE BAJA desde la pestaña Empleados (29/09/2026). Reemplaza al "Borrar":
   * a nadie se le borra; se le da de baja y se va a la Papelera de empleados,
   * de donde se le puede regresar. Sus checadas y el reloj no se tocan.
   */
  async darDeBaja(e: Empleado) {
    if (!e.id || this.moviendo) return;
    const nombre = this.nombreDe(e);
    const ok = await this.toast.confirmar({
      titulo: 'Dar de baja',
      mensaje: `¿Seguro que quieres dar de baja a ${nombre} (#${e.codigoChecador})? Deja de contar en la ` +
        'asistencia y se va a la Papelera de empleados, de donde la puedes regresar cuando se necesite.',
      destructivo: true, textoConfirmar: 'Sí, dar de baja'
    });
    if (!ok) return;
    this.moviendo = e.id;
    try {
      await this.checador.guardarEmpleado({ ...e, activo: false });
      e.activo = false;
      this.toast.exito(`${nombre} se fue a la Papelera de empleados.`);
    } catch (err) {
      console.error(err);
      this.toast.error('No se pudo dar de baja.');
    } finally {
      this.moviendo = '';
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
