import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms'; // <-- NECESARIO PARA LOS FILTROS
import { CandidateService } from '../../core/services/candidate'; 
import { Timestamp } from '@angular/fire/firestore';

// Interfaz para definir la estructura de las columnas
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

  // Definición de las 6 etapas del embudo profesional
  statusConfig = [
    { id: 'nuevo', title: 'Nuevo' },
    { id: 'contacto_pendiente', title: 'Contacto' },
    { id: 'entrevista', title: 'Entrevista' },
    { id: 'oferta', title: 'Oferta' },
    { id: 'contratado', title: 'Contratado' },
    { id: 'rechazado', title: 'Rechazado' }
  ];

  // Variables para Métricas (KPIs)
  kpiTotalCandidatos = 0;
  kpiTasaConversion = 0;
  kpiTiempoPromedio = 0;
  kpiMetaContrataciones = 20; // Puedes cambiar esto a dinámico después

  // Variables para Filtros
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

  // FUNCIÓN 1: CÁLCULO DE KPIs
  calcularMétricas() {
    this.kpiTotalCandidatos = this.candidatos.length;
    
    const contratados = this.candidatos.filter(c => c.status === 'contratado').length;
    this.kpiTasaConversion = this.kpiTotalCandidatos > 0 ? (contratados / this.kpiTotalCandidatos) * 100 : 0;

    // Cálculo básico de tiempo promedio (usando createdAt hasta hoy si no está contratado)
    // Para ser preciso, necesitas un campo 'hiredAt' en Firebase. Por ahora usaremos el promedio general.
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

  // FUNCIÓN 2: LÓGICA DE FILTROS EN TIEMPO REAL
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

    // Filtro básico de fecha (coincidencia exacta por ahora, ajustable a rango)
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

  // FUNCIÓN 3: DRAG & DROP (HTML Nativo)
  candidatoArrastradoId: string | null = null;
  columnaOverId: string | null = null;

  // Se ejecuta al empezar a arrastrar una tarjeta
  onDragStart(event: DragEvent, candidatoId: string) {
    this.candidatoArrastradoId = candidatoId;
    (event.target as HTMLElement).classList.add('is-dragging');
  }

  // Se ejecuta cuando dejas de arrastrar
  onDragEnd(event: DragEvent) {
    (event.target as HTMLElement).classList.remove('is-dragging');
  }

  // Se ejecuta cuando pasas una tarjeta SOBRE una columna (hay que cancelarlo para permitir soltar)
  onDragOver(event: DragEvent, columnaId: string) {
    event.preventDefault(); // <-- Importante: permite el drop
    this.columnaOverId = columnaId;
  }

  // Se ejecuta cuando sueltas la tarjeta en una columna
  async onDrop(event: DragEvent, columnaDestinoId: string) {
    event.preventDefault();
    if (!this.candidatoArrastradoId) return;

    const id = this.candidatoArrastradoId;
    this.candidatoArrastradoId = null; // Limpiamos

    // Encontramos el candidato en local
    const index = this.candidatos.findIndex(c => c.id === id);
    if (index === -1) return;

    // Si no cambió de estatus, no hacemos nada
    if (this.candidatos[index].status === columnaDestinoId) return;

    // Optimizamos en vista (Movimiento optimista)
    const estatusAnterior = this.candidatos[index].status;
    this.candidatos[index].status = columnaDestinoId;
    
    // Si se contrató o rechazó, deberíamos agregar la fecha final.
    const actualizacionData: any = { status: columnaDestinoId };
    if (columnaDestinoId === 'contratado') actualizacionData.hiredAt = Timestamp.now();
    if (columnaDestinoId === 'rechazado') actualizacionData.rejectedAt = Timestamp.now();

    try {
      this.filtrarYArmarTablero(); // Actualizamos vista local rápido
      await this.candidateService.updateCandidate(id, actualizacionData);
      // Recalculamos KPIs por si acaso (ej. cambió contratado)
      this.calcularMétricas();
    } catch (error) {
      console.error('Error al mover candidato:', error);
      // Revertimos en local si falla Firebase
      this.candidatos[index].status = estatusAnterior;
      this.filtrarYArmarTablero();
    }
  }

  // Funciones Auxiliares para UI
  getAvatarColor(nombre: string): string {
    if (!nombre) return '#64748b';
    const colores = ['#f87171', '#fb923c', '#4ade80', '#22d3ee', '#818cf8', '#c084fc'];
    const index = nombre.charCodeAt(0) % colores.length;
    return colores[index];
  }

  formatearFecha(timestamp: any): string {
    if (!timestamp) return 'S/F';
    const date = timestamp.toDate();
    const options: any = { day: '2-digit', month: 'short' }; // ej. "12 oct"
    return date.toLocaleDateString('es-MX', options);
  }

  // Alerta si lleva más de 3 días en "Nuevo"
  isCandidatoAlerta(candidato: any): boolean {
    if (candidato.status !== 'nuevo' || !candidato.createdAt) return false;
    const diasTotal = Math.ceil(Math.abs(new Date().getTime() - candidato.createdAt.toDate().getTime()) / (1000 * 60 * 60 * 24));
    return diasTotal > 3;
  }

contactarWhatsApp(telefono: string) {
    const numeroLimpio = telefono.replace(/\D/g, '');
    const url = `https://wa.me/52${numeroLimpio}`;
    window.open(url, '_blank');
  }
}