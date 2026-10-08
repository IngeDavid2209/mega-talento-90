import { Injectable, inject } from '@angular/core';
import { ApiService } from './api.service';
import { AreaChecador, HorarioArea, Checada, Empleado } from '../models/checador.model';
import { FilaChecadaCruda } from '../models/parser-attlog';

/** Resultado de una importación de checadas. */
export interface ResultadoImportacion {
  leidas: number;
  nuevas: number;
  duplicadas: number;
  sinEmpleado: number;
}

// ══════════════════════════════════════════════════════════════════
// ASISTENCIA CON EL HORARIO REAL DE CADA PERSONA
//
// Lo calcula la API (`api/src/agente-horarios/asistencia-personas.ts`). El
// navegador ya NO calcula retardos: la misma regla vivía en cuatro lugares y los
// cuatro comparaban contra el horario configurado de la sucursal.
// ══════════════════════════════════════════════════════════════════

/** Por qué un número puede no ser de fiar. `alta` invalida el número. */
export interface MarcaAsistencia {
  codigo: string;
  gravedad: 'alta' | 'media' | 'info' | 'ok';
  detalle: string;
  /** Las dos lecturas posibles de su horario, cuando la marca es de ambigüedad. */
  opciones?: (string | null)[];
  /** Cuánto retardo le saldría con cada opción: convierte la duda en pregunta. */
  impacto?: Array<{ turno: string; retardoRealMin: number | null; diasConRetardo: number | null }>;
  turnoActual?: string | null;
  turnosActuales?: (string | null)[];
}

/** `justificado` = falta que RH aprobó con justificante y ya NO cuenta. */
export type EstadoDiaApi = 'a_tiempo' | 'absorbido' | 'retardo' | 'falta' | 'descanso' | 'marca_faltante' | 'justificado';

export interface DiaApi {
  fecha: string;
  estado: EstadoDiaApi;
  entrada?: string | null;
  salida?: string | null;
  hora?: string | null;          // la marca única de un día 'marca_faltante'
  referencia?: string | null;    // contra qué se midió ese día
  comida: string;
  horasNetas: string;
  /** Duración del desayuno en minutos (la pausa de la mañana), o null si no hubo. */
  desayunoMin?: number | null;
  /** Minutos por encima del tope. Llega aunque no alcance el umbral de alerta. */
  desayunoExcesoMin?: number | null;
  atrasoMin: number;             // minutos crudos de atraso
  absorbidoMin: number;          // lo que absorbió la bolsa semanal
  retardoRealMin: number;        // el excedente: esto es el retardo
  bolsaAntes: number;
  bolsaDespues: number;
  atipico?: boolean;
  marcas?: number;
  /** Con qué se justificó, cuando el día quedó en `justificado`. */
  justificacion?: string;
  /** Horas netas en minutos, para poder sumarlas. null si no hubo jornada. */
  netasMin?: number | null;
  /** En corporativo el desayuno no se descuenta (si el día trae comida aparte). */
  desayunoPagado?: boolean;
  /** Faltó en un día que normalmente trabaja, pero le quedaba un descanso esa semana. */
  descansoPorAusencia?: boolean;
  /** Incidencias de RH que cubren este día. */
  incidencias?: IncidenciaDia[];
  // ── Contra el horario que RH le asignó (solo si tiene uno) ──
  comidaMin?: number | null;
  comidaExcesoMin?: number | null;
  salidaAntesMin?: number | null;
  esperadoMin?: number | null;
}

/** El horario de una persona, asignado por RH (manda sobre el deducido). */
export interface HorarioAsignado {
  entrada: string; salida: string; comidaMin: number;
  sabado: boolean; sabadoEntrada: string | null; sabadoSalida: string | null;
  asignadoPor?: string | null; actualizadoEn?: string | null;
}

// ══ INCIDENCIAS DE PERSONAL ══════════════════════════════════════
// El catálogo lo manda la API (`GET /checador/incidencias/tipos`), que es quien
// decide qué tipo excusa una falta. Ver api/src/incidencias.ts.
export interface TipoIncidencia {
  tipo: string; etiqueta: string; codigo: string; excusaFalta: boolean;
}
/** Una incidencia, tal como se pinta en la celda de un día. */
export interface IncidenciaDia {
  id: string; tipo: string; codigo: string; etiqueta: string; nota: string;
  /** "Uso de horas extra": minutos que se suman a las horas del día. */
  minutos?: number | null;
}
/**
 * El camino de una incidencia (01/10/2026). Solo calificada, cerrada y
 * auditada cambian el cálculo. Ver api/src/incidencias.ts.
 */
export type EstadoIncidencia = 'capturada' | 'calificada' | 'rechazada' | 'cerrada' | 'auditada' | 'anulada';
/** Lo que la auditoría tiene que mirar (no bloquea nada). */
export type BanderaIncidencia = 'corrimiento_60' | 'hd_frecuente' | 'autocalificada' | 'sin_nota' | 'retroactiva';

