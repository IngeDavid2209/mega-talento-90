import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CandidateService } from '../../core/services/candidate';
import * as XLSX from 'xlsx';

@Component({
  selector: 'app-historial',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './historial.html',
  styleUrl: './historial.css'
})
export class HistorialComponent implements OnInit {
  private candidateService = inject(CandidateService);

  candidatos: any[] = [];
  candidatosFiltrados: any[] = [];

  cargando: boolean = true;
  terminoBusqueda: string = '';

  async ngOnInit() {
    await this.cargarHistorialCompleto();
  }

  async cargarHistorialCompleto() {
    try {
      this.cargando = true;
      const todos = await this.candidateService.getCandidates();

      // Aquí NO hay filtro de 48 horas. Pasan todos directo.
      // CORRECCIÓN: Le decimos a TypeScript que 'a' y 'b' son de tipo 'any'
      this.candidatos = todos.sort((a: any, b: any) => {
        const dateA = a.createdAt?.toDate() || 0;
        const dateB = b.createdAt?.toDate() || 0;
        return (dateB as any) - (dateA as any);
      });

      this.candidatosFiltrados = [...this.candidatos];

    } catch (error) {
      console.error('Error cargando el historial:', error);
    } finally {
      this.cargando = false;
    }
  }

  filtrarCandidatos() {
    const termino = this.terminoBusqueda.toLowerCase().trim();

    if (!termino) {
      this.candidatosFiltrados = [...this.candidatos];
      return;
    }

    this.candidatosFiltrados = this.candidatos.filter(c =>
      c.nombre.toLowerCase().includes(termino) ||
      c.puesto.toLowerCase().includes(termino) ||
      (c.ciudad && c.ciudad.toLowerCase().includes(termino))
    );
  }

  exportarExcel() {
    const datosParaExcel = this.candidatosFiltrados.map(c => ({
      'Fecha de Registro': this.formatearFecha(c.createdAt),
      'Nombre Completo': c.nombre,
      'Teléfono': c.telefono,
      'Ciudad / Sucursal': c.ciudad || c.sucursal || 'Sin registro',
      'Puesto Solicitado': c.puesto,
      'Estatus Actual': c.status === 'nuevo' ? 'Nueva solicitud' : c.status
    }));

    const hoja = XLSX.utils.json_to_sheet(datosParaExcel);
    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, hoja, 'Historial_Completo');
    XLSX.writeFile(libro, 'Historial_Candidatos_MegaDulces.xlsx');
  }

  formatearFecha(timestamp: any): string {
    if (!timestamp) return 'Sin fecha';
    const date = timestamp.toDate();
    return date.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  async contactarWhatsApp(candidato: any) {
    // 1. Abrimos la pestaña de WhatsApp (como ya lo hacíamos)
    const numeroLimpio = candidato.telefono.replace(/\D/g, '');
    const mensaje = `Hola ${candidato.nombre}, te contactamos del equipo de Reclutamiento de Mega Dulces. Revisamos tu historial y nos gustaría platicar contigo sobre una nueva vacante.`;
    const url = `https://wa.me/52${numeroLimpio}?text=${encodeURIComponent(mensaje)}`;
    window.open(url, '_blank');

    // 2. LA MAGIA: Si el candidato era "nuevo", lo pasamos a "contacto_pendiente" automáticamente
    if (candidato.status === 'nuevo') {
      try {
        // Actualizamos en la base de datos (Firebase)
        await this.candidateService.updateCandidate(candidato.id, { status: 'contacto_pendiente' });

        // Actualizamos visualmente en la tabla al instante (sin tener que recargar la página)
        candidato.status = 'contacto_pendiente';

      } catch (error) {
        console.error('Error al automatizar el estatus:', error);
      }
    }
  }
  async cambiarEstatus(idCandidato: string, event: any) {
    const nuevoEstatus = event.target.value;
    try {
      // 1. Actualizamos el estatus en Firebase
      await this.candidateService.updateCandidate(idCandidato, { status: nuevoEstatus });

      // 2. Actualizamos el estatus visualmente en tu tabla local
      const index = this.candidatosFiltrados.findIndex(c => c.id === idCandidato);
      if (index !== -1) {
        this.candidatosFiltrados[index].status = nuevoEstatus;
      }
    } catch (error) {
      console.error('Error al actualizar el estatus desde el selector:', error);
    }
  }

  

}