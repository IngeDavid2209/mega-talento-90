import { Injectable, inject } from '@angular/core';
import { ApiService } from './api.service';

/**
 * Permanencia de los contratados (30/60/90 días). Las reglas de qué se puede
 * afirmar y qué no viven en api/src/permanencia.ts; aquí solo los tipos.
 */

/** 'activo' y 'sin_marcas' solo existen si la liga con el reloj está confirmada. */
export type EstadoPermanencia = 'activo' | 'sin_marcas' | 'sin_verificar' | 'baja_portal';

export interface EmpleadoLigado {
  id: string;
  codigo: string;
  nombre: string;
  sucursalId: string;
  activo: boolean;
  /** false = es una coincidencia por nombre que nadie ha confirmado. */
  confirmado: boolean;
  diasMarcados: number;
}

export interface PersonaPermanencia {
  id: string;
  nombre: string;
  puesto: string;
  telefono: string | null;
  /** Encuestas de onboarding: { "3": { enviadaEn, contestadaEn } , ... }. */
  encuestas: Record<string, { enviadaEn?: string; contestadaEn?: string }>;
  /** 'YYYY-MM-DD'. null = no hay fecha de ingreso y no se le pueden contar días. */
  ingreso: string | null;
  dias: number | null;
  /** true = la fecha viene de `hiredAt`; false = se dedujo del historial de etapas. */
  fechaPropia: boolean;
  sigueEnPortal: boolean;
  estado: EstadoPermanencia;
  /** Último hito cumplido (7/30/60/90) o null si aún no llega al primero. */
  hito: number | null;
  empleado: EmpleadoLigado | null;
  ultimaChecada: string | null;
  diasSinChecar: number | null;
  /** Hasta qué día de su contrato hay marcas que lo prueben. */
  diasProbados: number | null;
}

export interface HitoPermanencia {
  dia: number;
  /** Contratados hace al menos `dia` días: los únicos a los que se les puede exigir. */
  elegibles: number;
  /** Los que el portal sigue marcando como contratados (una suposición). */
  enPortal: number;
  /** Los que checaron en o después del día del hito (un hecho). */
  confirmados: number;
  sinVerificar: number;
  verificables: number;
  pctPortal: number | null;
  pctConfirmado: number | null;
}

export interface CohortePermanencia {
  /** 'YYYY-MM' */
  mes: string;
  n: number;
  hitos: Record<number, { elegibles: number; confirmados: number; enPortal: number }>;
}

export interface Permanencia {
  hoy: string;
  hitosDias: number[];
  resumen: {
    total: number; conFecha: number; sinFecha: number;
    ligados: number; sugeridos: number; sinLiga: number;
    activos: number; sinMarcas: number; bajaPortal: number;
  };
  hitos: HitoPermanencia[];
  cohortes: CohortePermanencia[];
  personas: PersonaPermanencia[];
  avisos: string[];
}

export interface EmpleadoReloj {
  id: string;
  nombre: string;
  puesto: string | null;
  sucursalId: string;
  codigo: string;
  activo: boolean;
  ultima: string | null;
}

@Injectable({ providedIn: 'root' })
export class PermanenciaService {
  private api = inject(ApiService);

  tablero(): Promise<Permanencia> {
    return this.api.get<Permanencia>('/permanencia');
  }

  /** Padrón del reloj sin ligar, para buscar a mano cuando el nombre no coincide. */
  buscarEmpleados(q = ''): Promise<EmpleadoReloj[]> {
    return this.api.get<EmpleadoReloj[]>('/permanencia/empleados', { q });
  }

  /** `empleadoId` null deshace la liga. */
  vincular(candidatoId: string, empleadoId: string | null): Promise<any> {
    return this.api.post('/permanencia/vincular', { candidatoId, empleadoId });
  }

  fijarIngreso(candidatoId: string, fecha: string): Promise<any> {
    return this.api.patch('/permanencia/ingreso', { candidatoId, fecha });
  }
}