/** La incidencia completa, con su periodo. */
export interface Incidencia {
  id?: string;
  sucursalId: string; empleadoCodigo: string; tipo: string;
  desde: string; hasta: string; nota?: string;
  /** "Uso de horas extra": minutos usados por día. "Horario distinto": su entrada de ese día. */
  minutos?: number | null;
  creadoPor?: string; creadoEn?: string;
  /** Quién lo autorizó (obligatorio en "Horario distinto"). */
  autorizo?: string;
  /** Al crear un "Horario distinto": por qué (obligatorio) y su entrada de siempre. */
  motivo?: string;
  horarioBase?: number | null;
  /** Al crear: dejarla por calificar aunque quien captura pueda calificar. */
  entregar?: boolean;
  // ── Lo que responde la API ──
  estado?: EstadoIncidencia;
  horarioBaseMin?: number | null;
  calificadoPor?: string; calificadoEn?: string | null; motivoRechazo?: string;
  auditadoPor?: string; auditadoEn?: string | null; notaAuditoria?: string;
  anuladoPor?: string; anuladoEn?: string | null; motivoAnulacion?: string;
  banderas?: BanderaIncidencia[];
}
/** Un paso en la bitácora de una incidencia. */
export interface PasoBitacora {
  accion: string; estadoAntes: string | null; estadoDespues: string | null;
  quien: string; cuando: string; detalle: string;
}
/** Una semana cerrada para prenómina. `foto` solo viene al pedir un cierre por id. */
export interface CierreSemana {
  id: string; sucursalId: string; desde: string; hasta: string;
  cerradoPor: string; cerradoEn: string;
  resumen: { personas: number; usables: number | null; faltas: number | null;
             retardoRealMin: number | null; horasTrabajadas: number | null; incidencias: number } | null;
  reabiertoPor: string; reabiertoEn: string | null; motivoReapertura: string;
  vigente: boolean;
  foto?: AsistenciaPersonas;
}

// ══ CAMBIOS EN LOS RELOJES (eliminar / renombrar) ════════════════
// El portal deja un comando por reloj; el agente de la plaza lo ejecuta y
// reporta. Ver api/src/reloj-comandos.ts y api/agente/escritura.js.
/** Alguien que el reloj dio de alta hace poco (reporte "Nuevos en los relojes"). */
export interface EmpleadoNuevo extends Empleado {
  creadoEn: string;
  primeraChecada: string | null;
  ultimaChecada: string | null;
  sinNombre: boolean;
  sinDepartamento: boolean;
  /** "Por identificar": cuántas veces checó en el periodo revisado. */
  checadasPeriodo?: number;
  /** Se le dio de baja pero sigue checando. */
  dadoDeBaja?: boolean;
  /** Está en la papelera y sigue checando. */
  enPapelera?: boolean;
}

/** Un renglón de la Papelera de empleados. */
export interface EmpleadoPapelera extends Empleado {
  ultimaChecada: string | null;
  eliminadoEn: string | null; eliminadoPor: string;
  /** Se le borró de algún reloj y hay respaldo para volver a darlo de alta. */
  borradoDeReloj: boolean;
}

export interface ComandoReloj {
  id: string; serie: string; alias: string; empleadoCodigo: string;
  tipo: 'borrar_usuario' | 'renombrar_usuario' | 'restaurar_usuario'; payload: { nombre?: string };
  estado: 'pendiente' | 'hecho' | 'error' | 'cancelado';
  intentos: number; detalle: string; creadoPor: string; creadoEn: string; actualizadoEn: string;
}
export interface CambiosReloj {
  relojes: { serie: string; alias: string | null }[];
  comandos: ComandoReloj[];
}

// ══ UBICACIÓN DE MI EQUIPO ═══════════════════════════════════════
// Quién está en cada RELOJ ahora y si trabaja o come. Lo calcula la API
// (api/src/agente-horarios/equipo.ts); solo la ven los administradores.
export interface PersonaEquipo {
  codigo: string; nombre: string; departamento: string | null;
  estado: 'dentro' | 'comida' | 'sin_salida';
  entrada: string; ultima: string;
  /** Minutos desde su última checada. */
  hace: number;
}
export interface PersonaSalidaEquipo {
  codigo: string; sucursalId: string; nombre: string; departamento: string | null;
  entrada: string; salida: string;
  /** Salió esta cantidad de minutos antes de lo que dura su jornada (null: a su hora). */
  antesMin: number | null;
  jornadaHabitual: string | null;
  /** RH ya la justificó hoy con una incidencia: se ve, pero no cuenta como aviso. */
  justificacion: string | null;
}
export interface PersonaFaltaEquipo {
  codigo: string; sucursalId: string; nombre: string; departamento: string | null;
  entraA: string; retrasoMin: number;
}
export interface EscenaEquipo {
  id: string; serie: string | null; sucursalId: string; alias: string;
  /** Los relojes que forman la escena (corporativo: entrada/salida + desayuno/comida). */
  relojes: string[];
  tipo: 'oficina' | 'comedor' | 'tienda' | 'bodega';
  relojMudo: boolean; segundosSinSenal: number | null;
  personas: PersonaEquipo[]; salieron: number; sinSalida: number;
  salidas: PersonaSalidaEquipo[];
  /** Tenían que venir hoy y no han checado (ya pasó su hora + 30 min). */
  faltan: PersonaFaltaEquipo[];
  descansan: number;
}
export interface EquipoAhora {
  fecha: string; hora: string;
  totales: { dentro: number; comida: number; salieron: number; sinSalida: number; salieronAntes: number; faltan: number };
  escenas: EscenaEquipo[];
}

