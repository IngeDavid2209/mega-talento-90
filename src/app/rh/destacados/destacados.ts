import { Component, inject, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { CandidateService } from '../../core/services/candidate';
import { ETAPAS } from '../../core/models/proceso.model';
import { normalizarCiudad } from '../../core/models/normalizacion.model';
import { BotService } from '../../core/services/bot.service';

/**
 * CANDIDATOS DESTACADOS — vista de "los más interesados".
 * El puntaje (0-100) lo calcula el bot RH con 4 señales de engagement y lo deja
 * en `candidato.destacado` (rapidez de respuesta, datos/documentos completos,
 * evaluaciones hechas, iniciativa en el chat). Aquí solo se LEE y se ordena.
 */
@Component({
  selector: 'app-destacados',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './destacados.html',
  styleUrl: './destacados.css'
})
export class DestacadosComponent implements OnInit, OnDestroy {
  private candidateService = inject(CandidateService);
  private router = inject(Router);
  private ngZone = inject(NgZone);
  private botService = inject(BotService);

  enviandoInvitacion = new Set<string>();
  cargando = true;
  todos: any[] = [];
  destacados: any[] = [];
  interesados: any[] = [];
  termino = '';
  verInteresados = false;

  // Cómo se acomodan los destacados: ranking plano, por zona o por puesto.
  agrupacion: 'ranking' | 'zona' | 'puesto' = 'zona';
  grupos: { titulo: string; total: number; items: any[] }[] = [];

  // Máximo de cada señal (para las barras).
  readonly MAX = { rapidez: 30, datos: 30, evaluaciones: 25, iniciativa: 15 };

  private unsub: any;

  ngOnInit() {
    this.unsub = this.candidateService.listenToCandidates(datos => {
      this.ngZone.run(() => {
        this.todos = datos || [];
        this.clasificar();
        this.cargando = false;
      });
    });
  }
  ngOnDestroy() { if (this.unsub) this.unsub(); }

  private pts(c: any): number { return c?.destacado?.puntaje ?? -1; }
  nivel(c: any): string { return c?.destacado?.nivel || 'bajo'; }
  puntaje(c: any): number { return c?.destacado?.puntaje ?? 0; }
  senales(c: any): any { return c?.destacado?.senales || { rapidez: 0, datos: 0, evaluaciones: 0, iniciativa: 0 }; }

  clasificar() {
    const t = this.termino.trim().toLowerCase();
    const coincide = (c: any) => !t
      || (c.nombre || '').toLowerCase().includes(t)
      || (c.puesto || '').toLowerCase().includes(t)
      || (c.ciudad || c.sucursal || '').toLowerCase().includes(t);
    const orden = (a: any, b: any) => this.pts(b) - this.pts(a);
    const activos = this.todos.filter(c => !c.deletedAt);
    this.destacados = activos.filter(c => c?.destacado?.destacado && coincide(c)).sort(orden);
    this.interesados = activos.filter(c => this.nivel(c) === 'interesado' && coincide(c)).sort(orden);
    this.agrupar();
  }

  setAgrupacion(a: 'ranking' | 'zona' | 'puesto') { this.agrupacion = a; this.agrupar(); }

  private zonaDe(c: any): string { return normalizarCiudad(c.ciudad || c.sucursal) || 'Sin zona'; }
  private puestoDe(c: any): string { return (c.puesto || '').trim() || 'Sin puesto'; }

  /** Arma los grupos (por zona o puesto) a partir de los destacados ya ordenados. */
  private agrupar() {
    if (this.agrupacion === 'ranking') {
      this.grupos = this.destacados.length
        ? [{ titulo: '', total: this.destacados.length, items: this.destacados }]
        : [];
      return;
    }
    const map = new Map<string, any[]>();
    for (const c of this.destacados) {
      const key = this.agrupacion === 'zona' ? this.zonaDe(c) : this.puestoDe(c);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(c); // ya vienen ordenados por puntaje
    }
    this.grupos = Array.from(map.entries())
      .map(([titulo, items]) => ({ titulo, total: items.length, items }))
      // Grupo con el mejor candidato primero; a igualdad, el más numeroso.
      .sort((a, b) => (b.items[0]?.destacado?.puntaje || 0) - (a.items[0]?.destacado?.puntaje || 0) || b.total - a.total);
  }

  pct(v: number, max: number): number { return Math.max(0, Math.min(100, Math.round((v / max) * 100))); }

  abrirExpediente(c: any) { this.router.navigate(['/app/expediente', c.id]); }
  contactar(c: any) { return this.botService.conectarConBot(c, this.enviandoInvitacion); }

  nombreEtapa(id: string): string { return ETAPAS.find(e => e.id === id)?.title || 'Filtro Inicial'; }
  colorEtapa(id: string): string { return ETAPAS.find(e => e.id === id)?.color || '#94a3b8'; }
  getInitials(n: string): string {
    if (!n) return '?';
    return n.trim().split(/\s+/).slice(0, 2).map(p => p.charAt(0).toUpperCase()).join('');
  }
}
