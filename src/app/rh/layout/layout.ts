import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterOutlet, RouterModule, Router } from '@angular/router'; // <-- Importamos Router

@Component({
  selector: 'app-layout',
  standalone: true,
  imports: [CommonModule, RouterOutlet, RouterModule],
  templateUrl: './layout.html',
  styleUrl: './layout.css'
})
export class LayoutComponent {
  private router = inject(Router); // <-- Inyectamos el motor de viaje

  // === LÓGICA DEL MENÚ DE HAMBURGUESA ===
  isMenuOpen: boolean = false; // El menú empieza cerrado

  toggleMenu() {
    this.isMenuOpen = !this.isMenuOpen; // Cambia el estado (abre/cierra)
  }

  // === NAVEGACIÓN A PRUEBA DE BALAS PARA MÓVILES ===
  navegar(ruta: string) {
    this.isMenuOpen = false; // 1. Obliga al menú a cerrarse al instante
    this.router.navigate([ruta]); // 2. Viaja a la pantalla seleccionada
  }
}