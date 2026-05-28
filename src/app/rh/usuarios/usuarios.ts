import { Component, inject, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { UsuariosService } from '../../core/services/usuarios.service';

@Component({
  selector: 'app-usuarios',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './usuarios.html',
  styleUrl: './usuarios.css'
})
export class UsuariosComponent implements OnInit, OnDestroy {
  private usuariosService = inject(UsuariosService);
  private ngZone = inject(NgZone);

  nuevoUsuario = {
    nombreCompleto: '',
    username: '',
    rol: 'reclutador',
    password: ''
  };

  cargando = false;
  mensajeExito = '';
  mensajeError = '';

  usuarios: any[] = [];
  private unsubscribeFn: any;

  ngOnInit() {
    this.unsubscribeFn = this.usuariosService.listarUsuarios((lista) => {
      this.ngZone.run(() => {
        // Más recientes primero
        this.usuarios = lista.sort((a, b) => {
          const da = a.createdAt?.toDate?.() || new Date(a.createdAt || 0);
          const db = b.createdAt?.toDate?.() || new Date(b.createdAt || 0);
          return db.getTime() - da.getTime();
        });
      });
    });
  }

  ngOnDestroy() {
    if (this.unsubscribeFn) this.unsubscribeFn();
  }

  async crearUsuario() {
    this.cargando = true;
    this.mensajeExito = '';
    this.mensajeError = '';

    // Validación mínima de contraseña (Firebase exige 6+)
    if (this.nuevoUsuario.password.length < 6) {
      this.mensajeError = 'La contraseña debe tener al menos 6 caracteres.';
      this.cargando = false;
      return;
    }

    try {
      const alias = this.nuevoUsuario.username.trim().toLowerCase();
      await this.usuariosService.crearUsuario(this.nuevoUsuario);
      this.mensajeExito = `Cuenta creada. ${this.nuevoUsuario.nombreCompleto} ya puede entrar con el usuario "${alias}".`;
      this.nuevoUsuario = { nombreCompleto: '', username: '', rol: 'reclutador', password: '' };
      setTimeout(() => this.mensajeExito = '', 6000);
    } catch (error: any) {
      console.error('Error al crear usuario:', error);
      this.mensajeError = this.traducirError(error?.code);
    } finally {
      this.cargando = false;
    }
  }

  async eliminarUsuario(user: any) {
    if (!confirm(`¿Desactivar el acceso de ${user.nombre}? No podrá volver a iniciar sesión.`)) return;
    try {
      await this.usuariosService.desactivarUsuario(user.id || user.uid);
    } catch (error) {
      this.mensajeError = 'No se pudo desactivar el usuario.';
    }
  }

  async reactivarUsuario(user: any) {
    try {
      await this.usuariosService.reactivarUsuario(user.id || user.uid);
    } catch (error) {
      this.mensajeError = 'No se pudo reactivar el usuario.';
    }
  }

  async borrarUsuario(user: any) {
    if (!confirm(`¿Eliminar definitivamente a ${user.nombre}? Saldrá del sistema y ya no podrá iniciar sesión. Esta acción no se puede deshacer.`)) return;
    try {
      await this.usuariosService.eliminarUsuario(user.id || user.uid);
    } catch (error) {
      this.mensajeError = 'No se pudo eliminar el usuario.';
    }
  }

  // ============================
  // EDICIÓN DE USUARIO
  // ============================
  usuarioEditando: any = null;
  edicion = { nombre: '', username: '', rol: 'reclutador' };
  guardandoEdicion = false;
  errorEdicion = '';

  abrirEditar(user: any) {
    this.usuarioEditando = user;
    this.edicion = {
      nombre: user.nombre || '',
      username: user.username || '',
      rol: user.rol === 'Administrador' ? 'admin' : 'reclutador'
    };
    this.errorEdicion = '';
  }

  cerrarEditar() {
    this.usuarioEditando = null;
    this.errorEdicion = '';
  }

  /** Sanitiza el alias al escribir: solo letras minúsculas, números, puntos y guiones */
  sanitizarUsername(valor: string): string {
    return (valor || '').toLowerCase().replace(/[^a-z0-9._-]/g, '');
  }

  async guardarEdicion() {
    if (!this.usuarioEditando) return;
    this.errorEdicion = '';

    const username = this.sanitizarUsername(this.edicion.username);
    if (!this.edicion.nombre.trim()) {
      this.errorEdicion = 'El nombre no puede estar vacío.';
      return;
    }
    if (!username) {
      this.errorEdicion = 'El usuario debe tener letras, números, puntos o guiones.';
      return;
    }

    this.guardandoEdicion = true;
    try {
      await this.usuariosService.actualizarPerfilUsuario(this.usuarioEditando.id || this.usuarioEditando.uid, {
        nombre: this.edicion.nombre,
        username,
        rol: this.edicion.rol
      });
      this.usuarioEditando = null;
    } catch (e) {
      console.error('Error al actualizar usuario:', e);
      this.errorEdicion = 'No se pudieron guardar los cambios.';
    } finally {
      this.guardandoEdicion = false;
    }
  }

  private traducirError(code: string): string {
    switch (code) {
      case 'auth/email-already-in-use':
        return 'Ese correo ya tiene una cuenta registrada.';
      case 'auth/invalid-email':
        return 'El correo no tiene un formato válido.';
      case 'auth/weak-password':
        return 'La contraseña es demasiado débil (mínimo 6 caracteres).';
      case 'auth/operation-not-allowed':
        return 'El acceso por correo/contraseña está desactivado en Firebase. Actívalo en Authentication → Método de acceso → Correo electrónico/contraseña.';
      case 'auth/admin-restricted-operation':
        return 'Firebase rechazó la operación. Revisa que el registro por correo esté habilitado en Authentication.';
      case 'auth/network-request-failed':
        return 'Sin conexión con Firebase. Revisa tu internet e intenta de nuevo.';
      default:
        return `No se pudo crear la cuenta${code ? ' (' + code + ')' : ''}. Verifica los datos e intenta de nuevo.`;
    }
  }

  getInitials(nombre: string): string {
    if (!nombre) return '?';
    return nombre.trim().split(/\s+/).slice(0, 2).map(p => p.charAt(0).toUpperCase()).join('');
  }
}
