import { Injectable } from '@angular/core';
import { TOKEN_KEY, USUARIO_KEY } from './api-config';

export interface UsuarioSesion {
  id: string;
  email: string;
  username?: string;
  nombre: string;
  rol: string;
}

/**
 * Guarda la sesión (JWT + usuario) en localStorage. Reemplaza a la sesión de
 * Firebase Auth. El token lo adjunta ApiService en cada llamada.
 */
@Injectable({ providedIn: 'root' })
export class AuthSession {
  setSesion(token: string, usuario: UsuarioSesion): void {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USUARIO_KEY, JSON.stringify(usuario));
  }

  getToken(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  }

  // ══ QUIÉN PUEDE VER QUÉ ═════════════════════════════════════════
  //
  // El rol venía comparándose a mano y con la cadena cruda, y eso ya estaba
  // roto: la base guarda DOS escrituras del mismo rol —2 usuarios con `admin` y
  // 6 con `Administrador`, porque el alta pasa por `normalizaRol` y los primeros
  // se sembraron antes—. Un `rol === 'admin'` es falso para seis de los ocho
  // administradores, así que el semáforo de relojes no se le veía a casi nadie.
  //
  // Aquí se normaliza al leer (sin acentos, en minúsculas) y las capacidades se
  // preguntan por nombre, no por rol. Agregar un permiso es tocar este mapa y
  // nada más.
  //
  // ⚠️ Esto es control de MENÚ, no de datos: esconder una sección no impide que
  // alguien llame a la API por su cuenta. Para que sea hermético hay que filtrar
  // del lado del servidor.

  /** El rol en una sola forma: 'admin' | 'reclutador' | 'promotoria' | otro. */
  rolCanonico(): string {
    const crudo = (this.getUsuario()?.rol || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    if (crudo.startsWith('admin')) return 'admin';
    if (crudo.startsWith('reclut')) return 'reclutador';
    if (crudo.startsWith('promotor')) return 'promotoria';
    return crudo;
  }

  esAdmin(): boolean { return this.rolCanonico() === 'admin'; }

  /**
   * Qué puede ver cada rol. El admin puede todo: si no, quien administra el
   * sistema se quedaría fuera de la sección que él mismo reparte.
   */
  private readonly CAPACIDADES: Record<string, string[]> = {
    admin: ['promotoria', 'relojes', 'usuarios'],
    promotoria: ['promotoria'],
    reclutador: [],
  };

  puede(capacidad: string): boolean {
    return (this.CAPACIDADES[this.rolCanonico()] || []).includes(capacidad);
  }

  getUsuario(): UsuarioSesion | null {
    try {
      const raw = localStorage.getItem(USUARIO_KEY);
      return raw ? JSON.parse(raw) as UsuarioSesion : null;
    } catch {
      return null;
    }
  }

  estaLogueado(): boolean {
    const token = this.getToken();
    if (!token) return false;
    // Si el JWT ya expiró, la sesión no sirve: se limpia y se trata como deslogueado.
    if (this.tokenExpirado(token)) {
      this.limpiar();
      return false;
    }
    return true;
  }

  /** Lee el `exp` del JWT (sin verificar firma) y decide si ya venció. */
  private tokenExpirado(token: string): boolean {
    try {
      const payload = token.split('.')[1];
      if (!payload) return true;
      const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
      if (!json.exp) return false; // sin exp: lo deja pasar (lo atrapará el 401)
      return Date.now() >= json.exp * 1000;
    } catch {
      return true; // token ilegible = inservible
    }
  }

  limpiar(): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USUARIO_KEY);
  }
}
