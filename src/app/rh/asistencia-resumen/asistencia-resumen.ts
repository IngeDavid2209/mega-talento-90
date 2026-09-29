import { Component, inject, OnInit, OnDestroy, OnChanges, SimpleChanges, Input, Output, EventEmitter, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import * as XLSX from 'xlsx';
import {
  ChecadorService, RevisionDia, EstadoRevision,
  AsistenciaPersonas, PersonaAsistencia, MarcaAsistencia, EstadoDiaApi,
  EstadoReloj, SemaforoReloj, IncidenciaDia, TipoIncidencia, CambiosReloj, ComandoReloj
} from '../../core/services/checador.service';
import { PeriodoAsistenciaService } from '../../core/services/periodo-asistencia.service';
import { semanaFiscal, SemanaFiscal } from '../../core/models/semana-fiscal';
import { aFechaLocal, Empleado } from '../../core/models/checador.model';
import { CENTROS_CON_RELOJ, centroChecadorPorId, tieneReloj } from '../../core/models/sucursales.model';
import { ToastService } from '../../core/services/toast.service';
import { AuthSession } from '../../core/services/auth-session';
import { SucursalSelectComponent } from '../ui/sucursal-select/sucursal-select';

/** Un día del empleado, ya medido por la API contra SU horario. */
interface DiaAsistencia {
  fecha: string; diaLabel: string;
  entrada: string; comida: string; salida: string; horasNetas: string;
  /** Duración de la pausa de la mañana, en minutos (null si ese día no hubo). */
  desayunoMin: number | null;
  /** Minutos por encima del tope (25 en corporativo, 30 en las demás). */
  desayunoExcesoMin: number | null;
  /** El retardo REAL: lo que excedió la bolsa semanal. */
  retardoMin: number;
  /** Minutos crudos de atraso y cuánto absorbió la bolsa (para poder auditarlo). */
  atrasoMin: number; absorbidoMin: number;
  /** Contra qué hora se midió ese día. En un rotativo cambia día con día. */
  referencia: string;
  estadoDia: EstadoDiaApi;
  falta: boolean;
  /** Día de UNA sola marca: no se sabe si es entrada o salida, no es medible. */
  noMedible: boolean;
  /** Falta que RH ya justificó: no cuenta y se pinta distinto. */
  justificado: boolean;
  atipico: boolean;
  justificacion: string;       // capturada por RH (se guarda en la base)
  estado: EstadoRevision;      // verificación: pendiente/verificada/aprobada/rechazada
  /** Horas netas en minutos (lo que se suma). */
  netasMin: number;
  /** En corporativo el desayuno no se descontó (el día trae comida aparte). */
  desayunoPagado: boolean;
  /** Descanso tomado en un día que normalmente trabaja (no cuenta como falta). */
  descansoPorAusencia: boolean;
  /** Incidencias de RH que cubren el día. */
  incidencias: IncidenciaDia[];
}

/**
 * ══ IRREGULARIDADES (25/09/2026) ══════════════════════════════════
 *
 * Lo que se pinta en la fila del reporte y se lee en la ficha rápida. Dos
 * niveles a propósito:
 *   · 'alta'  → falta, retardo real, desayuno excedido: la fila va en ROJO.
 *   · 'baja'  → una sola checada o un día fuera de su horario: se marca, pero
 *               no enrojece la fila. Los días de una sola marca son ~20% de los
 *               días-persona; si pintaran de rojo, media plaza saldría roja y el
 *               rojo dejaría de avisar de algo.
 */
/** Una incidencia tal como se lista en un día de la ficha. */
interface FichaInc { id: string; tipo: string; codigo: string; etiqueta: string; nota: string; }

export interface Irregularidad {
  fecha: string; diaLabel: string;
  nivel: 'alta' | 'baja';
  tipo: 'falta' | 'retardo' | 'desayuno' | 'una_marca' | 'atipico';
  /** Dos o tres palabras: "Falta", "Llegó 12 min tarde". */
  texto: string;
}
/** Una semana (miércoles → martes) con su bolsa de tolerancia. */
interface SemanaAsistencia {
  inicio: string; label: string;
  acumulado: number;           // retardo REAL de la semana
  atrasoMin: number;           // atraso crudo, antes de la bolsa
  minutosTrabajados: number;   // suma de horas netas de la semana
  fiscal: SemanaFiscal;        // "semana 39 de 52"
  bolsaRestante: number;
  excedido: boolean;           // se agotó la bolsa
  dias: DiaAsistencia[];
}
/** Qué pinta el componente. Lo manda la página con sus pestañas. */
export type VistaAsistencia = 'checadas' | 'tolerancia' | 'faltas';

/** Una persona con sus faltas fuera de domingo (la regla de tienda). */
interface FaltaNotificable { emp: EmpleadoAsistencia; dias: { fecha: string; label: string }[]; }

/** Cuánta gente hay en cada pendiente, para los contadores de las pestañas. */
export interface ConteosPendientes { rebasados: number; faltas: number; }

/** Un empleado con todo su periodo desglosado. */
interface EmpleadoAsistencia {
  codigo: string; nombre: string; fotoUrl: string; puesto: string; registrado: boolean;
  // ── Para el reporte calcado (vista tabla) ──
  nombreCompleto: string;
  departamento: string;
  esPracticante: boolean;
  /** Día por fecha, para pintar las columnas del reporte sin buscar en las semanas. */
  diasPorFecha: Map<string, DiaAsistencia>;
  // ── Su horario, que sale de SUS checadas (o de lo que RH confirmó) ──
  tipo: PersonaAsistencia['tipo'];
  horario: string; turnos: string; horarioConfirmado: boolean; costumbre: string;
  // ── Los números ──
  acumuladoTotal: number;      // retardo real del periodo
  atrasoBrutoMin: number; absorbidoMin: number;
  semanasExcedidas: number; diasConRetardo: number; diasRegistrados: number;
  faltas: number; faltasJustificadas: number; noMedibles: number; atipicos: number;
  horasTrabajadas: number; presupuesto: number;
  /** Suma exacta de horas netas del periodo, en minutos. */
  minutosTrabajados: number;
  /** Sus incidencias como periodos (para pintarlas aunque no haya checado). */
  incidencias: Array<IncidenciaDia & { desde: string; hasta: string }>;
  irregularidades: Irregularidad[];
  /** ¿Alguna irregularidad alta? Es lo que pone la fila en rojo. */
  irregularAlta: boolean;
  pctATiempo: number | null;
  // ── Por qué el número puede no servir ──
  usable: boolean; bloqueadoPor: string[]; marcas: MarcaAsistencia[];
  semanas: SemanaAsistencia[];
}

/**
 * ══ TOLERANCIA REBASADA ══════════════════════════════════════════
 *
 * Una semana en la que la bolsa de 15 min NO alcanzó, y la persona que la trae.
 * No se calcula nada nuevo: es la misma respuesta de la API leída de otra
 * forma. El minuto que sale aquí es el mismo que ya salía en el detalle.
 */
interface SemanaRebasada {
  inicio: string; label: string;
  /** Atraso crudo de la semana: lo que se acumuló día por día. */
  atrasoMin: number;
  /** Lo que absorbió la bolsa (tope: los 15 min de la semana). */
  absorbidoMin: number;
  /** El excedente. ESTO es lo que rebasa la tolerancia. */
  excedenteMin: number;
  /**
   * La semana no cabe completa en el periodo elegido, así que su acumulado va
   * a medias. Se dice, porque un acumulado partido se lee como si fuera el de
   * la semana entera.
   */
  parcial: boolean;
  /** Los días que aportaron minutos, para poder señalar cuáles fueron. */
  dias: { fecha: string; diaLabel: string; entrada: string; referencia: string; atrasoMin: number; contado: number }[];
}
/** Una persona que rebasó la bolsa en al menos una semana del periodo. */
interface Rebasado {
  emp: EmpleadoAsistencia;
  semanas: SemanaRebasada[];
  /** Suma del excedente de todas sus semanas rebasadas (= su retardo real). */
  excedenteTotal: number;
}

/**
 * Vista consolidada de asistencia: se elige sucursal y rango, y se muestra a
 * todos los empleados con su desglose por semana.
 *
 * ══ EL CÁLCULO YA NO VIVE AQUÍ ══
 *
 * Este componente calculaba el retardo en el NAVEGADOR comparando cada entrada
 * contra el horario configurado de la sucursal. Eso producía números que no se
 * podían defender: Ana #105 aparecía con **251 min de retardo en un solo día** y
 * Antonio #50 con **207 min y cero horas trabajadas** —Antonio había checado una
 * sola vez, así que no se sabía ni si esa marca era su entrada—.
 *
 * Ahora los pide a `/checador/agente/asistencia`, que aplica las reglas del
 * horario deducido: el horario de cada persona sale de SUS checadas, el retardo
 * se acumula contra una bolsa de 15 min por semana y solo cuenta el excedente, un
 * día de una sola marca no genera retardo, y una falta es un día laboral DE ESA
 * PERSONA sin marcas. Aquí solo se arma la vista.
 *
 * Lo que este componente sí decide es de PRESENTACIÓN, y hay una regla: un
 * retardo con marca alta NO se muestra como número usable. Un número mal
 * calculado que se ve igual que uno bien calculado acaba en un descuento.
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
  private auth = inject(AuthSession);
  private periodo = inject(PeriodoAsistenciaService);

  /**
   * El semáforo de relojes es solo para el admin (lo pidió RH: 20/08/2026).
   *
   * Comparaba `rol === 'admin'` contra la cadena cruda, y la base guarda dos
   * escrituras del mismo rol: 6 de los 8 administradores tienen `Administrador`
   * y para ellos esto daba false — el semáforo no se le veía a casi nadie. Ahora
   * la decisión la toma `AuthSession`, que normaliza.
   */
  get esAdmin(): boolean { return this.auth.puede('relojes'); }

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
  /**
   * QUÉ SE PINTA. La eligen las pestañas de la página, no este componente.
   *
   * Tolerancia y faltas vivían como franjas plegables encima del reporte: dos
   * bandas apiladas que había que abrir para ver algo y que empujaban el
   * reporte —lo que RH mira todos los días— fuera de la pantalla. Ahora cada
   * una es una pestaña y se entra a propósito.
   *
   * Es un Input y no un estado propio para que el componente NO se desmonte al
   * cambiar de pestaña: la barra de filtros, el periodo y la respuesta ya
   * cargada se conservan, y saltar entre las tres vistas no vuelve a pegarle a
   * la API.
   */
  @Input() vista: VistaAsistencia = 'checadas';
  /**
   * Mide a las PROMOTORAS de la plaza en vez del personal de planta.
   *
   * Promotoría pidió su propia pantalla "igual a la de horarios y checadas pero
   * con las promotoras". Es este mismo componente con el filtro invertido: una
   * copia habría dejado dos pantallas que se separan en el primer ajuste.
   */
  @Input() soloPromotoras = false;
  /** Emite el evento del <input file> para que el padre procese el archivo. */
  @Output() archivo = new EventEmitter<Event>();
  /**
   * Cuánta gente hay en cada pendiente, para los contadores de las pestañas.
   * Sin esto, la pestaña de tolerancia se ve igual con 14 personas que con
   * cero y hay que entrar para saberlo.
   */
  @Output() conteos = new EventEmitter<ConteosPendientes>();

  SUCURSALES = CENTROS_CON_RELOJ;

  // Catálogos para el detalle
  ESTADOS: { v: EstadoRevision; l: string }[] = [
    { v: 'pendiente', l: 'Pendiente' },
    { v: 'verificada', l: 'Verificada' },
    { v: 'aprobada', l: 'Aprobada' },
    { v: 'rechazada', l: 'Rechazada' }
  ];
  // Ojo con el orden y con cuáles EXCUSAN: vacaciones, permiso e incapacidad
  // borran la falta (cuando se aprueban); tráfico o cita médica explican un
  // retardo pero el día se queda contado. La lista de las que excusan vive en
  // la API (JUSTIFICAN_AUSENCIA), que es quien decide.
  JUSTIFICACIONES = ['Vacaciones', 'Incapacidad', 'Permiso', 'Cita Médica', 'Tráfico', 'Personal', 'No Registrada'];

  /** Atajos de periodo de la barra de filtros. */
  /**
   * ATAJOS DE PERIODO, PEGADOS AL CORTE DE LA SEMANA.
   *
   * Antes había un atajo de "7 días" que hacía `hoy − 6`: si se picaba un
   * viernes, el periodo salía viernes→viernes. Se veía como una semana y no lo
   * era —la semana de nómina abre en jueves—, así que el acumulado de la bolsa
   * salía cortado por delante y la tolerancia se leía sobre una semana que no
   * existe en el reporte de RH.
   *
   * Ahora los atajos se alinean al MISMO corte con el que se acumula, y el día
   * de corte lo dice la API (`diaInicioSemana`), no una copia local.
   */
  SEMANAS: { off: number; l: string }[] = [
    { off: 0, l: 'Esta semana' },
    { off: -1, l: 'Semana pasada' },
  ];

  /** Etiqueta corta de cada marca, para los chips de la tarjeta. */
  ETIQUETA_MARCA: Record<string, string> = {
    horario_ambiguo: 'horario por confirmar', turno_ambiguo: 'turno por confirmar',
    solo_una_marca: 'solo marca una vez', sin_datos: 'sin días suficientes',
    sin_patron: 'sin patrón', ex_trabajador: 'ya no viene',
    dias_atipicos: 'días atípicos', marcas_faltantes: 'marcas faltantes',
    fuera_del_padron: 'fuera del padrón', rotativo: 'rotativo',
    horario_confirmado: 'horario confirmado'
  };

  sucursalFiltro = CENTROS_CON_RELOJ[0]?.id || '';
  desde = '';
  hasta = '';

  lista: EmpleadoAsistencia[] = [];
  cargando = false;

  /** Datos crudos de la última respuesta (para los KPIs y las notas al pie). */
  datos: AsistenciaPersonas | null = null;

  // Detalle (modal) del empleado seleccionado
  detalle: EmpleadoAsistencia | null = null;

  // Datos para las gráficas laterales
  dist = { aTiempo: 0, retardo: 0, falta: 0, noMedible: 0 };
  semanasChart: { label: string; corto: string; min: number }[] = [];

  private pollAsist: any;
  private readonly POLL_ASIST_MS = 60000;   // refresco automático de la asistencia

  // ══ SEMÁFORO DE RELOJES ══════════════════════════════════════════
  //
  // Antes esta pantalla se veía igual con un reloj al día que con uno muerto
  // desde hace tres semanas: en los dos casos mostraba la última asistencia que
  // había en la base. El chip "En vivo" de la barra hablaba del refresco de la
  // PANTALLA, no de la llegada del DATO, y eso se leía como si todo estuviera
  // al corriente.
  //
  // Falta de dato ≠ falta del empleado. Esta franja es lo que impide confundir
  // las dos cosas.
  relojes: EstadoReloj[] = [];
  /** La franja arranca colapsada cuando todo está bien; se abre sola si algo falla. */
  relojesAbierto = false;
  private relojesTocado = false;   // ¿el usuario ya la abrió/cerró a mano?

  ngOnInit() {
    const hoy = new Date();
    const hace30 = new Date();
    hace30.setDate(hoy.getDate() - 29);
    this.hasta = aFechaLocal(hoy);
    this.desde = aFechaLocal(hace30);

    if (this.sucursalIdExterna) this.sucursalFiltro = this.sucursalIdExterna;

    // Si RH ya eligió un periodo en esta sesión, ese manda: el componente se
    // desmonta al pasar a Empleados o a Cruces, y antes al volver se reescribía
    // a "los últimos 30 días con dato". Ver PeriodoAsistenciaService.
    if (this.periodo.elegido) {
      this.desde = this.periodo.desde;
      this.hasta = this.periodo.hasta;
      this.cargar();
    } else {
      this.ajustarRangoYCargar();
    }
    this.cargarRelojes();
    this.cargarTiposIncidencia();

    // Refresco automático (en vivo): recarga sin interrumpir si estás cargando o
    // con el detalle abierto.
    this.pollAsist = setInterval(() => this.ngZone.run(() => this.refrescar()), this.POLL_ASIST_MS);
    // El menú de acciones flota con posición FIJA: si la página (o la tabla)
    // se desplaza, se cierra en vez de quedarse flotando lejos de su renglón.
    // En captura, porque el scroll de un contenedor no llega a window.
    window.addEventListener('scroll', this.alDesplazar, true);
    window.addEventListener('resize', this.alDesplazar);
  }

  private alDesplazar = () => {
    if (this.accMenu) this.ngZone.run(() => { this.accMenu = null; });
  };

  /** Recarga silenciosa periódica. */
  private refrescar() {
    // El semáforo se refresca SIEMPRE, incluso con el detalle abierto: si un
    // reloj se cae mientras RH está capturando justificaciones, tiene que
    // enterarse antes de firmar los números.
    this.cargarRelojes();
    if (this.cargando || this.detalle || this.ficha || this.incForm || this.accMenu || this.accEdit) return;
    this.cargar(true);
  }

  /** Estado de los relojes. Si falla, se calla: nunca debe tumbar la pantalla. */
  private async cargarRelojes() {
    // Solo el admin ve el semáforo de relojes: para el resto ni se consulta.
    if (!this.esAdmin) { this.relojes = []; return; }
    try {
      this.relojes = await this.checador.getEstadoRelojes();
      // Se abre sola la primera vez que hay algo que ver, y no se vuelve a
      // imponer si la persona ya decidió cerrarla.
      if (!this.relojesTocado && this.relojesConProblema.length) this.relojesAbierto = true;
    } catch { /* sin semáforo la pantalla sigue sirviendo */ }
  }

  toggleRelojes() {
    this.relojesAbierto = !this.relojesAbierto;
    this.relojesTocado = true;
  }

  // ---- Lectura del semáforo ----

  /** Todo lo que no está en verde: mudos, atrasados y en pausa. */
  get relojesConProblema(): EstadoReloj[] {
    return this.relojes.filter(r => r.semaforo !== 'ok');
  }
  get relojesMudos(): EstadoReloj[] {
    return this.relojes.filter(r => r.semaforo === 'mudo');
  }
  /** Relojes con la hora corrida más de 2 min: sus retardos no son de fiar. */
  get relojesDesfasados(): EstadoReloj[] {
    return this.relojes.filter(r => r.desfaseRelojSeg != null && Math.abs(r.desfaseRelojSeg) > 120);
  }

  /**
   * ¿La sucursal que se está viendo tiene algún reloj sin señal?
   *
   * Esto es lo que marca el resumen: si el reloj de esta plaza está mudo, los
   * números de abajo son de la última vez que hubo dato, no de hoy.
   */
  get relojesDeLaSucursal(): EstadoReloj[] {
    return this.relojes.filter(r => r.sucursalId === this.sucursalFiltro);
  }
  get sucursalSinSenal(): boolean {
    const propios = this.relojesDeLaSucursal;
    return propios.length > 0 && propios.every(r => r.semaforo === 'mudo');
  }

  /**
   * Esta plaza NO tiene reloj instalado — no es que esté fallando.
   *
   * Estas cuatro plazas se escondían del selector justamente para no llegar
   * aquí. Ahora salen, y por eso la pantalla tiene que decir la diferencia
   * entre "no hay equipo" y "el equipo está mudo": la primera se resuelve
   * comprando e instalando un reloj, la segunda revisando la red.
   */
  get sucursalSinReloj(): boolean {
    return !!this.sucursalFiltro && !tieneReloj(this.sucursalFiltro);
  }

  /** Un resumen de una línea para el botón de la franja. */
  get resumenRelojes(): string {
    if (!this.relojes.length) return 'sin relojes registrados';
    const mudos = this.relojesMudos.length;
    const atrasados = this.relojes.filter(r => r.semaforo === 'atrasado').length;
    const pausa = this.relojes.filter(r => r.semaforo === 'pendiente').length;
    const ok = this.relojes.filter(r => r.semaforo === 'ok').length;
    const partes: string[] = [];
    if (ok) partes.push(`${ok} al día`);
    if (atrasados) partes.push(`${atrasados} atrasado${atrasados > 1 ? 's' : ''}`);
    if (mudos) partes.push(`${mudos} sin señal`);
    if (pausa) partes.push(`${pausa} en pausa`);
    return partes.join(' · ');
  }

  /** El peor estado de todos, que es el que le da color a la franja. */
  get peorSemaforo(): SemaforoReloj | 'vacio' {
    if (!this.relojes.length) return 'vacio';
    if (this.relojesMudos.length) return 'mudo';
    if (this.relojes.some(r => r.semaforo === 'atrasado')) return 'atrasado';
    if (this.relojes.some(r => r.semaforo === 'pendiente')) return 'pendiente';
    return 'ok';
  }

  /** "hace 40 s", "hace 1 h 12 m", "sin señal desde el 17 jul". */
  desdeCuando(r: EstadoReloj): string {
    if (r.semaforo === 'pendiente') return 'en pausa';
    // Se muestra el atraso REAL de la cadena, no el de nuestro tramo: decir
    // "hace 2 s" cuando el dato lleva dos horas parado es la mentira que este
    // semáforo existe para evitar.
    const s = r.origenAtrasado ? r.segundosOrigen : r.segundosSinSenal;
    if (s == null) return 'nunca ha reportado';
    if (s < 90) return `hace ${Math.max(0, Math.round(s))} s`;
    if (s < 3600) return `hace ${Math.round(s / 60)} min`;
    if (s < 86400) {
      const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
      return `hace ${h} h${m ? ' ' + m + ' m' : ''}`;
    }
    return r.ultimaSenal
      ? `sin señal desde el ${this.fechaCorta(new Date(r.ultimaSenal))}`
      : `hace ${Math.floor(s / 86400)} días`;
  }

  /**
   * Por qué este reloj no está en verde, dicho de forma accionable. Un "no
   * responde" genérico no le sirve a nadie: hay que saber si es red, equipo,
   * o trabajo pendiente de RH.
   */
  motivoReloj(r: EstadoReloj): string {
    if (r.semaforo === 'pendiente') {
      return r.nota?.includes('numeracion') || r.sucursalId === 'REVISAR-NUMERACION'
        ? 'numeración propia sin traducir — sus marcas se atribuirían a otra persona'
        : 'sin identificar a qué plaza pertenece — sus checadas no se aplican';
    }
    // Primero lo de arriba: si quien nos pasa el dato dejó de leer el reloj,
    // revisar nuestro agente no arregla nada. Perseguir el problema del lado
    // equivocado es lo que hace que estas cosas duren días.
    if (r.origenAtrasado) {
      return 'nuestro agente está al corriente, pero el sistema que lee los relojes ' +
             `no toca este equipo desde hace ${this.duracion(r.segundosOrigen)}. ` +
             'El pendiente está allá, no aquí.';
    }
    if (r.ultimoError) return r.ultimoError;
    if (r.semaforo === 'mudo') return 'nadie ha reportado este reloj: agente apagado, equipo apagado, o sin red';
    if (r.semaforo === 'atrasado') return 'sigue llegando dato, pero más lento de lo normal';
    return '';
  }

  // ══ VISTA TABLA (reporte calcado al ReporteSemMD) ════════════════
  //
  // RH ya conoce el reporte semanal: filas por persona AGRUPADAS POR
  // DEPARTAMENTO, siete columnas de día (jueves→miércoles), con la jornada
  // arriba (entrada – salida) y la comida abajo, y los retardos a la derecha.
  // Esta vista lo reproduce en pantalla desde los mismos datos.
  vistaTabla = true;   // arranca en el formato que RH pidió

  /** Las fechas del rango, en orden, como columnas del reporte. */
  get columnasDia(): { fecha: string; dow: string; dia: string }[] {
    if (!this.desde || !this.hasta) return [];
    const cols: { fecha: string; dow: string; dia: string }[] = [];
    const d = new Date(this.desde + 'T00:00:00');
    const fin = new Date(this.hasta + 'T00:00:00');
    // Tope de seguridad: el reporte es de una semana; si el rango es enorme, no
    // se pinta una tabla de 200 columnas.
    let guarda = 0;
    while (d <= fin && guarda++ < 40) {
      const dow = d.toLocaleDateString('es-MX', { weekday: 'short' }).replace('.', '');
      cols.push({
        fecha: aFechaLocal(d),
        dow: dow.charAt(0).toUpperCase() + dow.slice(1),
        dia: String(d.getDate()).padStart(2, '0'),
      });
      d.setDate(d.getDate() + 1);
    }
    return cols;
  }

  private readonly SIN_DEPTO = 'SIN DEPARTAMENTO';
  private readonly PRACTICANTES = 'PRACTICANTES';

  /** La lista agrupada por departamento, cada grupo ordenado por código. */
  // ══ EXPORTAR POR SECCIONES ══════════════════════════════════════
  //
  // RH no siempre necesita el reporte completo: pide "nada más practicantes"
  // o "nada más los que no tienen departamento" para mandárselo a quien le
  // toca. Antes había que exportar todo y borrar filas en Excel a mano.
  //
  // Se filtra la VISTA, no el export: así lo que se ve es lo que sale, en PDF
  // y en Excel, y no hay dos caminos que puedan discrepar. El PDF sale de la
  // pantalla (regla de impresión en styles.css), así que esconder una sección
  // aquí ya la deja fuera del papel sin tocar una línea de CSS.
  //
  // Las secciones se guardan como OCULTAS y no como seleccionadas: si mañana
  // aparece un departamento nuevo en el padrón, sale a la vista por omisión en
  // vez de quedarse escondido sin que nadie se entere.
  seccionesOcultas = new Set<string>();

  /** Todas las secciones de la plaza, con o sin filtro. Para los chips. */
  get seccionesTodas(): { departamento: string; empleados: EmpleadoAsistencia[]; retardos: number }[] {
    return this.agruparPorDepartamento();
  }

  /** ¿Se está viendo un pedazo del reporte y no la plaza completa? */
  get seleccionParcial(): boolean {
    return this.seccionesOcultas.size > 0 && this.porDepartamento.length > 0;
  }

  /**
   * Las secciones que SÍ van, escritas. Va en el subtítulo del reporte y en el
   * nombre del Excel: un reporte parcial que no dice que lo es se lee como la
   * plaza completa, y sus totales pasan por los de todos.
   */
  get etiquetaSeleccion(): string {
    const vis = this.porDepartamento.map(g => g.departamento);
    if (!this.seccionesOcultas.size) return '';
    if (!vis.length) return 'ninguna sección seleccionada';
    if (vis.length <= 3) return vis.join(' + ');
    return `${vis.length} de ${this.seccionesTodas.length} secciones`;
  }

  seccionVisible(dep: string): boolean { return !this.seccionesOcultas.has(dep); }

  toggleSeccion(dep: string) {
    if (this.seccionesOcultas.has(dep)) this.seccionesOcultas.delete(dep);
    else this.seccionesOcultas.add(dep);
  }

  /** Aísla una sección: el atajo para "solo practicantes" en un clic. */
  soloEstaSeccion(dep: string) {
    this.seccionesOcultas = new Set(
      this.seccionesTodas.map(g => g.departamento).filter(d => d !== dep));
  }

  todasLasSecciones() { this.seccionesOcultas = new Set(); }

  /** El reporte tal como se ve: solo las secciones encendidas. */
  get porDepartamento(): { departamento: string; empleados: EmpleadoAsistencia[]; retardos: number }[] {
    return this.agruparPorDepartamento().filter(g => !this.seccionesOcultas.has(g.departamento));
  }

  private agruparPorDepartamento(): { departamento: string; empleados: EmpleadoAsistencia[]; retardos: number }[] {
    const grupos = new Map<string, EmpleadoAsistencia[]>();
    for (const e of this.lista) {
      // PRACTICANTES: los que RH puso ahí, y los de media jornada (~4 h) que
      // no tienen departamento. Si RH le asignó uno, ESE manda (29/09/2026):
      // antes la detección automática lo sacaba de su departamento y el cambio
      // hecho desde la ficha parecía no funcionar.
      const asignado = e.departamento && e.departamento !== this.SIN_DEPTO ? e.departamento : '';
      const dep = asignado || (e.esPracticante ? this.PRACTICANTES : this.SIN_DEPTO);
      // Los códigos enrolados en el reloj que NO están en el padrón de RH y que
      // además no marcaron en el periodo son ruido: no van al reporte. Los que
      // sí marcaron se conservan (en 'SIN DEPARTAMENTO') para que nada se esconda.
      if (dep === this.SIN_DEPTO && e.diasPorFecha.size === 0) continue;
      if (!grupos.has(dep)) grupos.set(dep, []);
      grupos.get(dep)!.push(e);
    }
    const numOrden = (c: string) => { const n = parseInt(c, 10); return Number.isFinite(n) ? n : 1e9; };
    // PRACTICANTES y SIN DEPARTAMENTO van al final (en ese orden).
    const rangoDepto = (d: string) => (d === this.SIN_DEPTO ? 2 : d === this.PRACTICANTES ? 1 : 0);
    return [...grupos.entries()]
      .sort((a, b) => rangoDepto(a[0]) - rangoDepto(b[0]) || a[0].localeCompare(b[0], 'es'))
      .map(([departamento, empleados]) => ({
        departamento,
        empleados: empleados.sort((a, b) => numOrden(a.codigo) - numOrden(b.codigo) || a.codigo.localeCompare(b.codigo)),
        // MINUTOS tarde en la entrada, no días (28/09/2026): "3 retardos" no
        // dice si fueron 3 minutos o 3 horas.
        retardos: empleados.reduce((s, e) => s + e.atrasoBrutoMin, 0),
      }));
  }

  /** El total de retardos del reporte (pie de página): cuadra con lo mostrado. */
  get totalRetardos(): number {
    return this.porDepartamento.reduce((s, g) => s + g.retardos, 0);
  }

  /** La celda de un día: jornada (entrada–salida) arriba y comida abajo. */
  celda(e: EmpleadoAsistencia, fecha: string): {
    jornada: string; comida: string; retardo: boolean; falta: boolean;
    /** Código de la incidencia de RH ese día ("VAC", "INC"…), o ''. */
    inc: string; incTitulo: string;
  } {
    const d = e.diasPorFecha.get(fecha);
    // La incidencia se busca también en los PERIODOS de la persona: quien estuvo
    // de vacaciones la semana entera no checó y no trae días que pintar.
    const incs = d?.incidencias.length ? d.incidencias
      : e.incidencias.filter(i => i.desde <= fecha && i.hasta >= fecha);
    const inc = incs.map(i => i.codigo).join('·');
    const incTitulo = incs.map(i => i.etiqueta + (i.nota ? ` — ${i.nota}` : '')).join(' · ');
    if (!d) return { jornada: inc, comida: '', retardo: false, falta: false, inc, incTitulo };
    // El descanso que se tomó en día laborable se dice como tal: un guion ahí
    // se leería como su descanso de siempre, y RH tiene que ver que se movió.
    if (d.estadoDia === 'descanso') {
      return { jornada: inc || (d.descansoPorAusencia ? 'DESC.' : '—'), comida: '', retardo: false, falta: false, inc,
               incTitulo: incTitulo || (d.descansoPorAusencia ? 'No checó en un día que normalmente trabaja; se tomó como su descanso de la semana.' : '') };
    }
    // El día justificado se marca como tal en el papel: dejarlo en blanco lo
    // haría indistinguible de un día sin dato, y en rojo sería una falta que RH
    // ya perdonó. Con incidencia, va su código (VAC, INC…) en vez de "JUST.".
    if (d.justificado) return { jornada: inc || 'JUST.', comida: '', retardo: false, falta: false, inc, incTitulo };
    const ent = d.entrada && d.entrada !== '—' ? d.entrada : '0';
    const sal = d.salida && d.salida !== '—' ? d.salida : '0';
    const com = d.comida && d.comida !== '—' ? d.comida.replace(/\s*[–-]\s*/, ' - ') : '';
    return {
      // Una falta con incidencia (p. ej. "falta injustificada") lleva su código
      // en lugar de "0 - 0": ya se revisó, y el papel tiene que decirlo.
      jornada: d.falta && inc ? inc : `${ent} - ${sal}`,
      comida: com,
      retardo: d.atrasoMin > 0,
      falta: d.falta,
      inc, incTitulo,
    };
  }

  // ══ SUMA DE HORAS ═══════════════════════════════════════════════
  //
  // Las horas netas de cada día ya vienen con la comida descontada. En
  // corporativo, el desayuno NO se descuenta cuando el día trae su comida
  // aparte (política de RH, ver api/…/asistencia-personas.ts::detalleDia).

  /** 2750 → "45h 50m". */
  horasTexto(min: number | null | undefined): string {
    if (!min || min <= 0) return '—';
    const h = Math.floor(min / 60), m = Math.round(min % 60);
    return `${h}h ${String(m).padStart(2, '0')}m`;
  }

  /** Total de horas de un departamento. */
  minutosDeGrupo(g: { empleados: EmpleadoAsistencia[] }): number {
    return g.empleados.reduce((t, e) => t + e.minutosTrabajados, 0);
  }

  get minutosTotales(): number {
    return this.porDepartamento.reduce((t, g) => t + this.minutosDeGrupo(g), 0);
  }

  // ══ IRREGULARIDADES ═════════════════════════════════════════════

  private irregularidadesDe(semanas: SemanaAsistencia[], usable: boolean):
      { irregularidades: Irregularidad[]; irregularAlta: boolean } {
    const umbralDesayuno = this.datos?.desayunoAlertaMin ?? 10;
    const out: Irregularidad[] = [];
    for (const s of semanas) for (const d of s.dias) {
      const base = { fecha: d.fecha, diaLabel: d.diaLabel };
      if (d.justificado || d.estadoDia === 'descanso') continue;
      if (d.falta) out.push({ ...base, nivel: 'alta', tipo: 'falta', texto: 'Falta' });
      // El retardo solo es irregularidad si el número se puede usar: con el
      // horario por confirmar, el minuto no es de fiar y no se acusa con él.
      if (d.retardoMin > 0 && usable) {
        out.push({ ...base, nivel: 'alta', tipo: 'retardo', texto: `Llegó ${d.retardoMin} min tarde` });
      }
      if ((d.desayunoExcesoMin || 0) >= umbralDesayuno) {
        out.push({ ...base, nivel: 'alta', tipo: 'desayuno', texto: `Desayuno +${d.desayunoExcesoMin} min` });
      }
      if (d.noMedible) out.push({ ...base, nivel: 'baja', tipo: 'una_marca', texto: 'Solo checó una vez' });
      if (d.atipico) out.push({ ...base, nivel: 'baja', tipo: 'atipico', texto: 'Fuera de su horario' });
    }
    return { irregularidades: out, irregularAlta: out.some(i => i.nivel === 'alta') };
  }

  /** Cuántas altas y bajas trae, para la pastilla de la fila. */
  cuentaIrregular(e: EmpleadoAsistencia, nivel: 'alta' | 'baja'): number {
    return e.irregularidades.filter(i => i.nivel === nivel).length;
  }

  /** Personas con fila en rojo, para el aviso de arriba de la tabla. */
  get personasIrregulares(): number {
    return this.porDepartamento.reduce((t, g) => t + g.empleados.filter(e => e.irregularAlta).length, 0);
  }

  /** Ver solo a quien trae algo en rojo. */
  soloIrregulares = false;

  /** Los empleados de un grupo, con el filtro de "solo irregulares" aplicado. */
  empleadosVisibles(g: { empleados: EmpleadoAsistencia[] }): EmpleadoAsistencia[] {
    return g.empleados.filter(e => (!this.soloIrregulares || e.irregularAlta) && this.coincide(e));
  }

  // ══ BUSCADOR DE TRABAJADORES (28/09/2026) ═════════════════════════
  //
  // Busca en nombre formal, nombre del reloj, clave, departamento y puesto, sin
  // distinguir acentos ni mayúsculas, y con varias palabras en cualquier orden
  // ("lucia garcia" encuentra a "GARCÍA TAPIA LUCÍA"). Filtra lo que se VE en
  // las tres vistas (reporte, tolerancia, faltas); no cambia los números ni lo
  // que se exporta: buscar a alguien no debe producir un PDF de una persona
  // que se lea como el de la plaza.
  busqueda = '';

  get buscando(): boolean { return !!this.busqueda.trim(); }

  private sinAcentos(t: string): string {
    return (t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  coincide(e: EmpleadoAsistencia): boolean {
    const q = this.sinAcentos(this.busqueda.trim());
    if (!q) return true;
    const texto = this.sinAcentos([e.nombreCompleto, e.nombre, e.codigo, e.departamento, e.puesto].join(' '));
    return q.split(/\s+/).every(p => texto.includes(p));
  }

  /** Cuántos coinciden en el reporte (para el aviso "3 de 46"). */
  get coincidencias(): number {
    return this.porDepartamento.reduce((t, g) => t + this.empleadosVisibles(g).length, 0);
  }
  get totalEnReporte(): number {
    return this.porDepartamento.reduce((t, g) => t + g.empleados.length, 0);
  }

  get rebasadosVisibles() { return this.rebasados.filter(r => this.coincide(r.emp)); }
  get faltasVisibles() { return this.faltasNotificables.filter(f => this.coincide(f.emp)); }

  /** La ficha rápida (clic en la fila). */
  ficha: EmpleadoAsistencia | null = null;
  abrirFicha(e: EmpleadoAsistencia) {
    this.ficha = e; this.menuIncidencia = false; this.fichaTipos = false;
    this.cargarCambiosReloj(e);
  }
  cerrarFicha() { this.ficha = null; this.fichaTipos = false; this.fichaReloj = null; }

  /** Relojes de la plaza y los cambios de esta persona (para la ficha). */
  fichaReloj: CambiosReloj | null = null;
  private async cargarCambiosReloj(e: EmpleadoAsistencia) {
    this.fichaReloj = null;
    try {
      const r = await this.checador.getCambiosReloj(this.sucursalFiltro, e.codigo);
      if (this.ficha?.codigo === e.codigo) this.fichaReloj = r;
    } catch { /* sin este dato la ficha sigue sirviendo */ }
  }

  /** Solo los que valen la pena en la ficha: lo pendiente, lo fallido y lo reciente. */
  get comandosVisibles(): ComandoReloj[] {
    return (this.fichaReloj?.comandos || []).filter(c => c.estado !== 'cancelado').slice(0, 6);
  }
  textoComando(c: ComandoReloj): string {
    const que = c.tipo === 'borrar_usuario' ? 'Borrar del reloj'
      : c.tipo === 'restaurar_usuario' ? 'Volver a dar de alta en el reloj'
      : `Renombrar a "${c.payload?.nombre || ''}"`;
    return `${que} · ${c.alias || c.serie}`;
  }
  estadoComando(c: ComandoReloj): string {
    switch (c.estado) {
      case 'hecho': return 'Hecho';
      case 'error': return 'Falló';
      case 'pendiente': return c.intentos ? `Reintentando (${c.intentos})` : 'En espera del agente';
      default: return c.estado;
    }
  }
  async cancelarComando(c: ComandoReloj) {
    const ok = await this.toast.confirmar({
      titulo: 'Cancelar cambio en el reloj',
      mensaje: `¿Seguro? "${this.textoComando(c)}" no se va a ejecutar. Lo que ya cambió en el sistema se queda.`,
      textoConfirmar: 'Sí, cancelar',
    });
    if (!ok) return;
    try {
      await this.checador.cancelarComandoReloj(c.id);
      if (this.ficha) await this.cargarCambiosReloj(this.ficha);
    } catch { this.toast.error('Ya no se pudo cancelar: el agente lo tomó o ya terminó.'); }
  }

  /** Las irregularidades de la ficha, agrupadas por día (un renglón por fecha). */
  get fichaPorDia(): { fecha: string; diaLabel: string; items: Irregularidad[]; incs: FichaInc[] }[] {
    if (!this.ficha) return [];
    const m = new Map<string, { fecha: string; diaLabel: string; items: Irregularidad[]; incs: FichaInc[] }>();
    const dia = (fecha: string, label?: string) => {
      if (!m.has(fecha)) m.set(fecha, { fecha, diaLabel: label || this.etiquetaDia(fecha), items: [], incs: [] });
      return m.get(fecha)!;
    };
    for (const i of this.ficha.irregularidades) dia(i.fecha, i.diaLabel).items.push(i);
    // El día que tiene incidencia la dice AHÍ MISMO: antes el jueves salía como
    // "Falta" a secas y la incidencia de ese día solo aparecía arriba, sin decir
    // qué fue. Se agregan también los días con incidencia que no traen ninguna
    // irregularidad (unas vacaciones bien capturadas no generan falta).
    for (const inc of this.ficha.incidencias) {
      const ini = inc.desde > this.desde ? inc.desde : this.desde;
      const fin = inc.hasta < this.hasta ? inc.hasta : this.hasta;
      for (let f = ini; f <= fin; f = this.diaSiguiente(f)) {
        dia(f).incs.push({ id: inc.id, tipo: inc.tipo, codigo: inc.codigo, etiqueta: inc.etiqueta, nota: inc.nota });
      }
    }
    return [...m.values()].sort((a, b) => a.fecha.localeCompare(b.fecha));
  }

  private diaSiguiente(iso: string): string {
    const d = new Date(iso + 'T12:00:00');
    d.setDate(d.getDate() + 1);
    return aFechaLocal(d);
  }

  /** "Otros" sin descripción no dice nada: la nota es lo que explica qué pasó. */
  get incNotaObligatoria(): boolean { return this.incForm?.tipo.tipo === 'otros'; }

  /** De la ficha al detalle completo (semanas, justificación por día). */
  fichaADetalle() {
    const e = this.ficha;
    this.ficha = null;
    if (e) this.abrir(e);
  }

  // ══ INCIDENCIAS (vacaciones, permisos, incapacidades…) ════════════
  //
  // Se capturan desde el tablero: botón "Incidencia" → menú de tipos → a quién
  // y qué días. "Solo hoy" es el caso común y va a un clic; "Otro día" y
  // "Varios días" abren el calendario. Los tipos que excusan (vacaciones,
  // incapacidad…) sacan la falta del conteo; el catálogo y esa decisión viven
  // en la API (api/src/incidencias.ts).

  tiposIncidencia: TipoIncidencia[] = [];
  /** El menú de la BARRA del reporte. */
  menuIncidencia = false;
  /**
   * Los tipos desplegados dentro de la ficha. Va aparte del menú de la barra:
   * compartían bandera, y al picar "+ Incidencia" en la ficha se abrían los dos.
   */
  fichaTipos = false;
  /** El formulario abierto (null = cerrado). */
  incForm: {
    tipo: TipoIncidencia; codigo: string;
    cuando: 'hoy' | 'dia' | 'rango';
    desde: string; hasta: string; nota: string;
  } | null = null;
  guardandoInc = false;

  private async cargarTiposIncidencia() {
    try { this.tiposIncidencia = await this.checador.getTiposIncidencia(); }
    catch { /* sin catálogo el botón queda deshabilitado; el resto sigue */ }
  }

  /**
   * Abre el formulario. Desde el menú llega solo el tipo; desde la ficha o el
   * detalle llega también la persona (y el día, si se picó uno).
   */
  abrirIncidencia(tipo: TipoIncidencia, codigo = '', fecha = '') {
    const hoy = aFechaLocal(new Date());
    this.menuIncidencia = false;
    this.fichaTipos = false;
    this.incForm = {
      tipo, codigo,
      cuando: fecha && fecha !== hoy ? 'dia' : 'hoy',
      desde: fecha || hoy, hasta: fecha || hoy, nota: '',
    };
  }

  /** Personas para el selector: las de la tabla, por nombre. */
  get personasParaIncidencia(): EmpleadoAsistencia[] {
    return [...this.lista].filter(e => e.registrado)
      .sort((a, b) => a.nombreCompleto.localeCompare(b.nombreCompleto, 'es'));
  }

  /** El periodo que se va a guardar, según "¿cuándo?". */
  private get incPeriodo(): { desde: string; hasta: string } | null {
    const f = this.incForm;
    if (!f) return null;
    if (f.cuando === 'hoy') { const h = aFechaLocal(new Date()); return { desde: h, hasta: h }; }
    if (f.cuando === 'dia') return f.desde ? { desde: f.desde, hasta: f.desde } : null;
    return f.desde && f.hasta && f.hasta >= f.desde ? { desde: f.desde, hasta: f.hasta } : null;
  }

  /** Días que abarca, para decirlo en el botón antes de guardar. */
  get incDias(): number {
    const p = this.incPeriodo;
    if (!p) return 0;
    return Math.round((Date.parse(p.hasta + 'T12:00:00') - Date.parse(p.desde + 'T12:00:00')) / 86400000) + 1;
  }

  async guardarIncidencia() {
    const f = this.incForm, p = this.incPeriodo;
    if (!f || !p || !f.codigo || this.guardandoInc) return;
    if (this.incNotaObligatoria && !f.nota.trim()) {
      this.toast.alerta('Escribe qué pasó: con "Otros" la descripción es lo único que explica la incidencia.');
      return;
    }
    const quien0 = this.lista.find(e => e.codigo === f.codigo)?.nombreCompleto || f.codigo;
    const cuando = p.desde === p.hasta
      ? `el ${this.fechaLarga(p.desde)}`
      : `del ${this.fechaLarga(p.desde)} al ${this.fechaLarga(p.hasta)} (${this.incDias} días)`;
    const ok = await this.toast.confirmar({
      titulo: `Registrar ${f.tipo.etiqueta.toLowerCase()}`,
      mensaje: `¿Seguro? Se registra ${f.tipo.etiqueta.toLowerCase()} para ${quien0} ${cuando}.` +
        (f.tipo.excusaFalta ? ' Esos días dejan de contar como falta.' : ''),
      textoConfirmar: 'Sí, registrar',
    });
    if (!ok) return;
    this.guardandoInc = true;
    try {
      await this.checador.crearIncidencia({
        sucursalId: this.sucursalFiltro, empleadoCodigo: f.codigo,
        tipo: f.tipo.tipo, desde: p.desde, hasta: p.hasta, nota: f.nota,
      });
      const quien = this.lista.find(e => e.codigo === f.codigo)?.nombreCompleto || f.codigo;
      this.toast.exito(`${f.tipo.etiqueta} · ${quien} · ${this.incDias} día(s).`);
      // Una incidencia de hace semanas VALE igual: el cálculo la lee cada vez.
      // Pero si cae fuera del periodo en pantalla no se ve, y parecería que no
      // se guardó: se dice.
      if (p.hasta < this.desde || p.desde > this.hasta) {
        this.toast.alerta(`Quedó registrada del ${this.fechaLarga(p.desde)} al ${this.fechaLarga(p.hasta)}, ` +
          'fuera del periodo que estás viendo. Cambia las fechas para verla en la tabla.');
      }
      this.incForm = null;
      await this.recargarConservandoAbiertos();
    } catch (e) {
      console.error(e);
      this.toast.error('No se pudo guardar la incidencia.');
    } finally {
      this.guardandoInc = false;
    }
  }

  async borrarIncidencia(i: { id: string; etiqueta: string }) {
    const ok = await this.toast.confirmar({
      titulo: 'Quitar incidencia',
      mensaje: `¿Quitar "${i.etiqueta}"? Si excusaba faltas, vuelven a contar.`,
      destructivo: true, textoConfirmar: 'Quitar',
    });
    if (!ok) return;
    try {
      await this.checador.eliminarIncidencia(i.id);
      await this.recargarConservandoAbiertos();
    } catch (e) {
      console.error(e);
      this.toast.error('No se pudo quitar la incidencia.');
    }
  }

  /**
   * Recarga para que la celda y los conteos lo reflejen ya, y vuelve a apuntar
   * la ficha y el detalle abiertos a la persona recalculada: si no, se quedan
   * mostrando la versión de antes del cambio.
   */
  private async recargarConservandoAbiertos() {
    const fichaCod = this.ficha?.codigo, detCod = this.detalle?.codigo;
    await this.cargar();
    if (fichaCod) this.ficha = this.lista.find(e => e.codigo === fichaCod) || null;
    if (detCod) this.detalle = this.lista.find(e => e.codigo === detCod) || null;
  }

  /** ¿Esta plaza mide retardo? Solo corporativo: las sucursales no tienen hora límite. */
  get mideRetardo(): boolean { return this.datos?.mideRetardo !== false; }

  /** Las incidencias de la persona en el periodo, sin repetir tipo (para el aviso del renglón). */
  incidenciasUnicas(e: EmpleadoAsistencia): { codigo: string; tipo: string; titulo: string }[] {
    const m = new Map<string, { codigo: string; tipo: string; titulo: string }>();
    for (const i of e.incidencias) {
      const t = `${i.etiqueta} · ${this.periodoCorto(i)}${i.nota ? ' · ' + i.nota : ''}`;
      const prev = m.get(i.tipo);
      m.set(i.tipo, { codigo: i.codigo, tipo: i.tipo, titulo: prev ? `${prev.titulo}\n${t}` : t });
    }
    return [...m.values()];
  }

  /** "vie 19 sep", para los mensajes de confirmación. */
  private fechaLarga(iso: string): string {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' }).replace(/\./g, '');
  }

  // ══ ACCIONES POR PERSONA, PEGADAS A SU RENGLÓN (26/09/2026) ══════════
  //
  // Lo que RH hace con una persona sin salir del reporte: corregir su nombre,
  // cambiarla de departamento, registrarle una incidencia, darla de baja o, si
  // checa sin estar en el padrón, darla de alta. TODO cambio pide confirmación
  // y dice exactamente qué va a pasar ("de COMPRAS a FINANZAS"), porque a un
  // clic de distancia de un renglón es muy fácil equivocarse de persona.
  //
  // No hay "Borrar": la ficha que se borra la repone la ingesta en minutos
  // (el reloj la sigue trayendo enrolada) y vuelve ACTIVA, sin nombre formal
  // ni departamento. La baja, en cambio, se sostiene y se puede revertir.
  //
  // Esto cambia el PADRÓN del portal, no el reloj: el nombre enrolado en el
  // equipo sigue igual (escribir en los relojes todavía no está construido).

  /** El menú abierto, con su posición en pantalla (fija, para que no lo recorte la tabla). */
  accMenu: { emp: EmpleadoAsistencia; top: number; left: number; arriba: boolean } | null = null;
  /** El formulario de edición abierto. */
  accEdit: {
    tipo: 'nombre' | 'departamento'; emp: EmpleadoAsistencia; valor: string;
    /** Departamento: el nombre nuevo cuando se elige "+ Nuevo departamento". */
    nuevo?: string;
    /** Solo al renombrar: el nombre enrolado en el reloj, y cómo estaba. */
    valorReloj?: string; relojAntes?: string;
  } | null = null;
  accGuardando = false;
  /** Los tipos de incidencia desplegados dentro del menú de acciones. */
  accTipos = false;

  abrirAcciones(ev: MouseEvent, e: EmpleadoAsistencia) {
    ev.stopPropagation();   // el renglón abre la ficha; el botón, solo su menú
    if (this.accMenu?.emp === e) { this.accMenu = null; return; }
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const ALTO = 300, ANCHO = 240;
    const arriba = r.bottom + ALTO > window.innerHeight && r.top > ALTO;
    this.accTipos = false;
    this.menuIncidencia = false;
    this.accMenu = {
      emp: e,
      top: arriba ? r.top - 6 : r.bottom + 6,
      left: Math.max(8, Math.min(r.right - ANCHO, window.innerWidth - ANCHO - 8)),
      arriba,
    };
  }
  cerrarAcciones() { this.accMenu = null; this.accTipos = false; }

  /** Departamentos que ya existen en la plaza, para sugerirlos. */
  get departamentosDeLaPlaza(): string[] {
    const s = new Set<string>();
    for (const e of this.lista) {
      if (e.departamento && e.departamento !== this.SIN_DEPTO && e.departamento !== this.PRACTICANTES) s.add(e.departamento);
    }
    return [...s].sort((a, b) => a.localeCompare(b, 'es'));
  }

  deptoActualTexto(e: EmpleadoAsistencia): string { return this.deptoActual(e) || 'SIN DEPARTAMENTO'; }

  private deptoActual(e: EmpleadoAsistencia): string {
    return e.departamento === this.SIN_DEPTO ? '' : e.departamento;
  }

  accEditar(tipo: 'nombre' | 'departamento', directo?: EmpleadoAsistencia) {
    const e = directo || this.accMenu?.emp;
    this.cerrarAcciones();
    if (!e) return;
    this.accEdit = tipo === 'nombre'
      ? { tipo, emp: e, valor: e.nombreCompleto, valorReloj: e.nombre, relojAntes: e.nombre }
      : { tipo, emp: e, valor: this.deptoActual(e), nuevo: '' };
    if (tipo === 'departamento') this.cargarDeptosDePlaza();
  }

  /**
   * TODOS los departamentos de la sucursal, con cuánta gente hay en cada uno.
   * Salen del PADRÓN de la plaza, no del reporte en pantalla (que solo trae a
   * quien checó en el periodo). Antes era un campo de texto con sugerencias:
   * como traía escrito el departamento actual, el navegador solo sugería ese
   * mismo, y la lista parecía vacía.
   */
  deptosDePlaza: { nombre: string; n: number }[] = [];
  readonly NUEVO_DEPTO = '__nuevo__';
  private async cargarDeptosDePlaza() {
    const cuenta = new Map<string, number>();
    const sumar = (d: string | null | undefined) => {
      const k = (d || '').trim().toUpperCase();
      if (k && k !== this.SIN_DEPTO) cuenta.set(k, (cuenta.get(k) || 0) + 1);
    };
    try {
      const fichas = await this.checador.getEmpleadosDeSucursal(this.sucursalFiltro);
      for (const f of fichas) if (f.activo !== false && !f.esPromotora) sumar(f.departamento);
    } catch {
      for (const e of this.lista) sumar(e.departamento);   // sin red: lo que hay en pantalla
    }
    const actual = this.accEdit ? this.deptoActual(this.accEdit.emp).toUpperCase() : '';
    if (actual && !cuenta.has(actual)) cuenta.set(actual, 1);
    this.deptosDePlaza = [...cuenta.entries()].map(([nombre, n]) => ({ nombre, n }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    if (this.accEdit?.tipo === 'departamento') this.accEdit.valor = actual;
  }

  /**
   * El nombre como lo va a guardar el reloj: sin acentos, solo ASCII, 23
   * caracteres. Es la misma regla que la API y el agente; aquí es para
   * ENSEÑARLO antes de confirmar ("Aarón" se va a ver "Aaron").
   */
  nombreParaReloj(t: string | undefined): string {
    return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9 .\-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 23).trim();
  }

  /** Cuántos relojes tiene la plaza (para decirlo en las confirmaciones). */
  private async relojesDeLaPlaza(e: EmpleadoAsistencia): Promise<number> {
    try {
      if (this.fichaReloj && this.ficha?.codigo === e.codigo) return this.fichaReloj.relojes.length;
      return (await this.checador.getCambiosReloj(this.sucursalFiltro, e.codigo)).relojes.length;
    } catch { return 0; }
  }

  accIncidencia(t: TipoIncidencia) {
    const e = this.accMenu?.emp;
    this.cerrarAcciones();
    if (e) this.abrirIncidencia(t, e.codigo);
  }

  accDetalle() {
    const e = this.accMenu?.emp;
    this.cerrarAcciones();
    if (e) this.abrir(e);
  }

  /** La ficha del padrón de esta persona (la del reporte no trae el id). */
  private async fichaDe(e: EmpleadoAsistencia): Promise<Empleado | null> {
    const todas = await this.checador.getEmpleadosDeSucursal(this.sucursalFiltro);
    return todas.find(x => String(x.codigoChecador).trim() === e.codigo) || null;
  }

  async guardarAccion() {
    const a = this.accEdit;
    if (!a || this.accGuardando) return;
    if (a.tipo === 'nombre') return this.guardarNombres(a);
    const elegido = a.valor === this.NUEVO_DEPTO ? (a.nuevo || '') : a.valor;
    if (a.valor === this.NUEVO_DEPTO && !elegido.trim()) { this.toast.alerta('Escribe el nombre del departamento nuevo.'); return; }
    const nuevo = elegido.trim().replace(/\s+/g, ' ').toUpperCase();
    const antes = this.deptoActual(a.emp).toUpperCase();
    if (nuevo === antes) { this.accEdit = null; return; }

    const ok = await this.toast.confirmar(
      {
          titulo: 'Cambiar departamento',
          mensaje: `¿Seguro? ${a.emp.nombreCompleto} pasará de ${antes || 'SIN DEPARTAMENTO'} a ` +
            `${nuevo || 'SIN DEPARTAMENTO'}.`,
          textoConfirmar: 'Sí, cambiar',
        });
    if (!ok) return;

    this.accGuardando = true;
    try {
      const ficha = await this.fichaDe(a.emp);
      if (!ficha) { this.toast.error('No encontré su ficha en el padrón. Recarga e intenta de nuevo.'); return; }
      await this.checador.guardarEmpleado({ ...ficha, departamento: nuevo });
      this.toast.exito(`${a.emp.nombreCompleto} → ${nuevo || 'SIN DEPARTAMENTO'}.`);
      this.accEdit = null;
      await this.recargarConservandoAbiertos();
    } catch (err) {
      console.error(err);
      this.toast.error('No se pudo guardar el cambio.');
    } finally {
      this.accGuardando = false;
    }
  }

  /**
   * Renombrar: el nombre FORMAL (el del reporte) y el que tiene ENROLADO en el
   * reloj son dos cosas y pueden cambiar por separado. El del reloj se aplica
   * en el sistema al instante y en cada reloj de la plaza vía el agente.
   */
  private async guardarNombres(a: NonNullable<AsistenciaResumenComponent['accEdit']>) {
    const formal = a.valor.trim().replace(/\s+/g, ' ').toUpperCase();
    if (!formal) { this.toast.alerta('Escribe el nombre completo.'); return; }
    const reloj = this.nombreParaReloj(a.valorReloj);
    const cambiaFormal = formal !== a.emp.nombreCompleto.toUpperCase();
    const cambiaReloj = !!reloj && reloj !== (a.relojAntes || '').trim();
    if (!cambiaFormal && !cambiaReloj) { this.accEdit = null; return; }
    if (a.valorReloj?.trim() && !reloj) { this.toast.alerta('El nombre para el reloj quedó vacío: usa letras sin símbolos.'); return; }

    const n = cambiaReloj ? await this.relojesDeLaPlaza(a.emp) : 0;
    const partes: string[] = [];
    if (cambiaFormal) partes.push(`En el reporte: "${a.emp.nombreCompleto}" → "${formal}".`);
    if (cambiaReloj) {
      partes.push(`En el reloj: "${a.relojAntes}" → "${reloj}"` +
        (n ? `, en ${n} reloj${n > 1 ? 'es' : ''} de la plaza (lo aplica el agente en uno o dos minutos).`
           : '. Esta plaza no tiene relojes a los que el agente pueda escribir: solo cambia en el sistema.'));
    }
    const ok = await this.toast.confirmar({
      titulo: 'Cambiar nombre',
      mensaje: `¿Seguro? ${partes.join(' ')}`,
      textoConfirmar: 'Sí, cambiar',
    });
    if (!ok) return;

    this.accGuardando = true;
    try {
      if (cambiaFormal) {
        const ficha = await this.fichaDe(a.emp);
        if (!ficha) { this.toast.error('No encontré su ficha en el padrón. Recarga e intenta de nuevo.'); return; }
        await this.checador.guardarEmpleado({ ...ficha, nombreCompleto: formal });
      }
      if (cambiaReloj) await this.checador.renombrarEnReloj(this.sucursalFiltro, a.emp.codigo, reloj);
      this.toast.exito(cambiaReloj && n ? 'Nombre cambiado. El reloj se actualiza en unos minutos.' : 'Nombre cambiado.');
      this.accEdit = null;
      await this.recargarConservandoAbiertos();
      if (this.ficha) this.cargarCambiosReloj(this.ficha);
    } catch (err) {
      console.error(err);
      this.toast.error('No se pudo cambiar el nombre.');
    } finally {
      this.accGuardando = false;
    }
  }

  // "Eliminar definitivamente" se quitó (29/09/2026): a nadie se le borra, se
  // le da de BAJA y se va a la Papelera de empleados, de donde se le regresa.

  async accBaja(directo?: EmpleadoAsistencia) {
    const e = directo || this.accMenu?.emp;
    this.cerrarAcciones();
    if (!e) return;
    const ok = await this.toast.confirmar({
      titulo: 'Dar de baja',
      mensaje: `¿Seguro que quieres dar de baja a ${e.nombreCompleto} (#${e.codigo})? ` +
        'Deja de contar en la asistencia y se va a la Papelera de empleados, de donde la puedes ' +
        'regresar cuando se necesite. Sus checadas no se borran y el reloj no se toca.',
      destructivo: true, textoConfirmar: 'Sí, dar de baja',
    });
    if (!ok) return;
    try {
      const ficha = await this.fichaDe(e);
      // Un código que checa sin ficha también se puede dar de baja: se le abre
      // la ficha ya inactiva, y así el reloj no lo vuelve a dar de alta.
      await this.checador.guardarEmpleado(ficha
        ? { ...ficha, activo: false }
        : { sucursalId: this.sucursalFiltro, codigoChecador: e.codigo, nombre: e.nombre, activo: false });
      this.toast.exito(`${e.nombreCompleto} se fue a la Papelera de empleados.`);
      if (this.ficha?.codigo === e.codigo) this.ficha = null;
      await this.cargar();
    } catch (err) {
      console.error(err);
      this.toast.error('No se pudo dar de baja.');
    }
  }

  /** Para un código que checa sin ficha: darlo de alta con el nombre del reloj. */
  async accAlta() {
    const e = this.accMenu?.emp;
    this.cerrarAcciones();
    if (!e) return;
    const ok = await this.toast.confirmar({
      titulo: 'Agregar al padrón',
      mensaje: `¿Seguro? El código #${e.codigo} checa en esta plaza sin estar en el padrón. ` +
        `Se dará de alta como "${e.nombre}"; después puedes corregirle el nombre y el departamento.`,
      textoConfirmar: 'Sí, agregar',
    });
    if (!ok) return;
    try {
      await this.checador.guardarEmpleado({
        sucursalId: this.sucursalFiltro, codigoChecador: e.codigo, nombre: e.nombre, activo: true,
      });
      this.toast.exito(`#${e.codigo} quedó en el padrón.`);
      await this.cargar();
    } catch (err) {
      console.error(err);
      this.toast.error('No se pudo agregar al padrón.');
    }
  }

  /** "12 sep" o "12 → 19 sep", para la lista de incidencias de la ficha. */
  periodoCorto(i: { desde: string; hasta: string }): string {
    const f = (iso: string) => {
      const d = new Date(iso + 'T00:00:00');
      return `${d.getDate()} ${d.toLocaleDateString('es-MX', { month: 'short' }).replace('.', '')}`;
    };
    return i.desde === i.hasta ? f(i.desde) : `${f(i.desde)} → ${f(i.hasta)}`;
  }

  /**
   * Exporta el reporte a PDF con la impresión del navegador (Guardar como PDF).
   * Sin librería y 100% fiel: se marca el body para que el CSS de impresión
   * esconda todo menos la tabla, y se restaura al terminar.
   */
  /** Se pone en true mientras se arma el PDF: el botón no debe verse muerto. */
  generandoPdf = false;

  /**
   * DESCARGA el reporte en PDF. No abre el diálogo de impresión.
   *
   * ══ POR QUÉ YA NO SE USA window.print() ══
   *
   * Antes el botón marcaba el <body> y llamaba a `window.print()`. Eso NO
   * descarga nada: abre el diálogo del navegador y deja el trabajo a quien lo
   * abrió —elegir "Guardar como PDF", quitar el encabezado con la URL y la
   * fecha, poner el nombre del archivo—. Para un botón que dice "PDF" es
   * cuatro pasos de más, y el archivo sale distinto según quién lo guarde.
   *
   * Ahora el PDF se arma aquí y se descarga con su nombre. De paso se arreglan
   * tres cosas que la impresión del navegador hacía mal y no se podían tocar
   * desde el CSS:
   *
   *   · Una fila podía cortarse a la mitad entre dos hojas. `autoTable` pagina
   *     por fila, así que eso ya no pasa.
   *   · La hoja 2 en adelante no decía de qué plaza ni de qué periodo era. Si
   *     alguien separaba las hojas, no había forma de saberlo. Ahora cada hoja
   *     lleva plaza, periodo y "Hoja N de M".
   *   · Un departamento podía quedar con su encabezado al pie de una hoja y su
   *     gente en la siguiente.
   *
   * La librería se carga SOLO al picar el botón (`import()` dinámico): pesa más
   * que toda la pantalla de asistencia junta y no tiene por qué viajar en la
   * carga inicial de quien nunca exporta.
   */
  async exportarPdf() {
    const grupos = this.porDepartamento;
    if (!grupos.length) {
      this.toast.alerta(this.seleccionParcial
        ? 'No hay nada que exportar en las secciones que dejaste encendidas.'
        : 'No hay asistencia para exportar en este rango.');
      return;
    }
    const dias = this.columnasDia;
    // El reporte está pensado para UNA semana. Con un mes en pantalla salen 30
    // columnas y el papel las encoge hasta que no se leen: más vale decirlo que
    // entregar un PDF ilegible.
    if (dias.length > 14) {
      this.toast.alerta(`El periodo trae ${dias.length} días y el reporte cabe bien hasta 14. ` +
        'Usa el atajo de Esta semana o Semana pasada para que se lea.');
    }

    this.generandoPdf = true;
    try {
      const [{ default: JsPDF }, { default: autoTable }] = await Promise.all([
        import('jspdf'),
        import('jspdf-autotable'),
      ]);

      const doc = new JsPDF({ orientation: 'landscape', unit: 'mm', format: 'letter' });
      const ancho = doc.internal.pageSize.getWidth();

      const head = [['Clv', 'Nombre', ...dias.map(c => `${c.dow} ${c.dia}`), 'Horas', this.mideRetardo ? 'Min. retardo' : 'Retardo']];
      const body: any[] = [];
      for (const g of grupos) {
        body.push([{
          content: `${g.departamento}  (${g.empleados.length})`,
          colSpan: dias.length + 4,
          styles: { fillColor: [238, 242, 248], textColor: [26, 47, 78], fontStyle: 'bold' },
        }]);
        for (const e of g.empleados) {
          const celdas = dias.map(c => {
            const cel = this.celda(e, c.fecha);
            return {
              content: [cel.jornada, cel.comida].filter(Boolean).join('\n'),
              // Falta y retardo se marcan como en pantalla: el PDF se firma, y
              // un día en rojo tiene que verse igual en los dos lados.
              styles: cel.falta ? { fillColor: [248, 230, 230], textColor: [107, 20, 20] }
                : cel.retardo ? { textColor: [161, 38, 38], fontStyle: 'bold' as const }
                : {},
            };
          });
          body.push([e.codigo, e.nombreCompleto, ...celdas, this.horasTexto(e.minutosTrabajados),
            this.mideRetardo ? (e.atrasoBrutoMin || '') : '—']);
        }
        body.push([{
          content: '', colSpan: dias.length + 2, styles: { fillColor: [255, 255, 255] },
        }, { content: this.horasTexto(this.minutosDeGrupo(g)), styles: { fontStyle: 'bold' as const, halign: 'center' as const } },
           { content: this.mideRetardo ? String(g.retardos || 0) : '—', styles: { fontStyle: 'bold' as const, halign: 'right' as const } }]);
      }

      // Medido con 105 personas y 7 columnas: a 7.5 pt con relleno de 1 mm el
      // reporte salia en SEIS hojas, contra las tres de la version impresa. El
      // renglon lleva dos lineas (jornada y comida), asi que la altura manda. A
      // 6 pt con relleno de 0.5 baja a cuatro, que es la densidad de siempre.
      const tam = dias.length > 10 ? 5 : dias.length > 7 ? 5.5 : 6;
      autoTable(doc, {
        head,
        body,
        foot: [[{ content: 'Totales', colSpan: dias.length + 2, styles: { halign: 'right' as const } },
                { content: this.horasTexto(this.minutosTotales), styles: { halign: 'center' as const } },
                { content: String(this.totalRetardos), styles: { halign: 'right' as const } }]],
        startY: 20,
        margin: { top: 20, left: 8, right: 8, bottom: 12 },
        styles: { fontSize: tam, cellPadding: 0.5, lineColor: [214, 222, 235], lineWidth: 0.1, valign: 'middle' },
        headStyles: { fillColor: [26, 47, 78], textColor: 255, fontSize: tam, halign: 'center' },
        footStyles: { fillColor: [238, 242, 248], textColor: [26, 47, 78], fontStyle: 'bold' },
        columnStyles: {
          0: { cellWidth: 11, halign: 'center' },
          1: { cellWidth: dias.length > 10 ? 38 : 46 },
          [dias.length + 2]: { cellWidth: 15, halign: 'center' },
          [dias.length + 3]: { cellWidth: 15, halign: 'center' },
        },
        // Una fila nunca se parte, y un encabezado de departamento no se queda
        // solo al pie de la hoja.
        rowPageBreak: 'avoid',
        theme: 'grid',
      });

      // El encabezado se estampa AL FINAL, cuando ya se sabe cuántas hojas son:
      // "Hoja 2 de 3" no se puede escribir mientras se dibuja la 2.
      const total = doc.getNumberOfPages();
      const parcial = this.seleccionParcial ? ` · solo ${this.etiquetaSeleccion}` : '';
      for (let i = 1; i <= total; i++) {
        doc.setPage(i);
        doc.setFontSize(11); doc.setTextColor(26, 47, 78);
        doc.text(this.nombreSucursal(this.sucursalFiltro), 8, 10);
        doc.setFontSize(8); doc.setTextColor(90, 105, 130);
        doc.text(this.tituloReporte + parcial, 8, 15);
        doc.text(`Hoja ${i} de ${total}`, ancho - 8, 10, { align: 'right' });
      }

      const limpiaTxt = (t: string) => t.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
      const parte = grupos.length === 1 ? '_' + limpiaTxt(grupos[0].departamento) : '';
      doc.save(`Asistencia_${limpiaTxt(this.nombreSucursal(this.sucursalFiltro))}${parte}_${this.desde}_a_${this.hasta}.pdf`);
    } catch (e) {
      console.error('Error al generar el PDF:', e);
      this.toast.error('No se pudo generar el PDF.');
    } finally {
      this.generandoPdf = false;
    }
  }

  /** Cabecera del reporte: "Asistencia del DD/MM al DD/MM". */
  get tituloReporte(): string {
    const f = (s: string) => { const d = new Date(s + 'T00:00:00'); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getFullYear()).slice(2)}`; };
    return this.desde && this.hasta
      ? `Asistencia del ${f(this.desde)} al ${f(this.hasta)} · ${this.semanasDelPeriodo}` : '';
  }

  // ══ SEMANA FISCAL (28/09/2026) ══════════════════════════════════════
  //
  // La semana fiscal es la de nómina (jueves→miércoles) contada desde la que
  // contiene el 1 de enero: ver core/models/semana-fiscal.ts.

  /** La semana en la que vamos hoy. */
  get semanaHoy(): SemanaFiscal { return semanaFiscal(aFechaLocal(new Date()), this.diaCorte); }

  /**
   * La semana fiscal del PERIODO en pantalla (el recuadro de la barra).
   *
   * Mostraba siempre la de HOY: se elegía otra semana en el calendario y el
   * recuadro seguía diciendo 39. Ahora sigue a las fechas: una semana → "37";
   * varias → "37–39"; si cruza de año, cada número con su año.
   */
  get semanaPeriodo(): { numeros: string; total: number; esActual: boolean; titulo: string } {
    const hoy = this.semanaHoy;
    if (!this.desde || !this.hasta) {
      return { numeros: String(hoy.numero), total: hoy.total, esActual: true, titulo: '' };
    }
    const a = semanaFiscal(this.desde, this.diaCorte), b = semanaFiscal(this.hasta, this.diaCorte);
    const numeros = a.anio !== b.anio ? `${a.numero}/${a.anio}–${b.numero}/${b.anio}`
      : a.numero === b.numero ? String(a.numero) : `${a.numero}–${b.numero}`;
    const esActual = b.anio === hoy.anio && b.numero === hoy.numero;
    const rango = a.numero === b.numero && a.anio === b.anio
      ? `del ${this.fechaLarga(a.inicio)} al ${this.fechaLarga(a.fin)}`
      : `de la ${a.numero} (${this.fechaLarga(a.inicio)}) a la ${b.numero} (${this.fechaLarga(b.fin)})`;
    return {
      numeros, total: b.total, esActual,
      titulo: `Semana de nómina (jueves a miércoles) ${rango}. Calendario de nómina de 52 semanas (la semana 1 del ciclo 2026 fue del 18 al 24 de diciembre de 2025). ` +
        `Hoy vamos en la ${hoy.numero}.`,
    };
  }

  /** "Semana 39" o "Semanas 37 a 39" (con el año si el periodo cruza de año). */
  get semanasDelPeriodo(): string {
    if (!this.desde || !this.hasta) return '';
    const a = semanaFiscal(this.desde, this.diaCorte), b = semanaFiscal(this.hasta, this.diaCorte);
    if (a.anio === b.anio && a.numero === b.numero) return `Semana ${a.numero} de ${a.total}`;
    if (a.anio === b.anio) return `Semanas ${a.numero} a ${b.numero}`;
    return `Semana ${a.numero}/${a.anio} a ${b.numero}/${b.anio}`;
  }

  /** "40 s", "12 min", "2 h 30 m" — para redactar los motivos. */
  private duracion(seg: number | null): string {
    if (seg == null) return 'un rato';
    if (seg < 90) return `${Math.max(0, Math.round(seg))} s`;
    if (seg < 3600) return `${Math.round(seg / 60)} min`;
    const h = Math.floor(seg / 3600), m = Math.round((seg % 3600) / 60);
    return `${h} h${m ? ' ' + m + ' m' : ''}`;
  }

  /** El texto de la deriva, que es lo que convierte un retardo real en uno inventado. */
  desfaseTexto(r: EstadoReloj): string {
    const d = r.desfaseRelojSeg;
    if (d == null || Math.abs(d) <= 120) return '';
    const min = Math.round(Math.abs(d) / 60);
    return `hora corrida ${d > 0 ? '+' : '−'}${min} min`;
  }

  /** Lo que le falta a la base contra lo que el equipo dice tener. */
  faltantesTexto(r: EstadoReloj): string {
    if (r.logsEnReloj == null || r.logsEnBase == null) return '';
    const falta = r.logsEnReloj - r.logsEnBase;
    if (falta <= 0) return 'completo';
    return `faltan ${falta.toLocaleString('es-MX')}`;
  }

  ngOnChanges(cambios: SimpleChanges) {
    if (cambios['sucursalIdExterna'] && !cambios['sucursalIdExterna'].firstChange) {
      const nueva = this.sucursalIdExterna || '';
      if (nueva && nueva !== this.sucursalFiltro) {
        this.sucursalFiltro = nueva;
        // Igual que el selector propio: se conserva el periodo, solo se recarga.
        this.cargar();
      }
    }
    // Tras importar un archivo se RECARGA con el mismo periodo. Antes se
    // reajustaba a los datos de la plaza, y era otra de las formas en que el
    // periodo elegido se perdía sin que nadie lo tocara.
    if (cambios['recargarToken'] && !cambios['recargarToken'].firstChange) {
      this.cargar();
    }
  }

  ngOnDestroy() {
    if (this.pollAsist) clearInterval(this.pollAsist);
    window.removeEventListener('scroll', this.alDesplazar, true);
    window.removeEventListener('resize', this.alDesplazar);
  }

  // ---- KPIs del periodo ----
  /** Retardo REAL del periodo (excedente de la bolsa), de todas las personas. */
  get retardoAcumulado(): number { return this.datos?.resumen.retardoRealMin ?? 0; }
  /** El que sí se puede usar: sin personas bloqueadas por una marca alta. */
  get retardoUsable(): number { return this.datos?.resumen.retardoRealUsableMin ?? 0; }
  get faltasTotales(): number { return this.datos?.resumen.faltas ?? 0; }
  get noMediblesTotales(): number { return this.datos?.resumen.diasNoMedibles ?? 0; }
  get horasTotales(): number { return this.datos?.resumen.horasTrabajadas ?? 0; }
  get totalConRetardo(): number { return this.lista.filter(e => e.acumuladoTotal > 0).length; }
  get totalUsables(): number { return this.datos?.resumen.usables ?? 0; }
  get porConfirmar(): number { return this.datos?.resumen.horarioAmbiguo ?? 0; }
  get bolsaSemanal(): number { return this.datos?.bolsaSemanalMin ?? 15; }

  /** Cómo llamarle a la gente que se está midiendo, según la pantalla. */
  get comoSeLlaman(): string { return this.soloPromotoras ? 'Promotoras' : 'Empleados'; }

  // Al cambiar de sucursal se CONSERVA el periodo elegido y solo se recarga.
  //
  // Antes se llamaba a `ajustarRangoYCargar()`, que reescribía las fechas a los
  // últimos 30 días de la nueva plaza. Eso obligaba a volver a fijar el periodo
  // cada vez que se saltaba de una sucursal a otra —justo lo que se hace para
  // comparar el MISMO rango entre plazas—. El autoajuste sigue existiendo, pero
  // solo donde tiene sentido: en la carga inicial y en el botón "Todo".
  onSucursalChange() { this.cargar(); }

  /** Solo el día de hoy. */
  aplicarHoy() {
    this.desde = this.hasta = aFechaLocal(new Date());
    this.cargar();
  }
  get hoyActivo(): boolean {
    const h = aFechaLocal(new Date());
    return this.desde === h && this.hasta === h;
  }

  /** El día que abre la semana de nómina. Lo manda la API; 4 = jueves. */
  private get diaCorte(): number {
    return this.datos?.diaInicioSemana ?? 4;
  }

  /** Inicio de la semana de nómina que contiene a esa fecha. */
  private inicioSemanaDe(f: Date): Date {
    const atras = (f.getDay() - this.diaCorte + 7) % 7;
    const d = new Date(f);
    d.setDate(f.getDate() - atras);
    return d;
  }

  /**
   * Semana de nómina completa. `off` 0 es la de hoy, -1 la anterior.
   *
   * La semana en curso se corta en HOY, no en su jueves final: pedir hasta una
   * fecha futura llenaría el reporte de columnas vacías que se leen como faltas.
   */
  private limitesSemana(off: number): { desde: string; hasta: string } {
    const hoy = new Date();
    const ini = this.inicioSemanaDe(hoy);
    ini.setDate(ini.getDate() + off * 7);
    const fin = new Date(ini);
    fin.setDate(ini.getDate() + 6);
    return { desde: aFechaLocal(ini), hasta: aFechaLocal(fin < hoy ? fin : hoy) };
  }

  aplicarSemana(off: number) {
    const r = this.limitesSemana(off);
    this.desde = r.desde;
    this.hasta = r.hasta;
    this.cargar();
  }
  semanaActiva(off: number): boolean {
    const r = this.limitesSemana(off);
    return this.desde === r.desde && this.hasta === r.hasta;
  }
  /** "jue 20 ago → hoy": qué periodo trae ese atajo, sin tener que picarlo. */
  etiquetaSemanaAtajo(off: number): string {
    const r = this.limitesSemana(off);
    const corta = (iso: string) => {
      const d = new Date(iso + 'T00:00:00');
      const dow = d.toLocaleDateString('es-MX', { weekday: 'short' }).replace('.', '');
      return `${dow} ${d.getDate()} ${d.toLocaleDateString('es-MX', { month: 'short' }).replace('.', '')}`;
    };
    const hoy = aFechaLocal(new Date());
    return `Semana ${semanaFiscal(r.desde, this.diaCorte).numero} · ${corta(r.desde)} → ${r.hasta === hoy ? 'hoy' : corta(r.hasta)}`;
  }

  /** Ajusta el rango a los últimos 30 días CON datos de la sucursal, luego carga. */
  async ajustarRangoYCargar() {
    if (!this.sucursalFiltro) { this.lista = []; this.computarTolerancia(); return; }
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

  async cargar(silencioso = false) {
    // Todo cambio de periodo pasa por aquí (atajos, calendario, autoajuste): es
    // el único punto donde hace falta recordarlo.
    if (this.desde && this.hasta) this.periodo.fijar(this.desde, this.hasta);
    if (!this.sucursalFiltro || !this.desde || !this.hasta) { this.lista = []; this.computarTolerancia(); return; }
    if (!silencioso) this.cargando = true;
    try {
      this.datos = await this.checador.getAsistencia(
        this.sucursalFiltro, this.desde, this.hasta, this.soloPromotoras);
      this.lista = this.datos.personas.map(p => this.aVista(p));
      this.computarGraficas();
      this.computarTolerancia();
    } catch (e) {
      console.error('Error al cargar asistencia:', e);
      if (!silencioso) {
        this.toast.error('No se pudieron cargar la asistencia.');
        this.lista = []; this.datos = null;
        this.computarTolerancia();   // si no, queda el apartado lleno sin datos detrás
      }
    } finally {
      if (!silencioso) this.cargando = false;
    }
  }

  // ------- De la respuesta de la API a la vista -------

  private aVista(p: PersonaAsistencia): EmpleadoAsistencia {
    const semanas: SemanaAsistencia[] = p.semanas.map(s => ({
      inicio: s.inicio,
      label: `Sem ${semanaFiscal(s.inicio, this.diaCorte).numero} · ${this.etiquetaSemana(s.inicio)}`,
      fiscal: semanaFiscal(s.inicio, this.diaCorte),
      acumulado: s.retardoRealMin,
      atrasoMin: s.atrasoMin,
      minutosTrabajados: s.minutosTrabajados ?? 0,
      bolsaRestante: s.bolsaRestante,
      excedido: s.bolsaAgotada,
      dias: s.dias.map(d => ({
        fecha: d.fecha,
        diaLabel: this.etiquetaDia(d.fecha),
        // En un día de una sola marca se muestra la hora que sí existe, sin
        // llamarla "entrada": no se sabe si lo es.
        entrada: d.entrada || d.hora || '—',
        comida: d.comida || '—',
        salida: d.salida || '—',
        horasNetas: d.horasNetas || '—',
        desayunoMin: d.desayunoMin ?? null,
        desayunoExcesoMin: d.desayunoExcesoMin ?? null,
        retardoMin: d.retardoRealMin,
        atrasoMin: d.atrasoMin,
        absorbidoMin: d.absorbidoMin,
        referencia: d.referencia || '—',
        estadoDia: d.estado,
        falta: d.estado === 'falta',
        noMedible: d.estado === 'marca_faltante',
        justificado: d.estado === 'justificado',
        atipico: !!d.atipico,
        justificacion: '',
        estado: 'pendiente' as EstadoRevision,
        netasMin: d.netasMin ?? 0,
        desayunoPagado: !!d.desayunoPagado,
        descansoPorAusencia: !!d.descansoPorAusencia,
        incidencias: d.incidencias || [],
      }))
    }));

    // Índice día-por-fecha para pintar las columnas del reporte de un vistazo.
    const diasPorFecha = new Map<string, DiaAsistencia>();
    for (const s of semanas) for (const d of s.dias) diasPorFecha.set(d.fecha, d);

    return {
      codigo: p.codigo,
      nombre: p.nombre || '(sin registrar)',
      nombreCompleto: p.nombreCompleto || p.nombre || '(sin registrar)',
      departamento: (p.departamento || '').trim().toUpperCase() || 'SIN DEPARTAMENTO',
      esPracticante: !!p.esPracticante,
      diasPorFecha,
      fotoUrl: p.fotoUrl,
      puesto: p.puesto,
      registrado: p.registrado,
      tipo: p.tipo,
      horario: p.horario || '—',
      turnos: (p.turnos || []).filter(Boolean).join(' · '),
      horarioConfirmado: p.horarioConfirmado,
      costumbre: p.costumbre || '—',
      acumuladoTotal: p.retardoRealMin,
      atrasoBrutoMin: p.atrasoBrutoMin,
      absorbidoMin: p.absorbidoMin,
      semanasExcedidas: p.semanas.filter(s => s.bolsaAgotada).length,
      diasConRetardo: p.diasConRetardo,
      diasRegistrados: p.diasEvaluados,
      faltas: p.faltas,
      faltasJustificadas: p.faltasJustificadas ?? 0,
      noMedibles: p.diasNoMedibles,
      atipicos: p.diasAtipicos,
      horasTrabajadas: p.horasTrabajadas,
      minutosTrabajados: p.minutosTrabajados ?? Math.round(p.horasTrabajadas * 60),
      incidencias: p.incidencias || [],
      ...this.irregularidadesDe(semanas, p.usable),
      presupuesto: this.datos?.bolsaSemanalMin ?? 15,
      pctATiempo: p.pctATiempo,
      usable: p.usable,
      bloqueadoPor: p.bloqueadoPor,
      marcas: p.marcas,
      semanas
    };
  }

  /** Agrega los datos de las gráficas laterales. */
  private computarGraficas() {
    const dist = { aTiempo: 0, retardo: 0, falta: 0, noMedible: 0 };
    const semMap = new Map<string, { label: string; corto: string; min: number; ini: string }>();
    for (const e of this.lista) {
      for (const s of e.semanas) {
        if (!semMap.has(s.inicio)) {
          const corto = `S${s.fiscal.numero}`;
          semMap.set(s.inicio, { label: s.label, corto, min: 0, ini: s.inicio });
        }
        semMap.get(s.inicio)!.min += s.acumulado;
        for (const d of s.dias) {
          if (d.estadoDia === 'descanso') continue;      // su día de descanso no es un dato
          // Un día justificado tampoco: no es falta (RH lo aprobó) ni asistencia
          // (no vino). Contarlo en cualquiera de los dos lados miente.
          if (d.justificado) continue;
          if (d.falta) dist.falta++;
          else if (d.noMedible) dist.noMedible++;        // ni a tiempo ni tarde: no se sabe
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

  // ------- Etiquetas -------

  private etiquetaSemana(inicioIso: string): string {
    const inicio = new Date(inicioIso + 'T00:00:00');
    const fin = new Date(inicio); fin.setDate(inicio.getDate() + 6);
    return `${this.fechaCorta(inicio)} → ${this.fechaCorta(fin)}`;
  }
  private etiquetaDia(fecha: string): string {
    return this.fechaCorta(new Date(fecha + 'T00:00:00'));
  }
  /** "Mié 28 jul" — compacto, para que quepa en la columna. */
  private fechaCorta(d: Date): string {
    const limpia = (s: string) => s.replace(/\.$/, '');
    const dow = limpia(d.toLocaleDateString('es-MX', { weekday: 'short' }));
    const mes = limpia(d.toLocaleDateString('es-MX', { month: 'short' }));
    const dia = String(d.getDate()).padStart(2, '0');
    return `${dow.charAt(0).toUpperCase()}${dow.slice(1)} ${dia} ${mes}`;
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

  /** Las marcas que vale la pena mostrar como chip (las de 'info' sobran). */
  marcasVisibles(e: EmpleadoAsistencia): MarcaAsistencia[] {
    return e.marcas.filter(m => m.gravedad === 'alta' || m.gravedad === 'media' || m.codigo === 'horario_confirmado');
  }
  etiquetaMarca(m: MarcaAsistencia): string { return this.ETIQUETA_MARCA[m.codigo] || m.codigo; }
  /** Un resumen de por qué el número no se puede usar, para el tooltip. */
  motivoNoUsable(e: EmpleadoAsistencia): string {
    return e.marcas.filter(m => m.gravedad === 'alta').map(m => m.detalle).join(' · ');
  }

  // ── Quién se ve en la rejilla ──────────────────────────────────────
  //
  // Las tarjetas de gente "Sin medir" llenaban la pantalla de ceros: puros
  // 0 min, 0 faltas, 0 h y "Ningún día medible en el periodo". No son datos,
  // son huecos, y estorbaban para ver a quien sí tiene números.
  //
  // Se esconden, NO se borran: siguen contando en los totales, en las gráficas
  // y en la exportación, y quedan detrás de una línea que dice cuántos son y
  // por qué. Entre ellos están los que esperan que RH confirme su horario, que
  // es trabajo pendiente de RH: desaparecerlos sin dejar rastro sería cambiar
  // "no se puede medir" por "no existe".

  /** Si está en true, la rejilla también muestra a los que no se pueden medir. */
  mostrarSinMedir = false;

  get listaVisible(): EmpleadoAsistencia[] {
    return (this.mostrarSinMedir ? this.lista : this.lista.filter(e => e.usable)).filter(e => this.coincide(e));
  }

  get sinMedir(): EmpleadoAsistencia[] {
    return this.lista.filter(e => !e.usable);
  }

  /** "3 esperan horario · 2 ya no vienen · 1 sin días suficientes" */
  get motivosSinMedir(): string {
    const cuenta = new Map<string, number>();
    for (const e of this.sinMedir) {
      const alta = e.marcas.filter(m => m.gravedad === 'alta');
      const codigo = alta[0]?.codigo || 'sin_datos';
      cuenta.set(codigo, (cuenta.get(codigo) || 0) + 1);
    }
    return [...cuenta.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([c, n]) => `${n} ${this.ETIQUETA_MARCA[c] || c}`)
      .join(' · ');
  }

  // ══ TOLERANCIA REBASADA (la bolsa de 15 min por semana) ══════════
  //
  // La bolsa ya se aplicaba: el atraso de cada día se absorbe de los 15 min que
  // trae la semana y solo cuenta el excedente. Lo que faltaba era poder VER a
  // quién ya se le acabó, sin abrir la tarjeta de cada persona y recorrer sus
  // semanas una por una —en una plaza de 40 personas con cuatro semanas en
  // pantalla, eso son 160 aperturas para responder una pregunta de sí o no—.
  //
  // Aquí no se recalcula nada. Es la MISMA respuesta de la API, leída al revés:
  // en vez de "esta persona, sus semanas", se pregunta "estas semanas, quién las
  // rebasó". Si el número de este apartado y el del detalle no coincidieran,
  // sería un error de lectura, no dos reglas distintas.
  //
  // Dos cosas que este apartado NO hace, a propósito:
  //  · No mete a quien tiene el número bloqueado por una marca alta. Un retardo
  //    medido contra un horario que RH todavía no confirma no puede encabezar
  //    una lista que se usa para descontar. Se cuentan aparte, no se esconden.
  //  · No inventa la semana que falta. Si el periodo elegido corta la semana a
  //    la mitad, se marca "semana partida": un acumulado de 3 días se lee como
  //    si fuera de 7 y así se firman descuentos que no van.

  /** Muestra también a los rebasados cuyo número está bloqueado por una marca. */
  tolIncluirBloqueados = false;

  /**
   * Las tres listas se calculan UNA vez al cargar, no en getters.
   *
   * Como getters se veían más limpios, pero el `@for` del template los llamaba
   * en cada ciclo de detección de cambios —y este componente se refresca solo
   * cada minuto y tiene un modal encima—: recorrer 40 personas × sus semanas
   * varias veces por movimiento del ratón, para un dato que solo cambia cuando
   * llega una respuesta nueva de la API.
   */
  rebasados: Rebasado[] = [];
  rebasadosBloqueados: Rebasado[] = [];
  alFilo: { emp: EmpleadoAsistencia; restante: number; label: string }[] = [];

  /** Lo último que se le avisó al padre, para no repetir el aviso. */
  private ultimosConteos: ConteosPendientes = { rebasados: 0, faltas: 0 };

  /** Rearma las listas de pendientes desde `lista`. Se llama al terminar de cargar. */
  private computarTolerancia() {
    this.rebasados = this.armarRebasados(this.lista.filter(e => e.usable));
    // Rebasaron, pero su número no se puede usar todavía (horario por confirmar,
    // una sola marca, fuera del padrón…). Van aparte porque el pendiente es de
    // RH, no de la persona.
    this.rebasadosBloqueados = this.armarRebasados(this.lista.filter(e => !e.usable));
    this.alFilo = this.computarAlFilo();
    this.faltasNotificables = this.computarFaltasNotificables();
    // Las pestañas de la página traen el contador: se les avisa desde aquí,
    // que es el único lugar donde estos números cambian.
    //
    // Solo cuando CAMBIAN, por dos razones: el refresco silencioso corre cada
    // minuto y no tiene por qué mover la vista del padre si nada se movió, y
    // avisar de un cero durante el primer ciclo de detección de cambios saca el
    // ExpressionChangedAfterItHasBeenChecked de modo desarrollo.
    const c = { rebasados: this.rebasados.length, faltas: this.faltasNotificables.length };
    if (c.rebasados !== this.ultimosConteos.rebasados || c.faltas !== this.ultimosConteos.faltas) {
      this.ultimosConteos = c;
      this.conteos.emit(c);
    }
  }

  private armarRebasados(gente: EmpleadoAsistencia[]): Rebasado[] {
    const salida: Rebasado[] = [];
    for (const emp of gente) {
      const semanas = emp.semanas
        .filter(s => s.acumulado > 0)
        .map(s => this.aSemanaRebasada(s))
        .sort((a, b) => b.excedenteMin - a.excedenteMin);
      if (!semanas.length) continue;
      // Ya vienen de peor a menos peor: la primera semana es la que duele.
      salida.push({ emp, semanas, excedenteTotal: semanas.reduce((t, s) => t + s.excedenteMin, 0) });
    }
    return salida.sort((a, b) =>
      b.excedenteTotal - a.excedenteTotal ||
      b.semanas.length - a.semanas.length ||
      a.emp.nombreCompleto.localeCompare(b.emp.nombreCompleto, 'es'));
  }

  private aSemanaRebasada(s: SemanaAsistencia): SemanaRebasada {
    const fin = new Date(s.inicio + 'T00:00:00');
    fin.setDate(fin.getDate() + 6);
    return {
      inicio: s.inicio,
      label: s.label,
      atrasoMin: s.atrasoMin,
      absorbidoMin: Math.max(0, s.atrasoMin - s.acumulado),
      excedenteMin: s.acumulado,
      parcial: s.inicio < this.desde || aFechaLocal(fin) > this.hasta,
      dias: s.dias
        .filter(d => d.atrasoMin > 0)
        .map(d => ({
          fecha: d.fecha, diaLabel: d.diaLabel,
          entrada: d.entrada, referencia: d.referencia,
          atrasoMin: d.atrasoMin, contado: d.retardoMin,
        })),
    };
  }

  /**
   * Van al filo: en su última semana del periodo ya gastaron casi toda la bolsa
   * y todavía no la rebasan. Es el aviso que sirve —cuando alguien ya está en
   * esta lista, avisarle todavía cambia algo—.
   */
  private computarAlFilo(): { emp: EmpleadoAsistencia; restante: number; label: string }[] {
    const filo: { emp: EmpleadoAsistencia; restante: number; label: string }[] = [];
    for (const e of this.lista) {
      if (!e.usable || e.acumuladoTotal > 0) continue;   // los que ya rebasaron van arriba
      const ult = e.semanas[e.semanas.length - 1];
      if (!ult) continue;
      const gastado = this.bolsaSemanal - ult.bolsaRestante;
      if (gastado > 0 && gastado >= this.bolsaSemanal - 3) {
        filo.push({ emp: e, restante: ult.bolsaRestante, label: ult.label });
      }
    }
    return filo.sort((a, b) => a.restante - b.restante ||
      a.emp.nombreCompleto.localeCompare(b.emp.nombreCompleto, 'es'));
  }

  /** Minutos rebasados en total (solo los utilizables): el número del encabezado. */
  get excedenteTotalRebasado(): number {
    return this.rebasados.reduce((t, r) => t + r.excedenteTotal, 0);
  }

  /** Suma de semanas rebasadas (para el pie de la tabla plana). */
  get totalSemanasRebasadas(): number {
    return this.rebasados.reduce((t, r) => t + r.semanas.length, 0);
  }

  // ══ FALTAS NOTIFICABLES (regla de descanso) ══════════════════════
  //
  // Regla de RH (20/08/2026): las TIENDAS descansan SOLO el domingo. Faltar en
  // domingo está permitido; faltar cualquier otro día se notifica. Oficinas
  // (corporativo, su comida, el reloj .196) y CEDIS quedan FUERA de esta regla.
  private readonly SIN_REGLA_FALTAS = new Set(['corporativo', 'corporativo-comida', 'cedis', 'reloj-196']);

  /** ¿La sucursal actual entra en la regla de faltas de tienda? */
  get aplicaReglaFaltas(): boolean {
    return !!this.sucursalFiltro && !this.SIN_REGLA_FALTAS.has(this.sucursalFiltro);
  }

  /** ¿La fecha 'yyyy-MM-dd' cae en domingo? (mediodía local, sin líos de huso). */
  private esDomingo(fecha: string): boolean {
    return new Date(fecha + 'T12:00:00').getDay() === 0;
  }

  /**
   * Quién faltó en un día que NO es domingo — eso es lo notificable. Una fila
   * por persona con sus días de falta (fuera de domingo), ordenada de más a
   * menos faltas.
   */
  faltasNotificables: FaltaNotificable[] = [];

  private computarFaltasNotificables(): FaltaNotificable[] {
    if (!this.aplicaReglaFaltas) return [];
    const salida: FaltaNotificable[] = [];
    for (const e of this.lista) {
      const dias: { fecha: string; label: string }[] = [];
      for (const s of e.semanas) for (const d of s.dias) {
        if (d.estadoDia === 'falta' && !this.esDomingo(d.fecha)) {
          dias.push({ fecha: d.fecha, label: d.diaLabel });
        }
      }
      if (dias.length) salida.push({ emp: e, dias });
    }
    return salida.sort((a, b) => b.dias.length - a.dias.length);
  }

  get totalFaltasNotificables(): number {
    return this.faltasNotificables.reduce((t, x) => t + x.dias.length, 0);
  }

  /** Cuántas de esas personas tienen MÁS DE UNA falta (el caso más grave). */
  get faltasMasDeUna(): number {
    return this.faltasNotificables.filter(x => x.dias.length > 1).length;
  }

  /** Los días de falta de una persona, como "Lun 18, Mar 19" para la tabla. */
  diasFaltaTexto(f: { dias: { fecha: string; label: string }[] }): string {
    return f.dias.map(d => d.label).join(' · ');
  }

  /** Resumen de una línea para el encabezado del apartado. */
  get resumenTolerancia(): string {
    const n = this.rebasados.length;
    if (!n) return 'nadie rebasó la tolerancia en este periodo';
    const semanas = this.rebasados.reduce((t, r) => t + r.semanas.length, 0);
    const partes = [`${n} persona${n > 1 ? 's' : ''}`,
                    `${semanas} semana${semanas > 1 ? 's' : ''}`,
                    `${this.excedenteTotalRebasado} min de más`];
    return partes.join(' · ');
  }


  /** Abre la tarjeta/detalle completo de la persona desde este apartado. */
  abrirDesdeTolerancia(r: Rebasado) { this.abrir(r.emp); }

  /** Exporta el apartado tal cual se ve: una fila por semana rebasada. */
  exportarTolerancia() {
    const filas: any[] = [];
    const volcar = (r: Rebasado, utilizable: string) => {
      for (const s of r.semanas) {
        filas.push({
          'Clv': r.emp.codigo,
          'Nombre': r.emp.nombreCompleto,
          'Departamento': r.emp.departamento,
          'Su horario': r.emp.tipo === 'rotativo' ? `Rota ${r.emp.turnos}` : r.emp.horario,
          'Semana': s.label,
          'Semana completa en el periodo': s.parcial ? 'No — partida' : 'Sí',
          'Tolerancia de la semana (min)': this.bolsaSemanal,
          'Atraso acumulado (min)': s.atrasoMin,
          'Absorbido por la tolerancia (min)': s.absorbidoMin,
          'Rebasado (min)': s.excedenteMin,
          'Días que aportaron': s.dias.map(d => `${d.diaLabel} ${d.entrada} (+${d.atrasoMin})`).join(' · '),
          'Número utilizable': utilizable,
        });
      }
    };
    for (const r of this.rebasados) volcar(r, 'Sí');
    for (const r of this.rebasadosBloqueados) volcar(r, `No — ${r.emp.bloqueadoPor.join(', ')}`);

    if (!filas.length) { this.toast.alerta('Nadie rebasó la tolerancia en este periodo.'); return; }
    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(filas), 'Tolerancia rebasada');
    const suc = this.nombreSucursal(this.sucursalFiltro).replace(/\s+/g, '_');
    XLSX.writeFile(libro, `Tolerancia_rebasada_${suc}_${this.desde}_a_${this.hasta}.xlsx`);
  }

  // Detalle en modal: al abrir, carga las revisiones (justificación/estado).
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

  // "Justificar un periodo" (Vacaciones/Incapacidad/Permiso) vivía aquí y
  // escribía texto libre en asistencia_revision. Lo reemplazaron las
  // INCIDENCIAS: el mismo propósito, con catálogo y un solo camino para
  // capturar. Las justificaciones viejas se siguen respetando en el cálculo.

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

  // ---- Gráficas: dona de distribución (conic-gradient) y barras por semana ----
  get distTotal(): number { return this.dist.aTiempo + this.dist.retardo + this.dist.falta + this.dist.noMedible; }
  distPct(n: number): number { return this.distTotal ? Math.round((n / this.distTotal) * 100) : 0; }
  get donutStyle(): string {
    const t = this.distTotal || 1;
    const a = (this.dist.aTiempo / t) * 100;
    const r = (this.dist.retardo / t) * 100;
    const f = (this.dist.falta / t) * 100;
    // El cuarto tramo (gris) son los días que no se pueden medir: existen, y por
    // eso ocupan lugar en la dona en vez de repartirse entre los otros tres.
    return `conic-gradient(var(--green) 0 ${a}%, var(--red) ${a}% ${a + r}%, `
         + `var(--gold) ${a + r}% ${a + r + f}%, #94a3b8 ${a + r + f}% 100%)`;
  }
  get barMax(): number { return Math.max(1, ...this.semanasChart.map(s => s.min)); }
  barPct(min: number): number { return Math.round((min / this.barMax) * 100); }

  /**
   * Exporta a Excel LO QUE SE VE: si hay secciones apagadas, no van. Antes
   * exportaba `this.lista` completa sin importar el filtro, así que el archivo y
   * la pantalla decían cosas distintas.
   */
  exportarExcel() {
    const filas: any[] = [];
    const visibles = this.porDepartamento;
    for (const g of visibles) for (const e of g.empleados) {
      for (const s of e.semanas) {
        for (const d of s.dias) {
          filas.push({
            'Empleado': e.nombre, 'Código': e.codigo, 'Puesto': e.puesto,
            'Su horario': e.horario, 'Tipo': e.tipo,
            'Horario confirmado por RH': e.horarioConfirmado ? 'Sí' : 'No',
            'Semana': s.label, 'Semana fiscal': s.fiscal.numero,
            'Fecha': d.fecha, 'Día': d.diaLabel,
            'Entrada': d.entrada,
            'Desayuno (min)': d.desayunoMin ?? '',
            'Desayuno excedido (min)': d.desayunoExcesoMin || '',
            'Comida': d.comida, 'Salida': d.salida, 'Horas netas': d.horasNetas,
            // En minutos, para que se pueda SUMAR en Excel: "8h 30m" es texto.
            'Horas netas (min)': d.netasMin || 0,
            'Desayuno pagado': d.desayunoPagado ? 'Sí' : '',
            'Incidencia': d.incidencias.map(i => i.etiqueta).join(', '),
            'Medido contra': d.referencia,
            'Atraso bruto (min)': d.atrasoMin,
            'Absorbido por la bolsa (min)': d.absorbidoMin,
            'Retardo real (min)': d.retardoMin,
            'Estado': this.estadoTexto(d),
            // Se exporta a propósito: quien abra el Excel tiene que poder ver que
            // este renglón no es utilizable antes de sumarlo a nómina.
            'Número utilizable': e.usable ? 'Sí' : `No — ${e.bloqueadoPor.join(', ')}`,
            // Va la sección en cada renglón: sin ella, dos exports parciales
            // pegados en un mismo libro no se pueden volver a separar.
            'Sección': g.departamento
          });
        }
      }
    }
    if (!filas.length) {
      this.toast.alerta(this.seleccionParcial
        ? 'No hay asistencia en las secciones que dejaste encendidas.'
        : 'No hay asistencia para exportar en este rango.');
      return;
    }
    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(filas), 'Asistencia');
    const limpia = (t: string) => t.replace(/[^A-Za-z0-9ÁÉÍÓÚÑáéíóúñ]+/g, '_').replace(/^_|_$/g, '');
    const suc = limpia(this.nombreSucursal(this.sucursalFiltro));
    // El nombre del archivo lleva la sección cuando es una sola: es lo que
    // evita que tres exports parciales acaben siendo tres archivos iguales.
    const parte = visibles.length === 1 ? '_' + limpia(visibles[0].departamento) : '';
    XLSX.writeFile(libro, `Asistencia_${suc}${parte}_${this.desde}_a_${this.hasta}.xlsx`);
  }

  /** Texto del estado de un día, para el Excel y el tooltip. */
  estadoTexto(d: DiaAsistencia): string {
    switch (d.estadoDia) {
      case 'falta': return 'Falta';
      case 'descanso': return 'Descanso';
      case 'marca_faltante': return 'Marca faltante (no medible)';
      case 'justificado': return 'Justificado (no cuenta)';
      case 'retardo': return 'Retardo';
      case 'absorbido': return 'Dentro de la tolerancia';
      default: return 'A tiempo';
    }
  }
}
