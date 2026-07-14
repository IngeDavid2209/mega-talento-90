import { Component, inject, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { CandidateService } from '../../core/services/candidate';
import { ETAPAS, ID_ETAPAS } from '../../core/models/proceso.model';

type Accion =
  | { tipo: 'restaurar'; candidato: any }
  | { tipo: 'definitivo'; candidato: any }
  | { tipo: 'restaurarAvanzados' }
  | { tipo: 'vaciar' };

@Component({
  selector: 'app-papelera',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './papelera.html',
  styleUrl: './papelera.css'
})
export class PapeleraComponent implements OnInit, OnDestroy {
  private candidateService = inject(CandidateService);
  private router = inject(Router);
  private ngZone = inject(NgZone);

  candidatos: any[] = [];
  filtrados: any[] = [];
  cargando = true;
  procesando = false;
  busqueda = '';

  confirmacion: { titulo: string; mensaje: string; advertencia?: string; accion: Accion } | null = null;
  flash: { tipo: 'ok' | 'error'; mensaje: string } | null = null;

  private unsub: any;

  ngOnInit() {
    this.unsub = this.candidateService.listenToCandidatosBorrados((datos) => {
      this.ngZone.run(() => {
        this.candidatos = datos.sort((a: any, b: any) => {
          const da = a.deletedAt?.toDate?.() || new Date(a.deletedAt || 0);
          const db = b.deletedAt?.toDate?.() || new Date(b.deletedAt || 0);
          return db.getTime() - da.getTime();
        });
        this.aplicarFiltro();
        this.cargando = false;
      });
    });
  }

  ngOnDestroy() {
    if (this.unsub) this.unsub();
  }

  aplicarFiltro() {
    const t = this.busqueda.toLowerCase().trim();
    this.filtrados = !t
      ? [...this.candidatos]
      : this.candidatos.filter(c =>
          (c.nombre || '').toLowerCase().includes(t) ||
          (c.telefono || '').toLowerCase().includes(t) ||
          (c.puesto || '').toLowerCase().includes(t)
        );
  }

  pedirRestaurar(c: any) {
    this.confirmacion = {
      titulo: `Restaurar a ${c.nombre || 'este candidato'}`,
      mensaje: 'El candidato volverá al dashboard y al historial como si no se hubiera borrado.',
      accion: { tipo: 'restaurar', candidato: c }
    };
  }

  pedirEliminarDefinitivo(c: any) {
    this.confirmacion = {
      titulo: `Eliminar definitivamente a ${c.nombre || 'este candidato'}`,
      mensaje: 'Se borrará el registro completo de la base de datos. Ya no será posible restaurarlo.',
      advertencia: 'Esta acción NO se puede deshacer.',
      accion: { tipo: 'definitivo', candidato: c }
    };
  }

  // Etapas posteriores a "Filtro Inicial": candidatos que YA avanzaron.
  private readonly ETAPAS_AVANZADAS = new Set<string>([
    ID_ETAPAS.RH, ID_ETAPAS.APTITUDES, ID_ETAPAS.PSICOMETRIA,
    ID_ETAPAS.JEFE, ID_ETAPAS.DOCUMENTAL, ID_ETAPAS.OFERTA, ID_ETAPAS.DICTAMEN,
  ]);

  /** Candidatos en la papelera que ya habían avanzado de etapa (más allá de Filtro Inicial). */
  avanzaronDeEtapa(): any[] {
    return this.candidatos.filter(c => this.ETAPAS_AVANZADAS.has(c.status));
  }

  pedirRestaurarAvanzados() {
    const lista = this.avanzaronDeEtapa();
    if (!lista.length) {
      this.mostrarFlash('ok', 'No hay candidatos avanzados de etapa en la papelera.');
      return;
    }
    this.confirmacion = {
      titulo: 'Restaurar los que ya avanzaron de etapa',
      mensaje: `Se sacarán de la papelera ${lista.length} candidato(s) que iban en Entrevista, Aptitudes o Psicométricas y volverán al proceso. Los de Filtro Inicial se quedan.`,
      accion: { tipo: 'restaurarAvanzados' }
    };
  }

  pedirVaciar() {
    if (this.candidatos.length === 0) return;
    this.confirmacion = {
      titulo: 'Vaciar la papelera',
      mensaje: `Se eliminarán definitivamente los ${this.candidatos.length} candidatos que están en la papelera.`,
      advertencia: 'Esta acción NO se puede deshacer.',
      accion: { tipo: 'vaciar' }
    };
  }

  cancelarConfirmacion() {
    this.confirmacion = null;
  }

  async ejecutarConfirmacion() {
    if (!this.confirmacion) return;
    const accion = this.confirmacion.accion;
    this.procesando = true;
    try {
      if (accion.tipo === 'restaurar') {
        await this.candidateService.restaurarCandidato(accion.candidato.id);
        this.mostrarFlash('ok', `Se restauró a ${accion.candidato.nombre}`);
      } else if (accion.tipo === 'definitivo') {
        await this.candidateService.eliminarCandidatoDefinitivo(accion.candidato.id);
        this.mostrarFlash('ok', `Se eliminó definitivamente a ${accion.candidato.nombre}`);
      } else if (accion.tipo === 'restaurarAvanzados') {
        const lista = this.avanzaronDeEtapa();
        let n = 0;
        for (const c of lista) {
          try { await this.candidateService.restaurarCandidato(c.id); n++; } catch { /* sigue con los demás */ }
        }
        this.mostrarFlash('ok', `Se ${n === 1 ? 'restauró' : 'restauraron'} ${n} candidato(s) que ya habían avanzado de etapa.`);
      } else if (accion.tipo === 'vaciar') {
        for (const c of this.candidatos) {
          await this.candidateService.eliminarCandidatoDefinitivo(c.id);
        }
        this.mostrarFlash('ok', 'Papelera vaciada');
      }
      this.confirmacion = null;
    } catch (e) {
      console.error('Error al procesar:', e);
      this.mostrarFlash('error', 'No se pudo completar la acción. Intenta de nuevo.');
    } finally {
      this.procesando = false;
    }
  }

  private mostrarFlash(tipo: 'ok' | 'error', mensaje: string) {
    this.flash = { tipo, mensaje };
    setTimeout(() => this.flash = null, 3500);
  }

  abrirExpediente(c: any) {
    this.router.navigate(['/app/expediente', c.id]);
  }

  formatearFecha(timestamp: any): string {
    if (!timestamp) return '—';
    const d = typeof timestamp.toDate === 'function' ? timestamp.toDate() : new Date(timestamp);
    return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' }) +
      ' · ' + d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  }

  nombreEtapa(id: string): string {
    return ETAPAS.find(e => e.id === id)?.title || id || '—';
  }

  colorEtapa(id: string): string {
    return ETAPAS.find(e => e.id === id)?.color || '#94a3b8';
  }

  formatearTelefono(tel: string): string {
    const t = (tel || '').replace(/\D/g, '');
    if (t.length !== 10) return tel || '—';
    return `${t.slice(0,3)} ${t.slice(3,6)} ${t.slice(6)}`;
  }

  getInitials(nombre: string): string {
    if (!nombre) return '?';
    return nombre.trim().split(/\s+/).slice(0, 2).map(p => p.charAt(0).toUpperCase()).join('');
  }
}