export interface SemanaApi {
  inicio: string;
  bolsaInicial: number;
  bolsaRestante: number;
  atrasoMin: number;
  retardoRealMin: number;
  bolsaAgotada: boolean;
  /** Suma de horas netas de la semana, en minutos. */
  minutosTrabajados?: number;
  dias: DiaApi[];
}

export interface PersonaAsistencia {
  codigo: string; nombre: string;
  /** Nombre completo del padrón de RH (para el reporte calcado). */
  nombreCompleto: string;
  /** Departamento del reporte (Compras, Finanzas, Promotoras…). null si no se ha asignado. */
  departamento: string | null;
  /** Media jornada (~4 h): se agrupa en la sección PRACTICANTES del reporte. */
  esPracticante: boolean;
  puesto: string; fotoUrl: string;
  registrado: boolean; activo: boolean | null;
  tipo: 'fijo' | 'rotativo' | 'sin_patron' | 'sin_datos';
  horario: string | null;             // su horario, deducido o confirmado
  turnos: (string | null)[];
  horarioConfirmado: boolean;         // lo dijo RH, no el cálculo
  costumbre: string | null;           // a qué hora ACOSTUMBRA llegar
  desfaseMin: number | null;
  salida: string | null;
  dispersionMin: number | null;
  diasLaborales: number[];
  diasUsados: number;                 // días con entrada Y salida usados para deducir
  diasEnRango: number;                // días con alguna marca dentro del rango
  silencioDias: number | null;
  pctUnaMarca: number;
  retardoRealMin: number;
  atrasoBrutoMin: number;
  absorbidoMin: number;
  diasConRetardo: number;
  diasEvaluados: number;
  faltas: number;
  /** Faltas que RH justificó y por eso NO están contadas en `faltas`. */
  faltasJustificadas: number;
  diasNoMedibles: number;             // días de una sola marca
  diasAtipicos: number;
  horasTrabajadas: number;
  /** La suma exacta de horas netas del periodo, en minutos. */
  minutosTrabajados?: number;
  diasConIncidencia?: number;
  /** Sus incidencias como periodos (aunque no haya checado esos días). */
  incidencias?: Array<IncidenciaDia & { desde: string; hasta: string }>;
  /** Minutos de desayuno por encima del tope, sumados en el periodo. */
  desayunoExcesoMin: number;
  diasDesayunoExcedido: number;
  /** null cuando no hubo ni un día evaluable: un 0% falso parece el peor empleado. */
  pctATiempo: number | null;
  semanas: SemanaApi[];
  marcas: MarcaAsistencia[];
  usable: boolean;
  bloqueadoPor: string[];
  /** Su horario asignado por RH, o null si se mide con el deducido. */
  horarioAsignado?: HorarioAsignado | null;
  /** Lo que su horario pide trabajar en el periodo (null sin horario asignado). */
  minutosEsperados?: number | null;
}

export interface AsistenciaPersonas {
  sucursalId: string; desde: string; hasta: string;
  /** Desde cuándo se leyó para DEDUCIR el horario (más ancho que el rango). */
  desdeHorario: string;
  ventanaHorarioDias: number;
  bolsaSemanalMin: number;
  corteSemana: string;
  /** Día en que ABRE la semana de nómina (0=domingo … 4=jueves). */
  diaInicioSemana: number;
  diasExTrabajador: number;
  /** Desde cuántos minutos de exceso el desayuno cuenta como irregularidad. */
  desayunoAlertaMin?: number;
  /** false = sucursal sin hora límite de entrada: no se mide retardo (solo faltas). */
  mideRetardo?: boolean;
  resumen: {
    personas: number; usables: number; conPendiente: number;
    fijos: number; rotativos: number; sinPatron: number; sinDatos: number;
    horarioAmbiguo: number; horarioConfirmado: number; soloUnaMarca: number;
    exTrabajadores: number; fueraDelPadron: number;
    retardoRealMin: number; retardoRealUsableMin: number;
    atrasoBrutoMin: number; absorbidoMin: number;
    faltas: number; faltasJustificadas: number; diasNoMedibles: number; horasTrabajadas: number;
    desayunoExcesoMin: number; diasDesayunoExcedido: number;
  };
  personas: PersonaAsistencia[];
}


// ══════════════════════════════════════════════════════════════════
// CRUCES ENTRE PLAZAS — quién checó en el reloj de otra
//
// Es el único dato de este servicio que NO va por sucursal, y no es un
// descuido: el cruce solo existe comparando una plaza contra otra. Peor aún,
// por CÓDIGO es invisible —los códigos se repiten entre plazas, así que la
// marca de alguien en el reloj ajeno entra limpiamente como si fuera del
// homónimo de allá—. La llave es el nombre, y la regla vive en
// `api/src/agente-horarios/cruces-plazas.ts`.
// ══════════════════════════════════════════════════════════════════

/**
 * - `traslape`        → dos jornadas reales encimadas: nadie está en dos plazas a la vez.
 * - `marca_ajena`     → una marca suelta en la plaza ajena, a media jornada propia.
 * - `jornada_partida` → cubrió dos tiendas y su día quedó cortado en dos.
 * - `ruta_promotora`  → su trabajo es andar entre plazas.
 * - `sueltas`         → dos presencias sin relación aparente.
 */
export type ClaseCruce = 'traslape' | 'marca_ajena' | 'jornada_partida' | 'ruta_promotora' | 'sueltas';

