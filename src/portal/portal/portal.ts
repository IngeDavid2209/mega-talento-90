import { Component, inject, OnInit, OnDestroy, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule, Router } from '@angular/router';
import { PuestosService, Puesto } from '../../app/core/services/puestos.service';

@Component({
  selector: 'app-portal',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './portal.html',
  styleUrl: './portal.css'
})
export class PortalComponent implements OnInit, OnDestroy {
  private puestosService = inject(PuestosService);
  private router = inject(Router);

  puestos: Puesto[] = [];
  cargando = true;

  // Filtros
  busqueda = '';
  filtroSucursal = '';

  // UI state
  vacanteSeleccionada: Puesto | null = null;
  mostrarVolverArriba = false;
  menuMovilAbierto = false;

  year = new Date().getFullYear();

  private unsub: any;

  ngOnInit() {
    this.unsub = this.puestosService.listar((lista) => {
      this.puestos = lista.filter(p => p.activo);
      this.cargando = false;
    });
  }

  ngOnDestroy() {
    if (this.unsub) this.unsub();
    document.body.style.overflow = '';
  }

  @HostListener('window:scroll')
  onScroll() {
    this.mostrarVolverArriba = window.scrollY > 400;
  }

  /** Vacantes filtradas por buscador y sucursal */
  get vacantesFiltradas(): Puesto[] {
    const t = this.busqueda.trim().toLowerCase();
    const s = this.filtroSucursal.trim().toLowerCase();
    return this.puestos.filter(p => {
      const matchBusqueda = !t
        || (p.nombre || '').toLowerCase().includes(t)
        || (p.descripcion || '').toLowerCase().includes(t);
      const matchSucursal = !s
        || (p.sucursales || '').toLowerCase().includes(s);
      return matchBusqueda && matchSucursal;
    });
  }

  /** Lista única de sucursales/ciudades para el dropdown de filtro */
  get sucursalesUnicas(): string[] {
    const set = new Set<string>();
    for (const p of this.puestos) {
      if (!p.sucursales) continue;
      // Partir por coma para soportar "La Piedad, Zamora"
      const parts = p.sucursales.split(',').map(x => x.trim()).filter(Boolean);
      for (const part of parts) set.add(part);
    }
    return Array.from(set).sort();
  }

  /** Cuántas vacantes hay activas en total (para el hero/cta) */
  get totalActivas(): number {
    return this.puestos.length;
  }

  abrirDetalle(p: Puesto) {
    this.vacanteSeleccionada = p;
    document.body.style.overflow = 'hidden';
    window.scrollTo({ top: window.scrollY, behavior: 'instant' as ScrollBehavior });
  }

  cerrarDetalle() {
    this.vacanteSeleccionada = null;
    document.body.style.overflow = '';
  }

  postularme(p: Puesto | null) {
    if (!p) return;
    this.cerrarDetalle();
    this.router.navigate(['/unete'], { queryParams: { puesto: p.nombre } });
  }

  irAVacantes() {
    const el = document.getElementById('vacantes');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    this.menuMovilAbierto = false;
  }

  irInicio() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    this.menuMovilAbierto = false;
  }

  volverArriba() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  limpiarFiltros() {
    this.busqueda = '';
    this.filtroSucursal = '';
  }

  /** Antigüedad legible de la publicación */
  hacePoco(timestamp: any): string {
    if (!timestamp) return 'Publicada recientemente';
    const d = typeof timestamp.toDate === 'function' ? timestamp.toDate() : new Date(timestamp);
    const ms = Date.now() - d.getTime();
    const dias = Math.floor(ms / 86_400_000);
    if (dias < 1) return 'Publicada hoy';
    if (dias === 1) return 'Hace 1 día';
    if (dias < 7) return `Hace ${dias} días`;
    const semanas = Math.floor(dias / 7);
    if (semanas === 1) return 'Hace 1 semana';
    if (semanas < 4) return `Hace ${semanas} semanas`;
    const meses = Math.floor(dias / 30);
    if (meses === 1) return 'Hace 1 mes';
    return `Hace ${meses} meses`;
  }

  /** Iniciales para el avatar de la tarjeta */
  iniciales(nombre: string): string {
    if (!nombre) return '?';
    return nombre.trim().split(/\s+/).slice(0, 2).map(p => p.charAt(0).toUpperCase()).join('');
  }
}
