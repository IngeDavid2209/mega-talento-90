import { Component, inject, OnInit, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CandidateService } from '../../core/services/candidate';
import { Timestamp } from '@angular/fire/firestore';

interface ContactoChecklist {
  validacionExperiencia: 'gris' | 'amarillo' | 'verde' | 'rojo';
  escolaridad: 'gris' | 'amarillo' | 'verde' | 'rojo';
  zonaResidencia: 'gris' | 'amarillo' | 'verde' | 'rojo';
  sueldoEsperado: 'gris' | 'amarillo' | 'verde' | 'rojo';
  documentacionPreliminar: 'gris' | 'amarillo' | 'verde' | 'rojo';
}

interface OfertaChecklist {
  ofertaAceptada: 'gris' | 'amarillo' | 'verde' | 'rojo';
  documentacion: 'gris' | 'amarillo' | 'verde' | 'rojo';
  aprobacionJefe: 'gris' | 'amarillo' | 'verde' | 'rojo';
  fechaIngreso: 'gris' | 'amarillo' | 'verde' | 'rojo';
  confirmacionFinal: 'gris' | 'amarillo' | 'verde' | 'rojo';
}

interface ContratadoChecklist {
  contratoFirmado: 'gris' | 'amarillo' | 'verde' | 'rojo';
  contratoOms: 'gris' | 'amarillo' | 'verde' | 'rojo';
  induccion: 'gris' | 'amarillo' | 'verde' | 'rojo';
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
  private ngZone = inject(NgZone);

  cargando = true;
  candidatos: any[] = [];
  columnas: KanbanColumn[] = [];

  // --- CONTROL DEL PANEL LATERAL ---
  candidatoSeleccionado: any = null;
  subiendoDoc = false;

  abrirExpediente(candidato: any) {
    if (!candidato.contactoChecklist) {
      candidato.contactoChecklist = { validacionExperiencia: 'gris', escolaridad: 'gris', zonaResidencia: 'gris', sueldoEsperado: 'gris', documentacionPreliminar: 'gris' };
    }
    if (!candidato.contratadoChecklist) {
      candidato.contratadoChecklist = { contratoFirmado: 'gris', contratoOms: 'gris', induccion: 'gris' };
    }
    this.candidatoSeleccionado = candidato;
  }

  cerrarExpediente() {
    this.candidatoSeleccionado = null;
  }

  // --- SUBIDA DE DOCUMENTOS ---
  async subirDocumento(event: any) {
    const file = event.target.files[0];
    if (!file || !this.candidatoSeleccionado) return;

    this.subiendoDoc = true;
    try {
      const url = await this.candidateService.uploadDocument(file, this.candidatoSeleccionado.id);

      const nuevoDoc = {
        nombre: file.name,
        url: url,
        fecha: new Date().toISOString()
      };

      const documentosActuales = this.candidatoSeleccionado.documentos || [];
      documentosActuales.push(nuevoDoc);

      await this.candidateService.updateCandidate(this.candidatoSeleccionado.id, {
        documentos: documentosActuales
      });

      this.candidatoSeleccionado.documentos = documentosActuales;

    } catch (error) {
      console.error("Error al subir el documento:", error);
      alert("Hubo un error al subir el archivo. Revisa tu conexión.");
    } finally {
      this.subiendoDoc = false;
      event.target.value = ''; 
    }
  }

