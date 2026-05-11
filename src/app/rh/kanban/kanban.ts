import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CandidateService } from '../../core/services/candidate'; 

@Component({
  selector: 'app-kanban',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './kanban.html',
  styleUrl: './kanban.css'
})
export class KanbanComponent implements OnInit {
  private candidateService = inject(CandidateService);

  // Nuestras 4 columnas
  nuevos: any[] = [];
  contactados: any[] = [];
  entrevistas: any[] = [];
  contratados: any[] = [];

  cargando = true;

  async ngOnInit() {
    await this.cargarTablero();
  }

async cargarTablero() {
    this.cargando = true;
    try {
      // 1. Corregido: Sin la 's' en candidateService
      const todos = await this.candidateService.getCandidates();
      
      // Limpiamos las listas antes de rellenarlas
      this.nuevos = [];
      this.contactados = [];
      this.entrevistas = [];
      this.contratados = [];

      // 2. Corregido: Le decimos a TypeScript que candidato es tipo "any"
      todos.forEach((candidato: any) => {
        if (candidato.status === 'nuevo') {
          this.nuevos.push(candidato);
        } else if (candidato.status === 'contacto_pendiente') {
          this.contactados.push(candidato);
        } else if (candidato.status === 'entrevista') {
          this.entrevistas.push(candidato);
        } else if (candidato.status === 'contratado') {
          this.contratados.push(candidato);
        }
      });

    } catch (error) {
      console.error('Error cargando el tablero:', error);
    } finally {
      this.cargando = false;
    }
  }

  // Función que envía el mensaje y mueve al candidato automáticamente
  async contactarYmover(candidato: any) {
    // 1. Preparamos el WhatsApp
    const numeroLimpio = candidato.telefono.replace(/\D/g, '');
    const mensaje = `Hola ${candidato.nombre}, te contactamos del equipo de Reclutamiento de Mega Dulces. Revisamos tu solicitud y nos gustaría platicar contigo.`;
    const url = `https://wa.me/52${numeroLimpio}?text=${encodeURIComponent(mensaje)}`;
    
    // Abrimos el chat
    window.open(url, '_blank');

    // 2. Si es nuevo, lo movemos a "Contacto Pendiente" en la base de datos
    if (candidato.status === 'nuevo') {
      try {
        await this.candidateService.updateCandidate(candidato.id, { status: 'contacto_pendiente' });
        // Recargamos el tablero para ver el cambio visualmente
        await this.cargarTablero();
      } catch (error) {
        console.error('Error al mover el candidato:', error);
      }
    }
  }
}