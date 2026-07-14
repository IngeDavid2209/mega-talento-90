import { Component, inject, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { CandidateService } from '../../core/services/candidate';
import {
  ETAPAS, ETAPA_CONTRATADO, ID_ETAPAS, FLUJO_LINEAL, EtapaConfig,
  COMPETENCIAS_STAR, CHECKLIST_JEFE,
  CHECKLIST_DOCUMENTAL, CHECKLIST_OFERTA, CHECKLIST_CONTRATADO,
  progresoChecklist, progresoPsicoDeCandidato
} from '../../core/models/proceso.model';
import { normalizarCiudad } from '../../core/models/normalizacion.model';
import { nivelSeguimiento, diasSinSeguimiento, NivelSeguimiento } from '../../core/models/seguimiento.model';
import { CapitalHumanoService } from '../../core/services/capital-humano.service';
import { ToastService } from '../../core/services/toast.service';
import { BotService } from '../../core/services/bot.service';

/**
 * Vista-modelo de una tarjeta del tablero. TODOS sus campos se precalculan
 * UNA sola vez (al llegar/cambiar los candidatos), para que la plantilla solo
 * lea propiedades y no ejecute métodos en cada ciclo de detección de cambios.
 * Esto elimina el lag que se sentía al abrir el menú o teclear con el tablero
 * lleno (antes se recalculaban ~10 métodos por tarjeta en cada evento).
 */
interface TarjetaVM {
  c: any;              // referencia al candidato (para navegar/contactar)
  id: string;
  puesto: string;
  alerta: boolean;
  critico: boolean;
  dias: number;
  progreso: { hechos: number; total: number; pct: number } | null;
  contratado: boolean;
  permEtiqueta: string;
  permClase: string;
  cvTipo: 'pdf' | 'foto' | null;
  cvUrl: string;
  fecha: string;
}

@Component({
  selector: 'app-etapa',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './etapa.html',
  styleUrl: './etapa.css'
})
export class EtapaComponent implements OnInit, OnDestroy {
  private candidateService = inject(CandidateService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private ngZone = inject(NgZone);
  // Público para que el template lea el signal y use displayName()
  capitalHumano = inject(CapitalHumanoService);
  private toast = inject(ToastService);
  private botService = inject(BotService);

  /** Ids con una invitación al bot en curso (deshabilita el botón) */
  enviandoInvitacion = new Set<string>();

  ID_ETAPAS = ID_ETAPAS;

  etapaId = '';
  etapa: EtapaConfig | null = null;
  cargando = true;

  private todos: any[] = [];
  candidatos: any[] = [];
  gruposCandidatos: { zona: string; tarjetas: TarjetaVM[] }[] = [];
  zonasColapsadas = new Set<string>();
  busqueda = '';

  private paramSub?: Subscription;
  private unsubscribeFn: any;

  ngOnInit() {
    // Conexión en vivo a los candidatos
    this.unsubscribeFn = this.candidateService.listenToCandidates((datos) => {
      this.ngZone.run(() => {
        this.todos = datos;
        this.normalizar();
        this.aplicarFiltro();
        this.cargando = false;
      });
    });

    // Reaccionar al cambio de etapa en la URL (el componente se reutiliza)
    this.paramSub = this.route.paramMap.subscribe(params => {
      this.etapaId = params.get('etapaId') || ID_ETAPAS.FILTRO;
      this.etapa = ETAPAS.find(e => e.id === this.etapaId)
        || (this.etapaId === ID_ETAPAS.CONTRATADO ? ETAPA_CONTRATADO : null);
      this.busqueda = '';
      this.aplicarFiltro();
    });
  }

  ngOnDestroy() {
    if (this.unsubscribeFn) this.unsubscribeFn();
    this.paramSub?.unsubscribe();
  }

  // Migración silenciosa de estatus viejos al flujo vigente de 4 etapas.
  // (Solo afecta la vista; no reescribe Firestore — los datos se conservan.)
  private normalizar() {
    const legacy: Record<string, string> = {
      'contacto_pendiente': ID_ETAPAS.FILTRO,
      'entrevista': ID_ETAPAS.RH,
      // Etapas retiradas → etapa vigente equivalente
      [ID_ETAPAS.NUEVO]: ID_ETAPAS.FILTRO,
      [ID_ETAPAS.JEFE]: ID_ETAPAS.APTITUDES,
      [ID_ETAPAS.DOCUMENTAL]: ID_ETAPAS.PSICOMETRIA,
      [ID_ETAPAS.OFERTA]: ID_ETAPAS.PSICOMETRIA,
      [ID_ETAPAS.DICTAMEN]: ID_ETAPAS.PSICOMETRIA
    };
    this.todos.forEach(c => {
      if (legacy[c.status]) c.status = legacy[c.status];
      // Contratado/Rechazado se conservan como desenlaces históricos; el resto
      // desconocido cae a la primera etapa.
      if (!FLUJO_LINEAL.includes(c.status) &&
          c.status !== ID_ETAPAS.RECHAZADO &&
          c.status !== ID_ETAPAS.CONTRATADO) {
        c.status = ID_ETAPAS.FILTRO;
      }
    });
  }

  aplicarFiltro() {
    let lista = this.todos.filter(c => c.status === this.etapaId);
    const t = this.busqueda.toLowerCase().trim();
    if (t) {
      lista = lista.filter(c =>
        (c.nombre || '').toLowerCase().includes(t) ||
        (c.puesto || '').toLowerCase().includes(t) ||
        (c.ciudad || '').toLowerCase().includes(t)
      );
    }
    // Más recientes primero
    lista.sort((a, b) => {
      const da = a.createdAt?.toDate?.() || new Date(a.createdAt || 0);
      const db = b.createdAt?.toDate?.() || new Date(b.createdAt || 0);
      return db.getTime() - da.getTime();
    });
    this.candidatos = lista;
    this.agruparPorZona();
  }

  /** Agrupa los candidatos de la etapa por zona (ciudad), de mayor a menor volumen. */
  private agruparPorZona() {
    const map = new Map<string, TarjetaVM[]>();
    for (const c of this.candidatos) {
      const zona = normalizarCiudad(c.ciudad || c.sucursal);
      if (!map.has(zona)) map.set(zona, []);
      map.get(zona)!.push(this.construirTarjeta(c));
    }
    this.gruposCandidatos = Array.from(map.entries())
      .map(([zona, tarjetas]) => ({ zona, tarjetas }))
      .sort((a, b) => b.tarjetas.length - a.tarjetas.length);
  }

  /** Precalcula TODO lo que la tarjeta necesita mostrar (una sola vez). */
  private construirTarjeta(c: any): TarjetaVM {
    const nivel = nivelSeguimiento(c);
    const dias = diasSinSeguimiento(c);
    const contratado = c.status === ID_ETAPAS.CONTRATADO;
    const diasPerm = contratado ? this.getDiasPermanencia(c.hiredAt) : 0;
    return {
      c,
      id: c.id,
      puesto: c.puesto || 'Sin puesto',
      alerta: nivel !== 'ok',
      critico: nivel === 'critico',
      dias: dias < 0 ? 0 : dias,
      progreso: this.getProgresoEtapa(c),
      contratado,
      permEtiqueta: contratado ? this.getEtiquetaPermanencia(diasPerm) : '',
      permClase: contratado ? this.getClasePermanencia(diasPerm) : '',
      cvTipo: this.tipoCV(c),
      cvUrl: c.cvUrl || '',
      fecha: this.formatearFecha(c.createdAt)
    };
  }

  toggleZona(zona: string) {
    if (this.zonasColapsadas.has(zona)) this.zonasColapsadas.delete(zona);
    else this.zonasColapsadas.add(zona);
  }

  abrirExpediente(c: any) {
    this.router.navigate(['/app/expediente', c.id]);
  }

  // Progreso de la etapa actual (mini barra en tarjeta)
  getProgresoEtapa(c: any): { hechos: number; total: number; pct: number } | null {
    switch (c.status) {
      // Filtro Inicial es solo bandeja de entrada: sin checklist, sin barra de progreso.
      case ID_ETAPAS.RH:          return this.progresoStarTexto(c);
      case ID_ETAPAS.PSICOMETRIA: return progresoPsicoDeCandidato(c);
      case ID_ETAPAS.JEFE:        return progresoChecklist(c.jefeChecklist, CHECKLIST_JEFE);
      case ID_ETAPAS.DOCUMENTAL:  return progresoChecklist(c.documentalChecklist, CHECKLIST_DOCUMENTAL);
      case ID_ETAPAS.OFERTA:      return progresoChecklist(c.ofertaChecklist, CHECKLIST_OFERTA);
      case ID_ETAPAS.CONTRATADO:  return progresoChecklist(c.contratadoChecklist, CHECKLIST_CONTRATADO);
      default: return null;
    }
  }

  private progresoStarTexto(c: any) {
    const obligatorias = COMPETENCIAS_STAR.filter(x => x.obligatorio);
    const notas = c.starNotas || {};
    const hechos = obligatorias.filter(x => (notas[x.key] || '').trim().length > 0).length;
    const total = obligatorias.length;
    return { hechos, total, pct: total === 0 ? 100 : Math.round((hechos / total) * 100) };
  }

  // Permanencia (etapa Contratado)
  getDiasPermanencia(hiredAt: any): number {
    if (!hiredAt) return 0;
    const f = typeof hiredAt.toDate === 'function' ? hiredAt.toDate() : new Date(hiredAt);
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0); f.setHours(0, 0, 0, 0);
    return Math.max(0, Math.floor((hoy.getTime() - f.getTime()) / 86400000));
  }
  getEtiquetaPermanencia(d: number): string {
    if (d === 0)  return 'Día 1 (Crítico)';
    if (d < 7)   return `${d} días (Riesgo)`;
    if (d < 15)  return `${d} días (Estable)`;
    if (d < 30)  return `${d} días (Avanzado)`;
    return `Consolidado (+${d} días)`;
  }
  getClasePermanencia(d: number): string {
    if (d < 7)  return 'badge-critico';
    if (d < 15) return 'badge-estable';
    if (d < 30) return 'badge-avanzado';
    return 'badge-consolidado';
  }

  // === SEGUIMIENTO: días sin que RH toque el expediente (ver seguimiento.model.ts) ===
  isCandidatoAlerta(c: any): boolean {
    return nivelSeguimiento(c) !== 'ok';
  }
  nivelSeguimiento(c: any): NivelSeguimiento {
    return nivelSeguimiento(c);
  }
  diasSinSeguimiento(c: any): number {
    return diasSinSeguimiento(c);
  }

  /** Conecta al candidato con el bot (le escribe por WhatsApp desde el número oficial). */
  contactarWhatsApp(c: any) {
    return this.botService.conectarConBot(c, this.enviandoInvitacion);
  }

  /** Detecta si el candidato envió CV y de qué tipo (pdf / foto) */
  tipoCV(c: any): 'pdf' | 'foto' | null {
    const url = (c?.cvUrl || '').toLowerCase();
    if (!url) return null;
    if (url.includes('.pdf')) return 'pdf';
    if (url.includes('.jpg') || url.includes('.jpeg') || url.includes('.png') || url.includes('.webp')) return 'foto';
    return 'pdf'; // por defecto, asumimos documento
  }

  formatearFecha(timestamp: any): string {
    if (!timestamp) return 'S/F';
    const d = typeof timestamp.toDate === 'function' ? timestamp.toDate() : new Date(timestamp);
    return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
  }
}
