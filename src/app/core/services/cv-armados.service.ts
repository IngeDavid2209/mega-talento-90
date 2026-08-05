import { Injectable, inject } from '@angular/core';
import { ApiService } from './api.service';

/** Una hoja armada por el bot, con lo que RH necesita para revisarla. */
export interface CvArmado {
  id: string;
  telefono: string;
  nombre: string;
  ciudad: string;
  estadoBot: string;
  etapa: string | null;
  creadoEn: string;
  /** 'aprobado' = el candidato lo aceptó y ya es su CV · 'borrador' = espera su sí. */
  estado: 'aprobado' | 'borrador';
  armadoEn: string | null;
  aprobadoEn: string | null;
  archivo: string | null;
  /** El PDF lo sirve el BOT con una liga por token: es de otro dominio. */
  url: string | null;
  /** Cuántas veces se rearmó (el candidato pidió corregir algo). */
  intentos: number;
  /** Todo lo que dictó por WhatsApp (la solicitud de empleo completa). */
  respuestas: Record<string, any>;
}

export interface CvArmadosResp {
  total: number;
  aprobados: number;
  borradores: number;
  candidatos: CvArmado[];
}

@Injectable({ providedIn: 'root' })
export class CvArmadosService {
  private api = inject(ApiService);

  /** Los currículums que el bot armó por WhatsApp para quien no tenía uno. */
  async listar(): Promise<CvArmadosResp> {
    return this.api.get<CvArmadosResp>('/candidatos/cv-armados');
  }
}
