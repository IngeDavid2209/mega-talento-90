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

    try {
      // 1. Resolver el correo real del usuario (por alias o correo completo)
      const correoFinal = await this.usuariosService.obtenerEmailLogin(this.credentials.username);

      // 2. Validar credenciales en Firebase Auth
      await signInWithEmailAndPassword(this.auth, correoFinal, this.credentials.password);

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

    } catch (error) {
      console.error('Error de Firebase:', error);
      this.cargando = false;
      this.mensajeError = 'Usuario o contraseña incorrectos. Intenta de nuevo.';
    }
  }
}