export interface EstanciaCruce {
  sucursalId: string; codigo: string;
  primera: string; ultima: string; marcas: number;
}
export interface DiaCruce {
  fecha: string;
  estancias: EstanciaCruce[];
  clase: ClaseCruce;
  /** Minutos entre una estancia y la siguiente. Negativo = se enciman. */
  huecoMin: number | null;
}
export interface AltaPersona { sucursalId: string; codigo: string; nombre: string; esPromotora: boolean; }
export interface PersonaCruce {
  nombre: string;
  clave: string;
  esPromotora: boolean;
  altas: AltaPersona[];
  clase: ClaseCruce;
  dias: DiaCruce[];
  diasCruzados: number;
  traslapes: number;
  marcasAjenas: number;
  ultimoDia: string;
}
// ── Mapa en vivo: quién está en cada plaza ───────────────────────────
// Lo calcula `api/src/agente-horarios/presencia.ts`, que es donde está
// explicado por qué "marcas impares" no basta para contestarlo bien.
export type EstadoPresencia = 'dentro' | 'salio' | 'sin_salida';
export interface PersonaPresente {
  codigo: string; nombre: string;
  desde: string; ultima: string; marcas: number;
  estado: EstadoPresencia;
  /** Su hora habitual de salida, deducida de sus propias semanas. */
  salidaHabitual: string | null;
  esPromotora: boolean;
}
export interface PlazaPresencia {
  sucursalId: string;
  dentro: number; salieron: number; sinSalida: number;
  segundosSinSenal: number | null;
  /** El reloj lleva rato mudo: el conteo es de la última vez que reportó. */
  relojMudo: boolean;
  personas: PersonaPresente[];
}
export interface Presencia {
  fecha: string; hora: string;
  totalDentro: number; totalSinSalida: number;
  plazas: PlazaPresencia[];
}

export interface CrucesPlazas {
  desde: string; hasta: string;
  /** De alta en dos sedes, con o sin cruce de marcas: el universo revisado. */
  enDosSedes: number;
  personas: PersonaCruce[];
  resumen: {
    personas: number; dias: number; traslapes: number;
    marcasAjenas: number; jornadasPartidas: number; rutas: number;
  };
}
// ══════════════════════════════════════════════════════════════════
// SEMÁFORO DE RELOJES
//
// La pantalla de asistencia se refresca sola cada minuto, pero solo lee la
// base: se ve EXACTAMENTE IGUAL con un reloj al día que con uno muerto desde
// hace tres semanas. En los dos casos aparece la última asistencia que hay.
//
// Por dentro esto ya se manejaba bien —el corredor del agente de horarios mide
// contra `max(checadas.fecha)` de cada sucursal y NO contra la fecha de hoy,
// justo para que un reloj sin bajar no invente faltas—. Lo que faltaba era que
// ese atraso fuera VISIBLE para quien mira la pantalla.
//
// Regla de producto: la pantalla nunca debe parecer al día cuando no lo está.
// Y al revés: falta de dato ≠ falta del empleado.
// ══════════════════════════════════════════════════════════════════

/**
 * - `ok`        → señal hace menos de 10 min
 * - `atrasado`  → señal hace menos de 2 h
 * - `mudo`      → 2 h o más sin señal (o nunca)
 * - `pendiente` → reloj en pausa: sus checadas NO entran (sin identificar o
 *                 con numeración propia sin traducir)
 */
export type SemaforoReloj = 'ok' | 'atrasado' | 'mudo' | 'pendiente';

export interface EstadoReloj {
  serie: string;
  sucursalId: string;
  alias: string;
  modo: string;                     // agente | push | manual
  ip: string;
  nota: string;
  ultimaSenal: string | null;       // último lote/latido recibido
  ultimaChecada: string | null;     // marca más reciente que llegó de ese equipo
  ultimoBackfill: string | null;
  segundosSinSenal: number | null;
  /**
   * Cuándo leyó este reloj el sistema del que tomamos el dato.
   *
   * Es la señal que distingue "nuestro agente se cayó" de "el proveedor dejó de
   * sondear sus relojes". Sin ella el semáforo se ve verde con la asistencia
   * parada: el agente sigue reportando puntualmente que no hay nada nuevo, y
   * eso es indistinguible de que nadie haya checado.
   */
  origenVisto: string | null;
  segundosOrigen: number | null;
  /** El eslabón flojo es el origen, no nosotros: revisar el agente no arregla nada. */
  origenAtrasado: boolean;
  logsEnReloj: number | null;       // lo que el equipo declara tener
  logsEnBase: number | null;        // lo que tenemos nosotros
  /** Hora del reloj − hora del servidor. Con esto corrido, los retardos son falsos. */
  desfaseRelojSeg: number | null;
  ultimoError: string;
  agenteVersion: string;
  agenteHost: string;
  semaforo: SemaforoReloj;
}

