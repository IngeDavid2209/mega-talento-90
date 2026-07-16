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
    return !!this.getToken();
  }

  limpiar(): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USUARIO_KEY);
  }
}
