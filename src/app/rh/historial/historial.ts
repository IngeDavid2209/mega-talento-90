import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CandidateService } from '../../core/services/candidate';
import { ETAPAS, ID_ETAPAS } from '../../core/models/proceso.model';
import { urlWhatsApp } from '../../core/models/puestos.model';
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

  ETAPAS = ETAPAS;
  ID_ETAPAS = ID_ETAPAS;

  candidatos: any[] = [];
  candidatosFiltrados: any[] = [];
  cargando = true;
  terminoBusqueda = '';
  filtroEstatus = '';

  async ngOnInit() {
    await this.cargarHistorial();
  }

  async cargarHistorial() {
    try {
      this.cargando = true;
      const todos = await this.candidateService.getCandidates();
      this.candidatos = todos.sort((a: any, b: any) => {
        const da = a.createdAt?.toDate?.() || new Date(a.createdAt || 0);
        const db = b.createdAt?.toDate?.() || new Date(b.createdAt || 0);
        return db.getTime() - da.getTime();
      });
      this.aplicarFiltros();
    } finally {
      this.cargando = false;
    }
  }

  aplicarFiltros() {
    const t = this.terminoBusqueda.toLowerCase().trim();
    this.candidatosFiltrados = this.candidatos.filter(c => {
      const matchTexto = !t ||
        (c.nombre || '').toLowerCase().includes(t) ||
        (c.puesto || '').toLowerCase().includes(t) ||
        (c.ciudad || '').toLowerCase().includes(t);
      const matchEstatus = !this.filtroEstatus || c.status === this.filtroEstatus;
      return matchTexto && matchEstatus;
    });
  }

  exportarExcel() {
    const datos = this.candidatosFiltrados.map(c => ({
      'Fecha Registro': this.formatearFecha(c.createdAt),
      'Nombre': c.nombre,
      'Teléfono': c.telefono,
      'Ciudad / Sucursal': c.ciudad || c.sucursal || '',
      'Puesto Solicitado': c.puesto,
      'Fuente': c.fuente || '',
      'Estatus Actual': this.getNombreEtapa(c.status),
      'Fecha Contratación': c.hiredAt ? this.formatearFecha(c.hiredAt) : '',
      'Fecha Rechazo': c.rejectedAt ? this.formatearFecha(c.rejectedAt) : ''
    }));
    const hoja = XLSX.utils.json_to_sheet(datos);
    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, hoja, 'Historial');
    XLSX.writeFile(libro, 'Historial_MegaTalento.xlsx');
  }

  getNombreEtapa(id: string): string {
    return ETAPAS.find(e => e.id === id)?.title || id || 'Sin estatus';
  }

  getColorEtapa(id: string): string {
    return ETAPAS.find(e => e.id === id)?.color || '#94a3b8';
  }

  formatearFecha(timestamp: any): string {
    if (!timestamp) return 'Sin fecha';
    const d = typeof timestamp.toDate === 'function' ? timestamp.toDate() : new Date(timestamp);
    return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  async contactarWhatsApp(c: any) {
    window.open(urlWhatsApp(c), '_blank');

    if (c.status === ID_ETAPAS.NUEVO) {
      try {
        await this.candidateService.updateCandidate(c.id, { status: ID_ETAPAS.FILTRO });
        c.status = ID_ETAPAS.FILTRO;
      } catch {}
    }
  }

  async cambiarEstatus(id: string, event: any) {
    const nuevo = event.target.value;
    try {
      await this.candidateService.updateCandidate(id, { status: nuevo });
      const idx = this.candidatosFiltrados.findIndex(c => c.id === id);
      if (idx !== -1) this.candidatosFiltrados[idx].status = nuevo;
    } catch (e) {
      console.error('Error al actualizar estatus:', e);
    }
  }

  getInitials(nombre: string): string {
    if (!nombre) return '?';
    return nombre.trim().split(/\s+/).slice(0, 2).map(p => p.charAt(0).toUpperCase()).join('');
  }
}
