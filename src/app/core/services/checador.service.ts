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
