import { Component, Input, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { VozService } from '../../app/core/services/voz.service';

/**
 * GIF (o MP4) del personaje guía de Mega Dulces.
 * Cambiar la URL aquí si se quiere reemplazar por otra animación.
 */
export const AVATAR_GIF_URL = 'https://i.imgur.com/6q3KMuz.gif';

/**
 * Avatar animado tipo MIDOT que aparece junto a la voz TTS.
 * - El GIF se reproduce siempre (animación natural del personaje)
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

  /** URL del GIF/MP4 a usar (por defecto el oficial). Permite override. */
  @Input() src: string = AVATAR_GIF_URL;
}
