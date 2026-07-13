import { Component, inject, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { CandidateService } from '../../core/services/candidate';
import {
  ETAPAS, ID_ETAPAS, FLUJO_LINEAL, EtapaConfig,
  COMPETENCIAS_STAR, PSICOMETRIA_ITEMS, CHECKLIST_JEFE,
  CHECKLIST_DOCUMENTAL, CHECKLIST_OFERTA, CHECKLIST_CONTRATADO,
  progresoChecklist
} from '../../core/models/proceso.model';
import { urlWhatsApp } from '../../core/models/puestos.model';
import { normalizarCiudad } from '../../core/models/normalizacion.model';
import { nivelSeguimiento, diasSinSeguimiento, NivelSeguimiento } from '../../core/models/seguimiento.model';
import { CapitalHumanoService } from '../../core/services/capital-humano.service';
import { ToastService } from '../../core/services/toast.service';

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

  ID_ETAPAS = ID_ETAPAS;

  etapaId = '';
  etapa: EtapaConfig | null = null;
  cargando = true;

  private todos: any[] = [];
  candidatos: any[] = [];
  gruposCandidatos: { zona: string; candidatos: any[] }[] = [];
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
      this.etapa = ETAPAS.find(e => e.id === this.etapaId) || null;
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
    const map = new Map<string, any[]>();
    for (const c of this.candidatos) {
      const zona = normalizarCiudad(c.ciudad || c.sucursal);
      if (!map.has(zona)) map.set(zona, []);
      map.get(zona)!.push(c);
    }
    this.gruposCandidatos = Array.from(map.entries())
      .map(([zona, candidatos]) => ({ zona, candidatos }))
      .sort((a, b) => b.candidatos.length - a.candidatos.length);
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
      case ID_ETAPAS.PSICOMETRIA: return progresoChecklist(c.psicometriaChecklist, PSICOMETRIA_ITEMS);
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

  contactarWhatsApp(c: any) {
    const url = urlWhatsApp(c);
    if (!url) {
      this.toast.alerta(
        `El teléfono (${c.telefono || 'vacío'}) no es válido. Corrígelo en el expediente para poder enviar WhatsApp.`,
        `Teléfono de ${c.nombre || 'este candidato'} inválido`
      );
      return;
    }
    window.open(url, '_blank');
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
