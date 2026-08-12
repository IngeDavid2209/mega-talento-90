import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../app/core/services/api.service';
import { CENTROS_CHECADOR } from '../../app/core/models/sucursales.model';

/**
 * =====================================================================
 * SOLICITUD DE PERSONAL · la liga que se le manda a los encargados
 * =====================================================================
 *
 * Los encargados de sucursal piden personal por WhatsApp. Esa petición se
 * queda en un chat: nadie puede contestar cuántas hay abiertas, desde cuándo,
 * ni cuáles ya se cubrieron. Con esta liga —que abren desde el celular, sin
 * usuario ni contraseña— la petición entra al sistema desde el minuto uno y
 * aparece en Requisiciones junto con las demás.
 *
 * ── TRES DECISIONES ─────────────────────────────────────────────────
 *
 * 1. SIN CUENTA. Pedirle usuario a un encargado que hace esto una vez al mes
 *    es garantizar que siga pidiendo por WhatsApp. La liga es el trámite.
 *
 * 2. LO MÍNIMO INDISPENSABLE. Cuatro campos obligatorios: sucursal, puesto,
 *    cuántas personas y quién lo pide. Todo lo demás es opcional. Un
 *    formulario largo se abandona a la mitad y la petición vuelve al chat.
 *
 * 3. TERMINA CON UN FOLIO. No un "gracias" a secas: un número que el
 *    encargado puede citar cuando pregunte si ya lo vieron. Sin acuse, la
 *    siguiente pregunta llega igual por WhatsApp.
 */
@Component({
  selector: 'app-requisicion-publica',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './requisicion.html',
  styleUrl: './requisicion.css'
})
export class RequisicionPublicaComponent {
  private api = inject(ApiService);

  SUCURSALES = CENTROS_CHECADOR;
  MOTIVOS = [
    { id: 'nuevo',     label: 'Puesto nuevo' },
    { id: 'reemplazo', label: 'Reemplazo de alguien que se fue' },
    { id: 'temporal',  label: 'Temporal / eventual' },
    { id: 'otro',      label: 'Otro' },
  ];

  f = {
    sucursalId: '',
    puesto: '',
    vacantes: 1,
    motivo: 'nuevo',
    reemplazaA: '',
    fechaRequerida: '',
    solicita: '',
    justificacion: '',
  };

  enviando = false;
  error = '';
  folio: number | null = null;

  /** Hoy, para que no pidan personal "para ayer". */
  get hoy(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  async enviar() {
    if (this.enviando) return;
    this.error = '';

    if (!this.f.sucursalId) { this.error = 'Dinos de qué sucursal es la solicitud.'; return; }
    if (!this.f.puesto.trim()) { this.error = 'Falta el puesto que necesitas.'; return; }
    if (!this.f.solicita.trim()) { this.error = 'Escribe tu nombre para saber quién lo está pidiendo.'; return; }

    this.enviando = true;
    try {
      const r = await this.api.post<{ ok: boolean; folio: number }>('/requisiciones/publica', this.f);
      this.folio = r.folio;
    } catch (e: any) {
      this.error = e?.error?.error || 'No se pudo enviar. Revisa tu conexión e intenta de nuevo.';
    } finally {
      this.enviando = false;
    }
  }

  /** Para levantar otra sin recargar: el encargado suele pedir dos de golpe. */
  otra() {
    this.folio = null;
    this.f = { ...this.f, puesto: '', vacantes: 1, reemplazaA: '', justificacion: '' };
  }
}
