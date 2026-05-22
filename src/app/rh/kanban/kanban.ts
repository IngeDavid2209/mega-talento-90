import { Component, inject, OnInit, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CandidateService } from '../../core/services/candidate';
import { Timestamp } from '@angular/fire/firestore';
import { Router } from '@angular/router';
import {
  ETAPAS, ID_ETAPAS, FLUJO_LINEAL, EstadoCheck,
  CHECKLIST_FILTRO, CHECKLIST_OFERTA, CHECKLIST_CONTRATADO,
  CHECKLIST_DOCUMENTAL, COMPETENCIAS_STAR, PSICOMETRIA_ITEMS, CHECKLIST_JEFE,
  checklistCompleto, itemsFaltantes, progresoChecklist
} from '../../core/models/proceso.model';

interface KanbanColumn {
  id: string;
  title: string;
  icon: string;
  color: string;
  count: number;
  candidates: any[];
}

@Component({
  selector: 'app-kanban',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './kanban.html',
  styleUrl: './kanban.css'
})
export class KanbanComponent implements OnInit {
  private candidateService = inject(CandidateService);
  private ngZone = inject(NgZone);
  private router = inject(Router);

  // Exponer al template
  ETAPAS = ETAPAS;
  ID_ETAPAS = ID_ETAPAS;
  FLUJO_LINEAL = FLUJO_LINEAL;
  CHECKLIST_OFERTA = CHECKLIST_OFERTA;
  CHECKLIST_FILTRO = CHECKLIST_FILTRO;

  cargando = true;
  candidatos: any[] = [];
  columnas: KanbanColumn[] = [];

  // KPIs
  kpiTotalCandidatos = 0;
  kpiTasaConversion = 0;
  kpiTiempoPromedio = 0;
  kpiMetaContrataciones = 20;
  kpiContratadosMes = 0;
  kpiActivos = 0;

  // Filtros
  filtroPuesto = '';
  filtroCiudad = '';
  filtroFecha = '';
  filtroFuente = '';

  // Mensajes de bloqueo
  mensajeBloqueo: { titulo: string; faltantes: string[] } | null = null;

  async ngOnInit() {
    await this.cargarTodo();
  }

  async cargarTodo() {
    this.cargando = true;
    try {
      this.candidateService.listenToCandidates((datosFrescos) => {
        this.ngZone.run(() => {
          this.candidatos = datosFrescos;
          this.normalizarCandidatos();
          this.calcularMetricas();
          this.filtrarYArmarTablero();
          this.cargando = false;
        });
      });
    } catch (error) {
      console.error('Error conectando el tablero en vivo:', error);
      this.cargando = false;
    }
  }

  // Migración silenciosa: status viejos -> nuevos
  normalizarCandidatos() {
    const mapeoLegacy: Record<string, string> = {
      'contacto_pendiente': ID_ETAPAS.FILTRO,
      'entrevista': ID_ETAPAS.RH
    };
    this.candidatos.forEach(c => {
      if (mapeoLegacy[c.status]) c.status = mapeoLegacy[c.status];
      if (!FLUJO_LINEAL.includes(c.status) && c.status !== ID_ETAPAS.RECHAZADO) {
        c.status = ID_ETAPAS.NUEVO;
      }
    });
  }

  calcularMetricas() {
    try {
      this.kpiTotalCandidatos = this.candidatos.length;
      const contratados = this.candidatos.filter(c => c.status === ID_ETAPAS.CONTRATADO);
      this.kpiTasaConversion = this.kpiTotalCandidatos > 0
        ? (contratados.length / this.kpiTotalCandidatos) * 100 : 0;

      // Contratados del mes en curso
      const ahora = new Date();
      this.kpiContratadosMes = contratados.filter(c => {
        if (!c.hiredAt) return false;
        const f = typeof c.hiredAt.toDate === 'function' ? c.hiredAt.toDate() : new Date(c.hiredAt);
        return f.getMonth() === ahora.getMonth() && f.getFullYear() === ahora.getFullYear();
      }).length;

      this.kpiActivos = this.candidatos.filter(c =>
        c.status !== ID_ETAPAS.RECHAZADO && c.status !== ID_ETAPAS.CONTRATADO
      ).length;

      let diasTotales = 0, validos = 0;
      this.candidatos.forEach(c => {
        try {
          if (c.createdAt) {
            const inicio = typeof c.createdAt.toDate === 'function' ? c.createdAt.toDate() : new Date(c.createdAt);
            let fin = new Date();
            if (c.status === ID_ETAPAS.CONTRATADO && c.hiredAt) {
              fin = typeof c.hiredAt.toDate === 'function' ? c.hiredAt.toDate() : new Date(c.hiredAt);
            }
            const diff = Math.abs(fin.getTime() - inicio.getTime());
            diasTotales += Math.ceil(diff / (1000 * 60 * 60 * 24));
            validos++;
          }
        } catch {}
      });
      this.kpiTiempoPromedio = validos > 0 ? Math.round(diasTotales / validos) : 0;
    } catch (error) {
      console.error('Error en KPIs:', error);
    }
  }

