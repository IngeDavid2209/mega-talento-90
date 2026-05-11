import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './login.html',
  styleUrl: './login.css'
})
export class LoginComponent {
  private router = inject(Router);
  
  // 1. Cambiamos 'email' por 'username' para que sea congruente
  credentials = {
    username: '', 
    password: ''
  };

  cargando = false;
  mensajeError = ''; // Variable para mostrar si se equivocan

  onLogin() {
    this.cargando = true;
    this.mensajeError = ''; // Limpiamos el error cada vez que intentan
    
    // 2. EL TRUCO MAESTRO: Limpiamos espacios y le pegamos el dominio fantasma
    const usuarioLimpio = this.credentials.username.trim().toLowerCase();
    const correoConstruido = `${usuarioLimpio}@megadulces.com`;

    console.log('El sistema evaluará este correo oculto:', correoConstruido);

    // Simulamos la validación (1 segundo)
    setTimeout(() => {
      
      // 3. ¡AQUÍ VALIDAMOS AL USUARIO! (Usamos la variable correoConstruido)
      if (correoConstruido === 'admin@megadulces.com' && this.credentials.password === 'admin123') {
        
        // Si es correcto, le damos el gafete y lo dejamos pasar
        localStorage.setItem('rh_logged', 'true'); 
        this.cargando = false;
        this.router.navigate(['/app/dashboard']);
        
      } else {
        // Si se equivoca, le marcamos error y no lo dejamos pasar
        this.cargando = false;
        this.mensajeError = 'Usuario o contraseña incorrectos. Intenta de nuevo.';
      }
      
    }, 1000);
  }
}