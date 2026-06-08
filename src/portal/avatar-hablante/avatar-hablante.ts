import { Component, Input, OnDestroy, effect, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { VozService } from '../../app/core/services/voz.service';

/**
 * Sprites del personaje guía de Mega Dulces. Cambiar las URLs aquí
 * si se quieren reemplazar por otras imágenes (mantener los 4 estados).
 */
export const SPRITES_AVATAR = {
  cerrada: 'https://i.imgur.com/P7IRrvD.jpeg',
  media:   'https://i.imgur.com/vyVRQbs.jpeg',
  abierta: 'https://i.imgur.com/27JXarO.jpeg',
  sonrisa: 'https://i.imgur.com/bnb1mCm.jpeg'
};

type EstadoBoca = 'cerrada' | 'media' | 'abierta' | 'sonrisa';

/**
 * Avatar animado tipo MIDOT que sincroniza la boca con la voz TTS.
 * Mientras VozService.hablando() es true, alterna entre los sprites
 * cerrada/media/abierta cada ~130ms para simular movimiento de labios.
 * Cuando termina de hablar, muestra el sprite 'sonrisa' brevemente
 * y vuelve a 'cerrada' para el estado idle.
 */
@Component({
  selector: 'app-avatar-hablante',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './avatar-hablante.html',
  styleUrl: './avatar-hablante.css'
})
export class AvatarHablanteComponent implements OnDestroy {
  voz = inject(VozService);

  /** Tamaño visual: 'sm' | 'md' | 'lg' */
  @Input() size: 'sm' | 'md' | 'lg' = 'md';

  /** Sprites a usar (por defecto los oficiales del catálogo). Permite override. */
  @Input() sprites: typeof SPRITES_AVATAR = SPRITES_AVATAR;

  estadoActual: EstadoBoca = 'cerrada';

  private cicloId: any = null;
  private timeoutSonrisa: any = null;

  constructor() {
    // Reaccionar al signal hablando() de VozService
    effect(() => {
      const hablando = this.voz.hablando();
      if (hablando) {
        this.iniciarCicloBoca();
      } else {
        this.pararCicloBoca();
        this.mostrarSonrisaBreve();
      }
    });
  }

  ngOnDestroy() {
    this.pararCicloBoca();
    if (this.timeoutSonrisa) clearTimeout(this.timeoutSonrisa);
  }

  /** Alterna entre los 3 sprites de boca a velocidad de fonemas */
  private iniciarCicloBoca() {
    if (this.cicloId) return;
    if (this.timeoutSonrisa) {
      clearTimeout(this.timeoutSonrisa);
      this.timeoutSonrisa = null;
    }
    // Secuencia natural: cerrada-media-abierta-media-cerrada (con algo de azar)
    const opciones: EstadoBoca[] = ['media', 'abierta', 'cerrada', 'media', 'abierta', 'media'];
    let i = 0;
    this.estadoActual = 'media';
    this.cicloId = setInterval(() => {
      this.estadoActual = opciones[i % opciones.length];
      i++;
    }, 130);
  }

  private pararCicloBoca() {
    if (this.cicloId) {
      clearInterval(this.cicloId);
      this.cicloId = null;
    }
  }

  /** Después de hablar, muestra una sonrisa por 700ms antes del idle */
  private mostrarSonrisaBreve() {
    this.estadoActual = 'sonrisa';
    if (this.timeoutSonrisa) clearTimeout(this.timeoutSonrisa);
    this.timeoutSonrisa = setTimeout(() => {
      if (!this.voz.hablando()) this.estadoActual = 'cerrada';
      this.timeoutSonrisa = null;
    }, 700);
  }
}
