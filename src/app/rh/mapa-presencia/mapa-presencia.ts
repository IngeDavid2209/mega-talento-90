import { Component, inject, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import * as L from 'leaflet';
import { ChecadorService, Presencia, PlazaPresencia } from '../../core/services/checador.service';
import { centroChecadorPorId } from '../../core/models/sucursales.model';
import { ToastService } from '../../core/services/toast.service';

/**
 * DÓNDE ESTÁ CADA QUIEN, AHORA.
 *
 * Un mapa con las plazas y cuánta gente hay dentro de cada una. Todo el cálculo
 * vive en `api/src/agente-horarios/presencia.ts`, incluidas las dos trampas que
 * lo vuelven falso si se contesta a lo bruto (marcas duplicadas que invierten la
 * paridad, y la salida que el lector no leyó). Aquí solo se pinta.
 *
 * ══ UNA PLAZA SIN COORDENADAS NO SE PINTA ══
 *
 * Sale en la lista de al lado, con su gente completa. Es a propósito: un pin en
 * el lugar equivocado se ve exactamente igual de convincente que uno correcto, y
 * de ahí no se vuelve. Cuando alguien capture su `lat`/`lng` en
 * `sucursales.model.ts`, aparece sola.
 *
 * ══ EL CONTADOR DICE SI ES VIEJO ══
 *
 * Si el reloj de una plaza lleva rato mudo, su número no es de ahorita sino de
 * la última vez que reportó, y la tarjeta lo dice. La regla del módulo es que la
 * pantalla nunca debe parecer al día cuando no lo está, y un mapa es justo el
 * tipo de vista que invita a creerle sin preguntar.
 */
@Component({
  selector: 'app-mapa-presencia',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './mapa-presencia.html',
  styleUrl: './mapa-presencia.css',
})
export class MapaPresenciaComponent implements OnInit, OnDestroy {
  private api = inject(ChecadorService);
  private toast = inject(ToastService);

  datos: Presencia | null = null;
  cargando = true;
  error = '';
  /** La plaza cuya lista de gente está abierta. */
  abierta: string | null = null;

  private mapa: L.Map | null = null;
  private capa: L.LayerGroup | null = null;
  private timer: any = null;

  /** Cada minuto: es la misma cadencia con la que el agente empuja las marcas. */
  private static readonly REFRESCO_MS = 60000;

  ngOnInit(): void {
    this.cargar();
    this.timer = setInterval(() => this.cargar(true), MapaPresenciaComponent.REFRESCO_MS);
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.mapa) { this.mapa.remove(); this.mapa = null; }
  }

  /** `silencioso` = refresco automático: no vuelve a poner la pantalla en blanco. */
  async cargar(silencioso = false): Promise<void> {
    if (!silencioso) this.cargando = true;
    try {
      this.datos = await this.api.presencia();
      this.error = '';
      // El mapa se pinta DESPUÉS de que Angular haya puesto el contenedor en el
      // DOM. Sin esta espera, en la primera carga `#mapa-presencia` todavía no
      // existe —está detrás del `@if`— y Leaflet no tiene dónde montarse.
      setTimeout(() => this.pintar(), 0);
    } catch (e) {
      console.error(e);
      // En un refresco automático NO se borra lo que ya se ve: un parpadeo de
      // red dejaría la pantalla vacía y parecería que no hay nadie en ninguna
      // plaza, que es peor que un dato de hace un minuto.
      if (silencioso) { this.toast.error('No se pudo refrescar el mapa.'); return; }
      this.error = 'No se pudo leer quién está en cada plaza.';
    } finally {
      this.cargando = false;
    }
  }

  // ── Datos derivados ────────────────────────────────────────────────
  nombre(id: string): string {
    const c = centroChecadorPorId(id);
    return c ? (c.ciudad || id) : id;
  }
  direccion(id: string): string {
    return centroChecadorPorId(id)?.direccion || '';
  }
  coords(id: string): { lat: number; lng: number } | null {
    const c = centroChecadorPorId(id);
    return c && typeof c.lat === 'number' && typeof c.lng === 'number'
      ? { lat: c.lat, lng: c.lng } : null;
  }

  get conUbicacion(): PlazaPresencia[] {
    return (this.datos?.plazas || []).filter((p) => this.coords(p.sucursalId));
  }
  get sinUbicacion(): PlazaPresencia[] {
    return (this.datos?.plazas || []).filter((p) => !this.coords(p.sucursalId));
  }

  alternar(id: string): void {
    this.abierta = this.abierta === id ? null : id;
  }

  /** Minutos sin señal, redondeados, para la etiqueta del reloj. */
  minutosSinSenal(p: PlazaPresencia): number | null {
    return p.segundosSinSenal == null ? null : Math.round(p.segundosSinSenal / 60);
  }

  // ── El mapa ────────────────────────────────────────────────────────
  private pintar(): void {
    const conPin = this.conUbicacion;
    if (!conPin.length) return;                 // nada que pintar todavía

    if (!this.mapa) {
      const el = document.getElementById('mapa-presencia');
      if (!el) return;
      this.mapa = L.map(el, { scrollWheelZoom: true });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '© OpenStreetMap',
      }).addTo(this.mapa);
      this.capa = L.layerGroup().addTo(this.mapa);
      // Encuadra en las plazas que sí tienen coordenadas, en vez de fijar un
      // centro a mano: si mañana se agrega una plaza lejos, el mapa se ajusta.
      const puntos = conPin.map((p) => this.coords(p.sucursalId)!);
      this.mapa.fitBounds(L.latLngBounds(puntos.map((c) => [c.lat, c.lng] as L.LatLngTuple)),
        { padding: [40, 40], maxZoom: 13 });
    }

    this.capa?.clearLayers();
    for (const p of conPin) {
      const c = this.coords(p.sucursalId)!;
      // Círculo con el número dentro: el tamaño sigue a la cantidad de gente,
      // así que el mapa se lee de un vistazo sin abrir nada.
      const radio = 16 + Math.min(18, Math.round(Math.sqrt(p.dentro) * 4));
      const icono = L.divIcon({
        className: 'pin-presencia',
        html: `<div class="pin ${p.relojMudo ? 'pin-mudo' : ''}" style="width:${radio * 2}px;height:${radio * 2}px">
                 <span>${p.dentro}</span>
               </div>`,
        iconSize: [radio * 2, radio * 2],
        iconAnchor: [radio, radio],
      });
      L.marker([c.lat, c.lng], { icon: icono })
        .addTo(this.capa!)
        .bindTooltip(`${this.nombre(p.sucursalId)} · ${p.dentro} dentro`, { direction: 'top' })
        .on('click', () => {
          this.abierta = p.sucursalId;
          document.getElementById(`plaza-${p.sucursalId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
    }
  }
}
