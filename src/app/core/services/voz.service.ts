import { Injectable, signal } from '@angular/core';

/**
 * Servicio de Text-to-Speech (TTS) nativo del navegador usando la
 * Web Speech API. Funciona gratis sin backend en Chrome, Edge, Firefox,
 * Safari y Android. La voz depende del sistema operativo del candidato
 * (en Windows hay 'Microsoft Sabina' para es-MX, en Android la voz de
 * Google, en iOS Paulina/Mónica).
 *
 * IMPORTANTE: los navegadores bloquean el primer audio hasta que el
 * usuario hace un gesto (click, tap). Por eso la evaluación arranca
 * con un botón "Empezar con audio" que llama a desbloquear() antes
 * de leer cualquier cosa.
 */
@Injectable({ providedIn: 'root' })
export class VozService {
  /** True cuando hay una utterance reproduciéndose */
  hablando = signal(false);

  /** Si el usuario activó/silenció con el botón de audio */
  habilitado = signal(true);

  /** Si el navegador ya nos dejó hablar (hubo gesto del usuario) */
  desbloqueado = signal(false);

  private synth: SpeechSynthesis | null = null;
  private voz: SpeechSynthesisVoice | null = null;

  constructor() {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      this.synth = window.speechSynthesis;
      this.cargarVoz();
    }
  }

  /** True si el navegador soporta TTS */
  get soportado(): boolean {
    return this.synth !== null;
  }

  /**
   * Desbloquea el audio del navegador. Debe llamarse DENTRO de un
   * handler de click/tap del usuario (la primera vez en la sesión).
   * Hace un speak silencioso para que después los demás funcionen.
   */
  desbloquear(): void {
    if (!this.synth || this.desbloqueado()) return;
    const utt = new SpeechSynthesisUtterance(' ');
    utt.volume = 0;
    utt.rate = 1;
    utt.onend = () => this.desbloqueado.set(true);
    utt.onerror = () => this.desbloqueado.set(true);
    try {
      this.synth.speak(utt);
    } catch {
      this.desbloqueado.set(true);
    }
  }

  /** Carga la mejor voz de español disponible en el sistema */
  private cargarVoz(): void {
    if (!this.synth) return;
    const elegir = () => {
      if (!this.synth) return;
      const voces = this.synth.getVoices();
      this.voz =
        voces.find(v => v.lang === 'es-MX') ||
        voces.find(v => v.lang === 'es-US') ||
        voces.find(v => v.lang === 'es-ES') ||
        voces.find(v => v.lang.startsWith('es-')) ||
        voces.find(v => v.lang.toLowerCase().startsWith('es')) ||
        null;
    };
    elegir();
    this.synth.onvoiceschanged = elegir;
  }

  /**
   * Lee un texto en voz alta. Cancela cualquier lectura previa.
   * @param texto      Lo que se va a leer
   * @param opciones   { onEnd } se llama cuando termina (o nunca si está silenciado)
   */
  hablar(texto: string, opciones: { onEnd?: () => void; rate?: number } = {}): void {
    if (!this.synth || !this.habilitado()) {
      if (opciones.onEnd) setTimeout(opciones.onEnd, 0);
      return;
    }
    this.parar();
    const utt = new SpeechSynthesisUtterance(texto);
    if (this.voz) utt.voice = this.voz;
    utt.lang = this.voz?.lang || 'es-MX';
    utt.rate = opciones.rate ?? 0.95;
    utt.pitch = 1;
    utt.volume = 1;
    utt.onstart = () => this.hablando.set(true);
    utt.onend = () => {
      this.hablando.set(false);
      if (opciones.onEnd) opciones.onEnd();
    };
    utt.onerror = () => {
      this.hablando.set(false);
    };
    try {
      this.synth.speak(utt);
    } catch (e) {
      console.warn('VozService: no se pudo hablar', e);
      this.hablando.set(false);
    }
  }

  /** Detiene cualquier lectura en curso */
  parar(): void {
    if (this.synth?.speaking || this.synth?.pending) {
      try { this.synth.cancel(); } catch {}
    }
    this.hablando.set(false);
  }

  /** Activa/silencia el audio. Si silencia, también detiene lo que se esté leyendo. */
  toggle(): void {
    if (this.habilitado()) {
      this.habilitado.set(false);
      this.parar();
    } else {
      this.habilitado.set(true);
    }
  }
}
