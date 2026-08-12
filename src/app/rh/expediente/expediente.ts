import { Component, inject, OnInit, NgZone, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { CandidateService } from '../../core/services/candidate';
import {
  ETAPAS, ID_ETAPAS, FLUJO_LINEAL, EstadoCheck,
  COMPETENCIAS_STAR, APTITUDES_POR_TIPO,
  PSICOMETRIA_ITEMS, CHECKLIST_JEFE, CHECKLIST_DOCUMENTAL,
  CHECKLIST_OFERTA, CHECKLIST_CONTRATADO, AREAS_DICTAMEN,
  DOCUMENTOS_EXPEDIENTE, CASILLAS_ESTATUS,
  ItemChecklist, ResultadoDictamen, AptitudItem,
  NIVELES_RUBRICA, NivelRubrica, UMBRAL_APROBACION_APTITUDES,
  calcularPuntajeRubrica, resolverAptitudes,
  CompetenciaStar, NivelStar, NIVELES_STAR, calcularPuntajeStar,
  checklistCompleto, itemsFaltantes, progresoChecklist,
  INTEGRITEST_NIVELES, STABILITEST_NIVELES, PsicoTests,
  interpretarHrAvatar, riesgoPsicometrico, psicoCompleto, progresoPsicoDeCandidato
} from '../../core/models/proceso.model';
import {
  CUESTIONARIO_LIDERAZGO, NIVELES_LIKERT, RespuestasCuestionario,
  calcularResultadoLiderazgo, calificaEnEvaluacion
} from '../../core/models/cuestionario-liderazgo.model';
import { normalizarTelefonoMX } from '../../core/models/puestos.model';
import { ToastService } from '../../core/services/toast.service';
import { BotService } from '../../core/services/bot.service';
import { PuestosService, Puesto } from '../../core/services/puestos.service';
// La contratación deja rastro en la bitácora: es lo que alimenta el KPI de
// conversión (entrevistados -> contratados).
import { KpiService } from '../../core/services/kpi.service';
import { AuthSession } from '../../core/services/auth-session';
import {
  hojaPorKey, hojaPorNombrePuesto, HOJAS_COMPETENCIAS
} from '../../core/models/competencias-puesto.model';
// Reporte de estatus + barra del proceso + bitácora de seguimiento (pestaña
// Resumen). Vive en su propio componente para no engordar más este archivo, que
// ya es el más grande del back-office.
import { StatusProcesoComponent } from '../status-proceso/status-proceso';
// Mínimos para avanzar de fase (CV, registro completo, sin bandera grave).
import { revisarAvance } from '../../core/models/requisitos-avance.model';

@Component({
  selector: 'app-expediente',
  standalone: true,
  imports: [CommonModule, FormsModule, StatusProcesoComponent],
  templateUrl: './expediente.html',
  styleUrl: './expediente.css'
})
export class ExpedienteComponent implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private candidateService = inject(CandidateService);
  private ngZone = inject(NgZone);
  private toast = inject(ToastService);
  private botService = inject(BotService);
  private puestosService = inject(PuestosService);
  private kpi = inject(KpiService);
  // Para firmar quién dio por cumplido el reporte de estatus al contratar.
  private auth = inject(AuthSession);

  /** Catálogo de puestos (para resolver las aptitudes propias de cada puesto). */
  puestosLista: Puesto[] = [];

  /** Link de evaluación de aptitudes generado (para copiar/compartir con el gerente). */
  linkAptitudes = '';
  generandoLinkApt = false;

  /** Ids con una invitación al bot en curso (deshabilita el botón) */
  enviandoInvitacion = new Set<string>();

  /** Ids con una petición de documentos al bot en curso (deshabilita el botón) */
  pidiendoDocs = new Set<string>();

  /** Conversación del bot con el candidato (pestaña "Conversación") */
  conversacion: any[] = [];
  cargandoConv = false;
  convError = '';
  convCargada = false;

  // Constantes expuestas al template
  ETAPAS = ETAPAS;
  ID_ETAPAS = ID_ETAPAS;
  FLUJO_LINEAL = FLUJO_LINEAL;
  COMPETENCIAS_STAR = COMPETENCIAS_STAR;
  APTITUDES_POR_TIPO = APTITUDES_POR_TIPO;
  NIVELES_RUBRICA = NIVELES_RUBRICA;
  UMBRAL_APROBACION = UMBRAL_APROBACION_APTITUDES;
  PSICOMETRIA_ITEMS = PSICOMETRIA_ITEMS;
  INTEGRITEST_NIVELES = INTEGRITEST_NIVELES;
  STABILITEST_NIVELES = STABILITEST_NIVELES;
  interpretarHrAvatar = interpretarHrAvatar;
  CHECKLIST_JEFE = CHECKLIST_JEFE;
  CHECKLIST_DOCUMENTAL = CHECKLIST_DOCUMENTAL;
  CHECKLIST_OFERTA = CHECKLIST_OFERTA;
  CHECKLIST_CONTRATADO = CHECKLIST_CONTRATADO;
  DOCUMENTOS_EXPEDIENTE = DOCUMENTOS_EXPEDIENTE;
  AREAS_DICTAMEN = AREAS_DICTAMEN;
  // Cuestionario de Liderazgo (12 preguntas Likert) que reemplaza a STAR
  CUESTIONARIO_LIDERAZGO = CUESTIONARIO_LIDERAZGO;
  NIVELES_LIKERT = NIVELES_LIKERT;

  candidato: any = null;
  cargando = true;
  subiendoDoc = false;
  /** key del slot del portafolio que se está subiendo (null = ninguno) */
  subiendoDocKey: string | null = null;
  tabActiva: string = 'resumen';
  mensajeBloqueo: { titulo: string; faltantes: string[] } | null = null;

  // Tipo de vacante para aptitudes
  tipoVacante: 'operativo' | 'administrativo' | 'ventas' | 'jefatura' = 'operativo';

  private unsubscribeFn: any;

  ngOnInit() {
    // Catálogo de puestos: para resolver las aptitudes propias del puesto del
    // candidato (mejor esfuerzo; si falla, se usa el preset por tipo de vacante).
    this.puestosService.obtener()
      .then(lista => this.ngZone.run(() => { this.puestosLista = lista; }))
      .catch(() => { /* sin catálogo: caemos al preset por tipo */ });

    const id = this.route.snapshot.paramMap.get('id');
    if (id) {
      this.unsubscribeFn = this.candidateService.listenToCandidate(id, (data) => {
        this.ngZone.run(() => {
          this.candidato = data;
          this.inicializarChecklists();
          this.tipoVacante = this.candidato.tipoVacante || 'operativo';
          this.cargando = false;
        });
      });
    }
  }

  ngOnDestroy() {
    if (this.unsubscribeFn) this.unsubscribeFn();
  }

  inicializarChecklists() {
    if (!this.candidato) return;
    const vacio = (items: ItemChecklist[]) => items.reduce((a, i) => ({ ...a, [i.key]: 'gris' }), {});
    this.candidato.starChecklist         ||= vacio(COMPETENCIAS_STAR);
    this.candidato.starNotas             ||= {};
    this.candidato.aptitudesResultados   ||= { puntaje: 0, tiempo: '', aprobado: false, notas: '' };
    this.candidato.rubricaAptitudes      ||= {}; // { [aptitudKey]: NivelRubrica }
    this.candidato.psicometriaChecklist  ||= vacio(PSICOMETRIA_ITEMS);
    this.candidato.psicometriaRiesgos    ||= '';
    this.candidato.psicoTests            ||= { integritest: '', stabilitest: '', hrAvatar: null } as PsicoTests;
    this.candidato.jefeChecklist         ||= vacio(CHECKLIST_JEFE);
    this.candidato.jefeNotas             ||= '';
    this.candidato.documentalChecklist   ||= vacio(CHECKLIST_DOCUMENTAL);
    this.candidato.ofertaChecklist       ||= vacio(CHECKLIST_OFERTA);
    this.candidato.contratadoChecklist   ||= vacio(CHECKLIST_CONTRATADO);
    this.candidato.cuestionarioLiderazgo ||= {} as RespuestasCuestionario;
    this.candidato.dictamen              ||= {
      rh: 'pendiente', competencias: 0, aptitudes: 0,
      psicometria: 'sin_riesgo', jefe: 'pendiente',
      documentos: 'incompleta', resultado: 'pendiente', notas: ''
    };
  }

  // ====== CUESTIONARIO DE LIDERAZGO (reemplaza STAR) ======

  /** Responde una pregunta del cuestionario y sincroniza el puntaje con el dictamen */
  async responderPregunta(num: number, valor: number) {
    if (!this.candidato.cuestionarioLiderazgo) this.candidato.cuestionarioLiderazgo = {};
    this.candidato.cuestionarioLiderazgo[num] = valor;

    // Sincronizar el porcentaje con dictamen.competencias para que el resultado
    // sugerido del Dictamen Final ya lo tome en cuenta.
    const r = this.resultadoLiderazgo();
    this.candidato.dictamen.competencias = r.porcentaje;

    // COMPUERTA 2 → 3, idéntica a la de la pantalla pública: al completar las 12
    // preguntas Y CALIFICAR, el candidato pasa a *Aptitudes y Entrevista Técnica*.
    //
    // El destino tiene que ser el MISMO sin importar quién capture el cuestionario
    // —el candidato por su liga o RH aquí a mano—; si no, la misma respuesta
    // movería a dos lugares distintos y el embudo dejaría de significar algo.
    //
    // Y además tiene que CUMPLIR LOS MÍNIMOS (CV, registro completo, sin bandera
    // grave). Ver requisitos-avance.model.ts: hasta el 30/07/2026 el autoavance
    // solo miraba el puntaje, y así subieron candidatos sin CV, con registro a
    // medias y uno con conflicto de interés declarado.
    const estado = this.candidato.status;
    const revision = revisarAvance(this.candidato);
    const avanzables: string[] = [ID_ETAPAS.FILTRO, ID_ETAPAS.NUEVO, ID_ETAPAS.RH];
    const debeAvanzar = calificaEnEvaluacion(r) && revision.ok
      && (!estado || avanzables.includes(estado));
    if (calificaEnEvaluacion(r) && !revision.ok) {
      this.toast.info(`Calificó, pero no avanza: ${revision.motivos[0]}`);
    }

    const payload: any = {
      cuestionarioLiderazgo: this.candidato.cuestionarioLiderazgo,
      dictamen: this.candidato.dictamen
    };
    if (debeAvanzar) payload.status = ID_ETAPAS.APTITUDES;

    try {
      await this.candidateService.updateCandidate(this.candidato.id, payload);
      if (debeAvanzar) this.candidato.status = ID_ETAPAS.APTITUDES;
    } catch (e) {
      console.error('Error al guardar respuesta del cuestionario:', e);
    }
  }

  /** Devuelve el resultado calculado (puntaje, %, nivel, interpretación) */
  resultadoLiderazgo() {
    return calcularResultadoLiderazgo(this.candidato?.cuestionarioLiderazgo);
  }

  /** Útil para marcar visualmente la opción seleccionada en una pregunta */
  respuestaActual(num: number): number | undefined {
    return this.candidato?.cuestionarioLiderazgo?.[num];
  }

  /** Cierre de seguimiento individual: manda este candidato a la Papelera. */
  async cerrarSeguimientoActual() {
    if (!this.candidato?.id) return;
    const ok = await this.toast.confirmar({
      titulo: `Cerrar seguimiento de ${this.candidato.nombre || 'este candidato'}`,
      mensaje: 'Se enviará a la Papelera. Podrás recuperarlo desde ahí si hace falta. ¿Continuar?',
      textoConfirmar: 'Sí, cerrar',
      textoCancelar: 'Cancelar'
    });
    if (!ok) return;
    try {
      await this.candidateService.cerrarSeguimiento(this.candidato.id);
      this.toast.exito(`${this.candidato.nombre || 'El candidato'} se movió a la Papelera.`, 'Cierre de seguimiento');
      this.volver();
    } catch (e) {
      this.toast.error('No se pudo cerrar el seguimiento.', 'Error');
    }
  }

  volver() {
    // Regresa a la vista de la etapa donde está el candidato (o al dashboard)
    const etapa = this.candidato?.status;
    if (etapa && etapa !== ID_ETAPAS.RECHAZADO) {
      this.router.navigate(['/app/etapa', etapa]);
    } else if (etapa === ID_ETAPAS.RECHAZADO) {
      this.router.navigate(['/app/etapa', ID_ETAPAS.RECHAZADO]);
    } else {
      this.router.navigate(['/app/dashboard']);
    }
  }

  // STEPPER
  getStepIndex(statusId: string): number {
    return FLUJO_LINEAL.indexOf(statusId);
  }

  /**
   * Devuelve true si la fase está realmente completa (no por orden secuencial,
   * sino por contenido validado). Permite ver de un vistazo qué quedó cerrado y
   * qué no, aunque el candidato ya esté en una etapa posterior.
   */
  etapaCompletada(etapaId: string): boolean {
    if (!this.candidato) return false;
    switch (etapaId) {
      case ID_ETAPAS.NUEVO:
        // Recibida → se considera "lista" en cuanto exista el candidato
        return true;
      case ID_ETAPAS.FILTRO:
        // Filtro Inicial ya no tiene checklist: es solo la bandeja de entrada.
        // Se considera superada en cuanto el candidato existe (primer contacto).
        return true;
      case ID_ETAPAS.RH:
        return this.progresoStar().pct === 100;
      case ID_ETAPAS.APTITUDES:
        // Etapa fusionada: requiere aptitudes aprobadas Y entrevista técnica completa
        return this.calcularPuntajeAptitudes().aprobado &&
               checklistCompleto(this.candidato.jefeChecklist, CHECKLIST_JEFE);
      case ID_ETAPAS.PSICOMETRIA:
        return psicoCompleto(this.candidato.psicoTests) ||
               checklistCompleto(this.candidato.psicometriaChecklist, PSICOMETRIA_ITEMS);
      case ID_ETAPAS.JEFE:
        return checklistCompleto(this.candidato.jefeChecklist, CHECKLIST_JEFE);
      case ID_ETAPAS.DOCUMENTAL:
        return checklistCompleto(this.candidato.documentalChecklist, CHECKLIST_DOCUMENTAL);
      case ID_ETAPAS.OFERTA:
        return checklistCompleto(this.candidato.ofertaChecklist, CHECKLIST_OFERTA);
      case ID_ETAPAS.DICTAMEN:
        return this.candidato.dictamen?.resultado && this.candidato.dictamen.resultado !== 'pendiente';
      case ID_ETAPAS.CONTRATADO:
        return checklistCompleto(this.candidato.contratadoChecklist, CHECKLIST_CONTRATADO);
      default:
        return false;
    }
  }

  /** Progreso 0-100 de una fase específica — para llenar parcialmente el círculo del stepper */
  etapaProgreso(etapaId: string): number {
    if (!this.candidato) return 0;
    switch (etapaId) {
      case ID_ETAPAS.NUEVO:        return 100;
      case ID_ETAPAS.FILTRO:       return 100; // bandeja de entrada, sin checklist que llenar
      case ID_ETAPAS.RH:           return this.progresoStar().pct;
      case ID_ETAPAS.APTITUDES: {
        // Promedio del puntaje de aptitudes y el avance de la entrevista técnica
        const apt = this.calcularPuntajeAptitudes().puntaje;
        const jefe = progresoChecklist(this.candidato.jefeChecklist, CHECKLIST_JEFE).pct;
        return Math.round((apt + jefe) / 2);
      }
      case ID_ETAPAS.PSICOMETRIA:  return progresoPsicoDeCandidato(this.candidato).pct;
      case ID_ETAPAS.JEFE:         return progresoChecklist(this.candidato.jefeChecklist, CHECKLIST_JEFE).pct;
      case ID_ETAPAS.DOCUMENTAL:   return progresoChecklist(this.candidato.documentalChecklist, CHECKLIST_DOCUMENTAL).pct;
      case ID_ETAPAS.OFERTA:       return progresoChecklist(this.candidato.ofertaChecklist, CHECKLIST_OFERTA).pct;
      case ID_ETAPAS.DICTAMEN:
        return (this.candidato.dictamen?.resultado && this.candidato.dictamen.resultado !== 'pendiente') ? 100 : 0;
      case ID_ETAPAS.CONTRATADO:   return progresoChecklist(this.candidato.contratadoChecklist, CHECKLIST_CONTRATADO).pct;
      default: return 0;
    }
  }

  /**
   * Leyenda de estatus que se muestra debajo de cada paso del stepper.
   * Traduce el progreso real (no el orden) a lenguaje de RH.
   */
  etapaEstadoTexto(etapaId: string): string {
    const aqui = this.candidato?.status === etapaId;
    // "Completada" a secas escondía el dato más útil cuando la etapa actual ya
    // estaba cerrada: se leía igual que las anteriores y no se sabía dónde está
    // parada la persona ni qué sigue.
    if (this.etapaCompletada(etapaId)) return aqui ? 'Completada · aquí va' : 'Completada';
    const pct = this.etapaProgreso(etapaId);
    if (aqui) return pct > 0 ? `En proceso · ${pct}%` : 'En proceso';
    return pct > 0 ? `Avance ${pct}%` : 'Pendiente';
  }

  /** La barra entre dos pasos se pinta solo si el paso anterior quedó cerrado. */
  etapaPreviaCompletada(idx: number): boolean {
    return idx > 0 && this.etapaCompletada(FLUJO_LINEAL[idx - 1]);
  }

  /** Nombre corto de la etapa donde está parado, para la migaja y el tooltip. */
  etapaActualLabel(): string {
    const id = this.candidato?.status;
    if (id === ID_ETAPAS.CONTRATADO) return 'Contratados';
    if (id === ID_ETAPAS.RECHAZADO) return 'Papelera';
    return ETAPAS.find(e => e.id === id)?.shortLabel || ETAPAS[0].shortLabel;
  }

  /**
   * Días desde que se postuló. Es el dato que responde "¿este lleva mucho
   * atorado?" sin salir del expediente — la misma vara que usa el tablero de KPI
   * (meta 7 días, límite 15).
   */
  diasEnProceso(): number | null {
    const alta = this.candidato?.createdAt || this.candidato?.creadoEn;
    if (!alta) return null;
    const ms = Date.now() - new Date(alta).getTime();
    return isNaN(ms) ? null : Math.max(0, Math.floor(ms / 86400000));
  }

  nivelDias(dias: number): 'bien' | 'atencion' | 'tarde' {
    return dias <= 7 ? 'bien' : dias <= 15 ? 'atencion' : 'tarde';
  }

  puedeMoverA(nuevaEtapa: string): { ok: boolean; faltan: string[] } {
    if (nuevaEtapa !== ID_ETAPAS.CONTRATADO) return { ok: true, faltan: [] };
    if (checklistCompleto(this.candidato.ofertaChecklist, CHECKLIST_OFERTA)) return { ok: true, faltan: [] };
    return {
      ok: false,
      faltan: itemsFaltantes(this.candidato.ofertaChecklist, CHECKLIST_OFERTA).map(i => i.label)
    };
  }

  // ====== CONTRATAR: la luz verde al final del proceso ======
  //
  // Hasta el 03/08/2026 NO EXISTIA forma de contratar a nadie desde el portal.
  // El stepper solo llega a Psicométricas (contratado no está en FLUJO_LINEAL),
  // la pestaña de Oferta —donde se validan los seis puntos previos al ingreso—
  // no tenía boton que la abriera, y la de Contratado tampoco. El codigo para
  // mover a esa etapa llevaba meses escrito y nadie podia llamarlo.
  //
  // Eso explica el dato que salia en todos los tableros: 320 candidatos vivos y
  // CERO contratados. No era que no se contratara gente; era que no habia donde
  // decirlo. Y sin esa marca, la cobertura en 7/15 dias y la permanencia a 90
  // dias se quedaban sin base para siempre.
  //
  // La fecha de ingreso SE PREGUNTA, no se asume. Casi nunca se captura el mismo
  // dia que entra la persona —se hace el viernes, o el lunes siguiente— y usar
  // "hoy" corre el reloj de los 90 dias desde el dia equivocado.

  /** Panel de contratación abierto (null = cerrado). */
  contratando = false;
  fechaIngreso = '';
  notaContratacion = '';
  guardandoContrato = false;

  /** ¿Ya está contratado? */
  get yaContratado(): boolean { return this.candidato?.status === ID_ETAPAS.CONTRATADO; }

  /** Solo el día del ingreso, sin la hora con la que se guarda. */
  get fechaIngresoTexto(): string {
    return String(this.candidato?.hiredAt || '').slice(0, 10);
  }

  /** Validaciones previas al ingreso que faltan (las seis de la pestaña Oferta). */
  faltantesParaContratar(): string[] {
    if (!this.candidato) return [];
    return itemsFaltantes(this.candidato.ofertaChecklist, CHECKLIST_OFERTA).map(i => i.label);
  }

  /** Cumplió con todo: el boton se pinta en verde y no pide confirmacion extra. */
  get listoParaContratar(): boolean {
    return !!this.candidato && this.faltantesParaContratar().length === 0;
  }

  abrirContratacion() {
    if (!this.candidato) return;
    // Por defecto hoy, pero editable: es la fecha en que EMPIEZA a trabajar.
    const h = new Date();
    this.fechaIngreso = `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, '0')}-${String(h.getDate()).padStart(2, '0')}`;
    this.notaContratacion = '';
    this.contratando = true;
  }

  cerrarContratacion() { this.contratando = false; }

  async confirmarContratacion() {
    if (!this.candidato || this.guardandoContrato) return;
    if (!this.fechaIngreso) {
      this.toast.alerta('Falta la fecha de ingreso: es el dia desde el que se cuentan los 30, 60 y 90 dias.', 'Sin fecha no se puede');
      return;
    }

    // Si falta alguna validacion se avisa y se deja decidir, igual que al
    // avanzar de fase: RH puede tener razones que el sistema no conoce. Lo que
    // no se hace es contratar en silencio saltandose los seis puntos -- queda
    // escrito en la bitacora que se contrato con pendientes y cuales eran.
    const faltan = this.faltantesParaContratar();
    if (faltan.length) {
      const seguir = confirm(
        `${this.candidato.nombre} todavia no cumple las validaciones previas al ingreso:\n\n` +
        faltan.map(f => `• ${f}`).join('\n') +
        `\n\n¿Contratarlo de todos modos? Quedara registrado que se contrato con estos pendientes.`
      );
      if (!seguir) return;
    }

    this.guardandoContrato = true;
    try {
      // Se guarda con la hora del MEDIODIA, no como '2026-08-03' a secas: una
      // fecha sin hora la interpreta `new Date()` como medianoche UTC, y en
      // México (UTC-6) eso cae el dia anterior. El contador de permanencia
      // habria dicho "1 dia" el mismo dia que la persona entra. El mediodia
      // aguanta cualquier huso sin correrse de dia.
      const hiredAt = `${this.fechaIngreso}T12:00:00`;

      /**
       * CONTRATAR DA POR CUMPLIDO EL REPORTE DE ESTATUS (11/08/2026)
       *
       * Si la persona ya está contratada, el proceso se cumplió: no tiene
       * sentido que su ficha siga mostrando "Psicométricas: sin aplicar" o
       * "Entrevistas: ninguna registrada". Lo pidió Capital Humano y tiene
       * razón — pero se marca con la MISMA regla que el palomeo a mano: queda
       * firmado quién y cuándo, con el motivo "al contratar". Una casilla verde
       * sin dueño es la que después nadie puede explicar.
       *
       * Las que ya están cumplidas con datos reales no se tocan: la marca
       * manual solo sube de pendiente a hecho, nunca degrada (ver
       * status-proceso.ts).
       */
      const quien = this.auth.getUsuario()?.nombre || 'RH';
      const ahora = new Date().toISOString();
      const marcas: Record<string, any> = { ...(this.candidato.checklistManual || {}) };
      for (const key of CASILLAS_ESTATUS) {
        if (!marcas[key]) marcas[key] = { por: quien, en: ahora, motivo: 'contratacion' };
      }

      await this.candidateService.updateCandidate(this.candidato.id, {
        status: ID_ETAPAS.CONTRATADO,
        hiredAt,
        checklistManual: marcas
      });
      this.candidato.status = ID_ETAPAS.CONTRATADO;
      this.candidato.hiredAt = hiredAt;
      this.candidato.checklistManual = marcas;

      // Queda en la bitacora del candidato: alimenta el KPI de conversion
      // (entrevistados -> contratados) y deja rastro de quien dio la luz verde.
      const detalle = [
        `Contratado. Ingreso: ${this.fechaIngreso}.`,
        this.notaContratacion.trim(),
        faltan.length ? `Se contrato con pendientes: ${faltan.join(', ')}.` : ''
      ].filter(Boolean).join(' ');
      this.kpi.registrarEvento(this.candidato.id, 'contratacion', { nota: detalle })
        .catch(() => { /* la contratacion ya quedo guardada; la bitacora es mejor esfuerzo */ });

      this.contratando = false;
      this.toast.exito(
        `${this.candidato.nombre} queda contratado con ingreso el ${this.fechaIngreso}.`,
        'Contratado'
      );
    } catch {
      this.toast.error('No se pudo guardar la contratacion. Revisa tu conexion e intenta de nuevo.', 'No se guardo');
    } finally {
      this.guardandoContrato = false;
    }
  }

  async moverEtapaDirecto(nuevaEtapa: string) {
    if (!this.candidato || this.candidato.status === nuevaEtapa) return;

    /**
     * SACAR A ALGUIEN DE CONTRATADO NO PUEDE SER UN CLIC DISTRAÍDO (11/08/2026)
     *
     * `contratado` NO está en FLUJO_LINEAL, así que `indexOf` devolvía -1 y la
     * comparación de abajo (`indexOf(destino) > indexOf(actual)`) leía un
     * regreso al proceso como si fuera un AVANCE: pasaba de largo sin una sola
     * pregunta. El stepper está justo encima de las casillas del reporte, y el
     * 11/08 entre las 16:35 y las 16:36 tres contratados —Jorge, Juan Carlos y
     * Diana— volvieron a Aptitudes con un clic mientras alguien palomeaba su
     * ficha. Nadie se enteró hasta que RH notó que no aparecían en Contratados.
     */
    if (this.candidato.status === ID_ETAPAS.CONTRATADO) {
      const ok = confirm(
        `${this.candidato.nombre} YA ESTÁ CONTRATADO.\n\n` +
        `Moverlo a "${ETAPAS.find(e => e.id === nuevaEtapa)?.title || nuevaEtapa}" lo saca de la lista de Contratados y ` +
        `deja de contar en Permanencia y en la cobertura.\n\n` +
        `¿Seguro que quieres regresarlo al proceso?`
      );
      if (!ok) return;
    }

    const v = this.puedeMoverA(nuevaEtapa);
    if (!v.ok) {
      this.mensajeBloqueo = { titulo: `No se puede contratar a ${this.candidato.nombre}`, faltantes: v.faltan };
      return;
    }

    // AVISO (no bloqueo) cuando se avanza a alguien que no cumple los mínimos.
    // A RH se le advierte y decide: puede tener razones que el sistema no sabe
    // (trajo el CV impreso, el puesto se abre la semana que entra). Al SISTEMA en
    // cambio se le prohíbe avanzar solo — ver requisitos-avance.model.ts.
    const avanza = FLUJO_LINEAL.indexOf(nuevaEtapa) > FLUJO_LINEAL.indexOf(this.candidato.status)
      || nuevaEtapa === ID_ETAPAS.CONTRATADO;
    if (avanza) {
      const revision = revisarAvance(this.candidato, this.puestosLista.filter(p => p.activo !== false).map(p => p.nombre));
      if (!revision.ok) {
        const seguir = confirm(
          `${this.candidato.nombre} no cumple lo mínimo para avanzar:\n\n` +
          revision.motivos.map(m => `• ${m}`).join('\n') +
          `\n\n¿Avanzarlo de todos modos?`
        );
        if (!seguir) return;
      }
    }

    const actualizacion: any = { status: nuevaEtapa };
    if (nuevaEtapa === ID_ETAPAS.CONTRATADO) actualizacion.hiredAt = new Date().toISOString();
    if (nuevaEtapa === ID_ETAPAS.RECHAZADO) actualizacion.rejectedAt = new Date().toISOString();
    try {
      await this.candidateService.updateCandidate(this.candidato.id, actualizacion);
    } catch (error) {
      console.error('Error al cambiar etapa:', error);
    }
  }

  cerrarBloqueo() { this.mensajeBloqueo = null; }

  // CHECKLISTS: set directo de Sí/No. Si vuelve a tocar el mismo botón, deselecciona.
  async setEstadoCheck(listName: string, key: string, nuevo: EstadoCheck) {
    if (!this.candidato[listName]) this.candidato[listName] = {};
    const actual = (this.candidato[listName][key] || 'gris') as EstadoCheck;
    const next: EstadoCheck = actual === nuevo ? 'gris' : nuevo;
    this.candidato[listName][key] = next;
    try {
      await this.candidateService.updateCandidate(this.candidato.id, { [listName]: this.candidato[listName] });
    } catch (error) {
      this.candidato[listName][key] = actual;
    }
  }

  // PROGRESO
  /** Entrevista Conductual: el progreso se cuenta por las preguntas contestadas del cuestionario */
  progresoStar() {
    const r = this.resultadoLiderazgo();
    return { hechos: r.contestadas, total: r.total, pct: r.total === 0 ? 100 : Math.round((r.contestadas / r.total) * 100) };
  }
  progresoPsicom() { return progresoPsicoDeCandidato(this.candidato); }

  // ====== PSICOMÉTRICAS · IntegriTEST / StabiliTEST / HR Avatar ======

  /** Interpretación (banda + color) del puntaje de HR Avatar. */
  hrAvatarInterp() { return interpretarHrAvatar(this.candidato?.psicoTests?.hrAvatar); }

  /** Recalcula el riesgo del dictamen a partir de las 3 pruebas. */
  private sincronizarRiesgoPsico() {
    if (!this.candidato?.dictamen) return;
    this.candidato.dictamen.psicometria = riesgoPsicometrico(this.candidato.psicoTests);
  }

  /** Selecciona un nivel de IntegriTEST/StabiliTEST (re-clic deselecciona). */
  async setPsicoNivel(prueba: 'integritest' | 'stabilitest', valor: string) {
    if (!this.candidato.psicoTests) this.candidato.psicoTests = {};
    const prev = this.candidato.psicoTests[prueba] || '';
    this.candidato.psicoTests[prueba] = prev === valor ? '' : valor;
    this.sincronizarRiesgoPsico();
    try {
      await this.candidateService.updateCandidate(this.candidato.id, {
        psicoTests: this.candidato.psicoTests,
        dictamen: this.candidato.dictamen
      });
    } catch (e) {
      this.candidato.psicoTests[prueba] = prev;
      this.sincronizarRiesgoPsico();
    }
  }

  /** Guarda el puntaje 0-100 de HR Avatar (o lo limpia si viene vacío). */
  async setHrAvatar(valor: any) {
    if (!this.candidato.psicoTests) this.candidato.psicoTests = {};
    const prev = this.candidato.psicoTests.hrAvatar ?? null;
    const raw = `${valor ?? ''}`.trim();
    let n: number | null = raw === '' ? null : Math.round(Number(raw));
    if (n !== null && isNaN(n)) n = null;
    if (n !== null) n = Math.max(0, Math.min(100, n));
    this.candidato.psicoTests.hrAvatar = n;
    this.sincronizarRiesgoPsico();
    try {
      await this.candidateService.updateCandidate(this.candidato.id, {
        psicoTests: this.candidato.psicoTests,
        dictamen: this.candidato.dictamen
      });
    } catch (e) {
      this.candidato.psicoTests.hrAvatar = prev;
      this.sincronizarRiesgoPsico();
    }
  }
  progresoJefe() { return progresoChecklist(this.candidato?.jefeChecklist, CHECKLIST_JEFE); }
  progresoDocs() { return progresoChecklist(this.candidato?.documentalChecklist, CHECKLIST_DOCUMENTAL); }
  progresoOferta() { return progresoChecklist(this.candidato?.ofertaChecklist, CHECKLIST_OFERTA); }
  progresoContratado() { return progresoChecklist(this.candidato?.contratadoChecklist, CHECKLIST_CONTRATADO); }

  // GUARDADOS DE NOTAS
  async guardarNota(campo: string, valor: any) {
    try {
      await this.candidateService.updateCandidate(this.candidato.id, { [campo]: valor });
    } catch (e) {
      console.error('Error al guardar:', e);
    }
  }

  async guardarNotaCompetencia(key: string, valor: string) {
    if (!this.candidato.starNotas) this.candidato.starNotas = {};
    this.candidato.starNotas[key] = valor;
    await this.guardarNota('starNotas', this.candidato.starNotas);
  }

  async guardarDictamen() {
    await this.guardarNota('dictamen', this.candidato.dictamen);
  }

  async cambiarTipoVacante(tipo: string) {
    this.tipoVacante = tipo as any;
    // Recalcular puntaje al cambiar el set de aptitudes activas
    const calc = this.calcularPuntajeAptitudes();
    this.candidato.aptitudesResultados.puntaje  = calc.puntaje;
    this.candidato.aptitudesResultados.aprobado = calc.aprobado;
    await this.candidateService.updateCandidate(this.candidato.id, {
      tipoVacante: tipo,
      aptitudesResultados: this.candidato.aptitudesResultados
    });
  }

  /** El puesto del candidato dentro del catálogo (match por nombre). */
  puestoDelCandidato(): Puesto | undefined {
    const nombre = (this.candidato?.puesto || '').trim().toLowerCase();
    if (!nombre) return undefined;
    return this.puestosLista.find(p => (p.nombre || '').trim().toLowerCase() === nombre);
  }

  // ====== COMPETENCIAS STAR (formato oficial de la entrevista técnica) ======

  NIVELES_STAR = NIVELES_STAR;

  /** Competencias efectivas del candidato: congeladas al generar el link →
   *  hoja oficial elegida en el puesto → hoja que coincide por nombre. */
  competenciasActivas(): CompetenciaStar[] {
    if (Array.isArray(this.candidato?.competenciasConfig) && this.candidato.competenciasConfig.length) {
      return this.candidato.competenciasConfig;
    }
    const p = this.puestoDelCandidato();
    const hoja = hojaPorKey(p?.hojaCompetencias) || hojaPorNombrePuesto(this.candidato?.puesto);
    return hoja?.competencias || [];
  }

  // ── ELEGIR OTRA HOJA DE ENTREVISTA ────────────────────────────────
  //
  // Hasta ahora la hoja salía SOLO del puesto al que se postuló, y no había
  // forma de aplicar otra sin ir a Vacantes a cambiarle la hoja al puesto
  // completo — lo que se la cambiaba a todos los demás candidatos de ese
  // puesto. En la práctica pasa seguido: alguien se postula a Cajero y se le
  // termina entrevistando para Almacenista.
  //
  // Se guarda en `competenciasConfig`, que es el campo que YA leen el portal
  // del jefe y el cálculo del puntaje. Por eso el cambio llega al link sin
  // tocar nada más.

  HOJAS = HOJAS_COMPETENCIAS;

  /** Hoja que le tocaría por su puesto, para la opción "la del puesto". */
  hojaDelPuesto() {
    const p = this.puestoDelCandidato();
    return hojaPorKey(p?.hojaCompetencias) || hojaPorNombrePuesto(this.candidato?.puesto);
  }

  /** key de la hoja elegida a mano; '' = se usa la del puesto. */
  get hojaElegida(): string {
    return this.candidato?.hojaCompetenciasElegida || '';
  }

  /** Cuántas competencias tiene calificadas hoy (lo que se perdería al cambiar). */
  private calificadasStar(): number {
    const r = this.candidato?.rubricaAptitudes || {};
    return Object.values(r).filter(Boolean).length;
  }

  /**
   * Cambia la hoja de esta persona. Si el jefe ya calificó, avisa antes: las
   * calificaciones se guardan por clave de competencia y las claves de otra
   * hoja no coinciden, así que ese trabajo se queda sin a qué pertenecer.
   */
  async elegirHoja(key: string) {
    if (!this.candidato?.id || key === this.hojaElegida) return;

    const yaCalificadas = this.calificadasStar();
    if (yaCalificadas > 0) {
      const seguir = await this.toast.confirmar({
        titulo: 'Ya hay competencias calificadas',
        mensaje: `El jefe calificó ${yaCalificadas} competencia(s) con la hoja actual. Si cambias de hoja, esas calificaciones dejan de contar porque pertenecen a otra lista. ¿Cambiar de todos modos?`,
        textoConfirmar: 'Cambiar la hoja',
        destructivo: true
      });
      if (!seguir) return;
    }

    const hoja = key ? hojaPorKey(key) : this.hojaDelPuesto();
    const payload: any = {
      hojaCompetenciasElegida: key || null,
      // Con una hoja elegida a mano se congela la lista: es lo que hace que el
      // jefe vea exactamente esa. Al volver a "la del puesto" se limpia, para
      // que siga a la vacante si mañana le cambian la hoja en Vacantes.
      competenciasConfig: key ? (hoja?.competencias || null) : null
    };

    const previaKey = this.candidato.hojaCompetenciasElegida;
    const previaConfig = this.candidato.competenciasConfig;
    this.candidato.hojaCompetenciasElegida = payload.hojaCompetenciasElegida;
    this.candidato.competenciasConfig = payload.competenciasConfig;

    try {
      await this.candidateService.updateCandidate(this.candidato.id, payload, { marcarActividad: false });
      this.toast.exito(
        key ? `Se evaluará con la hoja "${hoja?.nombre}".` : 'Vuelve a usarse la hoja del puesto.',
        'Hoja de entrevista actualizada'
      );
      // El link viejo apunta a la hoja anterior: se invalida para que nadie lo
      // reparta por WhatsApp creyendo que ya trae la nueva.
      this.linkAptitudes = '';
    } catch {
      this.candidato.hojaCompetenciasElegida = previaKey;
      this.candidato.competenciasConfig = previaConfig;
      this.toast.error('No se pudo cambiar la hoja. Intenta de nuevo.');
    }
  }

  /** De dónde viene la hoja que se está usando, en palabras. */
  origenHoja(): string {
    if (this.hojaElegida) {
      return `Elegida a mano: ${hojaPorKey(this.hojaElegida)?.nombre || this.hojaElegida}`;
    }
    const h = this.hojaDelPuesto();
    if (h) return `Por el puesto "${this.candidato?.puesto || '—'}": ${h.nombre}`;
    return 'El puesto de este candidato no tiene hoja asignada.';
  }

  resultadoStar() {
    return calcularPuntajeStar(this.candidato?.rubricaAptitudes, this.competenciasActivas());
  }

  nivelStarDe(key: string): NivelStar | null {
    return this.candidato?.rubricaAptitudes?.[key] || null;
  }
  puntosNivelStar(nivel: NivelStar): number {
    return NIVELES_STAR.find(n => n.id === nivel)?.puntos ?? 0;
  }
  etiquetaNivelStar(nivel: NivelStar): string {
    return NIVELES_STAR.find(n => n.id === nivel)?.label || '';
  }

  // APTITUDES: primero las CONGELADAS en el candidato (aptitudesConfig, si RH ya
  // generó el link), luego las propias del puesto, y por último el preset del tipo.
  getAptitudesActivas(): AptitudItem[] {
    if (Array.isArray(this.candidato?.aptitudesConfig) && this.candidato.aptitudesConfig.length) {
      return this.candidato.aptitudesConfig;
    }
    return resolverAptitudes(this.puestoDelCandidato()?.aptitudes, this.tipoVacante);
  }

  /**
   * Genera (y copia) el link público de evaluación de aptitudes para que RH se
   * lo comparta al jefe/gerente. Congela en el candidato la lista de aptitudes
   * (aptitudesConfig) para que el gerente evalúe exactamente lo que RH definió,
   * aunque el puesto cambie después.
   */
  async generarLinkAptitudes() {
    if (!this.candidato?.id || this.generandoLinkApt) return;
    this.generandoLinkApt = true;
    try {
      const competencias = this.competenciasActivas();
      if (!competencias.length) {
        this.toast.error('Este puesto no tiene una hoja de competencias. Asígnala en Vacantes (campo "Hoja de competencias").', 'Sin hoja');
        return;
      }
      await this.candidateService.updateCandidate(this.candidato.id, {
        competenciasConfig: competencias
      }, { marcarActividad: false });

      this.linkAptitudes = `${window.location.origin}/evaluar-aptitudes/${this.candidato.id}`;
      try {
        await navigator.clipboard.writeText(this.linkAptitudes);
        this.toast.exito('Link copiado. Compártelo por WhatsApp con el jefe/gerente que hará la entrevista técnica.', 'Link de evaluación listo');
      } catch {
        // clipboard bloqueado: el link queda visible para copiarlo a mano
        this.toast.info('Link generado. Cópialo del recuadro para compartirlo.', 'Link de evaluación');
      }
    } catch (e) {
      console.error('Error al generar el link de evaluación:', e);
      this.toast.error('No se pudo generar el link. Intenta de nuevo.', 'Error');
    } finally {
      this.generandoLinkApt = false;
    }
  }

  async copiarLinkAptitudes() {
    if (!this.linkAptitudes) return;
    try {
      await navigator.clipboard.writeText(this.linkAptitudes);
      this.toast.exito('Link copiado.', 'Listo');
    } catch {
      this.toast.info('Selecciona el texto del recuadro y cópialo manualmente.', 'Copiar link');
    }
  }

  // === Rúbrica: el reclutador marca un nivel por aptitud y el puntaje se calcula solo ===
  async seleccionarNivel(aptitudKey: string, nivel: NivelRubrica) {
    if (!this.candidato.rubricaAptitudes) this.candidato.rubricaAptitudes = {};
    // Si vuelve a tocar el mismo nivel, lo desmarca (toggle)
    if (this.candidato.rubricaAptitudes[aptitudKey] === nivel) {
      delete this.candidato.rubricaAptitudes[aptitudKey];
    } else {
      this.candidato.rubricaAptitudes[aptitudKey] = nivel;
    }
    // Recalcular puntaje y aprobado, y sincronizar con aptitudesResultados (para el dictamen)
    const calc = this.calcularPuntajeAptitudes();
    this.candidato.aptitudesResultados.puntaje  = calc.puntaje;
    this.candidato.aptitudesResultados.aprobado = calc.aprobado;
    // Persistir ambos campos
    try {
      await this.candidateService.updateCandidate(this.candidato.id, {
        rubricaAptitudes: this.candidato.rubricaAptitudes,
        aptitudesResultados: this.candidato.aptitudesResultados
      });
    } catch (e) {
      console.error('Error al guardar rúbrica:', e);
    }
  }

  calcularPuntajeAptitudes() {
    return calcularPuntajeRubrica(this.candidato?.rubricaAptitudes, this.getAptitudesActivas());
  }

  getNivelSeleccionado(aptitudKey: string): NivelRubrica | null {
    return this.candidato?.rubricaAptitudes?.[aptitudKey] || null;
  }

  // DICTAMEN: resultado final calculado
  calcularResultadoSugerido(): ResultadoDictamen {
    const d = this.candidato.dictamen || {};
    const todoOk =
      d.rh === 'aprobado' &&
      d.jefe === 'aprobado' &&
      d.documentos === 'completa' &&
      d.psicometria !== 'alto_riesgo' &&
      (d.competencias || 0) >= 70 &&
      (d.aptitudes || 0) >= 70;
    if (todoOk) return 'contratar';
    if (d.psicometria === 'alto_riesgo' || d.rh === 'rechazado' || d.jefe === 'rechazado') return 'rechazar';
    return 'bolsa';
  }

  aplicarResultadoSugerido() {
    const r = this.calcularResultadoSugerido();
    this.candidato.dictamen.resultado = r;
    this.guardarDictamen();
  }

  // PERMANENCIA
  getDiasPermanencia(): number {
    if (!this.candidato?.hiredAt) return 0;
    const f = typeof this.candidato.hiredAt.toDate === 'function' ? this.candidato.hiredAt.toDate() : new Date(this.candidato.hiredAt);
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    f.setHours(0, 0, 0, 0);
    return Math.max(0, Math.floor((hoy.getTime() - f.getTime()) / 86400000));
  }

  /**
   * Los hitos llegan a 90 días porque ese es el corte que mide Capital Humano
   * (ver la pantalla Permanencia). Paraban en 30 y dejaban fuera justo el tramo
   * donde se decide si la contratación sirvió: el segundo y el tercer mes.
   */
  getHitosPermanencia(): { label: string; dia: number; alcanzado: boolean }[] {
    const dias = this.getDiasPermanencia();
    return [
      { label: 'Día 1',   dia: 1,  alcanzado: dias >= 1 },
      { label: '7 días',  dia: 7,  alcanzado: dias >= 7 },
      { label: '30 días', dia: 30, alcanzado: dias >= 30 },
      { label: '60 días', dia: 60, alcanzado: dias >= 60 },
      { label: '90 días', dia: 90, alcanzado: dias >= 90 }
    ];
  }

  // ====== SUBIDA DE DOCUMENTOS ======
  //
  // Lo que pidió RH del área de contratados: cualquier tipo de archivo, más
  // peso, y poder soltar todos juntos. Antes se subía UNO a la vez y solo
  // PDF/JPG/PNG: un expediente de contratación son ocho o diez documentos, y
  // ocho vueltas al explorador de archivos es la razón por la que terminaban
  // llegando por WhatsApp.

  /**
   * Tope real por archivo. No lo inventa esta pantalla: es el límite de
   * Cloudinary para subidas SIN FIRMAR, que es como sube el portal (el archivo
   * va del navegador a Cloudinary, sin pasar por nuestro API). Se valida ANTES
   * de mandarlo: es preferible avisar al instante que esperar el viaje completo
   * de un archivo de 40 MB para recibir un error del servicio.
   *
   * Para pasar de aquí hay que firmar la subida desde el API.
   */
  readonly MAX_MB = 10;

  /** Progreso de la tanda: alimenta el "Subiendo 3 de 7…" del botón. */
  docsSubidos = 0;
  docsTotal = 0;

  /** Texto del botón de subida libre. */
  get etiquetaSubida(): string {
    if (!this.subiendoDoc) return '+ Agregar documentos';
    return this.docsTotal > 1 ? `Subiendo ${this.docsSubidos + 1} de ${this.docsTotal}…` : 'Subiendo…';
  }

  /** ¿El archivo cabe? Si no, lo dice con el nombre y el peso reales. */
  private cabe(f: File): boolean {
    if (f.size <= this.MAX_MB * 1024 * 1024) return true;
    this.toast.alerta(
      `"${f.name}" pesa ${(f.size / 1024 / 1024).toFixed(1)} MB y el tope por archivo es ${this.MAX_MB} MB.`,
      'El archivo pesa de más'
    );
    return false;
  }

  async subirDocumento(event: any) {
    const archivos: File[] = Array.from(event?.target?.files || []);
    if (!archivos.length || !this.candidato) return;

    // Los que se pasan del tope se avisan y se quedan fuera; los demás sí suben.
    // Cancelar la tanda completa por un archivo obligaría a repetir todo.
    const pesados = archivos.filter(f => f.size > this.MAX_MB * 1024 * 1024);
    const validos = archivos.filter(f => f.size <= this.MAX_MB * 1024 * 1024);
    if (pesados.length === 1) this.cabe(pesados[0]);
    else if (pesados.length > 1) {
      this.toast.alerta(
        `${pesados.map(f => f.name).join(', ')} — el tope por archivo es ${this.MAX_MB} MB.`,
        `${pesados.length} archivos pesan de más`
      );
    }
    if (!validos.length) { if (event?.target) event.target.value = ''; return; }

    this.subiendoDoc = true;
    this.docsTotal = validos.length;
    this.docsSubidos = 0;

    const nuevos: { nombre: string; url: string; fecha: string }[] = [];
    const fallidos: string[] = [];

    // De uno en uno a propósito: diez subidas en paralelo desde la conexión de
    // una sucursal se estorban entre ellas y empiezan a caerse por timeout.
    // Además así el contador avanza de verdad, en vez de saltar de 0 a 10.
    for (const f of validos) {
      try {
        const url = await this.candidateService.uploadDocument(f, this.candidato.id);
        nuevos.push({ nombre: f.name, url, fecha: new Date().toISOString() });
      } catch {
        fallidos.push(f.name);
      }
      this.docsSubidos++;
    }

    try {
      // Se guarda UNA sola vez con todo lo que sí subió: guardar por archivo
      // deja el expediente a medias si se corta la conexión a mitad de la tanda.
      if (nuevos.length) {
        const documentos = [...(this.candidato.documentos || []), ...nuevos];
        await this.candidateService.updateCandidate(this.candidato.id, { documentos });
        this.candidato.documentos = documentos;
      }
      if (fallidos.length) {
        this.toast.error(
          `No subieron: ${fallidos.join(', ')}. Vuelve a intentarlo solo con esos.`,
          nuevos.length ? 'Subieron algunos' : 'No se pudo subir'
        );
      } else if (nuevos.length > 1) {
        this.toast.exito(`Se agregaron ${nuevos.length} documentos al expediente.`, 'Listo');
      }
    } catch {
      this.toast.error('Los archivos se subieron pero no se pudieron guardar en el expediente.', 'No se guardó');
    } finally {
      this.subiendoDoc = false;
      this.docsTotal = 0;
      this.docsSubidos = 0;
      if (event?.target) event.target.value = '';
    }
  }

  // ====== PORTAFOLIO DE DOCUMENTOS DEL EXPEDIENTE ======

  /** Keys de los slots del portafolio, para separar lo que llega "suelto". */
  private readonly SLOT_KEYS = new Set(DOCUMENTOS_EXPEDIENTE.map(d => d.key));

  /** Archivo actual de un slot, con fallback a bot y a los campos del registro. */
  docExpediente(key: string): { url: string; nombre?: string; fecha?: string } | null {
    const e = this.candidato?.expedienteDocs?.[key];
    if (e?.url) return e;
    // Documento que el bot recibió por WhatsApp etiquetado con este tipo
    const bot = (this.candidato?.documentosBot || []).find((d: any) => d?.tipo === key && d?.url);
    if (bot) return { url: bot.url, nombre: bot.nombre || 'Recibido por WhatsApp', fecha: bot.recibidoEn };
    // Compatibilidad: CV y licencia pueden venir del alta del candidato
    if (key === 'cv' && this.candidato?.cvUrl) return { url: this.candidato.cvUrl, nombre: 'CV enviado al registrarse' };
    if (key === 'licencia' && this.candidato?.licenciaUrl) return { url: this.candidato.licenciaUrl, nombre: 'Enviada al registrarse' };
    return null;
  }

  /** Documentos del bot que no empatan con ningún slot conocido. */
  docsBotSueltos(): any[] {
    return (this.candidato?.documentosBot || []).filter((d: any) => d?.url && !this.SLOT_KEYS.has(d?.tipo));
  }

  /** Sube el archivo de un slot del portafolio (INE, contrato firmado, etc.). */
  async subirDocExpediente(key: string, event: any) {
    const file = event.target.files?.[0];
    if (!file || !this.candidato) return;
    // Un slot guarda un solo archivo: aquí no hay tanda, pero el tope es el mismo.
    if (!this.cabe(file)) { if (event?.target) event.target.value = ''; return; }

    this.subiendoDocKey = key;
    try {
      const url = await this.candidateService.uploadDocument(file, this.candidato.id);
      if (!this.candidato.expedienteDocs) this.candidato.expedienteDocs = {};
      this.candidato.expedienteDocs[key] = { nombre: file.name, url, fecha: new Date().toISOString() };
      await this.candidateService.updateCandidate(this.candidato.id, { expedienteDocs: this.candidato.expedienteDocs });
    } catch (error) {
      this.toast.error('Hubo un error al subir el archivo.', 'No se pudo subir');
    } finally {
      this.subiendoDocKey = null;
      if (event?.target) event.target.value = '';
    }
  }

  /** Cuántos documentos esperados ya están cargados (para el resumen del portafolio). */
  progresoExpediente(): { hechos: number; total: number } {
    const total = DOCUMENTOS_EXPEDIENTE.length;
    const hechos = DOCUMENTOS_EXPEDIENTE.filter(d => this.docExpediente(d.key)).length;
    return { hechos, total };
  }

  /** Normaliza el teléfono del candidato actual y, si es inválido, alerta */
  private obtenerNumeroValido(): string {
    if (!this.candidato) return '';
    const numero = normalizarTelefonoMX(this.candidato.telefono || '');
    if (!numero) {
      this.toast.alerta(
        `El teléfono guardado (${this.candidato.telefono || 'vacío'}) no es válido. Corrígelo en el expediente para poder enviar WhatsApp.`,
        `Teléfono de ${this.candidato.nombre} inválido`
      );
      return '';
    }
    return numero;
  }

  // WHATSAPP: conecta al candidato con el bot (le escribe desde el número oficial).
  contactarWhatsApp() {
    return this.botService.conectarConBot(this.candidato, this.enviandoInvitacion);
  }

  /** Carga (o refresca) el historial de la conversación del bot con el candidato. */
  async cargarConversacion(forzar = false) {
    if (!this.candidato?.id || this.cargandoConv) return;
    if (this.convCargada && !forzar) return;
    this.cargandoConv = true;
    this.convError = '';
    const r = await this.botService.obtenerConversacion(this.candidato.id);
    if (r.ok) {
      this.conversacion = r.mensajes || [];
      this.convCargada = true;
    } else {
      this.convError = r.error || 'No se pudo cargar la conversación';
    }
    this.cargandoConv = false;
  }

  /** Pide al bot que le solicite al candidato su documentación pendiente por WhatsApp.
   *  Manda los slots que AÚN faltan (key + label) para que el bot pida solo esos
   *  y, al clasificar cada archivo, lo acomode en su casillero del expediente. */
  solicitarDocumentosPorBot() {
    const pendientes = DOCUMENTOS_EXPEDIENTE
      .filter(d => !this.docExpediente(d.key))
      .map(d => ({ key: d.key, label: d.label }));
    const lista = pendientes.length ? pendientes : DOCUMENTOS_EXPEDIENTE.map(d => ({ key: d.key, label: d.label }));
    return this.botService.solicitarDocumentos(this.candidato, lista, this.pidiendoDocs);
  }

  /** Envía por WhatsApp el link único para que el candidato llene la Evaluación de Liderazgo en vivo */
  enviarEvaluacionPorWhatsApp() {
    const numero = this.obtenerNumeroValido();
    if (!numero) return;
    const link = `${window.location.origin}/evaluacion/${this.candidato.id}`;
    const msg =
`Hola ${this.candidato.nombre}, soy de Capital Humano de Mega Dulces.

Para continuar con tu evaluación, te pedimos contestar el cuestionario de Liderazgo desde tu celular en el siguiente enlace mientras estamos en la videollamada:

${link}

Son 12 preguntas breves. Responde con honestidad — veremos tus respuestas en tiempo real. ¡Gracias!`;
    window.open(`https://wa.me/52${numero}?text=${encodeURIComponent(msg)}`, '_blank');
  }

  /** Copia el link de la evaluación al portapapeles */
  copiarLinkEvaluacion() {
    if (!this.candidato) return;
    const link = `${window.location.origin}/evaluacion/${this.candidato.id}`;
    navigator.clipboard?.writeText(link).then(
      () => this.toast.exito('Link de evaluación copiado al portapapeles'),
      () => this.toast.error('No se pudo copiar el link')
    );
  }

  /** True si el candidato está respondiendo en vivo (actividad < 30 segundos) */
  get evaluacionEnVivo(): boolean {
    const t = this.candidato?.ultimaActividadCuestionario;
    if (!t) return false;
    const d = typeof t.toDate === 'function' ? t.toDate() : new Date(t);
    return (Date.now() - d.getTime()) < 30000;
  }

  /** Envía por WhatsApp el link único para que el candidato llene la solicitud electrónica */
  enviarSolicitudPorWhatsApp() {
    const numero = this.obtenerNumeroValido();
    if (!numero) return;
    const link = `${window.location.origin}/solicitud/${this.candidato.id}`;
    const msg =
`Hola ${this.candidato.nombre}, soy de Capital Humano de Mega Dulces.

Para continuar con tu proceso de selección, te pedimos completar tu Solicitud de Empleo electrónica en el siguiente enlace:

${link}

Son 8 pasos breves (≈ 5 minutos). Tu información se enviará directamente a nuestro equipo. ¡Gracias!`;
    window.open(`https://wa.me/52${numero}?text=${encodeURIComponent(msg)}`, '_blank');
  }

  /** Copia el link de la solicitud al portapapeles */
  copiarLinkSolicitud() {
    if (!this.candidato) return;
    const link = `${window.location.origin}/solicitud/${this.candidato.id}`;
    navigator.clipboard?.writeText(link).then(
      () => this.toast.exito('Link de solicitud copiado al portapapeles'),
      () => this.toast.error('No se pudo copiar el link')
    );
  }

  /** True si el candidato ya envió su solicitud electrónica */
  get tieneSolicitud(): boolean {
    return !!this.candidato?.solicitudElectronica?.enviadaAt;
  }

  /** Formatea la fecha de envío de la solicitud */
  fechaEnvioSolicitud(): string {
    const t = this.candidato?.solicitudElectronica?.enviadaAt;
    if (!t) return '';
    const d = typeof t.toDate === 'function' ? t.toDate() : new Date(t);
    return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  getInitials(nombre: string): string {
    if (!nombre) return '?';
    return nombre.trim().split(/\s+/).slice(0, 2).map(p => p.charAt(0).toUpperCase()).join('');
  }

  getAvatarColor(nombre: string): string {
    if (!nombre) return '#64748b';
    const colores = ['#f87171', '#fb923c', '#fbbf24', '#34d399', '#22d3ee', '#818cf8', '#c084fc', '#f472b6'];
    return colores[nombre.charCodeAt(0) % colores.length];
  }
}
