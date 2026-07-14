import { inject, Injectable } from '@angular/core';
import { ToastService } from './toast.service';

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

export interface PedirDocsResp {
  ok: boolean;
  /** true si el bot logró enviar el aviso (plantilla o dentro de ventana 24h) */
  enviado?: boolean;
  error?: string;
}

/** Slot de documento que el bot debe pedir (key debe coincidir con el expediente). */
export interface DocSlotPeticion {
  key: string;
  label: string;
}

/** Un mensaje del historial de la conversación bot ↔ candidato. */
export interface MensajeBot {
  direccion: 'in' | 'out';   // in = candidato→bot | out = bot→candidato
  tipo: string;              // text | image | document | template | ...
  texto: string | null;
  media_url: string | null;
  creado_en: string;
}

@Injectable({ providedIn: 'root' })
export class BotService {
  private toast = inject(ToastService);

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

  /**
   * Flujo COMPLETO para el botón "Conectar con el bot" que usan varias
   * pantallas (historial, etapa, expediente, contacto): pide confirmación,
   * llama al bot y muestra el toast según el resultado.
   *
   * @param c        candidato (necesita `id` de Firestore, `nombre` opcional)
   * @param enviando Set opcional de ids "en curso" para deshabilitar el botón
   *                 mientras se envía. El método lo agrega/quita solo.
   */
  async conectarConBot(c: any, enviando?: Set<string>): Promise<void> {
    if (!c?.id) {
      this.toast.error('Este candidato no tiene un identificador válido.', 'No se puede contactar');
      return;
    }
    if (enviando?.has(c.id)) return;

    const ok = await this.toast.confirmar({
      titulo: `Conectar a ${c.nombre || 'este candidato'} con el bot`,
      mensaje: 'El bot de reclutamiento le enviará un WhatsApp desde el número oficial para que continúe su proceso directamente en el chat. ¿Enviar ahora?',
      textoConfirmar: 'Sí, enviar',
      textoCancelar: 'Cancelar',
    });
    if (!ok) return;

    enviando?.add(c.id);
    try {
      const r = await this.invitarPorWhatsApp(c.id);
      if (r.ok && r.invitado) {
        this.toast.exito(
          `El bot le escribió a ${c.nombre || 'el candidato'} por WhatsApp.`,
          'Invitación enviada'
        );
      } else if (r.ok && r.motivo === 'ya_en_proceso') {
        this.toast.info(
          `${c.nombre || 'El candidato'} ya tiene una conversación en curso con el bot.`,
          'Sin cambios'
        );
      } else if (r.ok) {
        this.toast.error(
          'El bot no pudo enviar el mensaje. Revisa que la plantilla de WhatsApp esté aprobada en Meta y que el teléfono sea válido.',
          'No se envió'
        );
      } else {
        this.toast.error(
          r.error || 'No se pudo contactar al bot. Revisa tu conexión e intenta de nuevo.',
          'Error'
        );
      }
    } finally {
      enviando?.delete(c.id);
    }
  }

  /**
   * Pide al bot que le solicite al candidato su documentación pendiente por
   * WhatsApp (post-psicométricas). El bot lo pone en modo recolección y le manda
   * la lista; los archivos que envíe aparecen en su expediente (documentosBot).
   * @param documentos lista opcional de documentos; si se omite, el bot usa una
   *                   lista por defecto (INE, CURP, comprobantes, etc.).
   */
  async pedirDocumentos(candidateId: string, documentos?: DocSlotPeticion[]): Promise<PedirDocsResp> {
    try {
      const body: any = { candidateId };
      if (documentos?.length) body.documentos = documentos;
      const res = await fetch(`${BOT_URL}/api/pedir-documentos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      let data: any = {};
      try { data = await res.json(); } catch { /* respuesta sin JSON */ }
      if (!res.ok) {
        return { ok: false, error: data?.error || `HTTP ${res.status}` };
      }
      return data as PedirDocsResp;
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Sin conexión con el bot' };
    }
  }

  /**
   * Flujo COMPLETO para el botón "Pedir documentos por WhatsApp": confirma,
   * llama al bot y muestra el toast según el resultado.
   */
  async solicitarDocumentos(c: any, documentos?: DocSlotPeticion[], enviando?: Set<string>): Promise<void> {
    if (!c?.id) {
      this.toast.error('Este candidato no tiene un identificador válido.', 'No se puede contactar');
      return;
    }
    if (enviando?.has(c.id)) return;

    const ok = await this.toast.confirmar({
      titulo: `Pedir documentos a ${c.nombre || 'este candidato'}`,
      mensaje: 'El bot le enviará un WhatsApp desde el número oficial pidiéndole su documentación pendiente (INE, CURP, comprobantes, etc.). Los archivos que mande aparecerán aquí en Archivos. ¿Enviar ahora?',
      textoConfirmar: 'Sí, pedir documentos',
      textoCancelar: 'Cancelar',
    });
    if (!ok) return;

    enviando?.add(c.id);
    try {
      const r = await this.pedirDocumentos(c.id, documentos);
      if (r.ok && r.enviado) {
        this.toast.exito(
          `El bot le pidió sus documentos a ${c.nombre || 'el candidato'} por WhatsApp.`,
          'Solicitud enviada'
        );
      } else if (r.ok) {
        this.toast.error(
          'El bot no pudo enviar el mensaje. Revisa que la plantilla "documentos_pendientes" esté aprobada en Meta, o que el candidato haya escrito en las últimas 24 h.',
          'No se envió'
        );
      } else {
        this.toast.error(
          r.error || 'No se pudo contactar al bot. Revisa tu conexión e intenta de nuevo.',
          'Error'
        );
      }
    } finally {
      enviando?.delete(c.id);
    }
  }

  /**
   * Trae el historial de la conversación del bot con un candidato (por su id del
   * portal). Nunca lanza: devuelve { ok, mensajes | error }.
   */
  async obtenerConversacion(candidateId: string): Promise<{ ok: boolean; mensajes?: MensajeBot[]; error?: string }> {
    try {
      const res = await fetch(`${BOT_URL}/api/conversacion?candidateId=${encodeURIComponent(candidateId)}`);
      let data: any = {};
      try { data = await res.json(); } catch { /* respuesta sin JSON */ }
      if (!res.ok) return { ok: false, error: data?.error || `HTTP ${res.status}` };
      return { ok: true, mensajes: (data.mensajes || []) as MensajeBot[] };
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Sin conexión con el bot' };
    }
  }
}
