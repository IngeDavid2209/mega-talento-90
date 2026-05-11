import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
// 1. Importamos las herramientas reales de Firebase Auth
import { Auth, signInWithEmailAndPassword } from '@angular/fire/auth';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './login.html',
  styleUrl: './login.css'
})
export class LoginComponent {
  private router = inject(Router);
  private auth = inject(Auth); // 2. Inyectamos la conexión a Firebase
  
  credentials = {
    username: '', 
    password: ''
  };

  cargando = false;
  mensajeError = '';

  // 3. Volvemos la función asíncrona (async) porque conectaremos con internet
  async onLogin() {
    this.cargando = true;
    this.mensajeError = ''; 
    
    // 4. Limpiamos espacios
    let correoFinal = this.credentials.username.trim().toLowerCase();
    
    // 5. LA CORRECCIÓN: Si NO tiene el @, se lo pegamos. Si ya lo tiene, lo dejamos igual.
    if (!correoFinal.includes('@')) {
      correoFinal = `${correoFinal}@megadulces.com`;
    }

    console.log('Enviando a Firebase este correo:', correoFinal);

    try {
      // 6. ¡CONEXIÓN REAL! Le pedimos a Firebase que valide las credenciales
      await signInWithEmailAndPassword(this.auth, correoFinal, this.credentials.password);
      
      // Si Firebase dice que sí, apagamos el botón y lo dejamos pasar
      this.cargando = false;
      this.router.navigate(['/app/dashboard']);
      
    } catch (error) {
      // Si Firebase dice que no (error de contraseña o no existe), lo rechazamos
      console.error('Error de Firebase:', error);
      this.cargando = false;
      this.mensajeError = 'Usuario o contraseña incorrectos. Intenta de nuevo.';
    }
  }
}