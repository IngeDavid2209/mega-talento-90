import { Injectable, inject } from '@angular/core';
import { ApiService } from './api.service';

/**
 * KPI "Concentrado de candidatos" + BITÁCORA de lo que se le hace a cada uno.
 *
 * Dos cosas que conviene tener claras al usar esto:
 *
 * 1. `ocurridoEn` es OPCIONAL a propósito. RH captura al final del día lo que
 *    hizo en la mañana; si todo se fechara "ahora", el conteo por día mentiría.
 *
 * 2. La respuesta del concentrado trae `avisos[]`: son las razones por las que un
 *    número puede estar en cero (nadie marcado como contratado, ninguna entrevista
 *    registrada…). HAY QUE PINTARLOS. Un cero sin explicación en un tablero se
 *    lee como "no se trabajó", y eso es mentir con datos.
 */

export type TipoEvento = 'contacto' | 'entrevista' | 'contratacion' | 'nota';
export type CanalEvento = 'llamada' | 'whatsapp' | 'presencial' | 'bot' | 'portal';

export interface EventoCandidato {
  id: string;
  tipo: TipoEvento;
  canal: CanalEvento | null;
  nota: string | null;
  por: string | null;
  ocurridoEn: string;
}

export interface DiaKpi {
  dia: string;
  postulaciones: number;
  contactadosBot: number;
  contactadosRH: number;
  contactados: number;
  respondieron: number;
  entrevistas: number;
  contrataciones: number;
}

export interface Concentrado {
  rango: { desde: string; hasta: string; dias: number };
  porDia: DiaKpi[];
  totales: {
    postulaciones: number; contactados: number; contactadosBot: number;
    contactadosRH: number; respondieron: number; entrevistas: number;
    contrataciones: number; promedioContactadosPorDia: number;
    promedioPostulacionesPorDia: number; tasaRespuesta: number | null;
  };
  embudo: { etapa: string; n: number }[];
  cobertura: {
    medible: boolean; contratados: number; sinFecha: number;
    medianaDias: number | null; en7: number; en15: number; masDe15: number;
    detalle: { id: string; nombre: string; puesto: string; postuloEn: string; contratadoEn: string; dias: number }[];
  };
  enProceso: {
    total: number; dentroDe7: number; entre7y15: number; masDe15: number;
    atorados: { id: string; nombre: string; puesto: string; etapa: string; dias: number; ultimoContacto: string | null }[];
  };
  tiempoPorEtapa: { etapa: string; n: number; promHoras: number; minHoras: number; maxHoras: number }[];
  conversion: { entrevistados: number; contratados: number; tasa: number | null };
  avisos: string[];
}

@Injectable({ providedIn: 'root' })
export class KpiService {
  private api = inject(ApiService);

  concentrado(dias = 7): Promise<Concentrado> {
    return this.api.get<Concentrado>('/kpi/concentrado', { dias });
  }

  /** Registra un contacto/entrevista/nota. `ocurridoEn` en ISO si no fue ahora. */
  registrarEvento(candidatoId: string, tipo: TipoEvento, opts: {
    canal?: CanalEvento; nota?: string; ocurridoEn?: string;
  } = {}): Promise<EventoCandidato> {
    return this.api.post<EventoCandidato>('/kpi/eventos', { candidatoId, tipo, ...opts });
  }

  eventos(candidatoId: string): Promise<EventoCandidato[]> {
    return this.api.get<EventoCandidato[]>(`/kpi/eventos/${candidatoId}`);
  }

  borrarEvento(id: string): Promise<{ ok: boolean }> {
    return this.api.delete(`/kpi/eventos/${id}`);
  }
}
