import { Component, Input, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { VozService } from '../../app/core/services/voz.service';

/**
 * Mapa de viseme ID (0-21) → intensidad de movimiento (0-10).
 *
 * Cuando Azure pronuncia una vocal abierta (A, O) la "boca" se abre más
 * que con una consonante (M, S). Usamos esto para mover el rostro: a
 * mayor apertura, mayor desplazamiento vertical y escala. Da la sensación
 * de que la cabeza se mueve naturalmente con cada sílaba.
 */
const INTENSIDAD_VISEMA: Record<number, number> = {
  0: 0,    // silencio
  1: 7,    // æ, ə, ʌ
  2: 10,   // ɑ (A abierta — máximo movimiento)
  3: 6,    // ɔ
  4: 4,    // ɛ, ʊ
  5: 4,    // ɝ
  6: 5,    // i, ih
  7: 5,    // w, u
  8: 6,    // o
  9: 10,   // aw
  10: 6,   // oy
  11: 9,   // ay
  12: 3,   // h
  13: 3,   // r
  14: 4,   // l
  15: 3,   // s, z
  16: 5,   // sh, ch
  17: 3,   // th
  18: 4,   // f, v
  19: 4,   // d, t, n
  20: 4,   // k, g, ng
  21: 2,   // p, b, m
};

/**
 * URL de la foto profesional de Dalia. Es una foto stock de mujer latina
 * profesional de Unsplash (CC0). Si en el futuro se quiere otra imagen,
 * basta con cambiar esta constante o pasar [src] al componente.
 *
 * Recomendación: subir una foto propia a Cloudinary y poner aquí esa URL,
 * para que no dependa de un servicio externo. Las dimensiones ideales
 * son 400x400 (cuadrada), enfocada en el rostro.
 */
export const AVATAR_URL =
  'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=500&h=500&fit=crop&crop=faces&q=85';

/**
 * Avatar de la asistente Dalia.
 *
 * - Foto real (sin lip-sync porque la voz de Azure ya es realista).
 * - Halo dorado pulsante mientras habla.
 * - Anillos expansivos y burbuja con ondas de audio.
 * - Respiración sutil cuando está en silencio.
 *
 * El lip-sync con visemas se eliminó: la boca animada en SVG quedaba
 * caricaturesca y rompía la imagen corporativa. La foto fija + halo
 * pulsante + ondas comunica claramente que está hablando sin caer en
 * el uncanny valley.
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

  /** URL de la foto. Permite override desde el padre. */
  @Input() src: string = AVATAR_URL;

  /**
   * Intensidad de movimiento actual (0-10) basada en el viseme de Azure.
   * Se expone vía CSS variable `--ah-i` y el CSS la traduce a transform.
   * Cuando NO está hablando, devuelve 0 (posición de reposo).
   */
  intensidad = computed(() => {
    if (!this.voz.hablando()) return 0;
    return INTENSIDAD_VISEMA[this.voz.visemeActual()] ?? 3;
  });
}