  abrirExpediente(candidato: any) {
    this.router.navigate(['/app/expediente', candidato.id]);
  }

  getStepIndex(statusId: string): number {
    return FLUJO_LINEAL.indexOf(statusId);
  }

  // ====================================================================
  // REGLA CRÍTICA: bloquear avance a CONTRATADO si Oferta no está 100%
  // ====================================================================
  puedeMoverA(candidato: any, nuevaEtapa: string): { ok: boolean; faltan: string[] } {
    if (nuevaEtapa !== ID_ETAPAS.CONTRATADO) return { ok: true, faltan: [] };

    const ofertaOk = checklistCompleto(candidato.ofertaChecklist, CHECKLIST_OFERTA);
    if (ofertaOk) return { ok: true, faltan: [] };

    const faltan = itemsFaltantes(candidato.ofertaChecklist, CHECKLIST_OFERTA).map(i => i.label);
    return { ok: false, faltan };
  }

  async moverEtapaDirecto(candidato: any, nuevaColumnaId: string) {
    if (!candidato || candidato.status === nuevaColumnaId) return;

    const validacion = this.puedeMoverA(candidato, nuevaColumnaId);
    if (!validacion.ok) {
      this.mensajeBloqueo = {
        titulo: `No se puede contratar a ${candidato.nombre}`,
        faltantes: validacion.faltan
      };
      return;
    }

    const estatusAnterior = candidato.status;
    candidato.status = nuevaColumnaId;

    const actualizacion: any = { status: nuevaColumnaId };

    // Inicializar checklists si no existen al entrar a la etapa
    if (nuevaColumnaId === ID_ETAPAS.FILTRO && !candidato.filtroChecklist) {
      actualizacion.filtroChecklist = this.checklistVacio(CHECKLIST_FILTRO);
      candidato.filtroChecklist = actualizacion.filtroChecklist;
    }
    if (nuevaColumnaId === ID_ETAPAS.RH && !candidato.starChecklist) {
      actualizacion.starChecklist = this.checklistVacio(COMPETENCIAS_STAR);
      candidato.starChecklist = actualizacion.starChecklist;
    }
    if (nuevaColumnaId === ID_ETAPAS.PSICOMETRIA && !candidato.psicometriaChecklist) {
      actualizacion.psicometriaChecklist = this.checklistVacio(PSICOMETRIA_ITEMS);
      candidato.psicometriaChecklist = actualizacion.psicometriaChecklist;
    }
    if (nuevaColumnaId === ID_ETAPAS.JEFE && !candidato.jefeChecklist) {
      actualizacion.jefeChecklist = this.checklistVacio(CHECKLIST_JEFE);
      candidato.jefeChecklist = actualizacion.jefeChecklist;
    }
    if (nuevaColumnaId === ID_ETAPAS.DOCUMENTAL && !candidato.documentalChecklist) {
      actualizacion.documentalChecklist = this.checklistVacio(CHECKLIST_DOCUMENTAL);
      candidato.documentalChecklist = actualizacion.documentalChecklist;
    }
    if (nuevaColumnaId === ID_ETAPAS.OFERTA && !candidato.ofertaChecklist) {
      actualizacion.ofertaChecklist = this.checklistVacio(CHECKLIST_OFERTA);
      candidato.ofertaChecklist = actualizacion.ofertaChecklist;
    }
    if (nuevaColumnaId === ID_ETAPAS.CONTRATADO) {
      actualizacion.hiredAt = Timestamp.now();
      if (!candidato.contratadoChecklist) {
        actualizacion.contratadoChecklist = this.checklistVacio(CHECKLIST_CONTRATADO);
        candidato.contratadoChecklist = actualizacion.contratadoChecklist;
      }
    }
    if (nuevaColumnaId === ID_ETAPAS.RECHAZADO) {
      actualizacion.rejectedAt = Timestamp.now();
    }

    try {
      this.filtrarYArmarTablero();
      await this.candidateService.updateCandidate(candidato.id, actualizacion);
      this.calcularMetricas();
    } catch (error) {
      console.error('Error al mover etapa:', error);
      candidato.status = estatusAnterior;
      this.filtrarYArmarTablero();
    }
  }

