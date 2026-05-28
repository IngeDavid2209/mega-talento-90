import { Injectable } from '@angular/core';

/**
 * Notificaciones del navegador (Notification API).
 * Funcionan mientras el navegador esté abierto, aunque la pestaña
 * de la app esté en background o minimizada.
 */
export type EstadoNotif = 'granted' | 'denied' | 'default' | 'no-soportado';

@Injectable({ providedIn: 'root' })
export class NotificacionesService {
  permitido = false;

  /** Devuelve el estado actual sin pedir permiso */
  getEstado(): EstadoNotif {
    if (!('Notification' in window)) return 'no-soportado';
    this.permitido = Notification.permission === 'granted';
    return Notification.permission as EstadoNotif;
  }

  /** Pide permiso al navegador. Solo la primera vez muestra el popup nativo. */
  async pedirPermiso(): Promise<boolean> {
    if (!('Notification' in window)) {
      console.warn('Este navegador no soporta notificaciones.');
      return false;
    }

    if (Notification.permission === 'granted') {
      this.permitido = true;
      return true;
    }
    if (Notification.permission === 'denied') {
      this.permitido = false;
      return false;
    }

    const respuesta = await Notification.requestPermission();
    this.permitido = respuesta === 'granted';
    return this.permitido;
  }

  /** Muestra una notificación. Si se le pasa onClick, focusea la app al hacer click. */
  notificar(titulo: string, cuerpo: string, alHacerClick?: () => void): void {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;

    try {
      const n = new Notification(titulo, {
        body: cuerpo,
        icon: 'https://static.wixstatic.com/media/fd397e_0fd82a1ecec84a118ceeb603b493f25a~mv2.png',
        badge: 'https://static.wixstatic.com/media/fd397e_0fd82a1ecec84a118ceeb603b493f25a~mv2.png',
        tag: 'mega-talento-nuevo-candidato',
        requireInteraction: false,
        silent: false
      });

      n.onclick = () => {
        window.focus();
        if (alHacerClick) alHacerClick();
        n.close();
      };

      // Auto-cerrar después de 8 segundos por si el SO no lo hace
      setTimeout(() => n.close(), 8000);
    } catch (e) {
      console.warn('No se pudo mostrar la notificación:', e);
    }
  }
}
