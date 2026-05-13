import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms'; // <-- NECESARIO PARA EL BUSCADOR
import { CandidateService } from '../../core/services/candidate';
import * as XLSX from 'xlsx'; // <-- LIBRERÍA DE EXCEL

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule], // <-- AGREGADO AQUÍ
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css'
})
export class DashboardComponent implements OnInit {
  private candidateService = inject(CandidateService);
  
  candidatos: any[] = [];
  candidatosFiltrados: any[] = []; // <-- ARREGLO PARA EL BUSCADOR
  
  cargando: boolean = true;
  totalLeads: number = 0;
  terminoBusqueda: string = ''; // <-- LO QUE ESCRIBE EL USUARIO

  async ngOnInit() {
    await this.cargarCandidatos();
  }

  async cargarCandidatos() {
    try {
      this.cargando = true;
      const todosLosCandidatos = await this.candidateService.getCandidates();
      
      const ahora = new Date().getTime();
      const limite48Horas = 48 * 60 * 60 * 1000; 

      // Filtro de 48 horas
      this.candidatos = todosLosCandidatos.filter((candidato: any) => {
        if (!candidato.createdAt) return false; 
        const fechaCandidato = candidato.createdAt.toDate().getTime();
        return (ahora - fechaCandidato) <= limite48Horas; 
      });

      this.totalLeads = this.candidatos.length;

      this.candidatos.sort((a, b) => {
        const dateA = a.createdAt?.toDate() || 0;
        const dateB = b.createdAt?.toDate() || 0;
        return (dateB as any) - (dateA as any);
      });

      // Al inicio, los filtrados son todos los de las últimas 48h
      this.candidatosFiltrados = [...this.candidatos];

    } catch (error) {
      console.error('Error cargando los candidatos:', error);
    } finally {
      this.cargando = false;
    }
  }

  // FUNCIÓN 1: BUSCADOR EN TIEMPO REAL
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

  // FUNCIÓN 2: EXPORTAR A EXCEL
  exportarExcel() {
    // 1. Preparamos los datos limpios para el Excel
    const datosParaExcel = this.candidatosFiltrados.map(c => ({
      'Fecha de Registro': this.formatearFecha(c.createdAt),
      'Nombre Completo': c.nombre,
      'Teléfono': c.telefono,
      'Ciudad / Sucursal': c.ciudad || c.sucursal || 'Sin registro',
      'Puesto Solicitado': c.puesto,
      'Estatus Actual': c.status === 'nuevo' ? 'Nueva solicitud' : c.status
    }));

    // 2. Construimos y descargamos el archivo
    const hoja = XLSX.utils.json_to_sheet(datosParaExcel);
    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, hoja, 'Candidatos');
    XLSX.writeFile(libro, 'Reporte_MegaDulces.xlsx');
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

  async cambiarEstatus(idCandidato: string, event: any) {
    const nuevoEstatus = event.target.value;
    try {
      await this.candidateService.updateCandidate(idCandidato, { status: nuevoEstatus });
      // Actualizamos en la vista
      const index = this.candidatosFiltrados.findIndex(c => c.id === idCandidato);
      if (index !== -1) this.candidatosFiltrados[index].status = nuevoEstatus;
    } catch (error) {
      console.error('Error al actualizar el estatus:', error);
    }
  }
}