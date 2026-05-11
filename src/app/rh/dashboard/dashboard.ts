import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CandidateService } from '../../core/services/candidate'; // Ajusta la ruta si es necesario

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css'
})
export class DashboardComponent implements OnInit {
  private candidateService = inject(CandidateService);

  candidatos: any[] = [];
  cargando: boolean = true;
  totalLeads: number = 0;

  // OnInit se ejecuta automáticamente cuando la pantalla carga
  async ngOnInit() {
    await this.cargarCandidatos();
  }

  async cargarCandidatos() {
    try {
      this.cargando = true;
      // Llamamos a Firebase usando el método que agregaste hace un momento
      this.candidatos = await this.candidateService.getCandidates();
      this.totalLeads = this.candidatos.length;
      
      // Ordenamos para que los más recientes salgan primero en la tabla
      this.candidatos.sort((a, b) => {
        const dateA = a.createdAt?.toDate() || 0;
        const dateB = b.createdAt?.toDate() || 0;
        return dateB - dateA;
      });

    } catch (error) {
      console.error('Error cargando los candidatos:', error);
    } finally {
      this.cargando = false;
    }
  }
  
  // Pequeña función para que la fecha de Firebase se vea bonita (ej. 04 may 2026)
  formatearFecha(timestamp: any): string {
    if (!timestamp) return 'Sin fecha';
    const date = timestamp.toDate();
    return date.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
  }
}