/** Alerta del AGENTE de horarios (borrador de inconsistencia detectada por IA). */
export type EstadoAlerta = 'sugerida_ia' | 'aprobada' | 'rechazada' | 'descartada';
export interface AlertaAgente {
  id: string;
  sucursalId: string;
  empleadoCodigo: string;
  empleadoNombre: string;
  fecha: string;
  regla: string;
  severidad: 'baja' | 'media' | 'alta';
  detalle: string;
  evidencia: any;
  justificacionSugerida: string;
  estado: EstadoAlerta;
  decididoPor?: string | null;
  decididoEn?: string | null;
  analizadoEn?: string;
  codigo?: string;
  justificacionJefe?: string;
  respondidoPor?: string | null;
  respondidoEn?: string | null;
}
/**
 * Una línea de la cola agrupada: todas las alertas de la MISMA regla, la misma
 * sucursal y la misma persona. Es lo que convierte 2,510 tarjetas en decenas de
 * líneas sobre las que sí se puede decidir.
 */
export interface GrupoAlertas {
  regla: string;
  sucursalId: string;
  empleadoCodigo: string;
  empleadoNombre: string;
  /** Cuántas personas cubre la línea (en el nivel 'sucursal', varias). */
  personas?: number;
  total: number;
  primeraFecha: string;
  ultimaFecha: string;
  /** Cuántas ya traen la justificación del jefe: esas no hay que volver a preguntar. */
  conJustificacion: number;
}
export interface AlertasAgrupadas {
  grupos: GrupoAlertas[];
  porRegla: Record<string, number>;
  total: number;
  nivel: string;
}

export interface ResumenAgente {
  sucursalId: string; desde: string; hasta: string;
  empleadosAnalizados: number; diasAnalizados: number; checadasLeidas: number;
  totalInconsistencias: number; porRegla: Record<string, number>; empleadosSinTurno: number;
  exTrabajadoresOmitidos?: number;
}
export interface RespuestaAnalisis {
  resumen: ResumenAgente;
  borradores: { creadas: number; actualizadas: number; sinCambio: number; eliminadas: number };
}

/**
 * Lo que el agente revisó POR SU CUENTA en una sucursal. El corredor de la API
 * analiza las ocho sucursales cada media hora sin que nadie se lo pida; esto es
 * la bitácora, y es lo que permite que la pantalla muestre resultados en vez de
 * un botón que hay que apretar.
 */
export interface CorridaSucursal {
  sucursalId: string;
  desde: string; hasta: string;
  ultimoDato: string; primerDato: string;
  /** La ventana rodante no cubre todo el historial de esta sucursal. */
  historiaSinCubrir: boolean;
  empleados: number | null;
  omitidosEx: number | null;
  pendientes: number;
  creadas: number | null; actualizadas: number | null; eliminadas: number | null;
  duracionMs: number | null;
  saltada: boolean;
  /** Mensaje REAL del fallo. Si viene, esa sucursal NO está revisada. */
  error: string | null;
  corridaEn: string;
}
export interface EstadoAgente {
  auto: boolean;
  cadaMin: number;
  ventanaDias: number;
  diasEx: number;
  corriendo?: boolean;
  ultimaCorrida?: string | null;
  pendientesTotal?: number;
  error?: string;
  sucursales: CorridaSucursal[];
}

/**
 * Jefe responsable de una sucursal: a quién le avisa el agente por WhatsApp
 * cuando RH aprueba una alerta. Uno por sucursal (upsert por `sucursalId`).
 */
export interface JefeSucursal {
  sucursalId: string;
  nombre: string;
  telefono: string;
  activo: boolean;
}

/** Revisión de RH sobre un día: justificación y estado de verificación. */
export type EstadoRevision = 'pendiente' | 'verificada' | 'aprobada' | 'rechazada';
export interface RevisionDia {
  sucursalId: string;
  empleadoCodigo: string;
  fecha: string;
  justificacion: string;
  estado: EstadoRevision;
}

/**
 * Módulo Horarios y checadas contra la API (Postgres). Se conservan las firmas
 * del servicio anterior (Firestore); los `escuchar*` hacen polling.
 */
@Injectable({ providedIn: 'root' })
export class ChecadorService {
  private api = inject(ApiService);
  private readonly POLL_MS = 15000;

  private poll<T>(fetchFn: () => Promise<T>, callback: (v: T) => void) {
    let activo = true;
    const tick = async () => {
      if (!activo) return;
      try { callback(await fetchFn()); } catch (e) { console.warn('checador poll:', e); }
    };
    tick();
    const id = setInterval(tick, this.POLL_MS);
    return () => { activo = false; clearInterval(id); };
  }

  // ===================== ÁREAS =====================
  escucharAreas(callback: (areas: AreaChecador[]) => void) {
    return this.poll(() => this.api.get<AreaChecador[]>('/checador/areas'), callback);
  }
  async guardarArea(area: AreaChecador): Promise<string> {
    const r = area.id
      ? await this.api.patch<AreaChecador>(`/checador/areas/${area.id}`, area)
      : await this.api.post<AreaChecador>('/checador/areas', area);
    return (r as any)?.id || area.id || '';
  }
  async eliminarArea(id: string): Promise<void> {
    await this.api.delete(`/checador/areas/${id}`);
  }

  // ===================== HORARIOS =====================
  escucharHorarios(callback: (horarios: HorarioArea[]) => void) {
    return this.poll(() => this.api.get<HorarioArea[]>('/checador/horarios'), callback);
  }
  async guardarHorario(horario: HorarioArea): Promise<string> {
    const r = horario.id
      ? await this.api.patch<HorarioArea>(`/checador/horarios/${horario.id}`, horario)
      : await this.api.post<HorarioArea>('/checador/horarios', horario);
    return (r as any)?.id || horario.id || '';
  }
  async eliminarHorario(id: string): Promise<void> {
    await this.api.delete(`/checador/horarios/${id}`);
  }

