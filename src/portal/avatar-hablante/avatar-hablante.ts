import { Component, Input, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { VozService } from '../../app/core/services/voz.service';

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
}
