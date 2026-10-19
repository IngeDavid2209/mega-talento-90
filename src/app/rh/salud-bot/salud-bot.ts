import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { BotService, SaludBot, AtoradoBot } from '../../core/services/bot.service';
import { ToastService } from '../../core/services/toast.service';

/**
 * =====================================================================
 * SALUD DEL BOT · ¿el bot de reclutamiento está atendiendo bien?
 * =====================================================================
 *
 * 19/10/2026. Dos fallas pasaron días sin que nadie se enterara: WhatsApp
 * bloqueó los envíos por un pago (04–08/10) y el bot repetía la misma pregunta
 * a candidatos que ya habían contestado. Aquí se ve en un vistazo:
 *
 *  · Atorados: a quién el bot ya no supo ayudar (repitió la pregunta 4 veces)
 *    o quién escribió *asesor*. Hay que escribirle por WhatsApp y marcarlo
 *    "Atendido". El menú muestra cuántos esperan.
 *  · Envíos, mensajes repetidos, personas sin respuesta y actividad del día.
 *
 * Los datos los arma la API (api/src/bot-salud.ts) con lo que guarda el bot.
 */
@Component({
  selector: 'app-salud-bot',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './salud-bot.html',
  styleUrl: './salud-bot.css'
})
export class SaludBotComponent implements OnInit {
  private bot = inject(BotService);
  private toast = inject(ToastService);
  private router = inject(Router);

  cargando = true;
  error = '';
  s: SaludBot | null = null;
  marcando = '';

  ngOnInit() { this.cargar(); }

  async cargar() {
    this.cargando = true;
    this.error = '';
    try {
      this.s = await this.bot.salud();
    } catch {
      this.error = 'No se pudo revisar al bot. Reintenta en un momento.';
    } finally {
      this.cargando = false;
    }
  }

  abrir(a: AtoradoBot) { this.router.navigate(['/app/expediente', a.id]); }

  /** Link para escribirle por WhatsApp desde el teléfono o WhatsApp Web. */
  wa(tel: string): string { return `https://wa.me/${String(tel || '').replace(/\D/g, '')}`; }

  motivo(a: AtoradoBot): string {
    return a.motivo === 'pidio_asesor' ? 'Pidió hablar con una persona' : 'El bot le repitió la pregunta 4 veces';
  }

  cuando(iso: string | null): string {
    if (!iso) return '—';
    const f = new Date(iso);
    if (isNaN(f.getTime())) return '—';
    return f.toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  }

  async atendido(a: AtoradoBot, ev: Event) {
    ev.stopPropagation();
    if (this.marcando) return;
    this.marcando = a.telefono;
    try {
      await this.bot.marcarAtendido(a.telefono);
      this.toast.exito(`${a.nombre} salió de la bandeja.`, 'Atendido');
      await this.cargar();
    } catch {
      this.toast.error('No se pudo marcar como atendido.', 'Error');
    } finally {
      this.marcando = '';
    }
  }
}
