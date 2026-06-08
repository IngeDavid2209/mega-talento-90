import { Component, Input, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { VozService } from '../../app/core/services/voz.service';

/**
 * Mapa de los 22 visemas de Azure (0-21) a 7 formas de boca distintas.
 *
 * Tabla oficial Azure:
 *   0  silencio                         → CLOSED
 *   1  æ, ə, ʌ                          → MEDIUM
 *   2  ɑ (a abierta)                    → WIDE
 *   3  ɔ (o abierta)                    → ROUND
 *   4  ɛ, ʊ                             → SMALL
 *   5  ɝ                                → SMALL
 *   6  y, i, ih, ix                     → SMILE (sonrisa con dientes)
 *   7  w, u                             → ROUND
 *   8  o                                → ROUND
 *   9  aw                               → WIDE
 *   10 oy                               → ROUND
 *   11 ay                               → WIDE
 *   12 h                                → SMALL
 *   13 r                                → SMALL
 *   14 l                                → SMALL
 *   15 s, z                             → SMILE (dientes apretados)
 *   16 sh, ch, jh, zh                   → ROUND
 *   17 th, dh                           → SMALL
 *   18 f, v                             → BITE (labio inferior contra dientes)
 *   19 d, t, n                          → SMALL
 *   20 k, g, ng                         → SMALL
 *   21 p, b, m                          → CLOSED
 */
const VISEMA_A_FORMA: Record<number, FormaBoca> = {
  0: 'closed',  21: 'closed',
  1: 'medium',
  2: 'wide',    9: 'wide',   11: 'wide',
  3: 'round',   7: 'round',   8: 'round',  10: 'round',  16: 'round',
  4: 'small',   5: 'small',  12: 'small',  13: 'small',  14: 'small',
                17: 'small', 19: 'small',  20: 'small',
  6: 'smile',  15: 'smile',
  18: 'bite'
};

type FormaBoca = 'closed' | 'small' | 'medium' | 'wide' | 'round' | 'smile' | 'bite';

/**
 * Avatar "Dalia" 100% SVG con lip-sync real basado en visemas de Azure.
 *
 * - Cara estática (mujer profesional, paleta corporativa navy + dorado).
 * - La BOCA se anima en tiempo real reaccionando a VozService.visemeActual().
 * - Si el motor TTS no envía visemas (caso fallback nativo), la boca abre
 *   y cierra en loop suave mientras dura el habla.
 * - Parpadeo automático cada ~4s para dar vida.
 *
 * Compatible con la API anterior: <app-avatar-hablante size="lg|md|sm">.
 */
@Component({
  selector: 'app-avatar-hablante',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './avatar-hablante.html',
  styleUrl: './avatar-hablante.css'
})
export class AvatarHablanteComponent {
  voz = inject(VozService);

  /** Tamaño visual: 'sm' | 'md' | 'lg' */
  @Input() size: 'sm' | 'md' | 'lg' = 'md';

  /**
   * Forma actual de la boca (computado a partir del viseme de Azure).
   * Si no está hablando → siempre 'closed'.
   * Si habla pero no hay viseme (TTS nativo sin visemas) → la animación
   *  CSS .ah-talking-mock se encarga (alterna small/medium con keyframes).
   */
  forma = computed<FormaBoca>(() => {
    if (!this.voz.hablando()) return 'closed';
    const id = this.voz.visemeActual();
    return VISEMA_A_FORMA[id] ?? 'closed';
  });

  /** True si estamos en modo "habla sin visemas" (TTS nativo del navegador). */
  hablandoSinVisemas = computed(() => {
    return this.voz.hablando() && this.voz.visemeActual() === 0;
  });
}
