import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CandidateService } from '../../core/services/candidate';
import { ETAPAS, ID_ETAPAS } from '../../core/models/proceso.model';
import { normalizarCiudad } from '../../core/models/normalizacion.model';
import { CapitalHumanoService } from '../../core/services/capital-humano.service';
import { ToastService } from '../../core/services/toast.service';
import { BotService } from '../../core/services/bot.service';
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
  private toast = inject(ToastService);
  private botService = inject(BotService);
  // Público para que el template use displayName() en la tabla
  capitalHumano = inject(CapitalHumanoService);

  /** Ids de candidatos con una invitación al bot en curso (para deshabilitar el botón) */
  enviandoInvitacion = new Set<string>();

  ETAPAS = ETAPAS;
  ID_ETAPAS = ID_ETAPAS;

  candidatos: any[] = [];
  candidatosFiltrados: any[] = [];
  gruposCandidatos: { zona: string; candidatos: any[] }[] = [];
  zonasColapsadas = new Set<string>();
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
    this.agruparPorZona();
  }

  /** Agrupa las solicitudes filtradas por zona (ciudad), de mayor a menor volumen. */
  private agruparPorZona() {
    const map = new Map<string, any[]>();
    for (const c of this.candidatosFiltrados) {
      const zona = normalizarCiudad(c.ciudad || c.sucursal);
      if (!map.has(zona)) map.set(zona, []);
      map.get(zona)!.push(c);
    }
    this.gruposCandidatos = Array.from(map.entries())
      .map(([zona, candidatos]) => ({ zona, candidatos }))
      .sort((a, b) => b.candidatos.length - a.candidatos.length);
  }

  toggleZona(zona: string) {
    if (this.zonasColapsadas.has(zona)) this.zonasColapsadas.delete(zona);
    else this.zonasColapsadas.add(zona);
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

  /**
   * Conecta al candidato con el BOT de reclutamiento: le pide al bot que le
   * escriba por WhatsApp desde el número oficial para que continúe su proceso
   * directamente en el chat automático (no abre el WhatsApp personal del RH).
   */
  contactarWhatsApp(c: any) {
    return this.botService.conectarConBot(c, this.enviandoInvitacion);
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

  // Confirmación de borrado con modal propio
  candidatoAEliminar: any = null;
  borrando = false;
  errorBorrado = '';

  pedirBorrar(c: any) {
    this.candidatoAEliminar = c;
    this.errorBorrado = '';
  }

  cancelarBorrar() {
    this.candidatoAEliminar = null;
    this.errorBorrado = '';
  }

  async confirmarBorrar() {
    if (!this.candidatoAEliminar) return;
    this.borrando = true;
    this.errorBorrado = '';
    const id = this.candidatoAEliminar.id;
    try {
      await this.candidateService.eliminarCandidato(id);
      // El historial se carga con getCandidates() (one-shot) así que removemos manualmente
      this.candidatos = this.candidatos.filter(c => c.id !== id);
      this.aplicarFiltros();
      this.candidatoAEliminar = null;
    } catch (e) {
      console.error('Error al mover candidato a la papelera:', e);
      this.errorBorrado = 'No se pudo enviar a la papelera. Revisa tu conexión y vuelve a intentar.';
    } finally {
      this.borrando = false;
    }
  }

  getInitials(nombre: string): string {
    if (!nombre) return '?';
    return nombre.trim().split(/\s+/).slice(0, 2).map(p => p.charAt(0).toUpperCase()).join('');
  }
}
