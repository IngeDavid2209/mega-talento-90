import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CandidateService } from '../../core/services/candidate';
import { Timestamp } from '@angular/fire/firestore';

// Interfaz para el sistema de control de riesgos
interface OfertaChecklist {
  ofertaAceptada: 'gris' | 'amarillo' | 'verde' | 'rojo';
  documentacion: 'gris' | 'amarillo' | 'verde' | 'rojo';
  aprobacionJefe: 'gris' | 'amarillo' | 'verde' | 'rojo';
  fechaIngreso: 'gris' | 'amarillo' | 'verde' | 'rojo';
  confirmacionFinal: 'gris' | 'amarillo' | 'verde' | 'rojo';
}

interface KanbanColumn {
  id: string;
  title: string;
  count: number;
  candidates: any[];
}

@Component({
  selector: 'app-kanban',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './kanban.html',
  styleUrl: './kanban.css'
})
export class KanbanComponent implements OnInit {
  private candidateService = inject(CandidateService);

  cargando = true;
  candidatos: any[] = [];
  columnas: KanbanColumn[] = [];

  statusConfig = [
    { id: 'nuevo', title: 'Nuevo' },
    { id: 'contacto_pendiente', title: 'Contacto' },
    { id: 'entrevista', title: 'Entrevista' },
    { id: 'oferta', title: 'Oferta' },
    { id: 'contratado', title: 'Contratado' },
    { id: 'rechazado', title: 'Rechazado' }
  ];

  kpiTotalCandidatos = 0;
  kpiTasaConversion = 0;
  kpiTiempoPromedio = 0;
  kpiMetaContrataciones = 20;

  filtroPuesto = '';
  filtroCiudad = '';
  filtroFecha = '';

  async ngOnInit() {
    await this.cargarTodo();
  }

  async cargarTodo() {
    this.cargando = true;
    try {
      this.candidatos = await this.candidateService.getCandidates();
      this.calcularMétricas();
      this.filtrarYArmarTablero();
    } catch (error) {
      console.error('Error cargando el tablero:', error);
    } finally {
      this.cargando = false;
    }
  }

  calcularMétricas() {
    this.kpiTotalCandidatos = this.candidatos.length;
    const contratados = this.candidatos.filter(c => c.status === 'contratado').length;
    this.kpiTasaConversion = this.kpiTotalCandidatos > 0 ? (contratados / this.kpiTotalCandidatos) * 100 : 0;
    
    let diasTotales = 0;
    this.candidatos.forEach(c => {
      if (c.createdAt) {
        const fin = c.status === 'contratado' ? (c.hiredAt?.toDate() || new Date()) : new Date();
        const inicio = c.createdAt.toDate();
        const diffTime = Math.abs(fin.getTime() - inicio.getTime());
        diasTotales += Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      }
    });
    this.kpiTiempoPromedio = this.kpiTotalCandidatos > 0 ? Math.round(diasTotales / this.kpiTotalCandidatos) : 0;
  }

  // Lógica de auditoría: Calcular porcentaje de progreso visual
  getProgresoOferta(candidato: any): number {
    if (!candidato.ofertaChecklist) return 0;
    const items = Object.values(candidato.ofertaChecklist);
    const completados = items.filter(val => val === 'verde').length;
    return (completados / items.length) * 100;
  }

  filtrarYArmarTablero() {
    let candidatosFiltrados = [...this.candidatos];
    if (this.filtroPuesto) {
      const puestoLower = this.filtroPuesto.toLowerCase();
      candidatosFiltrados = candidatosFiltrados.filter(c => c.puesto.toLowerCase().includes(puestoLower));
    }
    if (this.filtroCiudad) {
      const ciudadLower = this.filtroCiudad.toLowerCase();
      candidatosFiltrados = candidatosFiltrados.filter(c => (c.ciudad || c.sucursal || '').toLowerCase().includes(ciudadLower));
    }
    if (this.filtroFecha) {
      candidatosFiltrados = candidatosFiltrados.filter(c => {
        if (!c.createdAt) return false;
        const fechaCandidato = c.createdAt.toDate().toISOString().split('T')[0];
        return fechaCandidato === this.filtroFecha;
      });
    }
    this.armarTablero(candidatosFiltrados);
  }

