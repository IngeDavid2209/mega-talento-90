import { Component, inject, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterOutlet, RouterModule } from '@angular/router';
import { CandidateService } from '../../core/services/candidate';
import { ETAPAS, ID_ETAPAS, FLUJO_LINEAL } from '../../core/models/proceso.model';

@Component({
  selector: 'app-layout',
  standalone: true,
  imports: [CommonModule, RouterOutlet, RouterModule],
  templateUrl: './layout.html',
  styleUrl: './layout.css'
})
export class LayoutComponent implements OnInit, OnDestroy {
  private candidateService = inject(CandidateService);
  private ngZone = inject(NgZone);

  isMenuOpen = false;
  year = new Date().getFullYear();

  ETAPAS = ETAPAS;
  ID_ETAPAS = ID_ETAPAS;

  // Conteo de candidatos por etapa (badge en el menú)
  conteos: Record<string, number> = {};
  private unsubscribeFn: any;

  ngOnInit() {
    this.unsubscribeFn = this.candidateService.listenToCandidates((datos) => {
      this.ngZone.run(() => this.calcularConteos(datos));
    });
  }

  ngOnDestroy() {
    if (this.unsubscribeFn) this.unsubscribeFn();
  }

  private calcularConteos(datos: any[]) {
    const legacy: Record<string, string> = {
      'contacto_pendiente': ID_ETAPAS.FILTRO,
      'entrevista': ID_ETAPAS.RH
    };
    const map: Record<string, number> = {};
    datos.forEach(c => {
      let s = c.status;
      if (legacy[s]) s = legacy[s];
      if (!FLUJO_LINEAL.includes(s) && s !== ID_ETAPAS.RECHAZADO) s = ID_ETAPAS.NUEVO;
      map[s] = (map[s] || 0) + 1;
    });
    this.conteos = map;
  }

  toggleMenu() {
    this.isMenuOpen = !this.isMenuOpen;
  }
}
