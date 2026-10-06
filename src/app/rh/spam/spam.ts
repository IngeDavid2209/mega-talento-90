import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { CandidateService } from '../../core/services/candidate';
import { ToastService } from '../../core/services/toast.service';

/**
 * =====================================================================
 * SPAM · postulaciones que no sirven
 * =====================================================================
 *
 * Lo pidió Capital Humano el 06/10/2026: postulaciones sin ciudad y sin
 * puesto, que no se pueden asignar a ninguna vacante ni plaza. Salen de la
 * lista de candidatos y de los conteos, pero NO se borran: si alguna se marcó
 * de más, "Sacar de spam" la regresa tal cual.
 */
@Component({
  selector: 'app-spam',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './spam.html',
  styleUrl: '../no-recontratables/no-recontratables.css'
})
export class SpamComponent implements OnInit {
  private candidatos = inject(CandidateService);
  private toast = inject(ToastService);
  private router = inject(Router);

  cargando = true;
  error = '';
  lista: any[] = [];
  sacando = '';

  ngOnInit() { this.cargar(); }

  async cargar() {
    this.cargando = true;
    this.error = '';
    try {
      this.lista = (await this.candidatos.getSpam()) || [];
    } catch {
      this.error = 'No se pudo cargar el spam. Reintenta en un momento.';
    } finally {
      this.cargando = false;
    }
  }

  abrir(id: string) { this.router.navigate(['/app/expediente', id]); }

  fecha(iso: string | null): string {
    if (!iso) return '—';
    const f = new Date(iso);
    if (isNaN(f.getTime())) return '—';
    return f.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  async sacar(c: any, ev: Event) {
    ev.stopPropagation();
    if (this.sacando) return;
    const nombre = c.nombre || 'este candidato';
    if (!confirm(`¿Sacar a ${nombre} de spam?\n\nVolverá a aparecer en la lista de candidatos.`)) return;
    this.sacando = c.id;
    try {
      await this.candidatos.marcarSpam(c.id, false);
      this.toast.exito(`${nombre} volvió a la lista de candidatos.`, 'Fuera de spam');
      await this.cargar();
    } catch {
      this.toast.error('No se pudo sacar de spam.', 'Error');
    } finally {
      this.sacando = '';
    }
  }
}
