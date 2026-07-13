import { Injectable } from '@angular/core';

/**
 * Puente con el bot de reclutamiento (proyecto BOT-RH, desplegado en Railway).
 *
 * El bot expone /api/nueva-solicitud: recibe un candidateId, lee al candidato
 * de Firestore por su id y le manda la plantilla de invitación por WhatsApp
 * desde el número OFICIAL del bot, enganchándolo a la conversación automática.
 * Es el mismo endpoint que dispara el formulario público /unete al registrarse.
 */
const BOT_URL = 'https://bot-rh-production.up.railway.app';

export interface InvitacionResp {
  ok: boolean;
  /** true si el bot mandó la invitación; false si no (ver `motivo`/`error`) */
  invitado?: boolean;
  /** p.ej. 'ya_en_proceso' cuando el candidato ya tiene conversación abierta */
  motivo?: string;
  error?: string;
}

@Injectable({ providedIn: 'root' })
export class BotService {
  /**
   * Pide al bot que le escriba al candidato por WhatsApp y lo conecte con la
   * conversación automática. Nunca lanza: devuelve un objeto con el resultado
   * para que la UI decida qué toast mostrar.
   */
  async invitarPorWhatsApp(candidateId: string): Promise<InvitacionResp> {
    try {
      const res = await fetch(`${BOT_URL}/api/nueva-solicitud`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateId }),
      });
      let data: any = {};
      try { data = await res.json(); } catch { /* respuesta sin JSON */ }
      if (!res.ok) {
        return { ok: false, error: data?.error || `HTTP ${res.status}` };
      }
      return data as InvitacionResp;
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Sin conexión con el bot' };
    }
  }
}
