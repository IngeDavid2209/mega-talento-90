import { Component, inject, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { CandidateService } from '../../core/services/candidate';
import { ETAPAS } from '../../core/models/proceso.model';
import { esReingreso, seLePregunto, detalleReingreso } from '../../core/models/reingreso.model';

/**
 * =====================================================================
 * YA TRABAJARON CON NOSOTROS — quién se está volviendo a postular
 * =====================================================================
 *
 * Lo pidió Capital Humano tras un caso concreto: alguien que estuvo unas
 * semanas en Yurécuaro se volvió a postular, y solo se detectó porque una
 * persona lo reconoció. Un reingreso no es malo por sí solo —hay quien se fue
 * bien y vuelve— pero hay que MIRARLO antes de avanzarlo, no enterarse después.
 *
 * ── POR QUÉ ES SU PROPIA PANTALLA ──
 *
 * Primero se hizo como un panel dentro del tablero, y quedó en el sexto lugar
 * de ocho, debajo de una lista larguísima. Estaba desplegado y aun así no se
 * veía. Aquí aplica lo mismo que ya costó caro con los botones de aprobar y
 * descartar: una alerta que hay que ir a buscar no evita nada.
 *
 * ── LA TRAMPA DEL DENOMINADOR ──
 *
 * Vacío significa "no se le preguntó", no "no trabajó aquí": la pregunta se
 * agregó al registro el 12/08/2026. Por eso la pantalla dice SIEMPRE a cuántos
 * no se les preguntó — si no, "3 reingresos" se lee como "solo 3 ex-empleados
 * se postularon", cuando la verdad es "3 de los que alcanzamos a preguntar".
 *
 * La regla de quién cuenta vive en core/models/reingreso.model.ts, compartida
 * con el expediente y el tablero: tres copias de la misma pregunta acabarían
 * diciendo cosas distintas de la misma persona.
 */
@Component({
  selector: 'app-reingresos',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './reingresos.html',
  styleUrl: './reingresos.css',
})
export class ReingresosComponent implements OnInit, OnDestroy {
  private candidateService = inject(CandidateService);
  private router = inject(Router);
  private ngZone = inject(NgZone);

  cargando = true;
  todos: any[] = [];
  lista: any[] = [];
  termino = '';

  /** A cuántos NUNCA se les hizo la pregunta. Se muestra siempre. */
  sinPreguntar = 0;
  /** De cuántos sí tenemos respuesta: el denominador honesto del conteo. */
  contestaron = 0;

  private unsub: any;

  ngOnInit() {
    this.unsub = this.candidateService.listenToCandidates((datos) => {
      this.ngZone.run(() => {
        this.todos = datos || [];
        this.clasificar();
        this.cargando = false;
      });
    });
  }
  ngOnDestroy() { if (this.unsub) this.unsub(); }

  clasificar() {
    const vivos = this.todos.filter((c) => !c.deletedAt);
    this.sinPreguntar = vivos.filter((c) => !seLePregunto(c.reingreso)).length;
    this.contestaron = vivos.filter((c) => seLePregunto(c.reingreso)).length;

    const t = this.termino.trim().toLowerCase();
    const coincide = (c: any) => !t
      || (c.nombre || '').toLowerCase().includes(t)
      || (c.puesto || '').toLowerCase().includes(t)
      || (c.ciudad || c.sucursal || '').toLowerCase().includes(t)
      || String(c.reingreso || '').toLowerCase().includes(t);

    this.lista = vivos
      .filter((c) => esReingreso(c.reingreso))
      .filter(coincide)
      // Los marcados como no recontratables primero: son los que no deberían
      // avanzar ni un paso más, y verlos hasta abajo derrota el propósito.
      .sort((a, b) => {
        const veto = (x: any) => (x.noRecontratable ? 1 : 0);
        if (veto(b) !== veto(a)) return veto(b) - veto(a);
        return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
      });
  }

  get vetados(): number { return this.lista.filter((c) => c.noRecontratable).length; }

  /**
   * Lo que contestó. Un "Sí" pelón no deja verificar nada, y decirlo es más
   * útil que pintar un "Sí" que parece un dato completo.
   */
  detalle(c: any): string { return detalleReingreso(c?.reingreso); }

  abrirExpediente(c: any) { this.router.navigate(['/app/expediente', c.id]); }
  nombreEtapa(id: string): string { return ETAPAS.find((e) => e.id === id)?.title || 'Filtro Inicial'; }
  colorEtapa(id: string): string { return ETAPAS.find((e) => e.id === id)?.color || '#94a3b8'; }
  getInitials(n: string): string {
    if (!n) return '?';
    return n.trim().split(/\s+/).slice(0, 2).map((p) => p.charAt(0).toUpperCase()).join('');
  }
  fecha(v: any): string {
    if (!v) return '—';
    const d = v?.toDate?.() || new Date(v);
    return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
  }
}
