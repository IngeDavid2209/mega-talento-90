import { Injectable, signal } from '@angular/core';

/**
 * Tipo mínimo del SDK de Azure (lo que usamos). El SDK real se carga
 * dinámicamente como <script> desde el CDN de Microsoft para evitar
 * problemas con polyfills de Node en el bundle de Angular.
 */
declare global {
  interface Window {
    SpeechSDK?: any;
  }
}

/**
 * Servicio de Text-to-Speech con DOS motores:
 *
 * 1. Azure Cognitive Services Speech (primario, alta calidad).
 *    - Voz humana realista (es-MX-CecilioNeural por defecto: masculina, locutor).
 *    - Eventos de visemas para sincronización labial.
 *    - Requiere endpoint /api/azure-token configurado en Vercel y la
 *      variable AZURE_SPEECH_KEY en environment variables del proyecto.
 *    - El SDK se carga dinámicamente desde el CDN de Microsoft.
 *
 * 2. Web Speech API nativa del navegador (fallback automático).
 *    - Gratis sin dependencias.
 *    - Calidad variable (suena más a robot).
 *    - Se usa si Azure no responde o el token endpoint falla.
 *
 * La app no se entera de cuál motor está usando: ambos exponen los mismos
 * signals (hablando, habilitado, soportado) y métodos (hablar, parar, toggle).
 */
@Injectable({ providedIn: 'root' })
export class VozService {
  /** True cuando hay audio reproduciéndose */
  hablando = signal(false);

  /** Si el usuario silenció con el botón */
  habilitado = signal(true);

  /** Si el navegador ya nos dejó hablar (hubo gesto del usuario) */
  desbloqueado = signal(false);

  /** ID del viseme actual de Azure (0-21). 0 = silencio. Solo aplica con Azure. */
  visemeActual = signal<number>(0);

  /**
   * Voz neural de Azure a usar. Cambiar aquí si se quiere otra.
   * es-MX-CecilioNeural: voz masculina mexicana neutra, estilo locutor
   * (acorde a una entrevista/evaluación formal). Otras masculinas es-MX:
   * JorgeNeural, LibertoNeural, GerardoNeural. Femenina: DaliaNeural.
   */
  vozAzure = 'es-MX-CecilioNeural';

  /** URL del SDK browser-ready de Azure (oficial Microsoft) */
  private readonly SDK_URL = 'https://aka.ms/csspeech/jsbrowserpackageraw';

  // ============== AZURE ==============
  private azureToken = '';
  private azureRegion = '';
  private azureTokenExpira = 0;
  /** Se vuelve false si Azure falla; entonces toda llamada usa TTS nativo. */
  private azureDisponible = true;
  private synthAzure: any = null;
  private sdkCargado = false;
  private sdkCargando: Promise<void> | null = null;

  /**
   * Contador de "generación" para invalidar llamadas en curso. Cada `parar()`
   * (y cada `hablar()` que lo precede) lo incrementa. Si un `hablarConAzure`
   * lleva varios await pendientes (cargar SDK, pedir token), al volver verifica
   * que su generación siga vigente; si no, aborta sin reproducir audio. Esto
   * evita que dos voces se reproduzcan a la vez cuando se encadenan llamadas
   * rápidas a `hablar()`.
   */
  private generacion = 0;

  /**
   * Timestamp del momento en que el callback de éxito del último Azure speak
   * fue invocado. Azure considera "terminado" cuando mandó el último chunk al
   * audio buffer, pero el speaker sigue sonando ~200-300ms más. Para no
   * encimar el siguiente speak sobre el residuo del anterior, esperamos a
   * que pase un mínimo desde este timestamp antes de iniciar otro audio.
   * Una marca de 0 significa "nunca hemos hablado" → la primera llamada
   * arranca sin retraso.
   */
  private tsFinUltimoAudio = 0;
  /**
   * Tiempo mínimo (ms) entre fin de un audio y inicio del siguiente. El buffer
   * del speaker en Chrome/Edge tarda hasta ~400ms en vaciarse después de
   * `synth.close()`, así que ponemos 450ms para no escuchar el residuo del
   * audio anterior cuando el usuario salta rápido entre preguntas.
   */
  private readonly DRENAJE_MS = 450;

