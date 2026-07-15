import { Component, inject, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { CandidateService } from '../../app/core/services/candidate';
import { BotService } from '../../app/core/services/bot.service';
import {
  AptitudItem, NivelRubrica, NIVELES_RUBRICA,
  resolverAptitudes, calcularPuntajeRubrica, UMBRAL_APROBACION_APTITUDES
} from '../../app/core/models/proceso.model';

/**
 * EVALUACIÓN DE APTITUDES · vista PÚBLICA (sin login).
 * La abre el jefe/gerente que entrevista al candidato, con un link que RH le
 * comparte: /evaluar-aptitudes/:id  (el id del candidato actúa como token,
 * mismo patrón que /evaluacion/:id y /solicitud/:id).
 *
 * El gerente califica cada aptitud (rúbrica 4/3/2/1), agrega su nombre y
 * observaciones, y al guardar:
 *   1. escribe la rúbrica + resultado en el candidato (update público),
 *   2. avisa al bot para que notifique a RH por WhatsApp.
 * RH sólo MONITOREA el resultado en el expediente; no captura esta entrevista.
 */
@Component({
  selector: 'app-evaluacion-aptitudes',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './evaluacion-aptitudes.html',
  styleUrl: './evaluacion-aptitudes.css'
})
export class EvaluacionAptitudesComponent implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private candidateService = inject(CandidateService);
  private botService = inject(BotService);
  private ngZone = inject(NgZone);

  NIVELES_RUBRICA = NIVELES_RUBRICA;
  UMBRAL = UMBRAL_APROBACION_APTITUDES;

  candidatoId: string | null = null;
  candidato: any = null;
  cargando = true;
  error = '';

  aptitudes: AptitudItem[] = [];
  rubrica: Record<string, NivelRubrica> = {};

  // Datos del evaluador
  evaluador = '';
  cargoEvaluador = '';
  tiempo = '';
  observaciones = '';

  guardando = false;
  terminado = false;

  private unsubscribe: any;
  private estiloHtmlOriginal = '';
  private estiloBodyOriginal = '';

  ngOnInit() {
    // El styles.css global pone overflow:hidden para el back-office; esta vista
    // es pública y necesita scroll natural del documento.
    this.estiloHtmlOriginal = document.documentElement.style.cssText;
    this.estiloBodyOriginal = document.body.style.cssText;
    document.documentElement.style.cssText = 'overflow: auto !important; height: auto !important; width: auto !important;';
    document.body.style.cssText = 'overflow: auto !important; height: auto !important; width: auto !important;';

    this.candidatoId = this.route.snapshot.paramMap.get('id');
    if (!this.candidatoId) {
      this.error = 'Link inválido. Solicita un nuevo enlace a Capital Humano de Mega Dulces.';
      this.cargando = false;
      return;
    }

    this.unsubscribe = this.candidateService.listenToCandidate(this.candidatoId, (data) => {
      this.ngZone.run(() => {
        this.candidato = data;
        // Aptitudes: primero las CONGELADAS al generar el link (aptitudesConfig),
        // si no, el preset del tipo de vacante del candidato.
        this.aptitudes = resolverAptitudes(data?.aptitudesConfig, data?.tipoVacante);
        // Precargar rúbrica previa si existe (permite corregir sin empezar de cero).
        if (!Object.keys(this.rubrica).length && data?.rubricaAptitudes) {
          this.rubrica = { ...data.rubricaAptitudes };
        }
        if (!this.evaluador && data?.aptitudesEval?.evaluador) this.evaluador = data.aptitudesEval.evaluador;
        if (!this.cargoEvaluador && data?.aptitudesEval?.cargoEvaluador) this.cargoEvaluador = data.aptitudesEval.cargoEvaluador;
        if (!this.tiempo && data?.aptitudesEval?.tiempo) this.tiempo = data.aptitudesEval.tiempo;
        if (!this.observaciones && data?.aptitudesEval?.observaciones) this.observaciones = data.aptitudesEval.observaciones;
        this.cargando = false;
      });
    }, (err) => {
      this.ngZone.run(() => {
        this.cargando = false;
        this.error = err?.code === 'not-found'
          ? 'No encontramos esta evaluación. Solicita un nuevo enlace a Capital Humano de Mega Dulces.'
          : 'No se pudo cargar la evaluación. Revisa tu conexión e intenta de nuevo.';
      });
    });
  }

  ngOnDestroy() {
    if (this.unsubscribe) this.unsubscribe();
    document.documentElement.style.cssText = this.estiloHtmlOriginal;
    document.body.style.cssText = this.estiloBodyOriginal;
  }

  get nombreCandidato(): string {
    return this.candidato?.nombre || 'el candidato';
  }
  get puestoCandidato(): string {
    return this.candidato?.puesto || '';
  }

  seleccionarNivel(key: string, nivel: NivelRubrica) {
    // Volver a tocar el mismo nivel lo deselecciona.
    if (this.rubrica[key] === nivel) {
      const copia = { ...this.rubrica };
      delete copia[key];
      this.rubrica = copia;
    } else {
      this.rubrica = { ...this.rubrica, [key]: nivel };
    }
  }

  nivelDe(key: string): NivelRubrica | null {
    return this.rubrica[key] || null;
  }

  get calc() {
    return calcularPuntajeRubrica(this.rubrica, this.aptitudes);
  }

  get todasCalificadas(): boolean {
    const c = this.calc;
    return c.total > 0 && c.calificadas === c.total;
  }

  get puedeGuardar(): boolean {
    return !!this.evaluador.trim() && this.todasCalificadas && !this.guardando;
  }

  async guardar() {
    if (!this.candidatoId || !this.puedeGuardar) return;
    this.guardando = true;
    this.error = '';
    const calc = this.calc;
    try {
      await this.candidateService.updateCandidate(this.candidatoId, {
        rubricaAptitudes: this.rubrica,
        aptitudesResultados: {
          puntaje: calc.puntaje,
          tiempo: this.tiempo.trim(),
          aprobado: calc.aprobado,
          notas: this.observaciones.trim()
        },
        aptitudesEval: {
          evaluador: this.evaluador.trim(),
          cargoEvaluador: this.cargoEvaluador.trim(),
          tiempo: this.tiempo.trim(),
          observaciones: this.observaciones.trim(),
          puntaje: calc.puntaje,
          aprobado: calc.aprobado,
          completadaEn: new Date().toISOString()
        }
      }, { marcarActividad: false }); // la captura el gerente, no es seguimiento de RH

      // Avisar al bot para que notifique a RH por WhatsApp (mejor esfuerzo).
      this.botService.avisarEvaluacionCompleta(this.candidatoId, {
        puntaje: calc.puntaje,
        aprobado: calc.aprobado
      });

      this.terminado = true;
    } catch (e: any) {
      console.error('Error al guardar la evaluación de aptitudes:', e);
      this.error = 'No se pudo guardar. Revisa tu conexión e intenta de nuevo.';
    } finally {
      this.guardando = false;
    }
  }
}
