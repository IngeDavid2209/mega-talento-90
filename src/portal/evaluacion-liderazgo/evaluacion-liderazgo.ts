import { Component, inject, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { CandidateService } from '../../app/core/services/candidate';
import { VozService } from '../../app/core/services/voz.service';
import { AvatarHablanteComponent } from '../avatar-hablante/avatar-hablante';
import {
  CUESTIONARIO_LIDERAZGO, NIVELES_LIKERT, RespuestasCuestionario
} from '../../app/core/models/cuestionario-liderazgo.model';
import { ID_ETAPAS } from '../../app/core/models/proceso.model';

@Component({
  selector: 'app-evaluacion-liderazgo',
  standalone: true,
  imports: [CommonModule, AvatarHablanteComponent],
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

  // Control de avance: solo se pasa a la siguiente pregunta cuando el audio de
  // la actual terminó. Si el candidato responde antes, el avance queda en
  // espera (esperandoFinAudio) y se dispara al terminar el audio.
  audioTerminado = false;
  private esperandoFinAudio = false;
  private avanzando = false;

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

    // Pre-carga el SDK de Azure y el token en background. Cuando el candidato
    // presione "Empezar" la voz arrancará casi instantáneamente.
    this.voz.precalentar();

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
    }, (err) => {
      this.ngZone.run(() => {
        this.cargando = false;
        this.error = err?.code === 'not-found'
          ? 'No encontramos tu evaluación. Solicita un nuevo enlace a Capital Humano de Mega Dulces.'
          : 'No se pudo cargar tu evaluación. Revisa tu conexión e intenta de nuevo. Si el problema sigue, avisa a Capital Humano.';
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
    // Guard: evitar que un doble-click dispare dos arranques en paralelo
    // (era una de las causas del audio solapado al iniciar).
    if (this.modoElegido) return;
    this.modoElegido = true;
    this.audioActivo = true;
    // Desbloquear el navegador con AudioContext (este click cuenta como gesto).
    this.voz.desbloquear();
    // Arranca directo con la pregunta 1. Sin saludo previo: el saludo encadenado
    // era la causa de las voces solapadas. La bienvenida ya está en texto en
    // pantalla, no hace falta repetirla con voz.
    setTimeout(() => this.leerPreguntaActual(), 120);
  }

  /** El candidato eligió empezar SIN audio (lectura normal) */
  empezarSinAudio() {
    this.modoElegido = true;
    this.audioActivo = false;
  }

  // ====== CONTROL DE VOZ DURANTE EL CUESTIONARIO ======

  /**
   * Lee la pregunta actual. Las opciones de respuesta SOLO se leen en la
   * primera pregunta (para explicar la escala una vez); de ahí en adelante se
   * lee únicamente el texto de la pregunta, porque el candidato ya conoce la
   * escala y a veces contesta rápido.
   */
  leerPreguntaActual() {
    // Nueva lectura: reinicia el estado de avance de la pregunta.
    this.audioTerminado = false;
    this.esperandoFinAudio = false;
    if (!this.audioActivo || !this.preguntaActual) return;
    let texto = `Pregunta ${this.paso} de ${this.TOTAL}. ${this.preguntaActual.texto}`;
    if (this.paso === 1) {
      const opciones = this.NIVELES_LIKERT
        .map(n => `${n.valor}: ${n.etiquetaCorta}`)
        .join('. ');
      texto += ` Las opciones son: ${opciones}.`;
    }
    this.voz.hablar(texto, {
      onEnd: () => this.ngZone.run(() => this.onAudioPreguntaTerminado())
    });
  }

  /** Llamado cuando el audio de la pregunta actual terminó de reproducirse. */
  private onAudioPreguntaTerminado() {
    this.audioTerminado = true;
    // Si el candidato ya había respondido, ahora sí avanzamos.
    if (this.esperandoFinAudio) {
      this.esperandoFinAudio = false;
      this.avanzar();
    }
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

  /**
   * Guarda la respuesta. El avance a la siguiente pregunta NO es inmediato:
   * solo ocurre cuando el audio de la pregunta actual termina de reproducirse.
   * Si el audio ya terminó (o el modo es sin voz), avanza enseguida.
   * NO se corta el audio en curso, por eso ya no se enciman las preguntas.
   */
  async responder(valor: number) {
    if (!this.candidatoId || !this.preguntaActual || this.guardando) return;
    this.guardando = true;

    const num = this.preguntaActual.num;
    this.respuestas = { ...this.respuestas, [num]: valor };

    try {
      await this.candidateService.updateCandidate(this.candidatoId, {
        cuestionarioLiderazgo: this.respuestas,
        ultimaActividadCuestionario: new Date()
      }, { marcarActividad: false }); // lo contesta el candidato, no cuenta como seguimiento de RH
    } catch (e) {
      console.error('Error al guardar respuesta:', e);
      this.error = 'No se pudo guardar. Revisa tu conexión.';
    } finally {
      this.guardando = false;
    }

    const audioEnCurso = this.audioActivo && this.voz.habilitado() && !this.audioTerminado;
    if (audioEnCurso) {
      // Esperar a que termine de leerse la pregunta antes de avanzar.
      this.esperandoFinAudio = true;
    } else {
      this.avanzar();
    }
  }

  /** Pasa a la siguiente pregunta (o termina). Protegido contra doble avance. */
  private avanzar() {
    if (this.avanzando) return;
    this.avanzando = true;
    this.esperandoFinAudio = false;
    if (this.paso < this.TOTAL) {
      this.paso++;
      this.leerPreguntaActual();
    } else if (this.todasContestadas()) {
      this.terminado = true;
      this.voz.parar();
      // Al completar la encuesta, el candidato pasa solo a la 2ª fase
      // (Entrevista Orientación Conductual). No bloquea la pantalla final.
      this.avanzarAConductual();
    }
    setTimeout(() => { this.avanzando = false; }, 50);
  }

  /**
   * Mueve al candidato a la etapa 2 (entrevista_rh) al terminar la encuesta.
   * Solo AVANZA: si ya está en Filtro Inicial (o 'nuevo'), lo sube; si ya va
   * más adelante, o fue rechazado/contratado, no lo toca. Es "mejor esfuerzo":
   * si falla, no rompe la pantalla de agradecimiento.
   */
  private async avanzarAConductual() {
    if (!this.candidatoId) return;
    const actual = this.candidato?.status;
    // Solo reubicamos a quienes siguen en la 1ª fase (o sin etapa / 'nuevo').
    if (actual && actual !== ID_ETAPAS.FILTRO && actual !== ID_ETAPAS.NUEVO) return;
    try {
      await this.candidateService.updateCandidate(
        this.candidatoId,
        { status: ID_ETAPAS.RH },
        { marcarActividad: false } // lo dispara el candidato, no es seguimiento de RH
      );
    } catch (e) {
      console.warn('No se pudo avanzar el candidato a Entrevista Orientación:', e);
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