  // ===================== EMPLEADOS =====================
  async getEmpleados(): Promise<Empleado[]> {
    return this.api.get<Empleado[]>('/checador/empleados');
  }
  escucharEmpleados(callback: (empleados: Empleado[]) => void) {
    return this.poll(() => this.api.get<Empleado[]>('/checador/empleados'), callback);
  }
  /** Las fichas de una sola plaza (para ubicar la de una persona por su código). */
  async getEmpleadosDeSucursal(sucursalId: string): Promise<Empleado[]> {
    return this.api.get<Empleado[]>('/checador/empleados', { sucursalId });
  }
  async guardarEmpleado(empleado: Empleado): Promise<string> {
    const r = empleado.id
      ? await this.api.patch<Empleado>(`/checador/empleados/${empleado.id}`, empleado)
      : await this.api.post<Empleado>('/checador/empleados', empleado);
    return (r as any)?.id || empleado.id || '';
  }
  // (Ya no se borra a nadie: se da de baja y va a la Papelera de empleados.)

  /** Los que los relojes dieron de alta en los últimos `dias` (todas las plazas). */
  async getNuevosDelReloj(dias = 14): Promise<EmpleadoNuevo[]> {
    return this.api.get<EmpleadoNuevo[]>('/checador/empleados/nuevos', { dias: String(dias) });
  }

  /**
   * Quién checó en los últimos `dias` y no está completo en el sistema (sin
   * nombre completo, sin departamento, dado de baja o en la papelera), más las
   * altas de los últimos 14 días.
   */
  /** El siguiente número libre del reloj en una plaza, y de quién es `codigo` (si se pasa). */
  async numeroReloj(sucursalId: string, codigo = ''): Promise<{ siguiente: string; ocupadoPor: { nombre: string; activo: boolean; enPapelera: boolean } | null }> {
    return this.api.get('/checador/empleados/numero', codigo ? { sucursalId, codigo } : { sucursalId });
  }

  async getPorIdentificar(dias = 30): Promise<EmpleadoNuevo[]> {
    return this.api.get<EmpleadoNuevo[]>('/checador/empleados/por-identificar', { dias: String(dias) });
  }

  /** La Papelera de empleados: dados de baja y eliminados, de todas las plazas. */
  async getPapeleraEmpleados(): Promise<EmpleadoPapelera[]> {
    return this.api.get<EmpleadoPapelera[]>('/checador/empleados/papelera');
  }
  /**
   * Regresar de la papelera: reactiva en el sistema y, si se le había borrado
   * de un reloj, deja en cola volver a darlo de alta ahí con su respaldo.
   */
  async restaurarEmpleado(sucursalId: string, codigo: string): Promise<{ relojes: number }> {
    return this.api.post('/checador/reloj-comandos/restaurar', { sucursalId, codigo });
  }

  // ===================== HORARIO DE CADA PERSONA =====================
  /** Le pone el mismo horario a una o varias personas de una plaza. */
  async asignarHorario(sucursalId: string, codigos: string[], h: HorarioAsignado): Promise<{ guardados: number }> {
    return this.api.put('/checador/agente/horario-asignado', { sucursalId, codigos, ...h });
  }

  /** Les quita el horario asignado: vuelven a medirse con el deducido. */
  async quitarHorario(sucursalId: string, codigos: string[]): Promise<{ quitados: number }> {
    return this.api.post('/checador/agente/horario-asignado/quitar', { sucursalId, codigos });
  }

  // ===================== CHECADAS =====================
  async getChecadas(sucursalId: string, desde: string, hasta: string, codigo?: string): Promise<Checada[]> {
    const params: any = { sucursalId, desde, hasta };
    if (codigo) params.codigo = codigo;
    return this.api.get<Checada[]>('/checador/checadas', params);
  }

  /** Rango de fechas con datos de una sucursal: { min, max } (o null). */
  async getRangoChecadas(sucursalId: string): Promise<{ min: string | null; max: string | null }> {
    return this.api.get('/checador/checadas/rango', { sucursalId });
  }

  // ===================== REVISIÓN (justificación + verificación) =====================
  /** Revisiones (justificación/estado) de un empleado en un rango. */
  async getRevisiones(sucursalId: string, codigo: string, desde: string, hasta: string): Promise<RevisionDia[]> {
    return this.api.get<RevisionDia[]>('/checador/revision', { sucursalId, codigo, desde, hasta });
  }
  /**
   * Justifica un RANGO completo de días (vacaciones, incapacidad larga).
   *
   * Existe porque capturar unas vacaciones día por día son siete u ocho
   * guardados para UNA decisión, y a la tercera persona nadie lo hace. El estado
   * llega como `aprobada`: quien captura el periodo ya lo autorizó, y solo lo
   * aprobado deja de contar como falta.
   */
  async guardarRevisionRango(datos: {
    sucursalId: string; empleadoCodigo: string; desde: string; hasta: string;
    justificacion: string; estado?: EstadoRevision;
  }): Promise<{ dias: number; revisiones: RevisionDia[] }> {
    return this.api.put('/checador/revision/rango', { estado: 'aprobada', ...datos });
  }

