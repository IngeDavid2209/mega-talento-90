import { Component, inject, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterOutlet, RouterModule, Router } from '@angular/router';
import { CandidateService } from '../../core/services/candidate';
import { NotificacionesService, EstadoNotif } from '../../core/services/notificaciones.service';
import { UpdateCheckerService } from '../../core/services/update-checker.service';
import { CapitalHumanoService } from '../../core/services/capital-humano.service';
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
  private notificaciones = inject(NotificacionesService);
  private router = inject(Router);
  private ngZone = inject(NgZone);
  // Público para que el template pueda leer el signal hayActualizacion()
  updateChecker = inject(UpdateCheckerService);
  // Público para que el template lea el signal activo() del modo Capital Humano
  capitalHumano = inject(CapitalHumanoService);

  isMenuOpen = false;
  year = new Date().getFullYear();

  ETAPAS = ETAPAS;
  ID_ETAPAS = ID_ETAPAS;

  // Conteo de candidatos por etapa (badge en el menú)
  conteos: Record<string, number> = {};

  // Estado del permiso de notificaciones (bloquea la app si no está concedido)
  estadoNotif: EstadoNotif = 'default';
  activando = false;

  // Detección de candidatos nuevos para notificar
  private idsConocidos = new Set<string>();
  private primeraCarga = true;
  private unsubscribeFn: any;

  async ngOnInit() {
    // Verificar el estado actual del permiso (sin pedirlo aún)
    this.estadoNotif = this.notificaciones.getEstado();

    // Iniciar el chequeo de nuevas versiones desplegadas en Vercel
    this.updateChecker.iniciar();

    this.unsubscribeFn = this.candidateService.listenToCandidates((datos) => {
      this.ngZone.run(() => {
        this.calcularConteos(datos);
        this.detectarNuevos(datos);
      });
    });
  }

  async activarNotificaciones() {
    this.activando = true;
    await this.notificaciones.pedirPermiso();
    this.estadoNotif = this.notificaciones.getEstado();
    this.activando = false;
  }

  recargarPagina() {
    window.location.reload();
  }

  ngOnDestroy() {
    if (this.unsubscribeFn) this.unsubscribeFn();
  }

  /**
   * Primera carga: registrar todos los IDs como "conocidos" sin notificar.
   * Cargas siguientes: cualquier ID que no esté en la lista es un candidato nuevo.
   */
  private detectarNuevos(datos: any[]) {
    if (this.primeraCarga) {
      datos.forEach(c => this.idsConocidos.add(c.id));
      this.primeraCarga = false;
      return;
    }
    for (const c of datos) {
      if (this.idsConocidos.has(c.id)) continue;
      this.idsConocidos.add(c.id);
      this.notificaciones.notificar(
        'Nuevo candidato · Mega Talento',
        `${c.nombre || 'Alguien'} aplicó para ${c.puesto || 'una vacante'}.`,
        () => this.router.navigate(['/app/etapa', ID_ETAPAS.NUEVO])
      );
    }
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
