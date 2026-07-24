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
