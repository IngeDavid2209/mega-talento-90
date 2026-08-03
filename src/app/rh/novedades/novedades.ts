import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { KpiService, Novedades } from '../../core/services/kpi.service';
import { ETAPAS, ETAPA_CONTRATADO } from '../../core/models/proceso.model';
import { centroChecadorPorId } from '../../core/models/sucursales.model';

/**
 * =====================================================================
 * NOVEDADES DEL DÍA — "¿qué pasó hoy?"
 * =====================================================================
 *
 * Lo que pidió Capital Humano para el panel: el resumen de lo nuevo que se
 * genera al día, sea gente que se postuló o gente que cambió de fase.
 *
 * ── DOS DECISIONES ──────────────────────────────────────────────────
 *
 * 1. NOMBRES, NO CIFRAS. El panel ya tiene indicadores de sobra. Un "3
 *    postulados hoy" obliga a ir a buscarlos a otra pantalla, y esa fricción es
 *    justo por lo que alguien nuevo se queda dos días sin que nadie lo toque.
 *    Cada renglón se abre en su expediente de un clic.
 *
 * 2. UN DÍA VACÍO SE DICE CON PALABRAS. Si no pasó nada, el bloque no pinta
 *    cuatro ceros: dice que no pasó nada y qué es lo que estaría contando. Una
 *    fila de ceros se lee como una falla del sistema, no como un día tranquilo.
 */
@Component({
  selector: 'app-novedades-dia',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './novedades.html',
  styleUrl: './novedades.css'
})
export class NovedadesDiaComponent implements OnInit {
  private kpi = inject(KpiService);
  private router = inject(Router);

  cargando = true;
  error = '';
  datos: Novedades | null = null;

  /** Cuántos días atrás se está mirando. 0 = hoy. */
  desplazamiento = 0;

  ngOnInit() { this.cargar(); }

  async cargar() {
    this.cargando = true;
    this.error = '';
    try {
      this.datos = await this.kpi.novedades(this.desplazamiento ? this.fechaPedida() : undefined);
    } catch {
      this.error = 'No se pudieron cargar las novedades del día.';
      this.datos = null;
    } finally {
      this.cargando = false;
    }
  }

  /**
   * La fecha se arma con el reloj de quien mira la pantalla. El API la vuelve a
   * interpretar en hora de México, que es donde se corta el día para todos los
   * indicadores; así el "ayer" del botón y el "ayer" del tablero son el mismo.
   */
  private fechaPedida(): string {
    const f = new Date();
    f.setDate(f.getDate() - this.desplazamiento);
    return `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`;
  }

  async mover(dias: number) {
    // No tiene caso viajar al futuro, y más de una semana atrás ya es trabajo
    // para el tablero de KPI, no para el resumen del día.
    const nuevo = Math.min(7, Math.max(0, this.desplazamiento + dias));
    if (nuevo === this.desplazamiento) return;
    this.desplazamiento = nuevo;
    await this.cargar();
  }

  get titulo(): string {
    if (this.desplazamiento === 0) return 'Hoy';
    if (this.desplazamiento === 1) return 'Ayer';
    return this.fechaLarga(this.datos?.dia || this.fechaPedida());
  }

  fechaLarga(iso: string): string {
    const f = new Date(iso.slice(0, 10) + 'T12:00:00');
    if (isNaN(f.getTime())) return iso;
    const t = f.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  nombreEtapa(id: string): string {
    if (id === ETAPA_CONTRATADO.id) return ETAPA_CONTRATADO.title;
    if (id === 'rechazado') return 'Rechazados';
    return ETAPAS.find(e => e.id === id)?.title || id;
  }

  colorEtapa(id: string): string {
    if (id === ETAPA_CONTRATADO.id) return ETAPA_CONTRATADO.color;
    if (id === 'rechazado') return '#94a3b8';
    return ETAPAS.find(e => e.id === id)?.color || '#64748b';
  }

  etiquetaEvento(tipo: string, canal: string | null): string {
    const base = tipo === 'contacto'     ? 'Contacto'
               : tipo === 'entrevista'   ? 'Entrevista'
               : tipo === 'contratacion' ? 'Contratación'
               :                           'Nota';
    return canal ? `${base} · ${canal}` : base;
  }

  nombreSucursal(id: string | null): string {
    if (!id) return '';
    const s = centroChecadorPorId(id);
    return s ? s.ciudad : id;
  }

  abrir(id: string) { this.router.navigate(['/app/expediente', id]); }
}