  /** Guarda (upsert) la revisión de un día. */
  async guardarRevision(r: RevisionDia): Promise<RevisionDia> {
    return this.api.put<RevisionDia>('/checador/revision', r);
  }

  // ===================== INCIDENCIAS =====================
  private tiposIncidencia: Promise<TipoIncidencia[]> | null = null;
  /** El catálogo se pide una vez por sesión: no cambia entre pantallas. */
  getTiposIncidencia(): Promise<TipoIncidencia[]> {
    if (!this.tiposIncidencia) {
      this.tiposIncidencia = this.api.get<TipoIncidencia[]>('/checador/incidencias/tipos')
        .catch(e => { this.tiposIncidencia = null; throw e; });
    }
    return this.tiposIncidencia;
  }
  async crearIncidencia(i: Incidencia): Promise<Incidencia> {
    return this.api.post<Incidencia>('/checador/incidencias', i);
  }
  /** Ya no borra: la ANULA con su motivo (queda en la bitácora). */
  async eliminarIncidencia(id: string, motivo: string): Promise<void> {
    await this.api.delete(`/checador/incidencias/${id}?motivo=${encodeURIComponent(motivo)}`);
  }
  /** Las incidencias de la plaza en el periodo, con estado y banderas. `estados='todas'` incluye las anuladas. */
  async getIncidencias(sucursalId: string, desde: string, hasta: string,
                       opc: { codigo?: string; estados?: string } = {}): Promise<Incidencia[]> {
    return this.api.get<Incidencia[]>('/checador/incidencias', { sucursalId, desde, hasta, ...opc });
  }
  async pasoIncidencia(id: string, accion: 'calificar' | 'rechazar' | 'anular' | 'auditar', motivo = ''): Promise<Incidencia> {
    return this.api.post<Incidencia>(`/checador/incidencias/${id}/${accion}`, { motivo });
  }
  async getBitacoraIncidencia(id: string): Promise<PasoBitacora[]> {
    return this.api.get<PasoBitacora[]>(`/checador/incidencias/${id}/bitacora`);
  }

  // ===================== CIERRE DE SEMANA =====================
  async getCierres(sucursalId: string): Promise<CierreSemana[]> {
    return this.api.get<CierreSemana[]>('/checador/cierres', { sucursalId });
  }
  /** Las semanas CERRADAS que toca el periodo (vacío = todo abierto). */
  async getCierresEnPeriodo(sucursalId: string, desde: string, hasta: string): Promise<CierreSemana[]> {
    return this.api.get<CierreSemana[]>('/checador/cierres/estado', { sucursalId, desde, hasta });
  }
  async getCierre(id: string): Promise<CierreSemana> {
    return this.api.get<CierreSemana>(`/checador/cierres/${id}`);
  }
  /** `forzar` + `motivo`: cerrar aunque haya gente que checó sin estar identificada. */
  async cerrarSemana(sucursalId: string, desde: string, forzar?: { motivo: string }): Promise<CierreSemana> {
    return this.api.post<CierreSemana>('/checador/cierres',
      forzar ? { sucursalId, desde, forzar: true, motivo: forzar.motivo } : { sucursalId, desde });
  }
  async reabrirSemana(id: string, motivo: string): Promise<CierreSemana> {
    return this.api.post<CierreSemana>(`/checador/cierres/${id}/reabrir`, { motivo });
  }

  // ===================== CAMBIOS EN LOS RELOJES =====================
  async getCambiosReloj(sucursalId: string, codigo: string): Promise<CambiosReloj> {
    return this.api.get<CambiosReloj>('/checador/reloj-comandos', { sucursalId, codigo });
  }
  /** Cambia el nombre con el que está enrolada en el reloj (sistema + relojes). */
  async renombrarEnReloj(sucursalId: string, codigo: string, nombre: string): Promise<{ nombre: string; relojes: number }> {
    return this.api.post('/checador/reloj-comandos/renombrar', { sucursalId, codigo, nombre });
  }
  async cancelarComandoReloj(id: string): Promise<void> {
    await this.api.post(`/checador/reloj-comandos/${id}/cancelar`, {});
  }

  // ===================== ASISTENCIA CON EL HORARIO REAL =====================
  /**
   * La asistencia de cada persona calculada EN EL SERVIDOR con las reglas del
   * horario deducido. Antes esto se calculaba en el navegador contra el horario
   * configurado de la sucursal —que está mal en casi todas las plazas— y salían
   * números como «251 min de retardo en un solo día» o «207 min con cero horas
   * trabajadas» (ese día la persona había checado UNA vez).
   *
   * Cada persona trae `usable` y `marcas`: si viene una marca de gravedad alta,
   * el número existe pero NO se puede llevar a nómina.
   */
  /**
   * `soloPromotoras` devuelve la asistencia de las PROMOTORAS de la plaza en vez
   * de la del personal de planta. Es la MISMA regla con el filtro invertido —no
   * otro cálculo—, y de ahí sale la pantalla de Promotoría.
   */
  async getAsistencia(
    sucursalId: string, desde: string, hasta: string, soloPromotoras = false,
  ): Promise<AsistenciaPersonas> {
    return this.api.get<AsistenciaPersonas>('/checador/agente/asistencia',
      soloPromotoras ? { sucursalId, desde, hasta, soloPromotoras: '1' } : { sucursalId, desde, hasta });
  }

