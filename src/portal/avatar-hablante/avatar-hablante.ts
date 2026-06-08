import { Component, ElementRef, Input, ViewChild, effect, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { VozService } from '../../app/core/services/voz.service';

/**
 * URL del personaje guía de Mega Dulces.
 * Si es MP4/WebM se usa <video>, si no <img>.
 * Imgur convierte GIFs a MP4 automáticamente — preferir .mp4 sobre
 * .gif porque Imgur a veces sirve thumbnails estáticos al hacer
 * hotlink de GIFs desde otro dominio.
 */
export const AVATAR_URL = 'https://i.imgur.com/6q3KMuz.mp4';

/**
 * Avatar animado tipo MIDOT sincronizado con la voz TTS.
 * - Cuando VozService.hablando() está TRUE → el video reproduce
 * - Cuando es FALSE → el video se pausa y vuelve al primer frame
 *   (queda quieto en pose neutral)
 * - Mientras habla, además se muestran anillos dorados pulsantes
 *   y burbuja con ondas de audio debajo
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

  @ViewChild('videoEl') videoEl?: ElementRef<HTMLVideoElement>;

  constructor() {
    // Sincronización: reproducir el video solo cuando la voz está hablando
    effect(() => {
      const hablando = this.voz.hablando();
      const video = this.videoEl?.nativeElement;
      if (!video || !this.esVideo) return;

      if (hablando) {
        // play() devuelve una Promise que puede fallar si el navegador
        // no permite autoplay aún (sin gesto del usuario). Lo ignoramos
        // porque en este punto la voz ya está activa (con gesto previo).
        video.play().catch(() => {});
      } else {
        try {
          video.pause();
          video.currentTime = 0; // volver al primer frame (pose neutral)
        } catch {}
      }
    });
  }

  /** True si el src termina en mp4/webm (usar <video>), false si es imagen */
  get esVideo(): boolean {
    const u = (this.src || '').toLowerCase().split('?')[0];
    return u.endsWith('.mp4') || u.endsWith('.webm') || u.endsWith('.mov');
  }
}
