import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CandidateService } from '../../core/services/candidate'; 

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

  async ngOnInit() {
    await this.cargarCandidatos();
  }

  async cargarCandidatos() {
    try {
      this.cargando = true;
      this.candidatos = await this.candidateService.getCandidates();
      this.totalLeads = this.candidatos.length;
      
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
  
  formatearFecha(timestamp: any): string {
    if (!timestamp) return 'Sin fecha';
    const date = timestamp.toDate();
    return date.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  contactarWhatsApp(telefono: string, nombre: string) {
    // 1. Limpiamos el número de cualquier carácter no numérico
    const numeroLimpio = telefono.replace(/\D/g, '');
    
    // 2. Mensaje personalizado
    const mensaje = `Hola ${nombre}, te contactamos del equipo de Reclutamiento de Mega Dulces. Revisamos tu solicitud y nos gustaría platicar contigo.`;
    
    // 3. Generamos link (Prefijo 52 para México)
    const url = `https://wa.me/52${numeroLimpio}?text=${encodeURIComponent(mensaje)}`;
    
    window.open(url, '_blank');
  }
}