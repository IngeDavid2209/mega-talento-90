import { Component, inject, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterOutlet, RouterModule, Router } from '@angular/router';
import { BusquedaGlobalComponent } from '../ui/busqueda-global/busqueda-global';
import { CandidateService } from '../../core/services/candidate';
import { NotificacionesService, EstadoNotif } from '../../core/services/notificaciones.service';
import { UpdateCheckerService } from '../../core/services/update-checker.service';
import { CapitalHumanoService } from '../../core/services/capital-humano.service';
import { ETAPAS, ETAPA_CONTRATADO, ID_ETAPAS, FLUJO_LINEAL } from '../../core/models/proceso.model';
import { debeCerrarseSeguimiento } from '../../core/models/seguimiento.model';
import { ToastService } from '../../core/services/toast.service';
import { AuthSession } from '../../core/services/auth-session';

@Component({
  selector: 'app-layout',
  standalone: true,
  imports: [CommonModule, RouterOutlet, RouterModule, BusquedaGlobalComponent],
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
  private toast = inject(ToastService);
  private auth = inject(AuthSession);

  /**
   * ¿Se le muestra Promotoría a este usuario?
   *
   * Es el primer renglón del menú que se reparte a mano. La decisión no se
   * toma aquí: `AuthSession` tiene el mapa de qué puede cada rol, para que un
   * permiso no acabe escrito de tres formas distintas en tres pantallas.
   */
  get puedePromotoria(): boolean { return this.auth.puede('promotoria'); }

  /** El cierre automático de seguimiento corre una sola vez por sesión. */
  private cierreEjecutado = false;

  isMenuOpen = false;
  year = new Date().getFullYear();

  ETAPAS = ETAPAS;
  ETAPA_CONTRATADO = ETAPA_CONTRATADO;
  ID_ETAPAS = ID_ETAPAS;

  // Conteo de candidatos por etapa (badge en el menú)
  conteos: Record<string, number> = {};

  // Estado del permiso de notificaciones (bloquea la app si no está concedido)
  estadoNotif: EstadoNotif = 'default';
  activando = false;
  // Si el usuario eligió saltar el modal, lo guardamos en localStorage
  notifSaltado = false;
  private readonly STORAGE_KEY_SALTAR_NOTIF = 'mt_notif_saltado_v1';

  // Detección de candidatos nuevos para notificar
  private idsConocidos = new Set<string>();
  private primeraCarga = true;
  private unsubscribeFn: any;

  async ngOnInit() {
    // Verificar el estado actual del permiso (sin pedirlo aún)
    this.estadoNotif = this.notificaciones.getEstado();

    // Si el usuario ya eligió saltar el modal antes, respetar esa decisión
    try {
      this.notifSaltado = localStorage.getItem(this.STORAGE_KEY_SALTAR_NOTIF) === 'true';
    } catch { this.notifSaltado = false; }

    // Iniciar el chequeo de nuevas versiones desplegadas en Vercel
    this.updateChecker.iniciar();

    this.unsubscribeFn = this.candidateService.listenToCandidates((datos) => {
      this.ngZone.run(() => {
        this.calcularConteos(datos);
        this.detectarNuevos(datos);
        this.ejecutarCierreAutomatico(datos);
      });
    });
  }

  /**
   * Cierre de seguimiento AUTOMÁTICO: al abrir la app, manda a la Papelera a los
   * candidatos activos con 10+ días sin seguimiento. Corre una sola vez por
   * sesión y es recuperable (van a la Papelera, no se borran de verdad).
   */
  private async ejecutarCierreAutomatico(datos: any[]) {
    if (this.cierreEjecutado) return;
    this.cierreEjecutado = true;

    const ahora = new Date();
    const paraCerrar = datos.filter(c => debeCerrarseSeguimiento(c, ahora));
    if (!paraCerrar.length) return;

    let cerrados = 0;
    for (const c of paraCerrar) {
      try { await this.candidateService.cerrarSeguimiento(c.id); cerrados++; } catch { /* se reintenta al recargar */ }
    }
    if (cerrados > 0) {
      this.toast.info(
        `${cerrados} candidato${cerrados === 1 ? '' : 's'} sin seguimiento (10+ días) se ${cerrados === 1 ? 'movió' : 'movieron'} a la Papelera.`,
        'Cierre de seguimiento'
      );
    }
  }

  async activarNotificaciones() {
    this.activando = true;
    await this.notificaciones.pedirPermiso();
    this.estadoNotif = this.notificaciones.getEstado();
    this.activando = false;
    // Si las acaba de activar, limpiar el flag de "saltar"
    if (this.estadoNotif === 'granted') {
      try { localStorage.removeItem(this.STORAGE_KEY_SALTAR_NOTIF); } catch {}
      this.notifSaltado = false;
    }
  }

  /** Permite usar la app sin activar notificaciones. Persiste la decisión. */
  saltarNotificaciones() {
    this.notifSaltado = true;
    try { localStorage.setItem(this.STORAGE_KEY_SALTAR_NOTIF, 'true'); } catch {}
  }

  /** Reabre el flujo de notificaciones desde el banner discreto */
  reabrirNotificaciones() {
    this.notifSaltado = false;
    try { localStorage.removeItem(this.STORAGE_KEY_SALTAR_NOTIF); } catch {}
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
        () => this.router.navigate(['/app/etapa', ID_ETAPAS.FILTRO])
      );
    }
  }

  private calcularConteos(datos: any[]) {
    const legacy: Record<string, string> = {
      'contacto_pendiente': ID_ETAPAS.FILTRO,
      'entrevista': ID_ETAPAS.RH,
      // Etapas retiradas → etapa vigente equivalente (conteo del menú lateral)
      [ID_ETAPAS.NUEVO]: ID_ETAPAS.FILTRO,
      [ID_ETAPAS.JEFE]: ID_ETAPAS.APTITUDES,
      [ID_ETAPAS.DOCUMENTAL]: ID_ETAPAS.PSICOMETRIA,
      [ID_ETAPAS.OFERTA]: ID_ETAPAS.PSICOMETRIA,
      [ID_ETAPAS.DICTAMEN]: ID_ETAPAS.PSICOMETRIA
    };
    const map: Record<string, number> = {};
    datos.forEach(c => {
      let s = c.status;
      if (legacy[s]) s = legacy[s];
      if (!FLUJO_LINEAL.includes(s) && s !== ID_ETAPAS.RECHAZADO && s !== ID_ETAPAS.CONTRATADO) s = ID_ETAPAS.FILTRO;
      map[s] = (map[s] || 0) + 1;
    });
    this.conteos = map;
  }

  toggleMenu() {
    this.isMenuOpen = !this.isMenuOpen;
  }

  /** Abre el portal público en una nueva pestaña */
  abrirPortal() {
    this.isMenuOpen = false;
    window.open('/portal', '_blank', 'noopener');
  }
}
