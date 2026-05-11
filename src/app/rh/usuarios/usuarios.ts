import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms'; 

@Component({
  selector: 'app-usuarios',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './usuarios.html',
  styleUrl: './usuarios.css'
})
export class UsuariosComponent {
  
  // 1. AHORA INCLUYE 'EMAIL'
  nuevoUsuario = {
    nombreCompleto: '',
    email: '',
    username: '',
    rol: 'reclutador',
    password: ''
  };

  cargando = false;
  mensajeExito = '';
  
  // Lista temporal actualizada
  listaUsuarios = [
    { nombre: 'Administrador Supremo', email: 'admin@megadulces.com', username: 'admin', rol: 'Administrador' }
  ];

  crearUsuario() {
    this.cargando = true;
    this.mensajeExito = '';

    const correoLimpio = this.nuevoUsuario.email.trim().toLowerCase();
    const usuarioLimpio = this.nuevoUsuario.username.trim().toLowerCase();

    // Simulamos la conexión a Firebase
    setTimeout(() => {
      
      // Lo agregamos a la tabla visual
      this.listaUsuarios.push({
        nombre: this.nuevoUsuario.nombreCompleto,
        email: correoLimpio,
        username: usuarioLimpio,
        rol: this.nuevoUsuario.rol === 'admin' ? 'Administrador' : 'Reclutador'
      });

      // Avisamos que salió bien y limpiamos el formulario
      this.mensajeExito = `¡El usuario "${usuarioLimpio}" fue creado con éxito!`;
      this.nuevoUsuario = { nombreCompleto: '', email: '', username: '', rol: 'reclutador', password: '' };
      this.cargando = false;

      setTimeout(() => this.mensajeExito = '', 3000);

    }, 1000);
  }
}