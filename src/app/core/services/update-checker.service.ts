import { Injectable, signal } from '@angular/core';

/**
 * Detecta cuando se sube una nueva versión de la app a Vercel y RECARGA
 * automáticamente — sin banner, sin preguntar al usuario.
 *
 * Cómo funciona:
 * 1. Al iniciar, captura el hash del bundle "main-XXXX.js" actualmente cargado.
 * 2. Cada 90 segundos (y cuando la pestaña vuelve a estar visible) hace fetch
 *    al index.html del servidor y compara el hash del bundle nuevo.
 * 3. Si difieren, fuerza window.location.reload() inmediatamente. El usuario
 *    ve un parpadeo y entra a la versión nueva.
 *
 * No requiere backend ni Service Worker — pura comparación cliente-servidor.
 */
@Injectable({ providedIn: 'root' })
export class UpdateCheckerService {
  /**
   * Se mantiene por compatibilidad con código viejo, pero ahora SIEMPRE es
   * false porque al detectar una actualización se recarga al instante.
   */
  hayActualizacion = signal(false);

  private bundleInicial = '';
  private intervalo: any = null;
  private yaInicio = false;
  private yaRecargando = false;

  iniciar(): void {
    if (this.yaInicio) return;
    this.yaInicio = true;

    this.bundleInicial = this.bundleEnDocumento();
    // Si no hay bundle hasheado (modo dev), no hay nada que verificar
    if (!this.bundleInicial) return;

    // Cada 60 s. El usuario no tiene que hacer NADA: cuando subimos una versión
    // nueva, en menos de un minuto la app se recarga sola a la versión buena.
    this.intervalo = setInterval(() => this.verificar(), 60000);

    // Y además se revisa en cuanto el usuario "vuelve" a la app, que es el
    // momento típico en celular (cambiar de app y regresar, desbloquear, abrir
    // el acceso directo) — así casi nunca llega a esperar los 60 s:
    const alVolver = () => { if (document.visibilityState === 'visible') this.verificar(); };
    document.addEventListener('visibilitychange', alVolver);
    window.addEventListener('focus', () => this.verificar());
    window.addEventListener('pageshow', () => this.verificar());   // regreso desde bfcache
    window.addEventListener('online', () => this.verificar());     // al recuperar internet
  }

  detener(): void {
    if (this.intervalo) clearInterval(this.intervalo);
  }

  /** Lee el nombre del bundle "main-XXXX.js" del DOM actual */
  private bundleEnDocumento(): string {
    const scripts = Array.from(document.querySelectorAll('script[src]')) as HTMLScriptElement[];
    for (const s of scripts) {
      const m = s.src.match(/main-[A-Za-z0-9]+\.js/);
      if (m) return m[0];
    }
    return '';
  }

  /** Compara el bundle del servidor contra el cargado actualmente */
  private async verificar(): Promise<void> {
    if (this.yaRecargando) return;
    try {
      const url = `/index.html?_=${Date.now()}`;
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) return;
      const html = await r.text();
      const m = html.match(/main-[A-Za-z0-9]+\.js/);
      if (m && m[0] !== this.bundleInicial) {
        // Nueva versión detectada: recargar a la fuerza, sin preguntar
        this.yaRecargando = true;
        if (this.intervalo) clearInterval(this.intervalo);
        window.location.reload();
      }
    } catch {
      // Sin conexión o error temporal: ignorar y volver a intentar en el siguiente ciclo
    }
  }
}