  armarTablero(candidatos: any[]) {
    this.columnas = this.statusConfig.map(status => {
      const candidatosEnStatus = candidatos.filter(c => c.status === status.id);
      return {
        id: status.id,
        title: status.title,
        count: candidatosEnStatus.length,
        candidates: candidatosEnStatus
      };
    });
  }

  candidatoArrastradoId: string | null = null;
  onDragStart(event: DragEvent, candidatoId: string) {
    this.candidatoArrastradoId = candidatoId;
    (event.target as HTMLElement).classList.add('is-dragging');
  }

  onDragEnd(event: DragEvent) {
    (event.target as HTMLElement).classList.remove('is-dragging');
  }

  onDragOver(event: DragEvent, columnaId: string) {
    event.preventDefault();
  }

  async onDrop(event: DragEvent, columnaDestinoId: string) {
    event.preventDefault();
    if (!this.candidatoArrastradoId) return;

    const id = this.candidatoArrastradoId;
    this.candidatoArrastradoId = null;

    const index = this.candidatos.findIndex(c => c.id === id);
    if (index === -1) return;
    if (this.candidatos[index].status === columnaDestinoId) return;

    const estatusAnterior = this.candidatos[index].status;
    this.candidatos[index].status = columnaDestinoId;
    
    const actualizacionData: any = { status: columnaDestinoId };

    // Automatización: Inicializar checklist si entra en oferta
    if (columnaDestinoId === 'oferta' && !this.candidatos[index].ofertaChecklist) {
      actualizacionData.ofertaChecklist = {
        ofertaAceptada: 'gris',
        documentacion: 'gris',
        aprobacionJefe: 'gris',
        fechaIngreso: 'gris',
        confirmacionFinal: 'gris'
      };
      this.candidatos[index].ofertaChecklist = actualizacionData.ofertaChecklist;
    }

    if (columnaDestinoId === 'contratado') actualizacionData.hiredAt = Timestamp.now();
    if (columnaDestinoId === 'rechazado') actualizacionData.rejectedAt = Timestamp.now();

    try {
      this.filtrarYArmarTablero();
      await this.candidateService.updateCandidate(id, actualizacionData);
      this.calcularMétricas();
    } catch (error) {
      console.error('Error al mover candidato:', error);
      this.candidatos[index].status = estatusAnterior;
      this.filtrarYArmarTablero();
    }
  }

  getAvatarColor(nombre: string): string {
    if (!nombre) return '#64748b';
    const colores = ['#f87171', '#fb923c', '#4ade80', '#22d3ee', '#818cf8', '#c084fc'];
    const index = nombre.charCodeAt(0) % colores.length;
    return colores[index];
  }

  formatearFecha(timestamp: any): string {
    if (!timestamp) return 'S/F';
    const date = timestamp.toDate();
    return date.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
  }

  isCandidatoAlerta(candidato: any): boolean {
    if (candidato.status !== 'nuevo' || !candidato.createdAt) return false;
    const diasTotal = Math.ceil(Math.abs(new Date().getTime() - candidato.createdAt.toDate().getTime()) / (1000 * 60 * 60 * 24));
    return diasTotal > 3;
  }

  contactarWhatsApp(telefono: string) {
    const numeroLimpio = telefono.replace(/\D/g, '');
    window.open(`https://wa.me/52${numeroLimpio}`, '_blank');
  }
  // Función para ciclar el estado del checklist
  async cambiarEstadoIcono(candidato: any, key: keyof OfertaChecklist) {
    if (!candidato.ofertaChecklist) return;

    const estados: ('gris' | 'amarillo' | 'verde' | 'rojo')[] = ['gris', 'amarillo', 'verde', 'rojo'];
    const actual = candidato.ofertaChecklist[key];
    const indexActual = estados.indexOf(actual);
    const siguienteIndex = (indexActual + 1) % estados.length;
    
    // Actualizamos localmente
    candidato.ofertaChecklist[key] = estados[siguienteIndex];

    // Persistimos en Firebase
    try {
      await this.candidateService.updateCandidate(candidato.id, {
        ofertaChecklist: candidato.ofertaChecklist
      });
      // Recalculamos la barra de progreso al instante
      this.getProgresoOferta(candidato);
    } catch (error) {
      console.error('Error al actualizar checklist:', error);
      // Revertimos si falla
      candidato.ofertaChecklist[key] = actual;
    }
  }
}