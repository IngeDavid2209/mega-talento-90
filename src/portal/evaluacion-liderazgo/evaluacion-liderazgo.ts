import { Component, inject, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { CandidateService } from '../../app/core/services/candidate';
import {
  CUESTIONARIO_LIDERAZGO, NIVELES_LIKERT, RespuestasCuestionario
} from '../../app/core/models/cuestionario-liderazgo.model';

@Component({
  selector: 'app-evaluacion-liderazgo',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './evaluacion-liderazgo.html',
  styleUrl: './evaluacion-liderazgo.css'
})
export class EvaluacionLiderazgoComponent implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private candidateService = inject(CandidateService);
  private ngZone = inject(NgZone);

  CUESTIONARIO_LIDERAZGO = CUESTIONARIO_LIDERAZGO;
  NIVELES_LIKERT = NIVELES_LIKERT;

  candidatoId: string | null = null;
  candidato: any = null;
  cargando = true;
  error = '';

  paso = 1;
  TOTAL = CUESTIONARIO_LIDERAZGO.length;
  respuestas: RespuestasCuestionario = {};
  guardando = false;

  // Pantalla final
  terminado = false;

  private unsubscribe: any;

  ngOnInit() {
    this.candidatoId = this.route.snapshot.paramMap.get('id');
    if (!this.candidatoId) {
      this.error = 'Link inválido. Solicita un nuevo enlace a Capital Humano de Mega Dulces.';
      this.cargando = false;
      return;
    }

    // Escuchar en vivo el candidato (por si RH lo cierra o algo)
    this.unsubscribe = this.candidateService.listenToCandidate(this.candidatoId, (data) => {
      this.ngZone.run(() => {
        this.candidato = data;
        this.respuestas = data.cuestionarioLiderazgo || {};
        this.cargando = false;
      });
    });
  }

  ngOnDestroy() {
    if (this.unsubscribe) this.unsubscribe();
  }

  get preguntaActual() {
    return CUESTIONARIO_LIDERAZGO[this.paso - 1];
  }

  get progreso(): number {
    const contestadas = Object.keys(this.respuestas).filter(k => {
      const v = this.respuestas[Number(k)];
      return v && v >= 1 && v <= 5;
    }).length;
    return Math.round((contestadas / this.TOTAL) * 100);
  }

  get respuestaActual(): number | undefined {
    if (!this.preguntaActual) return undefined;
    return this.respuestas[this.preguntaActual.num];
  }

  /** Guarda la respuesta y avanza automáticamente al siguiente paso */
  async responder(valor: number) {
    if (!this.candidatoId || !this.preguntaActual || this.guardando) return;
    this.guardando = true;

    const num = this.preguntaActual.num;
    this.respuestas = { ...this.respuestas, [num]: valor };

    try {
      await this.candidateService.updateCandidate(this.candidatoId, {
        cuestionarioLiderazgo: this.respuestas,
        // Timestamp para el indicador "en vivo" del lado RH
        ultimaActividadCuestionario: new Date()
      });

      // Avanzar al siguiente automáticamente (mejor UX en móvil)
      setTimeout(() => {
        if (this.paso < this.TOTAL) {
          this.paso++;
        } else {
          // Última pregunta — verificar si todas están contestadas
          if (this.todasContestadas()) {
            this.terminado = true;
          }
        }
      }, 350);
    } catch (e) {
      console.error('Error al guardar respuesta:', e);
      this.error = 'No se pudo guardar. Revisa tu conexión.';
    } finally {
      setTimeout(() => this.guardando = false, 400);
    }
  }

  todasContestadas(): boolean {
    return CUESTIONARIO_LIDERAZGO.every(p => {
      const v = this.respuestas[p.num];
      return v && v >= 1 && v <= 5;
    });
  }

  anterior() {
    if (this.paso > 1) this.paso--;
  }

  siguiente() {
    if (this.paso < this.TOTAL) this.paso++;
    else if (this.todasContestadas()) this.terminado = true;
  }

  irAPaso(n: number) {
    if (n >= 1 && n <= this.TOTAL) this.paso = n;
  }
}