  private checklistVacio(items: { key: string }[]): Record<string, EstadoCheck> {
    return items.reduce((acc, i) => ({ ...acc, [i.key]: 'gris' as EstadoCheck }), {});
  }

  cerrarBloqueo() { this.mensajeBloqueo = null; }

  // ====================================================================
  // PROGRESO VISUAL EN TARJETA (mini barra)
  // ====================================================================
  getProgresoEtapa(candidato: any): { hechos: number; total: number; pct: number } | null {
    switch (candidato.status) {
      case ID_ETAPAS.FILTRO:      return progresoChecklist(candidato.filtroChecklist, CHECKLIST_FILTRO);
      case ID_ETAPAS.RH:          return progresoChecklist(candidato.starChecklist, COMPETENCIAS_STAR);
      case ID_ETAPAS.PSICOMETRIA: return progresoChecklist(candidato.psicometriaChecklist, PSICOMETRIA_ITEMS);
      case ID_ETAPAS.JEFE:        return progresoChecklist(candidato.jefeChecklist, CHECKLIST_JEFE);
      case ID_ETAPAS.DOCUMENTAL:  return progresoChecklist(candidato.documentalChecklist, CHECKLIST_DOCUMENTAL);
      case ID_ETAPAS.OFERTA:      return progresoChecklist(candidato.ofertaChecklist, CHECKLIST_OFERTA);
      case ID_ETAPAS.CONTRATADO:  return progresoChecklist(candidato.contratadoChecklist, CHECKLIST_CONTRATADO);
      default: return null;
    }
  }

  // ====================================================================
  // PERMANENCIA (etapa Contratado)
  // ====================================================================
  getDiasPermanencia(hiredAt: any): number {
    if (!hiredAt) return 0;
    const f = typeof hiredAt.toDate === 'function' ? hiredAt.toDate() : new Date(hiredAt);
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    f.setHours(0, 0, 0, 0);
    return Math.max(0, Math.floor((hoy.getTime() - f.getTime()) / 86400000));
  }
  getEtiquetaPermanencia(d: number): string {
    if (d === 0)   return '⏳ Día 1 (Crítico)';
    if (d < 7)    return `⏳ ${d} días (Riesgo)`;
    if (d < 15)   return `⏳ ${d} días (Estable)`;
    if (d < 30)   return `⏳ ${d} días (Avanzado)`;
    return `✅ Consolidado (+${d} días)`;
  }
  getClasePermanencia(d: number): string {
    if (d < 7)  return 'badge-critico';
    if (d < 15) return 'badge-estable';
    if (d < 30) return 'badge-avanzado';
    return 'badge-consolidado';
  }

  filtrarYArmarTablero() {
    let filtrados = [...this.candidatos];
    if (this.filtroPuesto) filtrados = filtrados.filter(c => (c.puesto || '').toLowerCase().includes(this.filtroPuesto.toLowerCase()));
    if (this.filtroCiudad) filtrados = filtrados.filter(c => (c.ciudad || c.sucursal || '').toLowerCase().includes(this.filtroCiudad.toLowerCase()));
    if (this.filtroFuente) filtrados = filtrados.filter(c => (c.fuente || '').toLowerCase().includes(this.filtroFuente.toLowerCase()));
    if (this.filtroFecha) {
      filtrados = filtrados.filter(c => {
        if (!c.createdAt) return false;
        const d = typeof c.createdAt.toDate === 'function' ? c.createdAt.toDate() : new Date(c.createdAt);
        return d.toISOString().split('T')[0] === this.filtroFecha;
      });
    }
    this.armarTablero(filtrados);
  }