  /**
   * Quién checó en la plaza de otro, en el periodo. Mira TODAS las plazas a la
   * vez: por eso no lleva sucursalId.
   */
  async getCruces(desde: string, hasta: string): Promise<CrucesPlazas> {
    return this.api.get<CrucesPlazas>('/checador/agente/cruces', { desde, hasta });
  }

  /** Quién está en cada plaza AHORA. Alimenta el mapa en vivo. */
  presencia() {
    return this.api.get<Presencia>('/checador/agente/presencia');
  }

  /** "Ubicación de mi equipo": quién está en cada reloj ahora. Solo administradores. */
  getEquipo(fresco = false): Promise<EquipoAhora> {
    return this.api.get<EquipoAhora>('/checador/agente/equipo', fresco ? { fresco: '1' } : undefined);
  }

  // ===================== SEMÁFORO DE RELOJES =====================
  /**
   * Estado de cada reloj: cuándo se le oyó por última vez, cuánta historia
   * tiene, y si su hora está corrida. Es la contraparte visible del atraso que
   * el agente de horarios ya maneja bien por dentro.
   */
  async getEstadoRelojes(): Promise<EstadoReloj[]> {
    return this.api.get<EstadoReloj[]>('/checador/relojes/estado');
  }

  // ===================== AGENTE DE HORARIOS (IA) =====================
  /**
   * Qué revisó el agente POR SU CUENTA y cuándo (corredor de la Fase 3). Es lo
   * que permite que la pantalla muestre resultados al entrar, sin que nadie
   * apriete un botón.
   */
  async getEstadoAgente(): Promise<EstadoAgente> {
    return this.api.get<EstadoAgente>('/checador/agente/estado');
  }
  /** Corre la detección de inconsistencias y crea borradores. */
  async analizarAgente(sucursalId: string, desde: string, hasta: string): Promise<RespuestaAnalisis> {
    return this.api.post<RespuestaAnalisis>('/checador/agente/analizar', { sucursalId, desde, hasta });
  }
  /** Lista las alertas/borradores del agente (para revisar). */
  async getAlertasAgente(sucursalId: string, desde?: string, hasta?: string, estado?: string): Promise<AlertaAgente[]> {
    const params: any = { sucursalId };
    if (desde) params.desde = desde;
    if (hasta) params.hasta = hasta;
    if (estado) params.estado = estado;
    return this.api.get<AlertaAgente[]>('/checador/agente/alertas', params);
  }
  /**
   * La cola agrupada por causa. Al 30/07/2026 había **2,510 borradores
   * esperando y cero decididos**: pedir 2,510 decisiones una por una garantiza
   * que no se tome ninguna. Y no hacen falta — `checada_duplicada` es del LECTOR
   * (una decisión por sucursal) y `entrada_sin_salida` es de la rutina de una
   * PERSONA (una decisión por persona).
   */
  async getAlertasAgrupadas(
    sucursalId?: string, desde?: string, hasta?: string, estado?: string,
    nivel: 'persona' | 'sucursal' = 'sucursal'
  ): Promise<AlertasAgrupadas> {
    const params: any = { nivel };
    if (sucursalId) params.sucursalId = sucursalId;
    if (desde) params.desde = desde;
    if (hasta) params.hasta = hasta;
    if (estado) params.estado = estado;
    return this.api.get<AlertasAgrupadas>('/checador/agente/alertas/agrupadas', params);
  }

  /**
   * Decide un GRUPO completo. Solo `rechazada` o `descartada`: aprobar en bloque
   * mandaría un WhatsApp por alerta al jefe de la sucursal, así que aprobar sigue
   * siendo de una en una.
   */
  async decidirGrupo(g: {
    regla: string; sucursalId: string; empleadoCodigo?: string;
    desde?: string; hasta?: string;
    estado: 'rechazada' | 'descartada'; justificacion?: string;
  }): Promise<{ afectadas: number }> {
    return this.api.put<{ afectadas: number }>('/checador/agente/alertas/grupo', g);
  }

  /** RH resuelve una alerta: aprobada | rechazada | descartada (+ justificación opcional). */
  async decidirAlerta(id: string, estado: EstadoAlerta, justificacion?: string): Promise<AlertaAgente> {
    return this.api.put<AlertaAgente>(`/checador/agente/alertas/${id}`, { estado, justificacion });
  }

  // ===================== JEFES POR SUCURSAL (a quién se avisa) =====================
  /** Lista los jefes registrados (uno por sucursal, las que ya tienen). */
  async getJefes(): Promise<JefeSucursal[]> {
    return this.api.get<JefeSucursal[]>('/checador/agente/jefes');
  }
  /** Crea o actualiza el jefe de una sucursal (upsert por sucursalId). */
  async guardarJefe(j: JefeSucursal): Promise<JefeSucursal> {
    return this.api.put<JefeSucursal>('/checador/agente/jefes', j);
  }

  /**
   * Importa checadas. El mapeo código→empleado y la deduplicación ahora los hace
   * el servidor; `_empleados` se ignora (se mantiene por compatibilidad de firma).
   */
  async importarChecadas(
    sucursalId: string,
    filas: FilaChecadaCruda[],
    _empleados: Empleado[],
    areaId?: string
  ): Promise<ResultadoImportacion> {
    return this.api.post<ResultadoImportacion>('/checador/checadas/importar', { sucursalId, areaId, filas });
  }
}
