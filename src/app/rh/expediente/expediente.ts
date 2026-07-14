import { Component, inject, OnInit, NgZone, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { CandidateService } from '../../core/services/candidate';
import { Timestamp } from 'firebase/firestore';
import {
  ETAPAS, ID_ETAPAS, FLUJO_LINEAL, EstadoCheck,
  COMPETENCIAS_STAR, APTITUDES_POR_TIPO,
  PSICOMETRIA_ITEMS, CHECKLIST_JEFE, CHECKLIST_DOCUMENTAL,
  CHECKLIST_OFERTA, CHECKLIST_CONTRATADO, AREAS_DICTAMEN,
  DOCUMENTOS_EXPEDIENTE,
  ItemChecklist, ResultadoDictamen, AptitudItem,
  NIVELES_RUBRICA, NivelRubrica, UMBRAL_APROBACION_APTITUDES,
  calcularPuntajeRubrica,
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

@Component({
  selector: 'app-expediente',
  standalone: true,
  imports: [CommonModule, FormsModule],
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

    // Al completar las 12 preguntas Y CALIFICAR (>= umbral), avanza a la 2ª fase
    // (Entrevista Orientación), igual que cuando el candidato la contesta por su
    // cuenta. Solo si sigue en Filtro Inicial (o 'nuevo'): no retrocede a quien
    // ya va más adelante. Si completó pero NO calificó, se queda en Filtro.
    const estado = this.candidato.status;
    const debeAvanzar = calificaEnEvaluacion(r) && (!estado || estado === ID_ETAPAS.FILTRO || estado === ID_ETAPAS.NUEVO);

    const payload: any = {
      cuestionarioLiderazgo: this.candidato.cuestionarioLiderazgo,
      dictamen: this.candidato.dictamen
    };
    if (debeAvanzar) payload.status = ID_ETAPAS.RH;

    try {
      await this.candidateService.updateCandidate(this.candidato.id, payload);
      if (debeAvanzar) this.candidato.status = ID_ETAPAS.RH;
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

  puedeMoverA(nuevaEtapa: string): { ok: boolean; faltan: string[] } {
    if (nuevaEtapa !== ID_ETAPAS.CONTRATADO) return { ok: true, faltan: [] };
    if (checklistCompleto(this.candidato.ofertaChecklist, CHECKLIST_OFERTA)) return { ok: true, faltan: [] };
    return {
      ok: false,
      faltan: itemsFaltantes(this.candidato.ofertaChecklist, CHECKLIST_OFERTA).map(i => i.label)
    };
  }

  async moverEtapaDirecto(nuevaEtapa: string) {
    if (!this.candidato || this.candidato.status === nuevaEtapa) return;

    const v = this.puedeMoverA(nuevaEtapa);
    if (!v.ok) {
      this.mensajeBloqueo = { titulo: `No se puede contratar a ${this.candidato.nombre}`, faltantes: v.faltan };
      return;
    }

    const actualizacion: any = { status: nuevaEtapa };
    if (nuevaEtapa === ID_ETAPAS.CONTRATADO) actualizacion.hiredAt = Timestamp.now();
    if (nuevaEtapa === ID_ETAPAS.RECHAZADO) actualizacion.rejectedAt = Timestamp.now();
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

  // APTITUDES por tipo — ahora regresan objetos {key, label, criterio}
  getAptitudesActivas(): AptitudItem[] {
    return APTITUDES_POR_TIPO[this.tipoVacante] || [];
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

  getHitosPermanencia(): { label: string; dia: number; alcanzado: boolean }[] {
    const dias = this.getDiasPermanencia();
    return [
      { label: 'Día 1',   dia: 1,  alcanzado: dias >= 1 },
      { label: '3 días',  dia: 3,  alcanzado: dias >= 3 },
      { label: '7 días',  dia: 7,  alcanzado: dias >= 7 },
      { label: '15 días', dia: 15, alcanzado: dias >= 15 },
      { label: '30 días', dia: 30, alcanzado: dias >= 30 }
    ];
  }

  // SUBIDA DOCS
  async subirDocumento(event: any) {
    const file = event.target.files[0];
    if (!file || !this.candidato) return;

    this.subiendoDoc = true;
    try {
      const url = await this.candidateService.uploadDocument(file, this.candidato.id);
      const nuevoDoc = { nombre: file.name, url, fecha: new Date().toISOString() };
      const documentos = this.candidato.documentos || [];
      documentos.push(nuevoDoc);
      await this.candidateService.updateCandidate(this.candidato.id, { documentos });
    } catch (error) {
      this.toast.error('Hubo un error al subir el archivo.', 'No se pudo subir');
    } finally {
      this.subiendoDoc = false;
      event.target.value = '';
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