  armarTablero(candidatos: any[]) {
    this.columnas = ETAPAS.map(e => ({
      id: e.id,
      title: e.title,
      icon: e.icon,
      color: e.color,
      count: candidatos.filter(c => c.status === e.id).length,
      candidates: candidatos.filter(c => c.status === e.id)
    }));
  }

  // Drag & Drop
  candidatoArrastradoId: string | null = null;
  onDragStart(event: DragEvent, id: string) {
    this.candidatoArrastradoId = id;
    (event.target as HTMLElement).classList.add('is-dragging');
  }
  onDragEnd(event: DragEvent) {
    (event.target as HTMLElement).classList.remove('is-dragging');
  }
  onDragOver(event: DragEvent, _: string) { event.preventDefault(); }
  async onDrop(event: DragEvent, columnaDestinoId: string) {
    event.preventDefault();
    if (!this.candidatoArrastradoId) return;
    const id = this.candidatoArrastradoId;
    this.candidatoArrastradoId = null;
    const candidato = this.candidatos.find(c => c.id === id);
    if (candidato) await this.moverEtapaDirecto(candidato, columnaDestinoId);
  }

  // ====================================================================
  // WHATSAPP — Plantilla estandarizada de PRIMER CONTACTO
  // (Tomada literal del prompt del director)
  // ====================================================================
  contactarWhatsApp(candidato: any) {
    const numero = (candidato.telefono || '').replace(/\D/g, '');
    const plantilla =
`Hola, buen día. Mi nombre es Lupita, de Recursos Humanos de Mega Dulces de Los Altos.

Recibimos tu solicitud para la vacante de ${candidato.puesto || '[PUESTO]'}. Antes de agendar entrevista, necesito confirmar algunos datos:

1. ¿Sigues interesado/a en la vacante?
2. ¿En qué colonia o ciudad vives?
3. ¿Tienes disponibilidad para laborar en el horario?
4. ¿Tienes experiencia en el área?
5. ¿Cuál fue tu último empleo y motivo de salida?
6. ¿Cuál es tu expectativa salarial?

Quedo atenta para revisar si tu perfil coincide con la vacante.`;

    window.open(`https://wa.me/52${numero}?text=${encodeURIComponent(plantilla)}`, '_blank');

    // Auto-mover a Filtro Inicial si está en Nuevo
    if (candidato.status === ID_ETAPAS.NUEVO) {
      this.moverEtapaDirecto(candidato, ID_ETAPAS.FILTRO);
    }
  }

  getAvatarColor(nombre: string): string {
    if (!nombre) return '#64748b';
    const colores = ['#f87171', '#fb923c', '#fbbf24', '#34d399', '#22d3ee', '#818cf8', '#c084fc', '#f472b6'];
    return colores[nombre.charCodeAt(0) % colores.length];
  }

  formatearFecha(timestamp: any): string {
    if (!timestamp) return 'S/F';
    const d = typeof timestamp.toDate === 'function' ? timestamp.toDate() : new Date(timestamp);
    return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
  }

  // Alerta de SLA vencido (24-72h sin respuesta)
  isCandidatoAlerta(candidato: any): boolean {
    if (candidato.status === ID_ETAPAS.CONTRATADO || candidato.status === ID_ETAPAS.RECHAZADO) return false;
    if (!candidato.createdAt) return false;
    const d = typeof candidato.createdAt.toDate === 'function' ? candidato.createdAt.toDate() : new Date(candidato.createdAt);
    const horas = Math.abs(new Date().getTime() - d.getTime()) / 36e5;
    const etapa = ETAPAS.find(e => e.id === candidato.status);
    return etapa?.slaHoras ? horas > etapa.slaHoras : horas > 72;
  }

  getInitials(nombre: string): string {
    if (!nombre) return '?';
    return nombre.trim().split(/\s+/).slice(0, 2).map(p => p.charAt(0).toUpperCase()).join('');
  }
}
