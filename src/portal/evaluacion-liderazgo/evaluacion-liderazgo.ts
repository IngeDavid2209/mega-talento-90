import { Component, inject, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { CandidateService } from '../../app/core/services/candidate';
import { VozService } from '../../app/core/services/voz.service';
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
  // Público para el template (signals reactivos hablando() y habilitado())
  voz = inject(VozService);

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

  // Pantalla de bienvenida / selección de modo (con voz o sin voz)
  modoElegido = false;
  audioActivo = false;

  // Pantalla final
  terminado = false;

  private unsubscribe: any;
  private estiloHtmlOriginal = '';
  private estiloBodyOriginal = '';

  ngOnInit() {
    // El styles.css global pone overflow:hidden en html/body para el back-office.
    // Esta vista es pública y necesita scroll natural del documento.
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
        this.respuestas = data.cuestionarioLiderazgo || {};
        this.cargando = false;
      });
    });
  }

  ngOnDestroy() {
    if (this.unsubscribe) this.unsubscribe();
    this.voz.parar();
    // Restaurar los estilos del html/body al salir
    document.documentElement.style.cssText = this.estiloHtmlOriginal;
    document.body.style.cssText = this.estiloBodyOriginal;
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

  // ====== INICIO: elegir modo ======

  /** El candidato eligió empezar CON audio guiado */
  empezarConAudio() {
    this.modoElegido = true;
    this.audioActivo = true;
    // Desbloquear el navegador con un speak silencioso (este click cuenta como gesto)
    this.voz.desbloquear();
    // Después de un breve delay para que se cargue la voz, leer bienvenida + pregunta 1
    setTimeout(() => {
      const nombre = (this.candidato?.nombre || '').split(/\s+/)[0] || '';
      const saludo = nombre
        ? `Hola ${nombre}. Vas a contestar 12 preguntas. Responde con honestidad.`
        : 'Hola. Vas a contestar 12 preguntas. Responde con honestidad.';
      this.voz.hablar(saludo, {
        onEnd: () => this.leerPreguntaActual()
      });
    }, 350);
  }

  /** El candidato eligió empezar SIN audio (lectura normal) */
  empezarSinAudio() {
    this.modoElegido = true;
    this.audioActivo = false;
  }

  // ====== CONTROL DE VOZ DURANTE EL CUESTIONARIO ======

  /** Lee la pregunta actual + sus 5 opciones */
  leerPreguntaActual() {
    if (!this.audioActivo || !this.preguntaActual) return;
    const opciones = this.NIVELES_LIKERT
      .map(n => `${n.valor}: ${n.etiquetaCorta}`)
      .join('. ');
    const texto = `Pregunta ${this.paso} de ${this.TOTAL}. ${this.preguntaActual.texto} Las opciones son: ${opciones}.`;
    this.voz.hablar(texto);
  }

  /** Botón "Repetir": vuelve a leer la pregunta actual */
  repetir() {
    if (!this.audioActivo) return;
    this.leerPreguntaActual();
  }

  /** Botón "Silenciar / Activar" audio */
  toggleAudio() {
    this.voz.toggle();
    // Si reactivó y está en modo audio, leer la pregunta actual
    if (this.voz.habilitado() && this.audioActivo) {
      this.leerPreguntaActual();
    }
  }

  // ====== RESPUESTAS Y NAVEGACIÓN ======

  /** Guarda la respuesta y avanza automáticamente al siguiente paso */
  async responder(valor: number) {
    if (!this.candidatoId || !this.preguntaActual || this.guardando) return;
    this.guardando = true;

    const num = this.preguntaActual.num;
    this.respuestas = { ...this.respuestas, [num]: valor };

    try {
      await this.candidateService.updateCandidate(this.candidatoId, {
        cuestionarioLiderazgo: this.respuestas,
        ultimaActividadCuestionario: new Date()
      });

      // Avanzar al siguiente automáticamente
      setTimeout(() => {
        if (this.paso < this.TOTAL) {
          this.paso++;
          this.leerPreguntaActual();
        } else {
          if (this.todasContestadas()) {
            this.terminado = true;
            this.voz.parar();
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
    if (this.paso > 1) {
      this.paso--;
      this.leerPreguntaActual();
    }
  }

  siguiente() {
    if (this.paso < this.TOTAL) {
      this.paso++;
      this.leerPreguntaActual();
    } else if (this.todasContestadas()) {
      this.terminado = true;
      this.voz.parar();
    }
  }

  irAPaso(n: number) {
    if (n >= 1 && n <= this.TOTAL && n !== this.paso) {
      this.paso = n;
      this.leerPreguntaActual();
    }
  }
}
