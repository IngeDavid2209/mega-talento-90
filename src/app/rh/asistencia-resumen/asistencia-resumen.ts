import { Component, inject, OnInit, OnDestroy, OnChanges, SimpleChanges, Input, Output, EventEmitter, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import * as XLSX from 'xlsx';
import {
  ChecadorService, RevisionDia, EstadoRevision,
  AsistenciaPersonas, PersonaAsistencia, MarcaAsistencia, EstadoDiaApi,
  EstadoReloj, SemaforoReloj
} from '../../core/services/checador.service';
import { aFechaLocal } from '../../core/models/checador.model';
import { CENTROS_CON_RELOJ, centroChecadorPorId, tieneReloj } from '../../core/models/sucursales.model';
import { ToastService } from '../../core/services/toast.service';
import { SucursalSelectComponent } from '../ui/sucursal-select/sucursal-select';

/** Un día del empleado, ya medido por la API contra SU horario. */
interface DiaAsistencia {
  fecha: string; diaLabel: string;
  entrada: string; comida: string; salida: string; horasNetas: string;
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
  atipico: boolean;
  justificacion: string;       // capturada por RH (se guarda en la base)
  estado: EstadoRevision;      // verificación: pendiente/verificada/aprobada/rechazada
}
/** Una semana (miércoles → martes) con su bolsa de tolerancia. */
interface SemanaAsistencia {
  inicio: string; label: string;
  acumulado: number;           // retardo REAL de la semana
  atrasoMin: number;           // atraso crudo, antes de la bolsa
  bolsaRestante: number;
  excedido: boolean;           // se agotó la bolsa
  dias: DiaAsistencia[];
}
/** Un empleado con todo su periodo desglosado. */
interface EmpleadoAsistencia {
  codigo: string; nombre: string; fotoUrl: string; puesto: string; registrado: boolean;
  // ── Para el reporte calcado (vista tabla) ──
  nombreCompleto: string;
  departamento: string;
  /** Día por fecha, para pintar las columnas del reporte sin buscar en las semanas. */
  diasPorFecha: Map<string, DiaAsistencia>;
  // ── Su horario, que sale de SUS checadas (o de lo que RH confirmó) ──
  tipo: PersonaAsistencia['tipo'];
  horario: string; turnos: string; horarioConfirmado: boolean; costumbre: string;
  // ── Los números ──
  acumuladoTotal: number;      // retardo real del periodo
  atrasoBrutoMin: number; absorbidoMin: number;
  semanasExcedidas: number; diasConRetardo: number; diasRegistrados: number;
  faltas: number; noMedibles: number; atipicos: number;
  horasTrabajadas: number; presupuesto: number;
  pctATiempo: number | null;
  // ── Por qué el número puede no servir ──
  usable: boolean; bloqueadoPor: string[]; marcas: MarcaAsistencia[];
  semanas: SemanaAsistencia[];
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

  SUCURSALES = CENTROS_CON_RELOJ;

  // Catálogos para el detalle
  ESTADOS: { v: EstadoRevision; l: string }[] = [
    { v: 'pendiente', l: 'Pendiente' },
    { v: 'verificada', l: 'Verificada' },
    { v: 'aprobada', l: 'Aprobada' },
    { v: 'rechazada', l: 'Rechazada' }
  ];
  JUSTIFICACIONES = ['Cita Médica', 'Tráfico', 'Personal', 'Permiso', 'Incapacidad', 'No Registrada'];

  /** Atajos de periodo de la barra de filtros. */
  RANGOS: { d: number; l: string }[] = [
    { d: 1, l: 'Hoy' },
    { d: 7, l: '7 días' }
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

    this.ajustarRangoYCargar();
    this.cargarRelojes();

    // Refresco automático (en vivo): recarga sin interrumpir si estás cargando o
    // con el detalle abierto.
    this.pollAsist = setInterval(() => this.ngZone.run(() => this.refrescar()), this.POLL_ASIST_MS);
  }

  /** Recarga silenciosa periódica. */
  private refrescar() {
    // El semáforo se refresca SIEMPRE, incluso con el detalle abierto: si un
    // reloj se cae mientras RH está capturando justificaciones, tiene que
    // enterarse antes de firmar los números.
    this.cargarRelojes();
    if (this.cargando || this.detalle) return;
    this.cargar(true);
  }

  /** Estado de los relojes. Si falla, se calla: nunca debe tumbar la pantalla. */
  private async cargarRelojes() {
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

  /** La lista agrupada por departamento, cada grupo ordenado por código. */
  get porDepartamento(): { departamento: string; empleados: EmpleadoAsistencia[]; retardos: number }[] {
    const grupos = new Map<string, EmpleadoAsistencia[]>();
    for (const e of this.lista) {
      const dep = e.departamento || this.SIN_DEPTO;
      // Los códigos enrolados en el reloj que NO están en el padrón de RH y que
      // además no marcaron en el periodo son ruido: no van al reporte. Los que
      // sí marcaron se conservan (en 'SIN DEPARTAMENTO') para que nada se esconda.
      if (dep === this.SIN_DEPTO && e.diasPorFecha.size === 0) continue;
      if (!grupos.has(dep)) grupos.set(dep, []);
      grupos.get(dep)!.push(e);
    }
    const numOrden = (c: string) => { const n = parseInt(c, 10); return Number.isFinite(n) ? n : 1e9; };
    const rangoDepto = (d: string) => (d === this.SIN_DEPTO ? 1 : 0);   // el catch-all, al final
    return [...grupos.entries()]
      .sort((a, b) => rangoDepto(a[0]) - rangoDepto(b[0]) || a[0].localeCompare(b[0], 'es'))
      .map(([departamento, empleados]) => ({
        departamento,
        empleados: empleados.sort((a, b) => numOrden(a.codigo) - numOrden(b.codigo) || a.codigo.localeCompare(b.codigo)),
        retardos: empleados.reduce((s, e) => s + e.diasConRetardo, 0),
      }));
  }

  /** El total de retardos del reporte (pie de página): cuadra con lo mostrado. */
  get totalRetardos(): number {
    return this.porDepartamento.reduce((s, g) => s + g.retardos, 0);
  }

  /** La celda de un día: jornada (entrada–salida) arriba y comida abajo. */
  celda(e: EmpleadoAsistencia, fecha: string): { jornada: string; comida: string; retardo: boolean; falta: boolean } {
    const d = e.diasPorFecha.get(fecha);
    if (!d) return { jornada: '', comida: '', retardo: false, falta: false };
    if (d.estadoDia === 'descanso') return { jornada: '—', comida: '', retardo: false, falta: false };
    const ent = d.entrada && d.entrada !== '—' ? d.entrada : '0';
    const sal = d.salida && d.salida !== '—' ? d.salida : '0';
    const com = d.comida && d.comida !== '—' ? d.comida.replace(/\s*[–-]\s*/, ' - ') : '';
    return {
      jornada: `${ent} - ${sal}`,
      comida: com,
      retardo: d.retardoMin > 0,
      falta: d.falta,
    };
  }

  /**
   * Exporta el reporte a PDF con la impresión del navegador (Guardar como PDF).
   * Sin librería y 100% fiel: se marca el body para que el CSS de impresión
   * esconda todo menos la tabla, y se restaura al terminar.
   */
  exportarPdf() {
    const b = document.body;
    b.classList.add('imprimiendo-reporte');
    const limpiar = () => { b.classList.remove('imprimiendo-reporte'); window.removeEventListener('afterprint', limpiar); };
    window.addEventListener('afterprint', limpiar);
    setTimeout(() => window.print(), 60);   // deja pintar el DOM antes de imprimir
  }

  /** Cabecera del reporte: "Asistencia del DD/MM al DD/MM". */
  get tituloReporte(): string {
    const f = (s: string) => { const d = new Date(s + 'T00:00:00'); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getFullYear()).slice(2)}`; };
    return this.desde && this.hasta ? `Asistencia del ${f(this.desde)} al ${f(this.hasta)}` : '';
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
    if (cambios['recargarToken'] && !cambios['recargarToken'].firstChange) {
      this.ajustarRangoYCargar();
    }
  }

  ngOnDestroy() {
    if (this.pollAsist) clearInterval(this.pollAsist);
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

  // Al cambiar de sucursal se CONSERVA el periodo elegido y solo se recarga.
  //
  // Antes se llamaba a `ajustarRangoYCargar()`, que reescribía las fechas a los
  // últimos 30 días de la nueva plaza. Eso obligaba a volver a fijar el periodo
  // cada vez que se saltaba de una sucursal a otra —justo lo que se hace para
  // comparar el MISMO rango entre plazas—. El autoajuste sigue existiendo, pero
  // solo donde tiene sentido: en la carga inicial y en el botón "Todo".
  onSucursalChange() { this.cargar(); }

  /** Atajo de periodo: últimos N días naturales hasta hoy. */
  aplicarRango(dias: number) {
    const r = this.limitesRango(dias);
    this.desde = r.desde;
    this.hasta = r.hasta;
    this.cargar();
  }
  rangoActivo(dias: number): boolean {
    const r = this.limitesRango(dias);
    return this.desde === r.desde && this.hasta === r.hasta;
  }
  private limitesRango(dias: number): { desde: string; hasta: string } {
    const hoy = new Date();
    const ini = new Date(hoy);
    ini.setDate(hoy.getDate() - (dias - 1));
    return { desde: aFechaLocal(ini), hasta: aFechaLocal(hoy) };
  }

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

  async cargar(silencioso = false) {
    if (!this.sucursalFiltro || !this.desde || !this.hasta) { this.lista = []; return; }
    if (!silencioso) this.cargando = true;
    try {
      this.datos = await this.checador.getAsistencia(this.sucursalFiltro, this.desde, this.hasta);
      this.lista = this.datos.personas.map(p => this.aVista(p));
      this.computarGraficas();
    } catch (e) {
      console.error('Error al cargar asistencia:', e);
      if (!silencioso) { this.toast.error('No se pudieron cargar la asistencia.'); this.lista = []; this.datos = null; }
    } finally {
      if (!silencioso) this.cargando = false;
    }
  }

  // ------- De la respuesta de la API a la vista -------

  private aVista(p: PersonaAsistencia): EmpleadoAsistencia {
    const semanas: SemanaAsistencia[] = p.semanas.map(s => ({
      inicio: s.inicio,
      label: this.etiquetaSemana(s.inicio),
      acumulado: s.retardoRealMin,
      atrasoMin: s.atrasoMin,
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
        retardoMin: d.retardoRealMin,
        atrasoMin: d.atrasoMin,
        absorbidoMin: d.absorbidoMin,
        referencia: d.referencia || '—',
        estadoDia: d.estado,
        falta: d.estado === 'falta',
        noMedible: d.estado === 'marca_faltante',
        atipico: !!d.atipico,
        justificacion: '',
        estado: 'pendiente' as EstadoRevision
      }))
    }));

    // Índice día-por-fecha para pintar las columnas del reporte de un vistazo.
    const diasPorFecha = new Map<string, DiaAsistencia>();
    for (const s of semanas) for (const d of s.dias) diasPorFecha.set(d.fecha, d);

    return {
      codigo: p.codigo,
      nombre: p.nombre || '(sin registrar)',
      nombreCompleto: p.nombreCompleto || p.nombre || '(sin registrar)',
      departamento: p.departamento || 'SIN DEPARTAMENTO',
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
      noMedibles: p.diasNoMedibles,
      atipicos: p.diasAtipicos,
      horasTrabajadas: p.horasTrabajadas,
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
          const corto = s.label.split('→')[0].trim();
          semMap.set(s.inicio, { label: s.label, corto, min: 0, ini: s.inicio });
        }
        semMap.get(s.inicio)!.min += s.acumulado;
        for (const d of s.dias) {
          if (d.estadoDia === 'descanso') continue;      // su día de descanso no es un dato
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
    return this.mostrarSinMedir ? this.lista : this.lista.filter(e => e.usable);
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

  exportarExcel() {
    const filas: any[] = [];
    for (const e of this.lista) {
      for (const s of e.semanas) {
        for (const d of s.dias) {
          filas.push({
            'Empleado': e.nombre, 'Código': e.codigo, 'Puesto': e.puesto,
            'Su horario': e.horario, 'Tipo': e.tipo,
            'Horario confirmado por RH': e.horarioConfirmado ? 'Sí' : 'No',
            'Semana': s.label, 'Fecha': d.fecha, 'Día': d.diaLabel,
            'Entrada': d.entrada, 'Comida': d.comida, 'Salida': d.salida, 'Horas netas': d.horasNetas,
            'Medido contra': d.referencia,
            'Atraso bruto (min)': d.atrasoMin,
            'Absorbido por la bolsa (min)': d.absorbidoMin,
            'Retardo real (min)': d.retardoMin,
            'Estado': this.estadoTexto(d),
            // Se exporta a propósito: quien abra el Excel tiene que poder ver que
            // este renglón no es utilizable antes de sumarlo a nómina.
            'Número utilizable': e.usable ? 'Sí' : `No — ${e.bloqueadoPor.join(', ')}`
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

  /** Texto del estado de un día, para el Excel y el tooltip. */
  estadoTexto(d: DiaAsistencia): string {
    switch (d.estadoDia) {
      case 'falta': return 'Falta';
      case 'descanso': return 'Descanso';
      case 'marca_faltante': return 'Marca faltante (no medible)';
      case 'retardo': return 'Retardo';
      case 'absorbido': return 'Dentro de la tolerancia';
      default: return 'A tiempo';
    }
  }
}
