import { Component, inject, Input, OnInit, OnChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { KpiService, EventoCandidato, TipoEvento, CanalEvento } from '../../core/services/kpi.service';
import {
  ETAPAS, ETAPA_CONTRATADO, FLUJO_LINEAL, ID_ETAPAS,
  CHECKLIST_JEFE, PSICOMETRIA_ITEMS,
  progresoChecklist, puntajePsico
} from '../../core/models/proceso.model';
import { calcularResultadoLiderazgo } from '../../core/models/cuestionario-liderazgo.model';

/**
 * =====================================================================
 * TARJETA DE ESTATUS DEL CANDIDATO — "qué se le ha hecho a esta persona"
 * =====================================================================
 *
 * Lo que pidió Capital Humano: una tarjeta por candidato, con casillas, tipo
 * reporte de estatus, independiente para cada uno, más una barra del avance de
 * su proceso.
 *
 * Tres decisiones de fondo:
 *
 * 1. NO INVENTA UNA FUENTE NUEVA. Cada casilla se deriva de lo que YA existe en
 *    el expediente (CV, dictamen del bot, cuestionario conductual, rúbrica STAR,
 *    checklist del jefe, psicométricas, documentos) más la bitácora de eventos.
 *    Si mañana alguien califica una etapa, la casilla se prende sola.
 *
 * 2. TRES ESTADOS, NO DOS. Además de hecho/pendiente existe "parcial": un
 *    cuestionario contestado a medias no es lo mismo que uno sin empezar, y
 *    pintarlo igual esconde precisamente el trabajo que falta.
 *
 * 3. LO QUE NO SE PUEDE SABER, SE DICE. Si el dato no existe, la casilla queda
 *    en pendiente con su leyenda; nunca se marca en verde por defecto.
 */

type EstadoCasilla = 'hecho' | 'parcial' | 'pendiente';

interface Casilla {
  key: string;
  label: string;
  icono: string;
  estado: EstadoCasilla;
  detalle: string;
}

@Component({
  selector: 'app-status-proceso',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './status-proceso.html',
  styleUrl: './status-proceso.css'
})
export class StatusProcesoComponent implements OnInit, OnChanges {
  /** El candidato tal como lo entrega el API (portal_data ya desplegado). */
  @Input() candidato: any = null;

  private kpi = inject(KpiService);

  bitacora: EventoCandidato[] = [];
  cargandoBitacora = false;
  registrando = '';
  error = '';

  // Formulario de captura rápida.
  nota = '';
  canal: CanalEvento = 'llamada';

  /**
   * Id del candidato cuya bitácora está cargada. La condición anterior era
   * "recarga solo si la bitácora está vacía", y eso significaba que al pasar de
   * un candidato con eventos a otro se quedaba pintada la bitácora del primero:
   * las llamadas de una persona atribuidas a otra. Comparar el id es lo único
   * que distingue "ya la tengo" de "es de alguien más".
   */
  private idCargado = '';

  ngOnInit() { this.cargarBitacora(); }
  ngOnChanges() {
    if (this.candidato?.id && this.candidato.id !== this.idCargado) this.cargarBitacora();
  }

  async cargarBitacora() {
    const id = this.candidato?.id;
    if (!id) return;
    this.cargandoBitacora = true;
    this.idCargado = id;
    try {
      const eventos = await this.kpi.eventos(id);
      // Pudo cambiar de candidato mientras la petición viajaba: si ya no es el
      // que se pidió, se descarta la respuesta en vez de pintar datos ajenos.
      if (this.candidato?.id !== id) return;
      this.bitacora = eventos;
    } catch {
      if (this.candidato?.id === id) this.bitacora = [];
    } finally {
      this.cargandoBitacora = false;
    }
  }

  // ── LA BARRA: en qué punto del proceso va ─────────────────────────

  get etapas() { return ETAPAS; }

  private get etapaActual(): string {
    return this.candidato?.status || ID_ETAPAS.FILTRO;
  }

  get contratado(): boolean { return this.etapaActual === ID_ETAPAS.CONTRATADO; }
  get rechazado(): boolean { return this.etapaActual === ID_ETAPAS.RECHAZADO; }

  /** Índice de la etapa actual dentro del flujo lineal (-1 si está fuera). */
  private get indiceActual(): number {
    return FLUJO_LINEAL.indexOf(this.etapaActual);
  }

  /** 'pasada' | 'actual' | 'futura' — lo que pinta cada tramo de la barra. */
  estadoEtapa(id: string): 'pasada' | 'actual' | 'futura' {
    if (this.contratado) return 'pasada';
    const i = FLUJO_LINEAL.indexOf(id);
    const actual = this.indiceActual;
    if (actual < 0) return i === 0 ? 'actual' : 'futura'; // etapa desconocida: al inicio
    if (i < actual) return 'pasada';
    if (i === actual) return 'actual';
    return 'futura';
  }

  /** % de avance del proceso (la barra que pidió RH). */
  get avance(): number {
    if (this.contratado) return 100;
    const i = this.indiceActual;
    if (i < 0) return 5;
    // Cada etapa vale un tramo; dentro de la etapa actual se suma su progreso.
    const tramo = 100 / FLUJO_LINEAL.length;
    const dentro = this.progresoEtapaActual / 100;
    return Math.min(100, Math.round(i * tramo + dentro * tramo));
  }

  /** Progreso 0-100 DENTRO de la etapa en la que está parado. */
  private get progresoEtapaActual(): number {
    const c = this.candidato || {};
    switch (this.etapaActual) {
      case ID_ETAPAS.RH:          return calcularResultadoLiderazgo(c.cuestionarioLiderazgo).porcentaje || 0;
      case ID_ETAPAS.APTITUDES:   return progresoChecklist(c.jefeChecklist, CHECKLIST_JEFE).pct;
      case ID_ETAPAS.PSICOMETRIA: return puntajePsico(c.psicoTests).evaluada ? 100
                                    : progresoChecklist(c.psicometriaChecklist, PSICOMETRIA_ITEMS).pct;
      default:                    return this.tieneCv ? 100 : 20;
    }
  }

  nombreEtapa(id: string): string {
    if (id === ID_ETAPAS.CONTRATADO) return ETAPA_CONTRATADO.title;
    if (id === ID_ETAPAS.RECHAZADO) return 'Rechazado';
    return ETAPAS.find(e => e.id === id)?.shortLabel || id;
  }

  colorEtapa(id: string): string {
    if (id === ID_ETAPAS.CONTRATADO) return ETAPA_CONTRATADO.color;
    return ETAPAS.find(e => e.id === id)?.color || '#94a3b8';
  }

  // ── LAS CASILLAS: qué se le ha hecho ──────────────────────────────

  private get tieneCv(): boolean {
    const c = this.candidato || {};
    if (c.cvUrl) return true;
    return (c.documentosBot || []).some((d: any) => d?.tipo === 'cv');
  }

  private cuenta(tipo: TipoEvento): number {
    return this.bitacora.filter(e => e.tipo === tipo).length;
  }

  /** El reporte de estatus completo. Se recalcula solo al cambiar los datos. */
  get casillas(): Casilla[] {
    const c = this.candidato || {};
    const out: Casilla[] = [];
    const add = (key: string, label: string, icono: string, estado: EstadoCasilla, detalle: string) =>
      out.push({ key, label, icono, estado, detalle });

    // 1. CV
    add('cv', 'Currículum recibido', '📄',
      this.tieneCv ? 'hecho' : 'pendiente',
      this.tieneCv ? (c.cvUrl ? 'En el expediente' : 'Llegó por WhatsApp')
                   : (c.estadoBot === 'esperando_cv' ? 'Se le pidió y no lo ha mandado' : 'No lo ha entregado'));

    // 2. Dictamen automático del bot
    const d = c.dictamen;
    add('dictamen', 'Análisis del CV (bot)', '🤖',
      d?.recomendacion ? 'hecho' : 'pendiente',
      d?.recomendacion
        ? `${d.recomendacion} · ${d.puntaje}/100${d.via === 'reglas' ? ' (sin IA: revisar a mano)' : ''}`
        : 'Se genera solo cuando llega el CV');

    // 3. Entrevista de orientación conductual
    //    Completa = TODAS las preguntas contestadas. Antes se comparaba contra
    //    COMPETENCIAS_STAR.length (8) y `porcentaje`, que es el PUNTAJE y no el
    //    avance: un cuestionario de 12 preguntas se marcaba "hecho" con 8
    //    contestadas. Una casilla verde con un tercio del trabajo sin hacer es
    //    peor que no tener la casilla.
    const lid = calcularResultadoLiderazgo(c.cuestionarioLiderazgo);
    const lidCompleto = lid.total > 0 && lid.contestadas === lid.total;
    add('conductual', 'Entrevista conductual', '💬',
      lid.contestadas === 0 ? 'pendiente' : lidCompleto ? 'hecho' : 'parcial',
      lid.contestadas ? `${lid.contestadas}/${lid.total} respuestas · ${lid.porcentaje}%` : 'Sin contestar');

    // 4. Aptitudes (la califica el jefe por link)
    const apt = c.aptitudesEval;
    const rub = c.rubricaAptitudes ? Object.keys(c.rubricaAptitudes).length : 0;
    add('aptitudes', 'Aptitudes / STAR del jefe', '🎯',
      apt?.completadaEn ? 'hecho' : rub ? 'parcial' : 'pendiente',
      apt?.completadaEn ? `${apt.puntaje ?? '—'} · ${apt.banda || apt.resultado || 'evaluado'}`
        : rub ? `${rub} competencias calificadas` : 'Falta generar el link al jefe');

    // 5. Entrevista técnica
    const jefe = progresoChecklist(c.jefeChecklist, CHECKLIST_JEFE);
    add('tecnica', 'Entrevista técnica', '🔧',
      jefe.hechos === 0 ? 'pendiente' : jefe.pct >= 100 ? 'hecho' : 'parcial',
      `${jefe.hechos}/${jefe.total} puntos revisados`);

    // 6. Psicométricas
    const ps = puntajePsico(c.psicoTests);
    const psCheck = progresoChecklist(c.psicometriaChecklist, PSICOMETRIA_ITEMS);
    add('psicometria', 'Psicométricas', '🧠',
      ps.evaluada ? 'hecho' : psCheck.hechos ? 'parcial' : 'pendiente',
      ps.evaluada ? `Puntaje ${ps.puntaje}` : psCheck.hechos ? `${psCheck.hechos}/${psCheck.total} capturados` : 'Sin aplicar');

    // 7. Documentos del expediente
    const docs = (c.documentosBot || []).length + (c.expedienteDocs ? Object.keys(c.expedienteDocs).length : 0);
    add('documentos', 'Documentos del expediente', '🗂️',
      docs >= 5 ? 'hecho' : docs ? 'parcial' : 'pendiente',
      docs ? `${docs} archivo(s) recibidos` : 'Ninguno todavía');

    // 8-9. Trabajo de RH (de la bitácora)
    const nContactos = this.cuenta('contacto');
    add('contactos', 'Contactos de RH', '☎️',
      nContactos ? 'hecho' : 'pendiente',
      nContactos ? `${nContactos} registrado(s)` : 'Ninguno registrado (las llamadas no se cuentan solas)');

    const nEnt = this.cuenta('entrevista');
    add('entrevistas', 'Entrevistas realizadas', '🤝',
      nEnt ? 'hecho' : 'pendiente',
      nEnt ? `${nEnt} registrada(s)` : 'Ninguna registrada');

    // 10. Decisión final
    const dec = c.decision;
    add('decision', 'Decisión de RH', '✅',
      dec?.decision ? 'hecho' : 'pendiente',
      dec?.decision ? `${dec.decision}${dec.por ? ' · ' + dec.por : ''}` : 'Sin aprobar ni descartar');

    return out;
  }

  get hechas(): number { return this.casillas.filter(c => c.estado === 'hecho').length; }
  get totalCasillas(): number { return this.casillas.length; }

  // ── Captura ───────────────────────────────────────────────────────

  async registrar(tipo: TipoEvento, canal?: CanalEvento) {
    if (!this.candidato?.id || this.registrando) return;
    this.registrando = tipo;
    this.error = '';
    try {
      await this.kpi.registrarEvento(this.candidato.id, tipo, {
        canal: canal || (tipo === 'contacto' ? this.canal : undefined),
        nota: this.nota.trim() || undefined
      });
      this.nota = '';
      await this.cargarBitacora();
    } catch {
      this.error = 'No se pudo registrar. Reintenta.';
    } finally {
      this.registrando = '';
    }
  }

  async borrar(e: EventoCandidato) {
    if (!confirm('¿Borrar este registro de la bitácora?')) return;
    try {
      await this.kpi.borrarEvento(e.id);
      this.bitacora = this.bitacora.filter(x => x.id !== e.id);
    } catch {
      this.error = 'No se pudo borrar.';
    }
  }

  iconoEvento(e: EventoCandidato): string {
    if (e.tipo === 'entrevista') return '🤝';
    if (e.tipo === 'contratacion') return '🎉';
    if (e.tipo === 'nota') return '📝';
    return e.canal === 'whatsapp' ? '💬' : e.canal === 'presencial' ? '🧍' : '☎️';
  }

  etiquetaEvento(e: EventoCandidato): string {
    if (e.tipo === 'entrevista') return 'Entrevista';
    if (e.tipo === 'contratacion') return 'Contratación';
    if (e.tipo === 'nota') return 'Nota';
    const canal: Record<string, string> = { llamada: 'Llamada', whatsapp: 'WhatsApp', presencial: 'Presencial', bot: 'Bot', portal: 'Portal' };
    return canal[e.canal || ''] || 'Contacto';
  }

  cuando(iso: string): string {
    const f = new Date(iso);
    return f.toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  /** Días desde que se postuló, para el encabezado. */
  get diasEnProceso(): number | null {
    const alta = this.candidato?.createdAt;
    if (!alta) return null;
    return Math.floor((Date.now() - new Date(alta).getTime()) / 86400000);
  }

  nivelDias(d: number): 'bien' | 'atencion' | 'tarde' {
    return d <= 7 ? 'bien' : d <= 15 ? 'atencion' : 'tarde';
  }
}
