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
      // 1. Traemos todos los candidatos de la base de datos
      const todosLosCandidatos = await this.candidateService.getCandidates();
      
      // 2. Calculamos el tiempo actual y el límite de 48 horas en milisegundos
      const ahora = new Date().getTime();
      const limite48Horas = 48 * 60 * 60 * 1000; 

      // 3. EL FILTRO MÁGICO: Solo dejamos pasar a los que tengan menos de 48 horas de antigüedad
      this.candidatos = todosLosCandidatos.filter((candidato: any) => {
        if (!candidato.createdAt) return false; // Si por error no tiene fecha, lo ignoramos
        
        const fechaCandidato = candidato.createdAt.toDate().getTime();
        const diferencia = ahora - fechaCandidato;
        
        // Retorna true solo si la diferencia es menor o igual a 48 horas
        return diferencia <= limite48Horas; 
      });

      // 4. Actualizamos el contador de las tarjetas de arriba para que coincida
      this.totalLeads = this.candidatos.length;

      // 5. Los ordenamos del más reciente al más antiguo
      this.candidatos.sort((a, b) => {
        const dateA = a.createdAt?.toDate() || 0;
        const dateB = b.createdAt?.toDate() || 0;
        return (dateB as any) - (dateA as any);
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
    const numeroLimpio = telefono.replace(/\D/g, '');
    const mensaje = `Hola ${nombre}, te contactamos del equipo de Reclutamiento de Mega Dulces. Revisamos tu solicitud y nos gustaría platicar contigo.`;
    const url = `https://wa.me/52${numeroLimpio}?text=${encodeURIComponent(mensaje)}`;
    window.open(url, '_blank');
  }

  // NUEVA FUNCIÓN PARA CAMBIAR EL ESTATUS
  async cambiarEstatus(idCandidato: string, event: any) {
    const nuevoEstatus = event.target.value;

    try {
      // Llamamos a Firebase para guardar el cambio
      await this.candidateService.updateCandidate(idCandidato, { status: nuevoEstatus });

      // Actualizamos visualmente el color en la tabla
      const index = this.candidatos.findIndex(c => c.id === idCandidato);
      if (index !== -1) {
        this.candidatos[index].status = nuevoEstatus;
      }
      
    } catch (error) {
      console.error('Error al actualizar el estatus:', error);
      alert('Hubo un error al intentar cambiar el estatus.');
    }
  }
}