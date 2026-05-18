import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterOutlet, RouterModule } from '@angular/router';

@Component({
  selector: 'app-layout',
  standalone: true,
  imports: [CommonModule, RouterOutlet, RouterModule],
  templateUrl: './layout.html',
  styleUrl: './layout.css'
})
export class LayoutComponent {
  // === LÓGICA DEL MENÚ DE HAMBURGUESA ===
  isMenuOpen: boolean = false; // El menú empieza cerrado

  toggleMenu() {
    this.isMenuOpen = !this.isMenuOpen; // Cambia el estado (abre/cierra)
  }
}