  statusConfig = [
    { id: 'nuevo', title: 'Nuevo' },
    { id: 'contacto_pendiente', title: 'Contacto' },
    { id: 'entrevista', title: 'Entrevista' },
    { id: 'oferta', title: 'Oferta' },
    { id: 'contratado', title: 'Contratado' },
    { id: 'rechazado', title: 'No Viable' }
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
      this.candidateService.listenToCandidates((datosFrescos) => {
        this.ngZone.run(() => {
          this.candidatos = datosFrescos;
          this.calcularMétricas();
          this.filtrarYArmarTablero();
          this.cargando = false;
        });
      });
    } catch (error) {
      console.error('Error conectando el tablero en vivo:', error);
      this.cargando = false;
    }
  }

  calcularMétricas() {
    try {
      this.kpiTotalCandidatos = this.candidatos.length;
      const contratados = this.candidatos.filter(c => c.status === 'contratado').length;
      this.kpiTasaConversion = this.kpiTotalCandidatos > 0 ? (contratados / this.kpiTotalCandidatos) * 100 : 0;

      let diasTotales = 0;
      let candidatosValidos = 0;

      this.candidatos.forEach(c => {
        try {
          if (c.createdAt) {
            let inicio = typeof c.createdAt.toDate === 'function' ? c.createdAt.toDate() : new Date(c.createdAt);
            let fin = new Date();

            if (c.status === 'contratado' && c.hiredAt) {
              fin = typeof c.hiredAt.toDate === 'function' ? c.hiredAt.toDate() : new Date(c.hiredAt);
            }
            const diffTime = Math.abs(fin.getTime() - inicio.getTime());
            diasTotales += Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            candidatosValidos++;
          }
        } catch (errorFecha) {
          console.warn(`Error fecha:`, errorFecha);
        }
      });

      this.kpiTiempoPromedio = candidatosValidos > 0 ? Math.round(diasTotales / candidatosValidos) : 0;
    } catch (error) {
      console.error("Error crítico en calcularMétricas:", error);
    }
  }

  async cambiarEstadoIconoContacto(candidato: any, key: keyof ContactoChecklist) {
    if (!candidato.contactoChecklist) return;
    const estados: ('gris' | 'amarillo' | 'verde' | 'rojo')[] = ['gris', 'amarillo', 'verde', 'rojo'];
    const actual = candidato.contactoChecklist[key];
    const siguienteIndex = (estados.indexOf(actual) + 1) % estados.length;
    candidato.contactoChecklist[key] = estados[siguienteIndex];
    try { await this.candidateService.updateCandidate(candidato.id, { contactoChecklist: candidato.contactoChecklist }); } 
    catch (error) { candidato.contactoChecklist[key] = actual; }
  }

  async cambiarEstadoIcono(candidato: any, key: keyof OfertaChecklist) {
    if (!candidato.ofertaChecklist) return;
    const estados: ('gris' | 'amarillo' | 'verde' | 'rojo')[] = ['gris', 'amarillo', 'verde', 'rojo'];
    const actual = candidato.ofertaChecklist[key];
    const siguienteIndex = (estados.indexOf(actual) + 1) % estados.length;
    candidato.ofertaChecklist[key] = estados[siguienteIndex];
    try { await this.candidateService.updateCandidate(candidato.id, { ofertaChecklist: candidato.ofertaChecklist }); } 
    catch (error) { candidato.ofertaChecklist[key] = actual; }
  }

  async cambiarEstadoIconoContratado(candidato: any, key: keyof ContratadoChecklist) {
    if (!candidato.contratadoChecklist) return;
    const estados: ('gris' | 'amarillo' | 'verde' | 'rojo')[] = ['gris', 'amarillo', 'verde', 'rojo'];
    const actual = candidato.contratadoChecklist[key];
    const siguienteIndex = (estados.indexOf(actual) + 1) % estados.length;
    candidato.contratadoChecklist[key] = estados[siguienteIndex];
    try { await this.candidateService.updateCandidate(candidato.id, { contratadoChecklist: candidato.contratadoChecklist }); } 
    catch (error) { candidato.contratadoChecklist[key] = actual; }
  }

  getDiasPermanencia(hiredAt: any): number {
    if (!hiredAt) return 0;
    let fechaIngreso = typeof hiredAt.toDate === 'function' ? hiredAt.toDate() : new Date(hiredAt);
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    fechaIngreso.setHours(0, 0, 0, 0);
    const diffTime = hoy.getTime() - fechaIngreso.getTime();
    return Math.max(0, Math.floor(diffTime / (1000 * 60 * 60 * 24)));
  }

  getEtiquetaPermanencia(dias: number): string {
    if (dias === 0) return ' ⏳ Ingreso hoy (Crítico)';
    if (dias < 7) return ` ⏳ ${dias} días (Riesgo Alto)`;
    if (dias < 15) return ` ⏳ ${dias} días (Estable)`;
    if (dias < 30) return ` ⏳ ${dias} días (Avanzado)`;
    return ` ✅ Consolidado (+30 días)`;
  }

  getClasePermanencia(dias: number): string {
    if (dias < 7) return 'badge-critico';
    if (dias < 15) return 'badge-estable';
    if (dias < 30) return 'badge-avanzado';
    return 'badge-consolidado';
  }

  filtrarYArmarTablero() {
    let candidatosFiltrados = [...this.candidatos];
    if (this.filtroPuesto) candidatosFiltrados = candidatosFiltrados.filter(c => c.puesto.toLowerCase().includes(this.filtroPuesto.toLowerCase()));
    if (this.filtroCiudad) candidatosFiltrados = candidatosFiltrados.filter(c => (c.ciudad || c.sucursal || '').toLowerCase().includes(this.filtroCiudad.toLowerCase()));
    if (this.filtroFecha) {
      candidatosFiltrados = candidatosFiltrados.filter(c => {
        if (!c.createdAt) return false;
        let d = typeof c.createdAt.toDate === 'function' ? c.createdAt.toDate() : new Date(c.createdAt);
        return d.toISOString().split('T')[0] === this.filtroFecha;
      });
    }
    this.armarTablero(candidatosFiltrados);
  }

  armarTablero(candidatos: any[]) {
    this.columnas = this.statusConfig.map(status => {
      const candidatosEnStatus = candidatos.filter(c => c.status === status.id);
      return { id: status.id, title: status.title, count: candidatosEnStatus.length, candidates: candidatosEnStatus };
    });
  }

  candidatoArrastradoId: string | null = null;
  onDragStart(event: DragEvent, candidatoId: string) { this.candidatoArrastradoId = candidatoId; (event.target as HTMLElement).classList.add('is-dragging'); }
  onDragEnd(event: DragEvent) { (event.target as HTMLElement).classList.remove('is-dragging'); }
  onDragOver(event: DragEvent, columnaId: string) { event.preventDefault(); }

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
    
    if (columnaDestinoId === 'contacto_pendiente' && !this.candidatos[index].contactoChecklist) {
      actualizacionData.contactoChecklist = { validacionExperiencia: 'gris', escolaridad: 'gris', zonaResidencia: 'gris', sueldoEsperado: 'gris', documentacionPreliminar: 'gris' };
      this.candidatos[index].contactoChecklist = actualizacionData.contactoChecklist;
    }
    if (columnaDestinoId === 'oferta' && !this.candidatos[index].ofertaChecklist) {
      actualizacionData.ofertaChecklist = { ofertaAceptada: 'gris', documentacion: 'gris', aprobacionJefe: 'gris', fechaIngreso: 'gris', confirmacionFinal: 'gris' };
      this.candidatos[index].ofertaChecklist = actualizacionData.ofertaChecklist;
    }
    if (columnaDestinoId === 'contratado') {
      actualizacionData.hiredAt = Timestamp.now();
      if (!this.candidatos[index].contratadoChecklist) {
        actualizacionData.contratadoChecklist = { contratoFirmado: 'gris', contratoOms: 'gris', induccion: 'gris' };
        this.candidatos[index].contratadoChecklist = actualizacionData.contratadoChecklist;
      }
    }
    if (columnaDestinoId === 'rechazado') actualizacionData.rejectedAt = Timestamp.now();
    
    try {
      this.filtrarYArmarTablero();
      await this.candidateService.updateCandidate(id, actualizacionData);
      this.calcularMétricas();
    } catch (error) {
      this.candidatos[index].status = estatusAnterior;
      this.filtrarYArmarTablero();
    }
  }

  getAvatarColor(nombre: string): string {
    if (!nombre) return '#64748b';
    const colores = ['#f87171', '#fb923c', '#4ade80', '#22d3ee', '#818cf8', '#c084fc'];
    return colores[nombre.charCodeAt(0) % colores.length];
  }

  formatearFecha(timestamp: any): string {
    if (!timestamp) return 'S/F';
    const date = typeof timestamp.toDate === 'function' ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
  }

  isCandidatoAlerta(candidato: any): boolean {
    if (candidato.status !== 'nuevo' || !candidato.createdAt) return false;
    let d = typeof candidato.createdAt.toDate === 'function' ? candidato.createdAt.toDate() : new Date(candidato.createdAt);
    const diasTotal = Math.ceil(Math.abs(new Date().getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
    return diasTotal > 3;
  }

  contactarWhatsApp(telefono: string) {
    const numeroLimpio = telefono.replace(/\D/g, '');
    window.open(`https://wa.me/52${numeroLimpio}`, '_blank');
  }
}