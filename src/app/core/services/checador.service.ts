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

export type EstadoDiaApi = 'a_tiempo' | 'absorbido' | 'retardo' | 'falta' | 'descanso' | 'marca_faltante';

export interface DiaApi {
  fecha: string;
  estado: EstadoDiaApi;
  entrada?: string | null;
  salida?: string | null;
  hora?: string | null;          // la marca única de un día 'marca_faltante'
  referencia?: string | null;    // contra qué se midió ese día
  comida: string;
  horasNetas: string;
  atrasoMin: number;             // minutos crudos de atraso
  absorbidoMin: number;          // lo que absorbió la bolsa semanal
  retardoRealMin: number;        // el excedente: esto es el retardo
  bolsaAntes: number;
  bolsaDespues: number;
  atipico?: boolean;
  marcas?: number;
}

export interface SemanaApi {
  inicio: string;
  bolsaInicial: number;
  bolsaRestante: number;
  atrasoMin: number;
  retardoRealMin: number;
  bolsaAgotada: boolean;
  dias: DiaApi[];
}

export interface PersonaAsistencia {
  codigo: string; nombre: string; puesto: string; fotoUrl: string;
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
  diasNoMedibles: number;             // días de una sola marca
  diasAtipicos: number;
  horasTrabajadas: number;
  /** null cuando no hubo ni un día evaluable: un 0% falso parece el peor empleado. */
  pctATiempo: number | null;
  semanas: SemanaApi[];
  marcas: MarcaAsistencia[];
  usable: boolean;
  bloqueadoPor: string[];
}

export interface AsistenciaPersonas {
  sucursalId: string; desde: string; hasta: string;
  /** Desde cuándo se leyó para DEDUCIR el horario (más ancho que el rango). */
  desdeHorario: string;
  ventanaHorarioDias: number;
  bolsaSemanalMin: number;
  corteSemana: string;
  diasExTrabajador: number;
  resumen: {
    personas: number; usables: number; conPendiente: number;
    fijos: number; rotativos: number; sinPatron: number; sinDatos: number;
    horarioAmbiguo: number; horarioConfirmado: number; soloUnaMarca: number;
    exTrabajadores: number; fueraDelPadron: number;
    retardoRealMin: number; retardoRealUsableMin: number;
    atrasoBrutoMin: number; absorbidoMin: number;
    faltas: number; diasNoMedibles: number; horasTrabajadas: number;
  };
  personas: PersonaAsistencia[];
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
  async guardarEmpleado(empleado: Empleado): Promise<string> {
    const r = empleado.id
      ? await this.api.patch<Empleado>(`/checador/empleados/${empleado.id}`, empleado)
      : await this.api.post<Empleado>('/checador/empleados', empleado);
    return (r as any)?.id || empleado.id || '';
  }
  async eliminarEmpleado(id: string): Promise<void> {
    await this.api.delete(`/checador/empleados/${id}`);
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
  /** Guarda (upsert) la revisión de un día. */
  async guardarRevision(r: RevisionDia): Promise<RevisionDia> {
    return this.api.put<RevisionDia>('/checador/revision', r);
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
  async getAsistencia(sucursalId: string, desde: string, hasta: string): Promise<AsistenciaPersonas> {
    return this.api.get<AsistenciaPersonas>('/checador/agente/asistencia', { sucursalId, desde, hasta });
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