  // ============== TTS NATIVO ==============
  private synthNativa: SpeechSynthesis | null = null;
  private vozNativa: SpeechSynthesisVoice | null = null;

  constructor() {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      this.synthNativa = window.speechSynthesis;
      this.cargarVozNativa();
    }
  }

  /** True si al menos un motor de TTS está disponible */
  get soportado(): boolean {
    return this.synthNativa !== null || this.azureDisponible;
  }

  /**
   * Pre-carga el SDK de Azure y pide el token en background, sin reproducir
   * nada. Se debe llamar al entrar a la pantalla que usa voz (típicamente
   * en ngOnInit), antes de que el usuario presione "Empezar". Cuando llegue
   * el primer hablar(), ya estará todo en caché → latencia ~instantánea.
   *
   * No falla si no hay conectividad: las llamadas reales harán fallback al
   * TTS nativo cuando toque.
   */
  precalentar(): void {
    if (!this.azureDisponible) return;
    // Carga del SDK
    this.cargarSDK().catch(() => { this.azureDisponible = false; });
    // Token (se almacena en caché 8 minutos)
    this.obtenerTokenAzure().catch(() => { /* silencioso: fallback en runtime */ });
  }

  /**
   * Debe llamarse DENTRO de un click handler la primera vez para autorizar audio.
   *
   * Si Azure está disponible (caso normal), NO usamos la "speech silenciosa"
   * del navegador, porque corre en el motor nativo (speechSynthesis) — distinto
   * del AudioContext que usa Azure. Tener ambas activas a la vez es lo que
   * causaba las voces solapadas al iniciar.
   *
   * En su lugar, desbloqueamos el AudioContext con un buffer vacío. El click
   * que disparó esta llamada cuenta como el "gesto del usuario" requerido por
   * los navegadores. Si Azure no está disponible, sí hacemos la unlock nativa.
   */
  desbloquear(): void {
    if (this.desbloqueado()) return;

    if (this.azureDisponible) {
      // Azure: desbloquear AudioContext con un buffer vacío.
      try {
        const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
        if (Ctx) {
          const ctx = new Ctx();
          const buffer = ctx.createBuffer(1, 1, 22050);
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          source.connect(ctx.destination);
          source.start(0);
          // El AudioContext puede iniciar en estado 'suspended' en Safari/iOS.
          ctx.resume?.();
        }
      } catch { /* no pasa nada, Azure manejará su propio unlock */ }
      this.desbloqueado.set(true);
    } else if (this.synthNativa) {
      // Fallback: motor nativo necesita la speech silenciosa para desbloquear
      const utt = new SpeechSynthesisUtterance(' ');
      utt.volume = 0;
      utt.onend = () => this.desbloqueado.set(true);
      utt.onerror = () => this.desbloqueado.set(true);
      try {
        this.synthNativa.speak(utt);
      } catch {
        this.desbloqueado.set(true);
      }
    } else {
      this.desbloqueado.set(true);
    }
  }

  /**
   * Lee un texto en voz alta. Intenta Azure primero; si falla cae a TTS nativo.
   */
  hablar(texto: string, opciones: { onEnd?: () => void; rate?: number } = {}): void {
    if (!this.habilitado()) {
      if (opciones.onEnd) setTimeout(opciones.onEnd, 0);
      return;
    }
    this.parar();
    const miGen = this.generacion;

    if (this.azureDisponible) {
      this.hablarConAzure(texto, opciones, miGen).catch((err) => {
        // Si esta llamada ya fue invalidada por un parar() o un hablar() nuevo,
        // no caer al fallback nativo: el siguiente hablar() ya tomó el control.
        if (miGen !== this.generacion) return;
        console.warn('VozService: Azure falló, fallback a TTS nativo.', err);
        this.azureDisponible = false;
        this.hablarConNativa(texto, opciones);
      });
    } else {
      this.hablarConNativa(texto, opciones);
    }
  }

  /** Detiene cualquier audio que esté reproduciéndose */
  parar(): void {
    // Invalida cualquier hablar() en vuelo (cargando SDK / pidiendo token).
    this.generacion++;
    if (this.synthAzure) {
      try { this.synthAzure.close(); } catch {}
      this.synthAzure = null;
      // Si interrumpimos en vivo, el buffer del speaker aún sonará un rato.
      // Marcar el timestamp para que el siguiente hablar espere a que se drene.
      this.tsFinUltimoAudio = Date.now();
    }
    if (this.synthNativa?.speaking || this.synthNativa?.pending) {
      try { this.synthNativa.cancel(); } catch {}
    }
    this.hablando.set(false);
    this.visemeActual.set(0);
  }

  /** Activa/silencia el audio */
  toggle(): void {
    if (this.habilitado()) {
      this.habilitado.set(false);
      this.parar();
    } else {
      this.habilitado.set(true);
    }
  }

  // ============== AZURE: implementación ==============

  /** Carga el SDK de Azure como <script> desde el CDN oficial */
  private cargarSDK(): Promise<void> {
    if (this.sdkCargado) return Promise.resolve();
    if (this.sdkCargando) return this.sdkCargando;

    this.sdkCargando = new Promise<void>((resolve, reject) => {
      // Si ya está en window (otra parte de la app lo cargó), reusar
      if (window.SpeechSDK) {
        this.sdkCargado = true;
        resolve();
        return;
      }
      const existente = document.querySelector<HTMLScriptElement>('script[data-azure-speech-sdk]');
      if (existente) {
        existente.addEventListener('load', () => {
          this.sdkCargado = true;
          resolve();
        });
        existente.addEventListener('error', () => reject(new Error('SDK script failed')));
        return;
      }
      const s = document.createElement('script');
      s.src = this.SDK_URL;
      s.async = true;
      s.dataset['azureSpeechSdk'] = 'true';
      s.onload = () => {
        this.sdkCargado = true;
        resolve();
      };
      s.onerror = () => reject(new Error('No se pudo cargar el SDK de Azure Speech.'));
      document.head.appendChild(s);
    });
    return this.sdkCargando;
  }

  /** Pide un token temporal al endpoint /api/azure-token */
  private async obtenerTokenAzure(): Promise<void> {
    const ahora = Date.now();
    if (this.azureToken && ahora < this.azureTokenExpira) return;

    const resp = await fetch('/api/azure-token');
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.error || `Token endpoint respondió ${resp.status}`);
    }
    const data = await resp.json();
    if (!data.token || !data.region) {
      throw new Error('Token endpoint devolvió respuesta inválida');
    }
    this.azureToken = data.token;
    this.azureRegion = data.region;
    this.azureTokenExpira = ahora + 8 * 60 * 1000; // 8 minutos (token dura 10)
  }

  private async hablarConAzure(
    texto: string,
    opciones: { onEnd?: () => void; rate?: number },
    miGen: number
  ): Promise<void> {
    await this.cargarSDK();
    if (miGen !== this.generacion) return;

    await this.obtenerTokenAzure();
    if (miGen !== this.generacion) return;

    // Esperar a que el buffer del speaker del audio anterior se haya drenado.
    // En la primera llamada (tsFinUltimoAudio = 0) no hay espera.
    if (this.tsFinUltimoAudio > 0) {
      const transcurrido = Date.now() - this.tsFinUltimoAudio;
      if (transcurrido < this.DRENAJE_MS) {
        await new Promise<void>(r => setTimeout(r, this.DRENAJE_MS - transcurrido));
        if (miGen !== this.generacion) return;
      }
    }

    const SDK = window.SpeechSDK;
    if (!SDK) throw new Error('SDK de Azure Speech no disponible en window');

    const config = SDK.SpeechConfig.fromAuthorizationToken(this.azureToken, this.azureRegion);
    config.speechSynthesisVoiceName = this.vozAzure;

    const audioConfig = SDK.AudioConfig.fromDefaultSpeakerOutput();
    const synth = new SDK.SpeechSynthesizer(config, audioConfig);

    // Última verificación antes de arrancar el audio.
    if (miGen !== this.generacion) {
      try { synth.close(); } catch {}
      return;
    }
    this.synthAzure = synth;

    // Visemas: 0 (silencio) a 21 (vocales/consonantes específicas)
    synth.visemeReceived = (_s: any, e: any) => {
      if (miGen !== this.generacion) return;
      this.visemeActual.set(e.visemeId);
    };

    synth.synthesisStarted = () => {
      if (miGen !== this.generacion) return;
      this.hablando.set(true);
    };

    // Marcar hablando=true ANTES de pedir el audio, sin esperar al evento
    // synthesisStarted (que en algunos navegadores tarda o no dispara). Esto
    // garantiza que el avatar muestre el halo/ondas mientras Azure prepara
    // y reproduce el audio. Si la generación cambia, no toques los signals
    // porque otro hablar() ya está mandando.
    if (miGen === this.generacion) {
      this.hablando.set(true);
    }

    return new Promise<void>((resolve, reject) => {
      synth.speakTextAsync(
        texto,
        (result: any) => {
          try { synth.close(); } catch {}
          if (this.synthAzure === synth) this.synthAzure = null;
          // Marcar el momento de fin para que el siguiente hablar espere
          // a que se drene el buffer del speaker.
          this.tsFinUltimoAudio = Date.now();
          // Si esta generación ya quedó obsoleta, no toques los signals
          // (otro hablar() los está controlando).
          if (miGen !== this.generacion) {
            resolve();
            return;
          }
          this.hablando.set(false);
          this.visemeActual.set(0);

          if (result?.reason === SDK.ResultReason.SynthesizingAudioCompleted) {
            if (opciones.onEnd) opciones.onEnd();
            resolve();
          } else {
            reject(new Error('Azure: síntesis no completada (' + (result?.errorDetails || 'sin detalle') + ')'));
          }
        },
        (err: any) => {
          try { synth.close(); } catch {}
          if (this.synthAzure === synth) this.synthAzure = null;
          this.tsFinUltimoAudio = Date.now();
          if (miGen !== this.generacion) {
            resolve();
            return;
          }
          this.hablando.set(false);
          this.visemeActual.set(0);
          reject(new Error('Azure: ' + err));
        }
      );
    });
  }

  // ============== TTS NATIVO: implementación ==============

  private cargarVozNativa(): void {
    if (!this.synthNativa) return;
    const elegir = () => {
      if (!this.synthNativa) return;
      const voces = this.synthNativa.getVoices();
      this.vozNativa =
        voces.find(v => v.lang === 'es-MX') ||
        voces.find(v => v.lang === 'es-US') ||
        voces.find(v => v.lang === 'es-ES') ||
        voces.find(v => v.lang.startsWith('es-')) ||
        voces.find(v => v.lang.toLowerCase().startsWith('es')) ||
        null;
    };
    elegir();
    this.synthNativa.onvoiceschanged = elegir;
  }

  private hablarConNativa(
    texto: string,
    opciones: { onEnd?: () => void; rate?: number }
  ): void {
    if (!this.synthNativa) {
      if (opciones.onEnd) setTimeout(opciones.onEnd, 0);
      return;
    }
    const utt = new SpeechSynthesisUtterance(texto);
    if (this.vozNativa) utt.voice = this.vozNativa;
    utt.lang = this.vozNativa?.lang || 'es-MX';
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
      this.synthNativa.speak(utt);
    } catch (e) {
      console.warn('VozService nativo: no se pudo hablar', e);
      this.hablando.set(false);
    }
  }
}
