import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { Auth, signInWithEmailAndPassword, signOut } from '@angular/fire/auth';
import { UsuariosService } from '../../core/services/usuarios.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './login.html',
  styleUrl: './login.css'
})
export class LoginComponent {
  private router = inject(Router);
  private auth = inject(Auth);
  private usuariosService = inject(UsuariosService);

  credentials = {
    username: '',
    password: ''
  };

  cargando = false;
  mensajeError = '';

  async onLogin() {
    this.cargando = true;
    this.mensajeError = '';

    const entrada = this.credentials.username.trim().toLowerCase();
    let correoFinal = '';

    try {
      // 1. Resolver el correo real del usuario (por alias o correo completo)
      correoFinal = await this.usuariosService.obtenerEmailLogin(entrada);

      // 2. Validar credenciales en Firebase Auth
      try {
        await signInWithEmailAndPassword(this.auth, correoFinal, this.credentials.password);
      } catch (firstErr) {
        // Respaldo: si fue un alias que cayó al dominio interno y falló, probar
        // con el dominio antiguo (cuentas heredadas como admin@megadulces.com).
        if (!entrada.includes('@') && correoFinal.endsWith('@megatalento.app')) {
          correoFinal = `${entrada}@megadulces.com`;
          await signInWithEmailAndPassword(this.auth, correoFinal, this.credentials.password);
        } else {
          throw firstErr;
        }
      }

      // 3. Verificar que la cuenta no esté desactivada por un administrador
      const habilitado = await this.usuariosService.puedeIniciarSesion(correoFinal);
      if (!habilitado) {
        await signOut(this.auth);
        this.cargando = false;
        this.mensajeError = 'Tu cuenta fue desactivada. Contacta al administrador.';
        return;
      }

      this.cargando = false;
      this.router.navigate(['/app/dashboard']);

    } catch (error: any) {
      console.error('Error de Firebase:', error);
      this.cargando = false;
      const code = error?.code || '';
      if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
        this.mensajeError = `Usuario o contraseña incorrectos. Email probado: ${correoFinal}`;
      } else if (code === 'auth/too-many-requests') {
        this.mensajeError = 'Demasiados intentos fallidos. Espera unos minutos y vuelve a intentar.';
      } else if (code === 'auth/network-request-failed') {
        this.mensajeError = 'Sin conexión a internet. Revisa tu red y vuelve a intentar.';
      } else if (code === 'auth/user-disabled') {
        this.mensajeError = 'Tu cuenta fue deshabilitada en Firebase. Contacta al administrador.';
      } else if (code) {
        this.mensajeError = `Error (${code}). ${error?.message || ''}`;
      } else {
        this.mensajeError = error?.message || 'Error desconocido al iniciar sesión.';
      }
    }
  }
}