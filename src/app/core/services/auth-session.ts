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
