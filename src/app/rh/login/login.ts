import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { ApiService } from '../../core/services/api.service';
import { AuthSession, UsuarioSesion } from '../../core/services/auth-session';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './login.html',
  styleUrl: './login.css'
})
export class LoginComponent implements OnInit {
  private router = inject(Router);
  private api = inject(ApiService);
  private sesion = inject(AuthSession);

  credentials = {
    username: '',
    password: ''
  };

  cargando = false;
  mensajeError = '';

  ngOnInit() {
    // Entrar al login equivale a cerrar sesión (limpia el token existente).
    this.sesion.limpiar();
  }

  async onLogin() {
    this.cargando = true;
    this.mensajeError = '';

    try {
      const r = await this.api.post<{ token: string; usuario: UsuarioSesion }>('/auth/login', {
        email: this.credentials.username.trim(),
        password: this.credentials.password
      });
      this.sesion.setSesion(r.token, r.usuario);
      this.cargando = false;
      this.router.navigate(['/app/dashboard']);
    } catch (error: any) {
      this.cargando = false;
      const status = error?.status;
      if (status === 401) {
        this.mensajeError = 'Usuario o contraseña incorrectos.';
      } else if (status === 403) {
        this.mensajeError = error?.error?.error || 'Tu cuenta fue desactivada. Contacta al administrador.';
      } else if (status === 0) {
        this.mensajeError = 'Sin conexión con el servidor. Revisa tu red e intenta de nuevo.';
      } else {
        this.mensajeError = error?.error?.error || 'Error al iniciar sesión. Intenta de nuevo.';
      }
    }
  }
}
