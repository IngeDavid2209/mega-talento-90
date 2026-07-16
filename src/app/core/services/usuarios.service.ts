import { Injectable, inject } from '@angular/core';
import { ApiService } from './api.service';

// Dominio interno con el que se genera el correo técnico a partir del alias.
export const DOMINIO_INTERNO = 'megatalento.app';

/** Convierte un alias en el correo técnico interno. */
export function aliasAEmail(alias: string): string {
  return `${alias.trim().toLowerCase()}@${DOMINIO_INTERNO}`;
}

export interface NuevoUsuario {
  nombreCompleto: string;
  username: string;
  rol: string;       // 'reclutador' | 'admin'
  password: string;
}

/**
 * Gestión de usuarios de RH contra la API (Postgres). Reemplaza el alta vía
 * Firebase Auth. Se conservan las firmas para no tocar el componente de usuarios.
 */
@Injectable({ providedIn: 'root' })
export class UsuariosService {
  private api = inject(ApiService);
  private readonly POLL_MS = 12000;

  async crearUsuario(datos: NuevoUsuario): Promise<void> {
    await this.api.post('/usuarios', datos);
  }

  /** Lista de usuarios (polling). */
  listarUsuarios(callback: (usuarios: any[]) => void) {
    let activo = true;
    const tick = async () => {
      if (!activo) return;
      try { callback(await this.api.get<any[]>('/usuarios')); }
      catch (e) { console.error('Error al listar usuarios:', e); }
    };
    tick();
    const id = setInterval(tick, this.POLL_MS);
    return () => { activo = false; clearInterval(id); };
  }

  async desactivarUsuario(uid: string): Promise<void> {
    await this.api.post(`/usuarios/${uid}/desactivar`);
  }

  async reactivarUsuario(uid: string): Promise<void> {
    await this.api.post(`/usuarios/${uid}/reactivar`);
  }

  async actualizarPerfilUsuario(
    uid: string,
    datos: { nombre?: string; username?: string; rol?: string }
  ): Promise<void> {
    await this.api.patch(`/usuarios/${uid}`, datos);
  }

  async eliminarUsuario(uid: string): Promise<void> {
    await this.api.delete(`/usuarios/${uid}`);
  }

  /**
   * Con el login por JWT, el backend acepta directamente el alias o el correo,
   * así que el login manda la entrada tal cual. Se conservan por compatibilidad.
   */
  async obtenerEmailLogin(entrada: string): Promise<string> {
    return (entrada || '').trim();
  }

  async puedeIniciarSesion(_email: string): Promise<boolean> {
    // El backend valida `activo` al iniciar sesión.
    return true;
  }
}
