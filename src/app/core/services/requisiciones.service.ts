import { Injectable, inject } from '@angular/core';
import { ApiService } from './api.service';

/**
 * Requisiciones de personal: la petición formal de una sucursal para que RH
 * consiga a alguien. Ver api/src/requisiciones.ts para las reglas del modelo.
 */

export type EstadoRequisicion = 'pendiente' | 'autorizada' | 'rechazada' | 'cubierta' | 'cancelada';
export type MotivoRequisicion = 'nuevo' | 'reemplazo' | 'temporal' | 'otro';

export interface Requisicion {
  id: string;
  folio: number;
  puesto: string;
  puestoId: string | null;
  sucursalId: string | null;
  area: string | null;
  vacantes: number;
  motivo: MotivoRequisicion;
  reemplazaA: string | null;
  /** 'YYYY-MM-DD' — para cuándo se necesita. */
  fechaRequerida: string | null;
  justificacion: string | null;
  archivoUrl: string | null;
  archivoNombre: string | null;
  solicita: string | null;
  estado: EstadoRequisicion;
  resueltaPor: string | null;
  resueltaEn: string | null;
  notaResolucion: string | null;
  cubiertaPor: string | null;
  cubiertaNombre: string | null;
  cubiertaEn: string | null;
  creadoPor: string | null;
  creadoEn: string;
  /** Días que lleva esperando desde que se capturó. */
  diasEsperando: number;
  /** Días que faltan para la fecha pedida. Negativo = ya se pasó. null = sin fecha. */
  diasParaFecha: number | null;
}

export interface ResumenRequisiciones {
  pendientes: number;
  autorizadas: number;
  paraHoy: number;
  vencidas: number;
  /** Suma de vacantes de todo lo que sigue abierto: personas, no requisiciones. */
  personasPedidas: number;
  cubiertas30d: number;
  urgentes: Requisicion[];
}

@Injectable({ providedIn: 'root' })
export class RequisicionesService {
  private api = inject(ApiService);

  /** `estado` acepta un estado concreto o 'abiertas' (pendientes + autorizadas). */
  listar(estado?: string, sucursalId?: string): Promise<Requisicion[]> {
    const q: any = {};
    if (estado) q.estado = estado;
    if (sucursalId) q.sucursalId = sucursalId;
    return this.api.get<Requisicion[]>('/requisiciones', q);
  }

  resumen(): Promise<ResumenRequisiciones> {
    return this.api.get<ResumenRequisiciones>('/requisiciones/resumen');
  }

  crear(r: Partial<Requisicion>): Promise<Requisicion> {
    return this.api.post<Requisicion>('/requisiciones', r);
  }

  actualizar(id: string, cambios: Partial<Requisicion>): Promise<Requisicion> {
    return this.api.patch<Requisicion>(`/requisiciones/${id}`, cambios);
  }

  borrar(id: string): Promise<{ ok: boolean }> {
    return this.api.delete(`/requisiciones/${id}`);
  }
}
