import { Injectable, inject, signal } from '@angular/core';
import { Router, NavigationEnd } from '@angular/router';
import { filter } from 'rxjs/operators';

/**
 * Detecta cuando se sube una nueva versión de la app y la aplica recargando la
 * página. La diferencia con antes está en CUÁNDO recarga:
 *
 * ── EL PROBLEMA QUE ESTO ARREGLA (05/11/2026) ──
 *
 * Antes recargaba a la fuerza EN CUANTO el usuario volvía a la pestaña
 * (`visibilitychange`/`focus`). Como RH trabaja con varias ventanas abiertas y
 * nosotros desplegamos varias veces al día, cada vez que volvían a MT —con una
 * semana y una sucursal ya elegidas, un modal abierto, media captura hecha— la
 * recarga les borraba todo y los dejaba en la vista por defecto. Se vivía como
 * "me regresó a la pantalla principal".
 *
 * Cambiar de pestaña NO reinicia una SPA por sí solo: el componente sigue vivo
 * con su estado. El único que los reiniciaba era esta recarga a destiempo.
 *
 * ── LA REGLA NUEVA ──
 *
 * · Portal PÚBLICO (candidatos, fuera de /app): se recarga al instante, igual
 *   que antes. Están en una sola pantalla y una versión vieja es justo lo que
 *   rompía las ligas que manda el bot.
 * · PANEL (/app, RH): la versión nueva queda PENDIENTE y se aplica en el
 *   siguiente cambio de pantalla (NavigationEnd). En ese momento el usuario ya
 *   está navegando, así que el salto es invisible y no pierde lo que tenía.
 *
 * Costo: si alguien se queda horas en la misma pantalla sin navegar, sigue con
 * la versión anterior hasta que cambie de sección. Es aceptable: los datos
 * vienen del API (versionado aparte) y el front viejo sigue sirviendo; mucho
 * mejor que arrancarle el trabajo de las manos cada vez que cambia de ventana.
 *
 * No requiere backend ni Service Worker — pura comparación cliente-servidor.
 */
@Injectable({ providedIn: 'root' })
export class UpdateCheckerService {
  private router = inject(Router);

  /**
   * true cuando hay una versión nueva detectada y aún sin aplicar (pendiente de
   * la siguiente navegación, dentro del panel). El template puede mostrar un
   * aviso discreto si quiere; ya no es un bloqueo.
   */
  hayActualizacion = signal(false);

  private bundleInicial = '';
  private intervalo: any = null;
  private yaInicio = false;
  private yaRecargando = false;
  /** Versión nueva detectada dentro del panel, esperando el próximo cambio de pantalla. */
  private pendiente = false;

  iniciar(): void {
    if (this.yaInicio) return;
    this.yaInicio = true;

    this.bundleInicial = this.bundleEnDocumento();
    // Si no hay bundle hasheado (modo dev), no hay nada que verificar
    if (!this.bundleInicial) return;

    // Cada 60 s. Cuando subimos una versión nueva, la app la toma sola — pero
    // sin interrumpir: ver la regla de arriba.
    this.intervalo = setInterval(() => this.verificar(), 60000);

    // Se revisa también en cuanto el usuario "vuelve" a la app (cambiar de app y
    // regresar, desbloquear, abrir el acceso directo). Detectar aquí es barato;
    // lo que cambió es que detectar ya NO implica recargar de inmediato.
    const alVolver = () => { if (document.visibilityState === 'visible') this.verificar(); };
    document.addEventListener('visibilitychange', alVolver);
    window.addEventListener('focus', () => this.verificar());
    window.addEventListener('pageshow', () => this.verificar());   // regreso desde bfcache
    window.addEventListener('online', () => this.verificar());     // al recuperar internet

    // Dentro del panel, la actualización pendiente se aplica al CAMBIAR de
    // pantalla: es el único momento en que recargar no le cuesta nada al usuario
    // porque de todos modos está dejando la vista en la que estaba.
    this.router.events
      .pipe(filter((e) => e instanceof NavigationEnd))
      .subscribe(() => { if (this.pendiente) this.recargar(); });
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

  /** ¿El usuario está dentro del panel de RH (/app)? Ahí no se recarga a media tarea. */
  private enPanel(): boolean {
    try { return location.pathname.startsWith('/app'); } catch { return false; }
  }

  /** Compara el bundle del servidor contra el cargado actualmente */
  private async verificar(): Promise<void> {
    if (this.yaRecargando || this.pendiente) return;
    try {
      const url = `/index.html?_=${Date.now()}`;
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) return;
      const html = await r.text();
      const m = html.match(/main-[A-Za-z0-9]+\.js/);
      if (m && m[0] !== this.bundleInicial) {
        // Hay versión nueva.
        this.hayActualizacion.set(true);
        if (this.enPanel()) {
          // RH: se deja pendiente y se aplica en el próximo cambio de pantalla.
          this.pendiente = true;
        } else {
          // Portal público: se aplica al instante, como siempre.
          this.recargar();
        }
      }
    } catch {
      // Sin conexión o error temporal: ignorar y volver a intentar en el siguiente ciclo
    }
  }

  /** Aplica la versión nueva recargando. Una sola vez. */
  private recargar(): void {
    if (this.yaRecargando) return;
    this.yaRecargando = true;
    if (this.intervalo) clearInterval(this.intervalo);
    window.location.reload();
  }
}
