import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CENTROS_CON_RELOJ, CENTROS_INTERNOS, Sucursal } from '../../../core/models/sucursales.model';

interface Opcion { id: string; ciudad: string; detalle: string; interno: boolean; }

/**
 * Selector de sucursal: TODAS a la vista, se elige con un clic.
 *
 * Antes era un desplegable. Con ocho plazas eso costaba dos clics y, sobre todo,
 * escondía la lista: no se veía de un vistazo qué plazas hay, ni se podía saltar
 * de una a otra para comparar. Ahora son botones visibles y cambiar de sucursal
 * es un solo clic.
 *
 * Solo se ofrecen las que tienen reloj (`CENTROS_CON_RELOJ`): una plaza sin datos
 * en el selector deja la pantalla vacía y hace pensar que el sistema está roto.
 *
 * La interfaz pública NO cambió —[value] / (valueChange)—, así que las pantallas
 * que ya lo usaban (Asistencia y Horarios) no se tocaron.
 */
@Component({
  selector: 'app-sucursal-select',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './sucursal-select.html',
  styleUrl: './sucursal-select.css'
})
export class SucursalSelectComponent {
  @Input() value = '';
  @Output() valueChange = new EventEmitter<string>();

  /** Las ocho, en orden: primero las dulcerías y al final los centros internos. */
  get opciones(): Opcion[] {
    const internos = new Set(CENTROS_INTERNOS.map(c => c.id));
    const aOpcion = (s: Sucursal): Opcion => ({
      id: s.id,
      ciudad: s.ciudad,
      // La calle distingue dos plazas de la misma ciudad (Zamora tiene dos). Va
      // en el title y no en el botón, para que la fila no se desborde.
      detalle: s.direccion ? s.direccion.split(',')[0] : '',
      interno: internos.has(s.id),
    });
    const todas = CENTROS_CON_RELOJ.map(aOpcion);
    return [...todas.filter(o => !o.interno), ...todas.filter(o => o.interno)];
  }

  titulo(o: Opcion): string {
    return o.detalle ? `${o.ciudad} · ${o.detalle}` : o.ciudad;
  }

  elegir(id: string) {
    if (id === this.value) return;
    this.value = id;
    this.valueChange.emit(id);
  }
}
