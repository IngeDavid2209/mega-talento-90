import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CandidateService } from '../../core/services/candidate'; 
import { DragDropModule, CdkDragDrop, moveItemInArray, transferArrayItem } from '@angular/cdk/drag-drop';

@Component({
  selector: 'app-kanban',
  standalone: true,
  imports: [CommonModule, DragDropModule],
  templateUrl: './kanban.html',
  styleUrl: './kanban.css'
})
export class KanbanComponent implements OnInit {
  private candidateService = inject(CandidateService);

  // Nuestras 4 columnas del embudo
  leads: any[] = [];
  contactosPendientes: any[] = [];
  entrevistas: any[] = [];
  contratados: any[] = [];
  cargando = true;

  // === VARIABLES PARA EL PANEL LATERAL ===
  candidatoSeleccionado: any = null;
  panelAbierto: boolean = false;

  ngOnInit() {
    this.cargarEmbudo();
  }

  // === FUNCIONES DEL PANEL LATERAL ===
  abrirPanel(candidato: any) {
    this.candidatoSeleccionado = candidato;
    this.panelAbierto = true;
  }

  cerrarPanel() {
    this.panelAbierto = false;
    // Limpiamos la variable después de que termine la animación de cierre
    setTimeout(() => {
      this.candidatoSeleccionado = null;
    }, 300);
  }

  cargarEmbudo() {
    this.candidateService.getCandidates()
      .then((data: any[]) => {
        this.leads = [];
        this.contactosPendientes = [];
        this.entrevistas = [];
        this.contratados = [];

        data.forEach((candidato: any) => {
          const status = candidato.status || 'nuevo'; 

          if (status === 'nuevo') {
            this.leads.push(candidato);
          } else if (status === 'contacto_pendiente') {
            this.contactosPendientes.push(candidato);
          } else if (status === 'entrevista') {
            this.entrevistas.push(candidato);
          } else if (status === 'contratado') {
            this.contratados.push(candidato);
          }
        });

        this.cargando = false;
      })
      .catch((err: any) => {
        console.error('Error al cargar el Kanban:', err);
        this.cargando = false;
      });
  }

  drop(event: CdkDragDrop<any[]>, nuevoStatus: string) {
    if (event.previousContainer === event.container) {
      moveItemInArray(event.container.data, event.previousIndex, event.currentIndex);
    } else {
      transferArrayItem(
        event.previousContainer.data,
        event.container.data,
        event.previousIndex,
        event.currentIndex,
      );

      const candidatoMovido = event.container.data[event.currentIndex];
      candidatoMovido.status = nuevoStatus;

      console.log(`Moviendo a ${candidatoMovido.nombre} a: ${nuevoStatus}`);
      
      this.candidateService.updateCandidate(candidatoMovido.id, { status: nuevoStatus })
        .then(() => console.log('¡Firebase actualizado con éxito!'))
        .catch((err: any) => console.error('Error al actualizar:', err));
    }
  }
}