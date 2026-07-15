import { Component, inject, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { CandidateService } from '../../app/core/services/candidate';
import { BotService } from '../../app/core/services/bot.service';
import {
  CompetenciaStar, NivelStar, NIVELES_STAR, calcularPuntajeStar
} from '../../app/core/models/proceso.model';
import { hojaPorNombrePuesto } from '../../app/core/models/competencias-puesto.model';

/**
 * EVALUACIÓN DE APTITUDES · vista PÚBLICA (sin login) · formato STAR oficial.
 * La abre el jefe/gerente que entrevista al candidato con el link que RH le
 * comparte: /evaluar-aptitudes/:id (el id del candidato actúa como token).
 *
 * Cada competencia trae su pregunta STAR y 3 descripciones ancla (5/8/10) para
 * guiar la calificación. Total /150 (15 competencias × 10) con banda de
 * resultado. Al guardar: escribe la rúbrica + resultado en el candidato y avisa
 * al bot para que notifique a RH por WhatsApp.
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

  NIVELES_STAR = NIVELES_STAR;

  candidatoId: string | null = null;
  candidato: any = null;
  cargando = true;
  error = '';

  competencias: CompetenciaStar[] = [];
  rubrica: Record<string, NivelStar> = {};

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
        // Competencias: primero las CONGELADAS al generar el link
        // (competenciasConfig), si no, la hoja oficial que coincide por el
        // nombre del puesto del candidato.
        if (Array.isArray(data?.competenciasConfig) && data.competenciasConfig.length) {
          this.competencias = data.competenciasConfig;
        } else {
          this.competencias = hojaPorNombrePuesto(data?.puesto)?.competencias || [];
        }
        // Precargar rúbrica previa si existe (permite corregir sin empezar de cero).
        if (!Object.keys(this.rubrica).length && data?.rubricaAptitudes) {
          this.rubrica = { ...data.rubricaAptitudes };
        }
        const ev = data?.aptitudesEval;
        if (ev) {
          if (!this.evaluador) this.evaluador = ev.evaluador || '';
          if (!this.cargoEvaluador) this.cargoEvaluador = ev.cargoEvaluador || '';
          if (!this.tiempo) this.tiempo = ev.tiempo || '';
          if (!this.observaciones) this.observaciones = ev.observaciones || '';
        }
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

  get nombreCandidato(): string { return this.candidato?.nombre || 'el candidato'; }
  get puestoCandidato(): string { return this.candidato?.puesto || ''; }
  get sinCompetencias(): boolean { return !this.cargando && this.competencias.length === 0; }

  /** Ancla (descripción) de un nivel para una competencia. */
  ancla(c: CompetenciaStar, nivel: NivelStar): string {
    return c.anclas ? (c.anclas as any)[nivel] : '';
  }

  seleccionarNivel(key: string, nivel: NivelStar) {
    if (this.rubrica[key] === nivel) {
      const copia = { ...this.rubrica };
      delete copia[key];
      this.rubrica = copia;
    } else {
      this.rubrica = { ...this.rubrica, [key]: nivel };
    }
  }

  nivelDe(key: string): NivelStar | null {
    return this.rubrica[key] || null;
  }

  get calc() {
    return calcularPuntajeStar(this.rubrica, this.competencias);
  }

  get puedeGuardar(): boolean {
    return !!this.evaluador.trim() && this.calc.completa && !this.guardando;
  }

  async guardar() {
    if (!this.candidatoId || !this.puedeGuardar) return;
    this.guardando = true;
    this.error = '';
    const calc = this.calc;
    // aprobado = al menos "Recomendable" (banda verde o verde-claro)
    const aprobado = calc.pct >= 76.667;
    try {
      await this.candidateService.updateCandidate(this.candidatoId, {
        rubricaAptitudes: this.rubrica,
        aptitudesResultados: {
          puntaje: calc.puntaje,
          max: calc.max,
          pct: calc.pct,
          tiempo: this.tiempo.trim(),
          aprobado,
          banda: calc.banda.label,
          notas: this.observaciones.trim()
        },
        aptitudesEval: {
          evaluador: this.evaluador.trim(),
          cargoEvaluador: this.cargoEvaluador.trim(),
          tiempo: this.tiempo.trim(),
          observaciones: this.observaciones.trim(),
          puntaje: calc.puntaje,
          max: calc.max,
          pct: calc.pct,
          banda: calc.banda.label,
          aprobado,
          completadaEn: new Date().toISOString()
        }
      }, { marcarActividad: false }); // la captura el gerente, no es seguimiento de RH

      // Avisar al bot para que notifique a RH por WhatsApp (mejor esfuerzo).
      this.botService.avisarEvaluacionCompleta(this.candidatoId, {
        puntajeTexto: `${calc.puntaje}/${calc.max}`,
        resultado: calc.banda.label
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
