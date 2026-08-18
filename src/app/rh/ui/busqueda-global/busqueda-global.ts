import { Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { CandidateService } from '../../../core/services/candidate';
import { ETAPAS, ETAPA_CONTRATADO, ID_ETAPAS } from '../../../core/models/proceso.model';

interface Resultado {
  id: string;
  nombre: string;
  puesto: string;
  ciudad: string;
  etapa: string;       // etiqueta legible de la fase
  color: string;       // color de la fase
}

/**
 * BUSCADOR GLOBAL DE POSTULADOS.
 *
 * RH se quejaba de tener que buscar a la misma persona fase por fase (Filtro →
 * Entrevista → Aptitudes) para dar con su tarjeta. Aquí se teclea el nombre o
 * apellido y aparece la persona ESTÉ EN LA FASE QUE ESTÉ, con su fase a la vista;
 * un clic (o Enter) abre su expediente directo.
 *
 * Vive en la barra superior del layout, así que está disponible en TODA la app.
 */
@Component({
  selector: 'app-busqueda-global',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './busqueda-global.html',
  styleUrl: './busqueda-global.css',
})
export class BusquedaGlobalComponent implements OnInit, OnDestroy {
  private candidatos = inject(CandidateService);
  private router = inject(Router);
  private host = inject(ElementRef);
  @ViewChild('caja') caja?: ElementRef<HTMLInputElement>;

  q = '';
  abierto = false;
  activo = -1;                  // índice resaltado para navegar con flechas
  resultados: Resultado[] = [];

  private todos: any[] = [];    // padrón cargado
  private unsub?: () => void;

  // Etapa (status) → etiqueta y color legibles. Cubre las 4 vigentes, el
  // desenlace (contratado), rechazado y los ids viejos que aún viven en datos.
  private readonly ETIQUETA: Record<string, { label: string; color: string }> = {
    ...Object.fromEntries(ETAPAS.map(e => [e.id, { label: e.title, color: e.color }])),
    [ETAPA_CONTRATADO.id]: { label: ETAPA_CONTRATADO.title, color: ETAPA_CONTRATADO.color },
    [ID_ETAPAS.NUEVO]: { label: 'Filtro Inicial', color: '#1F4E8C' },
    [ID_ETAPAS.JEFE]: { label: 'Aptitudes y Entrevista Técnica', color: '#2A5A8A' },
    [ID_ETAPAS.DOCUMENTAL]: { label: 'Aptitudes y Entrevista Técnica', color: '#2A5A8A' },
    [ID_ETAPAS.OFERTA]: { label: 'Psicométricas', color: '#3F5C7A' },
    [ID_ETAPAS.DICTAMEN]: { label: 'Psicométricas', color: '#3F5C7A' },
    [ID_ETAPAS.RECHAZADO]: { label: 'Rechazado', color: '#A12626' },
  };

  ngOnInit() {
    // El mismo polling que el resto de la app: el buscador nunca queda con un
    // padrón viejo, y no cuesta una llamada aparte.
    this.unsub = this.candidatos.listenToCandidates(datos => {
      this.todos = Array.isArray(datos) ? datos : [];
      if (this.q) this.filtrar();     // si ya estaba buscando, refresca en vivo
    });
  }
  ngOnDestroy() { this.unsub?.(); }

  /** Quita acentos y baja a minúsculas: "MARÍA" encuentra "maria". */
  private norm(s: string): string {
    // Tabla explícita en vez de un rango de marcas combinantes: ese rango son
    // caracteres invisibles en el archivo y se rompen al reguardar en otra
    // codificación. Aquí se ve lo que hace.
    const sinAcentos = String(s || '').toLowerCase().replace(/[áéíóúüñ]/g, (c) =>
      ({ 'á': 'a', 'é': 'e', 'í': 'i', 'ó': 'o', 'ú': 'u', 'ü': 'u', 'ñ': 'n' } as Record<string, string>)[c] || c);
    return sinAcentos.replace(/\s+/g, ' ').trim();
  }

  onInput() {
    this.filtrar();
    this.abierto = true;
    this.activo = this.resultados.length ? 0 : -1;
  }

  private filtrar() {
    const q = this.norm(this.q);
    if (q.length < 2) { this.resultados = []; return; }
    // Cada palabra tecleada debe aparecer en el nombre: "lopez juan" encuentra
    // "Juan Carlos López" aunque el orden no coincida.
    const partes = q.split(' ').filter(Boolean);
    const activos = this.todos.filter(c => {
      const n = this.norm(c.nombre);
      return n && partes.every(p => n.includes(p));
    });
    // Los no rechazados primero (son los que RH suele buscar), luego por nombre.
    activos.sort((a, b) => {
      const ra = a.status === ID_ETAPAS.RECHAZADO ? 1 : 0;
      const rb = b.status === ID_ETAPAS.RECHAZADO ? 1 : 0;
      return ra - rb || this.norm(a.nombre).localeCompare(this.norm(b.nombre));
    });
    this.resultados = activos.slice(0, 8).map(c => {
      const et = this.ETIQUETA[c.status] || { label: c.status || 'En proceso', color: '#64748B' };
      return {
        id: c.id, nombre: c.nombre || '(sin nombre)',
        puesto: c.puesto || '', ciudad: c.ciudad || '',
        etapa: et.label, color: et.color,
      };
    });
  }

  abrir(r: Resultado) {
    this.router.navigate(['/app/expediente', r.id]);
    this.q = '';
    this.resultados = [];
    this.abierto = false;
    this.caja?.nativeElement.blur();
  }

  // ── Teclado: flechas para moverse, Enter para abrir, Esc para cerrar ──
  onKey(ev: KeyboardEvent) {
    if (!this.abierto || !this.resultados.length) {
      if (ev.key === 'Escape') this.limpiar();
      return;
    }
    if (ev.key === 'ArrowDown') { ev.preventDefault(); this.activo = (this.activo + 1) % this.resultados.length; }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); this.activo = (this.activo - 1 + this.resultados.length) % this.resultados.length; }
    else if (ev.key === 'Enter') { ev.preventDefault(); if (this.resultados[this.activo]) this.abrir(this.resultados[this.activo]); }
    else if (ev.key === 'Escape') { this.limpiar(); }
  }

  limpiar() { this.q = ''; this.resultados = []; this.abierto = false; }

  // Cerrar el desplegable al hacer clic fuera del buscador.
  @HostListener('document:click', ['$event'])
  onDocClick(ev: MouseEvent) {
    if (!this.host.nativeElement.contains(ev.target)) this.abierto = false;
  }
}
