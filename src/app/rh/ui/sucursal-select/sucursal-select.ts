import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CENTROS_CON_RELOJ, CENTROS_INTERNOS, Sucursal, tieneReloj } from '../../../core/models/sucursales.model';

interface Opcion {
  id: string; ciudad: string; detalle: string;
  interno: boolean; sinReloj: boolean;
  /** Lo que se pinta en el chip: la ciudad, y la zona solo si la ciudad se repite. */
  etiqueta: string;
}

/**
 * Selector de sucursal: TODAS a la vista, se elige con un clic.
 *
 * Antes era un desplegable. Con ocho plazas eso costaba dos clics y, sobre todo,
 * escondía la lista: no se veía de un vistazo qué plazas hay, ni se podía saltar
 * de una a otra para comparar. Ahora son botones visibles y cambiar de sucursal
 * es un solo clic.
 *
 * Se ofrecen TODAS las ubicaciones, incluidas las que todavía no tienen reloj
 * instalado. Antes esas cuatro se escondían —una plaza vacía en el selector se
 * lee como "el sistema está roto"— pero esconderlas salía más caro: una plaza
 * que no aparece es una plaza de la que nadie se acuerda, y así fue como Morelia
 * Abastos llevaba desde siempre sin importarse sin que nadie lo notara.
 *
 * Van marcadas con un punto para que se vea que están vacías POR ALGO, y la
 * pantalla explica el motivo al elegirlas.
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

  /** Todas, en orden: primero las dulcerías y al final los centros internos. */
  get opciones(): Opcion[] {
    const internos = new Set(CENTROS_INTERNOS.map(c => c.id));
    const aOpcion = (s: Sucursal): Opcion => ({
      id: s.id,
      ciudad: s.ciudad,
      // La calle distingue dos plazas de la misma ciudad (Zamora tiene dos). Va
      // en el title y no en el botón, para que la fila no se desborde.
      detalle: s.direccion ? s.direccion.split(',')[0] : '',
      interno: internos.has(s.id),
      sinReloj: !tieneReloj(s.id),
      etiqueta: s.ciudad,   // se afina abajo si la ciudad se repite
    });
    const todas = CENTROS_CON_RELOJ.map(aOpcion);

    // Desambiguar las ciudades repetidas. Zamora SIEMPRE tuvo dos chips que
    // decían exactamente "Zamora" y no había forma de saber cuál era cuál sin
    // pasar el mouse por encima; con Morelia (tres) y La Piedad (dos) eso deja
    // de ser un detalle. La zona sale del id, que es el dato estable.
    const cuantas = new Map<string, number>();
    for (const o of todas) cuantas.set(o.ciudad, (cuantas.get(o.ciudad) || 0) + 1);
    for (const o of todas) {
      o.etiqueta = (cuantas.get(o.ciudad) || 0) > 1
        ? `${o.ciudad} · ${this.zonaDe(o.id, o.ciudad)}`
        : o.ciudad;
    }

    // Las que no tienen reloj van al final de su grupo: siguen a la vista, pero
    // no estorban a las que sí traen datos.
    const ordenar = (a: Opcion, b: Opcion) => Number(a.sinReloj) - Number(b.sinReloj);
    return [
      ...todas.filter(o => !o.interno).sort(ordenar),
      ...todas.filter(o => o.interno).sort(ordenar),
    ];
  }

  /** 'zamora-canindo' + 'Zamora' → 'Canindo'. Si no empata, se usa el id completo. */
  private zonaDe(id: string, ciudad: string): string {
    // Los acentos se quitan con una tabla explícita en vez de un rango de
    // marcas combinantes: ese rango son caracteres invisibles en el archivo, y
    // basta con que alguien lo reguarde en otra codificación para que deje de
    // hacer nada. Aquí se ve lo que hace.
    const sinAcentos = ciudad.toLowerCase().replace(/[áéíóúüñ]/g, (c) =>
      ({ 'á': 'a', 'é': 'e', 'í': 'i', 'ó': 'o', 'ú': 'u', 'ü': 'u', 'ñ': 'n' })[c] || c);
    const slug = sinAcentos.replace(/[^a-z0-9]+/g, '-');
    const resto = id.startsWith(slug + '-') ? id.slice(slug.length + 1) : id;
    return resto.split('-')
      .map(p => p.charAt(0).toUpperCase() + p.slice(1))
      .join(' ');
  }

  titulo(o: Opcion): string {
    const base = o.detalle ? `${o.ciudad} · ${o.detalle}` : o.ciudad;
    return o.sinReloj ? `${base} — todavía sin reloj checador` : base;
  }

  elegir(id: string) {
    if (id === this.value) return;
    this.value = id;
    this.valueChange.emit(id);
  }
}
