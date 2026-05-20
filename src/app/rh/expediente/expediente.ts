import { Component, inject, OnInit, NgZone, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { CandidateService } from '../../core/services/candidate';
import { Timestamp } from '@angular/fire/firestore';

@Component({
  selector: 'app-expediente',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './expediente.html',
  styleUrl: './expediente.css'
})
export class ExpedienteComponent implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private candidateService = inject(CandidateService);
  private ngZone = inject(NgZone);

  candidato: any = null;
  cargando = true;
  subiendoDoc = false;
  private unsubscribeFn: any;

  statusConfig = [
    { id: 'nuevo', title: 'Nuevo' },
    { id: 'contacto_pendiente', title: 'Contacto' },
    { id: 'entrevista', title: 'Entrevista' },
    { id: 'oferta', title: 'Oferta' },
    { id: 'contratado', title: 'Contratado' },
    { id: 'rechazado', title: 'No Viable' }
  ];

  ngOnInit() {
    const id = this.route.snapshot.paramMap.get('id');
    if (id) {
      this.unsubscribeFn = this.candidateService.listenToCandidate(id, (data) => {
        this.ngZone.run(() => {
          this.candidato = data;
          
          // Aseguramos que existan las listas
          if (!this.candidato.contactoChecklist) {
            this.candidato.contactoChecklist = { validacionExperiencia: 'gris', escolaridad: 'gris', zonaResidencia: 'gris', sueldoEsperado: 'gris', documentacionPreliminar: 'gris' };
          }
          if (!this.candidato.contratadoChecklist) {
            this.candidato.contratadoChecklist = { contratoFirmado: 'gris', contratoOms: 'gris', induccion: 'gris' };
          }
          this.cargando = false;
        });
      });
    }
  }

  ngOnDestroy() {
    if (this.unsubscribeFn) this.unsubscribeFn();
  }

  volver() {
    this.router.navigate(['/rh/kanban']); // Ajusta esta ruta a donde esté tu tablero
  }

  // --- STEPPER VISUAL ---
  getStepIndex(statusId: string): number {
    return this.statusConfig.findIndex(s => s.id === statusId);
  }

  async moverEtapaDirecto(nuevaColumnaId: string) {
    if (this.candidato.status === nuevaColumnaId) return;
    try {
      let actualizacion: any = { status: nuevaColumnaId };
      if (nuevaColumnaId === 'contratado') actualizacion.hiredAt = Timestamp.now();
      if (nuevaColumnaId === 'rechazado') actualizacion.rejectedAt = Timestamp.now();
      await this.candidateService.updateCandidate(this.candidato.id, actualizacion);
    } catch (error) {
      console.error("Error al cambiar etapa", error);
    }
  }

  // --- NUEVO DISEÑO CHECKLIST (BINARIO SIN COLORES) ---
  async toggleCheck(listName: string, key: string) {
    const currentState = this.candidato[listName][key] || 'gris';
    // Si estaba verde (completado), lo pasamos a gris. Si estaba gris, a verde.
    const newState = currentState === 'verde' ? 'gris' : 'verde';
    this.candidato[listName][key] = newState;

    try {
      await this.candidateService.updateCandidate(this.candidato.id, { [listName]: this.candidato[listName] });
    } catch (error) {
      this.candidato[listName][key] = currentState; // Revertir si hay error
    }
  }

  // --- SUBIR DOCUMENTOS ---
  async subirDocumento(event: any) {
    const file = event.target.files[0];
    if (!file || !this.candidato) return;

    this.subiendoDoc = true;
    try {
      const url = await this.candidateService.uploadDocument(file, this.candidato.id);
      const nuevoDoc = { nombre: file.name, url: url, fecha: new Date().toISOString() };
      const documentosActuales = this.candidato.documentos || [];
      documentosActuales.push(nuevoDoc);
      await this.candidateService.updateCandidate(this.candidato.id, { documentos: documentosActuales });
    } catch (error) {
      alert("Hubo un error al subir el archivo.");
    } finally {
      this.subiendoDoc = false;
      event.target.value = '';
    }
  }
}