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
// Para palomear a mano: guardar la marca en el candidato y firmar quién la puso.
import { CandidateService } from '../../core/services/candidate';
import { AuthSession } from '../../core/services/auth-session';

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
  estado: EstadoCasilla;
  detalle: string;
  /** Quién y cuándo la palomeó a mano (si es que se palomeó). */
  manual?: { por: string; en: string; motivo?: string };
  /**
   * Qué pasa al hacer clic:
   *  · 'evento'  — registra de verdad el contacto/entrevista en la bitácora.
   *  · 'manual'  — la marca a mano, dejando constancia de quién y cuándo.
   *  · 'ninguna' — no se palomea desde aquí (la decisión tiene sus botones).
   */
  accion: 'evento' | 'manual' | 'ninguna';
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
  private candidateService = inject(CandidateService);
  private auth = inject(AuthSession);

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

  /**
   * PALOMEAR A MANO, SIN QUE LA CASILLA MIENTA (11/08/2026)
   *
   * Lo que pidió Capital Humano: poder darle clic a una casilla y que quede
   * marcada. El problema es que estas casillas se derivan de datos reales, y
   * una palomita puesta a mano encima de eso vuelve el reporte indistinguible
   * de la realidad: nadie sabría si el sistema TIENE la psicométrica o si
   * alguien nada más dijo que sí.
   *
   * Así que se resuelve en dos formas, según la casilla:
   *
   *  · Las que tienen una acción de verdad detrás —contactos y entrevistas—
   *    NO se fingen: el clic REGISTRA el evento en la bitácora. La casilla se
   *    pone verde porque el hecho ocurrió, y de paso alimenta el KPI, que es
   *    justo el dato que hoy sale en cero por falta de captura.
   *
   *  · Las demás se marcan a mano, pero guardando QUIÉN y CUÁNDO, y la ficha
   *    lo dice con todas sus letras ("Marcado por Leslie el 11/08"). RH tiene
   *    razones que el sistema no conoce —la entrevista fue en papel, la prueba
   *    se aplicó impresa— y esconder que la palomita es de una persona y no
   *    del sistema sería exactamente el tipo de dato bonito que no aguanta la
   *    primera pregunta incómoda.
   *
   * Se guarda en `portal_data.checklistManual`, que ya viaja en el PATCH del
   * candidato: no hace falta tocar el API.
   */
  private get marcasManuales(): Record<string, { por: string; en: string; motivo?: string }> {
    const m = this.candidato?.checklistManual;
    return (m && typeof m === 'object') ? m : {};
  }

  /** Casillas que se palomean registrando el hecho, no marcándolo. */
  private readonly CON_EVENTO: Record<string, TipoEvento> = {
    contactos: 'contacto',
    entrevistas: 'entrevista',
  };

  /** El reporte de estatus completo. Se recalcula solo al cambiar los datos. */
  get casillas(): Casilla[] {
    const c = this.candidato || {};
    const out: Casilla[] = [];
    const manuales = this.marcasManuales;
    const add = (key: string, label: string, estado: EstadoCasilla, detalle: string) => {
      const manual = manuales[key];
      // La marca a mano solo SUBE de pendiente/parcial a hecho. Si el dato real
      // ya dice "hecho", manda el dato: una marca vieja no puede degradarlo.
      if (manual && estado !== 'hecho') {
        out.push({
          key, label, estado: 'hecho', manual, accion: 'manual',
          // Se distingue la palomita suelta de la que se puso al contratar: son
          // dos historias distintas y la ficha no debe contarlas igual.
          detalle: manual.motivo === 'contratacion'
            ? `Se dio por cumplido al contratar · ${manual.por}, ${this.fechaCorta(manual.en)}`
            : `Marcado por ${manual.por} el ${this.fechaCorta(manual.en)}`,
        });
        return;
      }
      out.push({
        key, label, estado, detalle,
        accion: this.CON_EVENTO[key] ? 'evento' : (key === 'decision' ? 'ninguna' : 'manual'),
      });
    };

    // 1. CV
    add('cv', 'Currículum recibido', this.tieneCv ? 'hecho' : 'pendiente',
      this.tieneCv ? (c.cvUrl ? 'En el expediente' : 'Llegó por WhatsApp')
                   : (c.estadoBot === 'esperando_cv' ? 'Se le pidió y no lo ha mandado' : 'No lo ha entregado'));

    // 2. Dictamen automático del bot
    const d = c.dictamen;
    add('dictamen', 'Análisis del CV (bot)', d?.recomendacion ? 'hecho' : 'pendiente',
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
    add('conductual', 'Entrevista conductual', lid.contestadas === 0 ? 'pendiente' : lidCompleto ? 'hecho' : 'parcial',
      lid.contestadas ? `${lid.contestadas}/${lid.total} respuestas · ${lid.porcentaje}%` : 'Sin contestar');

    // 4. Aptitudes (la califica el jefe por link)
    const apt = c.aptitudesEval;
    const rub = c.rubricaAptitudes ? Object.keys(c.rubricaAptitudes).length : 0;
    add('aptitudes', 'Aptitudes / STAR del jefe', apt?.completadaEn ? 'hecho' : rub ? 'parcial' : 'pendiente',
      apt?.completadaEn ? `${apt.puntaje ?? '—'} · ${apt.banda || apt.resultado || 'evaluado'}`
        : rub ? `${rub} competencias calificadas` : 'Falta generar el link al jefe');

    // 5. Entrevista técnica
    const jefe = progresoChecklist(c.jefeChecklist, CHECKLIST_JEFE);
    add('tecnica', 'Entrevista técnica', jefe.hechos === 0 ? 'pendiente' : jefe.pct >= 100 ? 'hecho' : 'parcial',
      `${jefe.hechos}/${jefe.total} puntos revisados`);

    // 6. Psicométricas
    const ps = puntajePsico(c.psicoTests);
    const psCheck = progresoChecklist(c.psicometriaChecklist, PSICOMETRIA_ITEMS);
    add('psicometria', 'Psicométricas', ps.evaluada ? 'hecho' : psCheck.hechos ? 'parcial' : 'pendiente',
      ps.evaluada ? `Puntaje ${ps.puntaje}` : psCheck.hechos ? `${psCheck.hechos}/${psCheck.total} capturados` : 'Sin aplicar');

    // 7. Documentos del expediente
    const docs = (c.documentosBot || []).length + (c.expedienteDocs ? Object.keys(c.expedienteDocs).length : 0);
    add('documentos', 'Documentos del expediente', docs >= 5 ? 'hecho' : docs ? 'parcial' : 'pendiente',
      docs ? `${docs} archivo(s) recibidos` : 'Ninguno todavía');

    // 8-9. Trabajo de RH (de la bitácora)
    const nContactos = this.cuenta('contacto');
    add('contactos', 'Contactos de RH', nContactos ? 'hecho' : 'pendiente',
      nContactos ? `${nContactos} registrado(s)` : 'Ninguno registrado (las llamadas no se cuentan solas)');

    const nEnt = this.cuenta('entrevista');
    add('entrevistas', 'Entrevistas realizadas', nEnt ? 'hecho' : 'pendiente',
      nEnt ? `${nEnt} registrada(s)` : 'Ninguna registrada');

    // 10. Decisión final
    const dec = c.decision;
    add('decision', 'Decisión de RH', dec?.decision ? 'hecho' : 'pendiente',
      dec?.decision ? `${dec.decision}${dec.por ? ' · ' + dec.por : ''}` : 'Sin aprobar ni descartar');

    return out;
  }

  get hechas(): number { return this.casillas.filter(c => c.estado === 'hecho').length; }
  get totalCasillas(): number { return this.casillas.length; }

  // ── Palomear ──────────────────────────────────────────────────────

  /** Key de la casilla que se está guardando (para apagar el clic). */
  palomeando = '';

  fechaCorta(iso: string): string {
    const f = new Date(iso);
    if (isNaN(f.getTime())) return String(iso).slice(0, 10);
    return f.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
  }

  /** El texto del tooltip: qué va a pasar si le doy clic. */
  tituloCasilla(c: Casilla): string {
    if (c.accion === 'ninguna') return 'La decisión se toma con los botones de abajo';
    if (c.accion === 'evento') {
      return c.key === 'contactos'
        ? 'Clic para registrar un contacto con esta persona (cuenta para el KPI)'
        : 'Clic para registrar una entrevista realizada (cuenta para el KPI)';
    }
    return c.manual
      ? 'Clic para quitar la marca'
      : 'Clic para marcarla como hecha (queda tu nombre y la fecha)';
  }

  async palomear(c: Casilla) {
    if (c.accion === 'ninguna' || this.palomeando || !this.candidato?.id) return;

    // Contactos y entrevistas no se fingen: se registran de verdad. Ese registro
    // es además lo que alimenta el KPI de contactos/entrevistas por día.
    if (c.accion === 'evento') {
      if (c.estado === 'hecho') return;   // ya hay eventos; no se "desregistra" desde aquí
      await this.registrar(this.CON_EVENTO[c.key]);
      return;
    }

    this.palomeando = c.key;
    this.error = '';
    const previas = { ...this.marcasManuales };
    try {
      const marcas = { ...previas };
      if (c.manual) delete marcas[c.key];
      else {
        marcas[c.key] = {
          por: this.auth.getUsuario()?.nombre || 'RH',
          en: new Date().toISOString(),
        };
      }
      // Optimista: la palomita responde al instante y se revierte si falla.
      this.candidato.checklistManual = marcas;
      await this.candidateService.updateCandidate(this.candidato.id, { checklistManual: marcas });
    } catch {
      this.candidato.checklistManual = previas;
      this.error = 'No se pudo guardar la marca. Revisa tu conexión e intenta de nuevo.';
    } finally {
      this.palomeando = '';
    }
  }

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

  // ── LA LUZ VERDE ──────────────────────────────────────────────────
  //
  // El bot dictamina y deja al candidato esperando decisión. Hasta el
  // 01/08/2026 esa decisión solo se podía dar por WhatsApp o en el panel del
  // bot, y había 28 candidatos dictaminados con CERO decisiones: la puerta
  // estaba en otra herramienta. Aquí, en la ficha donde RH ya está leyendo el
  // análisis, cuesta un clic.

  decidiendo = '';

  /**
   * ¿Hay un dictamen esperando decisión, Y el candidato ya llegó al final?
   *
   * Los botones aparecen SOLO en Psicométricas (la 4ª fase). Es lo que pidió RH:
   * el bot empuja al candidato por las tres compuertas —expediente completo,
   * entrevista calificada, aptitudes aprobadas por el jefe— y una persona decide
   * hasta el final. Si el botón viviera en cualquier fase, aprobar se volvería un
   * atajo para saltarse las compuertas, y entonces medir el proceso no serviría
   * de nada.
   *
   * Los de fases anteriores igual ven su dictamen y su reporte de estatus; lo que
   * no tienen es el botón.
   */
  get esperaDecision(): boolean {
    const c = this.candidato || {};
    if (!c.dictamen?.recomendacion || c.decision?.decision) return false;
    return c.status === ID_ETAPAS.PSICOMETRIA;
  }

  /** Para explicarle a RH por qué todavía no hay botones. */
  get faltaLlegarAlFinal(): boolean {
    const c = this.candidato || {};
    return !!c.dictamen?.recomendacion && !c.decision?.decision
      && c.status !== ID_ETAPAS.PSICOMETRIA && !this.contratado && !this.rechazado;
  }

  /** Lo que YA se decidió, si es que se decidió. */
  get decision(): { decision: string; por?: string; en?: string } | null {
    return this.candidato?.decision?.decision ? this.candidato.decision : null;
  }

  async decidir(decision: 'aprobado' | 'descartado') {
    const c = this.candidato;
    if (!c?.id || this.decidiendo) return;
    const rec = c.dictamen?.recomendacion;
    // Confirmar SIEMPRE, y con más razón si va contra lo que sugirió el análisis:
    // aprobar a quien el bot marcó para descartar puede ser lo correcto, pero
    // debe ser deliberado.
    const contraria = (decision === 'aprobado' && rec === 'descartar')
      || (decision === 'descartado' && rec === 'entrevistar');
    const texto = `¿${decision === 'aprobado' ? 'Aprobar' : 'Descartar'} a ${c.nombre}?`
      + (contraria ? `\n\nOJO: el análisis del CV recomendó "${rec}".` : '')
      + (decision === 'aprobado' ? '\n\nSe le avisa al candidato por WhatsApp.' : '');
    if (!confirm(texto)) return;

    this.decidiendo = decision;
    this.error = '';
    try {
      await this.kpi.decidir(c.id, decision);
      // Se refleja al instante; el candidato ya salió de la cola.
      this.candidato.decision = { decision, por: 'tú', en: new Date().toISOString() };
      await this.cargarBitacora();
    } catch (e: any) {
      this.error = e?.status === 503
        ? 'Falta conectar el bot con el portal (avísale a sistemas).'
        : 'No se pudo registrar la decisión. Reintenta.';
    } finally {
      this.decidiendo = '';
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

  /**
   * Clave de color del evento. Reemplaza a los emojis que traía la bitácora:
   * la identidad de la app es navy + dorado, y una fila de caritas rompe ese
   * registro. El tipo ya se lee en la etiqueta de al lado; el color solo ayuda
   * a barrer la lista con la vista.
   */
  tipoEvento(e: EventoCandidato): string {
    if (e.tipo === 'entrevista') return 'entrevista';
    if (e.tipo === 'contratacion') return 'contratacion';
    if (e.tipo === 'nota') return 'nota';
    return 'contacto';
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
