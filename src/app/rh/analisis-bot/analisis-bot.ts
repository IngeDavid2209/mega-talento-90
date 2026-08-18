import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * =====================================================================
 * ANÁLISIS DEL CV CONTRA LA VACANTE — el juicio del bot, como reclutador
 * =====================================================================
 *
 * El bot lee el CV del candidato, lo compara con la vacante a la que se postuló
 * y deja su juicio en `portal_data.dictamen`. Llega aquí completo porque el API
 * derrama `portal_data` dentro del objeto del candidato.
 *
 * ── QUÉ MUESTRA, Y POR QUÉ EN ESE ORDEN ──
 *
 *   1. El SEMÁFORO como botón (Excelente / Bueno / Regular / No encaja).
 *   2. La CRÍTICA en 2-3 renglones: lo que se lee en diez segundos.
 *   3. POR QUÉ DESTACARÍA EN ESTE PUESTO — la pregunta que el puntaje no
 *      contesta: entre dos candidatos con 78, ¿por qué me quedo con este?
 *   4. Fortalezas y lo que hay que validar en entrevista.
 *
 * ── TRES DECISIONES QUE SOSTIENEN ESTO ──
 *
 * · EL SEMÁFORO NO SE CALCULA AQUÍ. Lo deriva el bot de su veredicto y su
 *   puntaje. Si esta pantalla lo recalculara por su cuenta, tarde o temprano
 *   las dos cuentas se separarían y RH tendría dos verdades enfrente sin saber
 *   a cuál creerle — que es exactamente el problema que ya obligó a escribir
 *   `nivelCoherente` en el bot. Aquí solo se pinta.
 *
 * · ES UN BOTÓN, NO UNA ETIQUETA. Un "78/100" suelto no le dice nada a nadie:
 *   el estatus solo sirve si puedes abrir el porqué en el mismo lugar.
 *
 * · "NO ENCAJA" HABLA DE LA VACANTE, NO DE LA PERSONA. Se lee al lado del
 *   nombre de alguien real, y esa misma persona puede ser excelente para otra
 *   de nuestras vacantes. Por eso tampoco va en rojo: no es una falta suya.
 *
 * Vive aparte de `expediente` por el mismo motivo que `status-proceso`: ese
 * archivo es el más grande del back-office y su CSS ya venía rozando el tope
 * del presupuesto de Angular (44 de 45 kB). Meterle esto lo habría reventado.
 */

type EstatusUI = { texto: string; clase: string; ayuda: string };

const ESTATUS_UI: Record<string, EstatusUI> = {
  excelente: { texto: 'Excelente', clase: 'est-excelente', ayuda: 'Cumple de sobra el perfil de la vacante' },
  bueno:     { texto: 'Bueno',     clase: 'est-bueno',     ayuda: 'Cumple el perfil; vale la pena entrevistarlo' },
  regular:   { texto: 'Regular',   clase: 'est-regular',   ayuda: 'Cumple a medias; hay dudas que resolver en entrevista' },
  no_encaja: { texto: 'No encaja', clase: 'est-noencaja',  ayuda: 'No encaja con ESTA vacante; puede servir para otra' },
  sin_datos: { texto: 'Sin evaluar', clase: 'est-sindatos', ayuda: 'Falta su CV o no se pudo analizar. No es un juicio sobre el candidato.' },
};

@Component({
  selector: 'app-analisis-bot',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './analisis-bot.html',
  styleUrl: './analisis-bot.css',
})
export class AnalisisBotComponent {
  @Input() candidato: any;

  abierto = false;
  toggle() { this.abierto = !this.abierto; }

  private get d(): any { return this.candidato?.dictamen || null; }

  /** El semáforo listo para pintar, o null si este candidato no tiene análisis. */
  get estatus(): (EstatusUI & { clave: string; puntaje: number | null }) | null {
    const d = this.d;
    if (!d) return null;
    // Los dictámenes viejos no traen `estatus`. Antes que no mostrar nada, se
    // deduce del veredicto que sí tienen, con el MISMO criterio del bot
    // (src/dictamen.js::estatusDe). En cuanto se recalculan, viene ya hecho.
    const clave: string | null = d.estatus || (
      d.cv_leido === false ? 'sin_datos'
        : d.recomendacion === 'entrevistar' ? ((d.puntaje ?? 0) >= 85 ? 'excelente' : 'bueno')
        : d.recomendacion === 'dudoso' ? 'regular'
        : d.recomendacion === 'descartar' ? 'no_encaja'
        : null
    );
    if (!clave) return null;
    return { clave, ...(ESTATUS_UI[clave] || ESTATUS_UI['sin_datos']), puntaje: d.puntaje ?? null };
  }

  get critica(): string { return this.d?.critica || ''; }

  /** Puede venir VACÍO a propósito: el bot no le inventa virtudes a un
   *  candidato del montón, y decirlo es más útil que rellenar. */
  get destaca(): string[] { return this.d?.destaca_en_puesto || []; }

  get fortalezas(): string[] { return this.d?.fortalezas || []; }

  get riesgos(): { riesgo: string; severidad: string }[] {
    // Los dictámenes v1 guardaban texto plano; los nuevos, objeto con severidad.
    return (this.d?.riesgos || []).map((x: any) =>
      (typeof x === 'string' ? { riesgo: x, severidad: 'media' } : x));
  }

  get sinCV(): boolean { return this.d?.cv_leido === false; }

  get puesto(): string { return this.candidato?.puesto || 'el puesto solicitado'; }
}
