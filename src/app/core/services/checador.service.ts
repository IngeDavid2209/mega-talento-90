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
}
export interface RespuestaAnalisis {
  resumen: ResumenAgente;
  borradores: { creadas: number; actualizadas: number; sinCambio: number; eliminadas: number };
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

  // ===================== AGENTE DE HORARIOS (IA) =====================
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
