import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { CandidateService } from '../../core/services/candidate';
import { ToastService } from '../../core/services/toast.service';

/**
 * =====================================================================
 * NO RECONTRATABLES · el apartado de los que no vuelven a entrar
 * =====================================================================
 *
 * Lo pidió Capital Humano el 12/08/2026, y el caso que lo detonó dice todo lo
 * que hay que saber: alguien que estuvo unas semanas en Yurécuaro se volvió a
 * postular, y solo se detectó porque una persona lo reconoció.
 *
 * ── POR QUÉ LA ALERTA VA ARRIBA Y LA LISTA ABAJO ────────────────────
 *
 * Una lista negra que hay que ir a consultar no detiene a nadie: nadie abre
 * esta pantalla antes de cada entrevista. Lo que sirve es el cruce al revés —
 * "de la gente que TIENES EN PROCESO AHORA, estos ya están vetados"—, y por
 * eso ocupa el primer lugar. La lista completa es la referencia; la alerta es
 * la que evita que vuelva a pasar.
 *
 * El cruce es por teléfono normalizado a 10 dígitos, no por nombre: el nombre
 * se escribe de diez formas, y el 06/08 ya nos costó una tarde descubrir que
 * el mismo número guardado con y sin '+52' burlaba hasta el índice único.
 */
@Component({
  selector: 'app-no-recontratables',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './no-recontratables.html',
  styleUrl: './no-recontratables.css'
})
export class NoRecontratablesComponent implements OnInit {
  private candidatos = inject(CandidateService);
  private toast = inject(ToastService);
  private router = inject(Router);

  cargando = true;
  error = '';
  lista: any[] = [];
  alertas: any[] = [];
  quitando = '';

  ngOnInit() { this.cargar(); }

  async cargar() {
    this.cargando = true;
    this.error = '';
    try {
      const [lista, al] = await Promise.all([
        this.candidatos.getNoRecontratables(),
        this.candidatos.getAlertasReingreso(),
      ]);
      this.lista = lista || [];
      this.alertas = al?.alertas || [];
    } catch {
      this.error = 'No se pudo cargar la lista. Reintenta en un momento.';
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

  async quitar(c: any, ev: Event) {
    ev.stopPropagation();
    if (this.quitando) return;
    if (!confirm(`¿Quitarle a ${c.nombre} la marca de no recontratable?\n\nVolverá a poder avanzar en el proceso.`)) return;
    this.quitando = c.id;
    try {
      await this.candidatos.marcarNoRecontratable(c.id, false);
      this.toast.exito(`${c.nombre} ya puede volver a considerarse.`, 'Marca retirada');
      await this.cargar();
    } catch {
      this.toast.error('No se pudo quitar la marca.', 'Error');
    } finally {
      this.quitando = '';
    }
  }
}
