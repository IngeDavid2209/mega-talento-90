import { Component, inject, OnInit, OnDestroy, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule, Router } from '@angular/router';
import { PuestosService, Puesto, dedupPuestos } from '../../app/core/services/puestos.service';
import { SUCURSALES, sucursalPorId } from '../../app/core/models/sucursales.model';

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
  errorCarga = '';
  private timeoutCarga: any = null;

  // Filtros
  busqueda = '';
  filtroSucursal = '';

  // UI state
  vacanteSeleccionada: Puesto | null = null;
  mostrarVolverArriba = false;
  menuMovilAbierto = false;

  year = new Date().getFullYear();

  private unsub: any;

  // Guardamos los estilos originales de html/body para restaurarlos al salir
  private estiloHtmlOriginal = '';
  private estiloBodyOriginal = '';

  ngOnInit() {
    // El styles.css global pone overflow:hidden y height:100vh en html/body
    // para que el back-office sea pantalla completa sin scroll. Para el
    // portal SÍ necesitamos scroll natural del documento.
    this.estiloHtmlOriginal = document.documentElement.style.cssText;
    this.estiloBodyOriginal = document.body.style.cssText;
    document.documentElement.style.cssText = 'overflow: auto !important; height: auto !important; width: auto !important;';
    document.body.style.cssText = 'overflow: auto !important; height: auto !important; width: auto !important;';

    // Si Firestore no responde en 8s, asumir error de red/permisos
    this.timeoutCarga = setTimeout(() => {
      if (this.cargando) {
        this.cargando = false;
        this.errorCarga = 'Las vacantes están tardando demasiado en cargar. Revisa tu conexión a internet o intenta refrescar la página.';
      }
    }, 8000);

    this.unsub = this.puestosService.listar(
      (lista) => {
        if (this.timeoutCarga) { clearTimeout(this.timeoutCarga); this.timeoutCarga = null; }
        this.puestos = dedupPuestos(lista.filter(p => p.activo));
        this.cargando = false;
        this.errorCarga = '';
      },
      (err) => {
        if (this.timeoutCarga) { clearTimeout(this.timeoutCarga); this.timeoutCarga = null; }
        this.cargando = false;
        this.errorCarga = 'No se pudieron cargar las vacantes (' + (err?.code || err?.message || 'error desconocido') + '). Si el problema persiste, contacta al administrador.';
      }
    );
  }

  ngOnDestroy() {
    if (this.unsub) this.unsub();
    if (this.timeoutCarga) clearTimeout(this.timeoutCarga);
    // Restaurar los estilos globales para que el back-office vuelva a su
    // estado original (sin scroll del documento, layout interno se encarga)
    document.documentElement.style.cssText = this.estiloHtmlOriginal;
    document.body.style.cssText = this.estiloBodyOriginal;
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

  /**
   * Sucursales de un puesto como {nombre, mapsUrl}. Usa el catálogo por id; si
   * la vacante es antigua (texto libre) cae a partir el texto en chips sin link.
   */
  listaSucursales(p: Puesto): { nombre: string; mapsUrl?: string }[] {
    if (Array.isArray(p.sucursalIds) && p.sucursalIds.length) {
      const out: { nombre: string; mapsUrl?: string }[] = [];
      for (const id of p.sucursalIds) {
        const s = sucursalPorId(id);
        if (s) out.push({ nombre: s.direccion, mapsUrl: s.mapsUrl });
      }
      if (out.length) return out;
    }
    // Respaldo (vacantes antiguas): separar SOLO por " · " para no fragmentar una
    // dirección que lleva comas internas. Si la dirección coincide con el
    // catálogo, recuperamos su enlace a Maps.
    return (p.sucursales || '')
      .split(' · ').map(x => x.trim()).filter(Boolean)
      .map(nombre => {
        const s = SUCURSALES.find(c => c.direccion === nombre);
        return s ? { nombre: s.direccion, mapsUrl: s.mapsUrl } : { nombre };
      });
  }

  /** Lista única de sucursales/ciudades para el dropdown de filtro */
  get sucursalesUnicas(): string[] {
    const set = new Set<string>();
    for (const p of this.puestos) {
      for (const s of this.listaSucursales(p)) set.add(s.nombre);
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

  irABienvenida() {
    const el = document.getElementById('bienvenida');
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

  recargar() {
    window.location.reload();
  }

  limpiarFiltros() {
    this.busqueda = '';
    this.filtroSucursal = '';
  }

  /** Abre Google Maps centrado en la zona/dirección del chip */
  abrirMapa(zona: string) {
    const q = zona.toLowerCase().includes('méxico') ? zona : `${zona}, México`;
    const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
    window.open(url, '_blank', 'noopener');
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

  /** Convierte el texto libre de requisitos en una lista de líneas no vacías */
  parseRequisitos(texto: string | undefined): string[] {
    if (!texto) return [];
    return texto.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  }

  /**
   * Devuelve un identificador de ícono según el nombre del puesto.
   * Se usa cuando la vacante no tiene imagenUrl configurada — en lugar
   * de mostrar iniciales aburridas, mostramos un SVG temático.
   */
  iconoPuesto(nombre: string): string {
    const n = (nombre || '').toLowerCase();
    if (n.includes('aux') && n.includes('chofer')) return 'aux-chofer';
    if (n.includes('chofer') || n.includes('repartidor')) return 'chofer';
    if (n.includes('cajero')) return 'cajero';
    if (n.includes('surtidor')) return 'surtidor';
    if (n.includes('vendedor') || n.includes('venta')) return 'vendedor';
    if (n.includes('almacen')) return 'almacenista';
    if (n.includes('bodeguero') || n.includes('bodega')) return 'bodeguero';
    if (n.includes('anaquel')) return 'anaquelista';
    if (n.includes('gerente')) return 'gerente';
    if (n.includes('administrativo') || n.includes('oficina')) return 'admin';
    if (n.includes('logistica') || n.includes('logística')) return 'logistica';
    return 'default';
  }
}
