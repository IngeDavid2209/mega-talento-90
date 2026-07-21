import { Component, inject, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { CandidateService } from '../../core/services/candidate';
import { ETAPAS } from '../../core/models/proceso.model';
import { normalizarCiudad } from '../../core/models/normalizacion.model';
import { BotService } from '../../core/services/bot.service';

/**
 * CANDIDATOS EN RIESGO — el espejo de "Destacados".
 * Quienes YA interactuaron (registro a medias, no confirmaron, falta su CV) y se
 * ENFRIARON: llevan días sin escribir. El bot RH calcula esto y lo deja en
 * `candidato.riesgo` = { nivel, diasSilencio, pendiente }. Aquí se LEE y agrupa
 * por zona para que RH los reenganche antes de perderlos.
 */
@Component({
  selector: 'app-enriesgo',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './enriesgo.html',
  styleUrl: './enriesgo.css'
})
export class EnRiesgoComponent implements OnInit, OnDestroy {
  private candidateService = inject(CandidateService);
  private router = inject(Router);
  private ngZone = inject(NgZone);
  private botService = inject(BotService);

  enviandoInvitacion = new Set<string>();
  cargando = true;
  todos: any[] = [];
  enRiesgo: any[] = [];
  grupos: { titulo: string; total: number; items: any[] }[] = [];
  termino = '';

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

  nivel(c: any): string { return c?.riesgo?.nivel || ''; }
  dias(c: any): number { return c?.riesgo?.diasSilencio ?? 0; }
  pendiente(c: any): string { return c?.riesgo?.pendiente || 'Seguimiento pendiente'; }

  private ordenSeveridad(a: any, b: any) {
    const peso: any = { critico: 3, riesgo: 2, tibio: 1 };
    return (peso[this.nivel(b)] || 0) - (peso[this.nivel(a)] || 0) || this.dias(b) - this.dias(a);
  }

  clasificar() {
    const t = this.termino.trim().toLowerCase();
    const coincide = (c: any) => !t
      || (c.nombre || '').toLowerCase().includes(t)
      || (c.puesto || '').toLowerCase().includes(t)
      || (c.ciudad || c.sucursal || '').toLowerCase().includes(t);
    const activos = this.todos.filter(c => !c.deletedAt && c?.riesgo?.nivel);
    this.enRiesgo = activos.filter(coincide).sort((a, b) => this.ordenSeveridad(a, b));
    this.agrupar();
  }

  private zonaDe(c: any): string { return normalizarCiudad(c.ciudad || c.sucursal) || 'Sin zona'; }

  private agrupar() {
    const map = new Map<string, any[]>();
    for (const c of this.enRiesgo) {
      const key = this.zonaDe(c);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(c);
    }
    this.grupos = Array.from(map.entries())
      .map(([titulo, items]) => ({ titulo, total: items.length, items }))
      .sort((a, b) => b.total - a.total);
  }

  etiquetaNivel(n: string): string {
    return n === 'critico' ? 'Crítico' : n === 'riesgo' ? 'En riesgo' : n === 'tibio' ? 'Enfriándose' : n;
  }

  abrirExpediente(c: any) { this.router.navigate(['/app/expediente', c.id]); }
  contactar(c: any) { return this.botService.conectarConBot(c, this.enviandoInvitacion); }
  nombreEtapa(id: string): string { return ETAPAS.find(e => e.id === id)?.title || 'Filtro Inicial'; }
  colorEtapa(id: string): string { return ETAPAS.find(e => e.id === id)?.color || '#94a3b8'; }
  getInitials(n: string): string {
    if (!n) return '?';
    return n.trim().split(/\s+/).slice(0, 2).map(p => p.charAt(0).toUpperCase()).join('');
  }
}
