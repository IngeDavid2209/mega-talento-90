import { Component, ElementRef, EventEmitter, HostListener, Input, Output, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SUCURSALES, CENTROS_INTERNOS, CENTROS_SIN_RELOJ, centroChecadorPorId, Sucursal } from '../../../core/models/sucursales.model';

interface Grupo { titulo: string; items: { id: string; ciudad: string; detalle: string }[]; }

/**
 * Selector de sucursal con diseño propio (navy + dorado): reemplaza al <select>
 * nativo. Agrupa en "Sucursales" y "Centros internos", con búsqueda, hover y
 * marca de selección. Two-way binding vía [value]/(valueChange).
 */
@Component({
  selector: 'app-sucursal-select',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './sucursal-select.html',
  styleUrl: './sucursal-select.css'
})
export class SucursalSelectComponent {
  private el = inject(ElementRef<HTMLElement>);

  @Input() value = '';
  @Output() valueChange = new EventEmitter<string>();

  abierto = false;
  filtro = '';

  private toDetalle(s: Sucursal) {
    return { id: s.id, ciudad: s.ciudad, detalle: s.direccion ? s.direccion.split(',')[0] : '' };
  }

  get grupos(): Grupo[] {
    const f = this.filtro.trim().toLowerCase();
    const coincide = (s: Sucursal) =>
      !f || `${s.ciudad} ${s.direccion}`.toLowerCase().includes(f);
    const conReloj = (s: Sucursal) => !CENTROS_SIN_RELOJ.includes(s.id);
    const grupos: Grupo[] = [
      // Solo las que tienen reloj: ofrecer una plaza sin datos hace pensar que la
      // pantalla esta rota (ver CENTROS_SIN_RELOJ).
      { titulo: 'Sucursales', items: SUCURSALES.filter(conReloj).filter(coincide).map(s => this.toDetalle(s)) },
      { titulo: 'Centros internos', items: CENTROS_INTERNOS.filter(conReloj).filter(coincide).map(s => this.toDetalle(s)) }
    ];
    return grupos.filter(g => g.items.length);
  }

  get etiqueta(): string {
    const s = centroChecadorPorId(this.value);
    if (!s) return 'Elige una sucursal';
    return s.direccion ? `${s.ciudad} · ${s.direccion.split(',')[0]}` : s.ciudad;
  }

  get seleccionCiudad(): string {
    return centroChecadorPorId(this.value)?.ciudad || '';
  }

  toggle() {
    this.abierto = !this.abierto;
    if (this.abierto) this.filtro = '';
  }

  elegir(id: string) {
    if (id !== this.value) {
      this.value = id;
      this.valueChange.emit(id);
    }
    this.abierto = false;
  }

  @HostListener('document:click', ['$event'])
  onDocClick(ev: MouseEvent) {
    if (this.abierto && !this.el.nativeElement.contains(ev.target as Node)) this.abierto = false;
  }

  @HostListener('document:keydown.escape')
  onEsc() { this.abierto = false; }
}
