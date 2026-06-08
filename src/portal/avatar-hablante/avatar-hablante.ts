import { Component, Input, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { VozService } from '../../app/core/services/voz.service';

/**
 * URL del personaje guía de Mega Dulces.
 * Si es MP4/WebM se usa <video autoplay loop muted>, si no <img>.
 * Imgur convierte GIFs a MP4 automáticamente — preferir .mp4 sobre
 * .gif porque Imgur a veces sirve thumbnails estáticos al hacer
 * hotlink de GIFs desde otro dominio.
 */
export const AVATAR_URL = 'https://i.imgur.com/6q3KMuz.mp4';

/**
 * Avatar animado tipo MIDOT que acompaña la voz TTS.
 * - El video/GIF se reproduce siempre (loop natural del personaje)
 * - Cuando VozService.hablando() está activo, se agregan efectos
 *   visuales adicionales: anillos dorados pulsantes + burbuja con
 *   ondas de audio + bounce sutil del marco
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

  /** URL del recurso a usar (GIF, MP4 o WebM). Permite override. */
  @Input() src: string = AVATAR_URL;

  /** True si el src termina en mp4/webm (usar <video>), false si es imagen */
  get esVideo(): boolean {
    const u = (this.src || '').toLowerCase().split('?')[0];
    return u.endsWith('.mp4') || u.endsWith('.webm') || u.endsWith('.mov');
  }
}
