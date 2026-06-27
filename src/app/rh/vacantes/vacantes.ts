import { Component, inject, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { PuestosService, Puesto } from '../../core/services/puestos.service';
import { SUCURSALES, Sucursal, sucursalPorId, inferirSucursalIds } from '../../core/models/sucursales.model';
import { subirACloudinary } from '../../core/services/cloudinary';

@Component({
  selector: 'app-vacantes',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './vacantes.html',
  styleUrl: './vacantes.css'
})
export class VacantesComponent implements OnInit, OnDestroy {
  private puestosService = inject(PuestosService);
  private ngZone = inject(NgZone);

  puestos: Puesto[] = [];
  cargando = true;
  errorCarga = '';
  private timeoutCarga: any = null;
  private unsub: any;

  // Editor (crear / editar)
  mostrarEditor = false;
  edicion: Puesto = this.puestoVacio();
  guardando = false;
  errorEditor = '';

  // Catálogo de sucursales: por puesto se activan/desactivan. La selección se
  // guarda como ids (sucursalIds) y como nombres separados por comas en
  // sucursales (formato que ya consume el portal y la cartelera).
  catalogoSucursales: Sucursal[] = SUCURSALES;
  sucursalesSel = new Set<string>();

  // Confirmación de borrado
  puestoAEliminar: Puesto | null = null;
  borrando = false;

  // Carga del catálogo Mega Dulces
  cargandoCatalogo = false;
  resultadoCatalogo: { creados: string[]; omitidos: string[] } | null = null;
  errorCatalogo = '';

  // Vinculación automática de sucursales (migración de vacantes antiguas)
  vinculando = false;
  resultadoVinculacion: { vinculados: string[]; sinCoincidencia: string[]; yaTenian: string[] } | null = null;
  errorVinculacion = '';

  // Subida de imagen al editor
  subiendoImagen = false;
  errorImagen = '';

  private yaIntentadoSembrar = false;

  async ngOnInit() {
    // Si Firestore no responde en 8s, asumir error (red, reglas, etc.)
    this.timeoutCarga = setTimeout(() => {
      if (this.cargando) {
        this.ngZone.run(() => {
          this.cargando = false;
          this.errorCarga = 'Las vacantes están tardando demasiado en cargar. Revisa tu conexión o intenta refrescar.';
        });
      }
    }, 8000);

    // Empezar a escuchar la lista DE INMEDIATO (no bloquear con sembrado).
    // Si la primera respuesta llega vacía, sembramos en background y los
    // documentos creados aparecerán solos por el mismo listener.
    this.unsub = this.puestosService.listar(
      (lista) => {
        this.ngZone.run(() => {
          if (this.timeoutCarga) { clearTimeout(this.timeoutCarga); this.timeoutCarga = null; }
          this.puestos = lista;
          this.cargando = false;
          this.errorCarga = '';
        });

        if (!this.yaIntentadoSembrar && lista.length === 0) {
          this.yaIntentadoSembrar = true;
          this.puestosService.sembrar().catch(e =>
            console.warn('No se pudo sembrar el catálogo de puestos:', e)
          );
        }
      },
      (err) => {
        this.ngZone.run(() => {
          if (this.timeoutCarga) { clearTimeout(this.timeoutCarga); this.timeoutCarga = null; }
          this.cargando = false;
          this.errorCarga = 'No se pudieron cargar las vacantes (' + (err?.code || err?.message || 'error desconocido') + '). Verifica las reglas de Firestore o contacta al administrador.';
        });
      }
    );
  }

  ngOnDestroy() {
    if (this.unsub) this.unsub();
    if (this.timeoutCarga) clearTimeout(this.timeoutCarga);
  }

  private puestoVacio(): Puesto {
    return {
      nombre: '', descripcion: '', sucursales: '', sueldo: '', horario: '',
      activo: true, orden: this.puestos.length
    };
  }

  // ====== CRUD ======
  abrirNuevo() {
    this.edicion = this.puestoVacio();
    this.sucursalesSel = new Set<string>();
    this.errorEditor = '';
    this.mostrarEditor = true;
  }

  abrirEditar(p: Puesto) {
    this.edicion = { ...p };
    this.sucursalesSel = this.seleccionDesdePuesto(p);
    this.errorEditor = '';
    this.mostrarEditor = true;
  }

  /**
   * Reconstruye qué sucursales están activas para un puesto. Usa sucursalIds
   * si existe; si no (vacantes guardadas antes del catálogo), intenta inferir
   * a partir de los nombres del texto antiguo en sucursales.
   */
  private seleccionDesdePuesto(p: Puesto): Set<string> {
    const sel = new Set<string>();
    if (Array.isArray(p.sucursalIds) && p.sucursalIds.length) {
      for (const id of p.sucursalIds) {
        if (sucursalPorId(id)) sel.add(id);
      }
      return sel;
    }
    // Vacante antigua: pre-marcar las sucursales que se infieran de su texto.
    for (const id of inferirSucursalIds(p.sucursales || '')) sel.add(id);
    return sel;
  }

  /** Activa/desactiva una sucursal del catálogo para el puesto en edición. */
  alternarSucursal(id: string) {
    if (this.sucursalesSel.has(id)) this.sucursalesSel.delete(id);
    else this.sucursalesSel.add(id);
  }

  /** Direcciones de las sucursales de un puesto, para los chips de la tarjeta. */
  sucursalesDe(p: Puesto): string[] {
    if (Array.isArray(p.sucursalIds) && p.sucursalIds.length) {
      const dirs = p.sucursalIds
        .map(id => sucursalPorId(id)?.direccion)
        .filter((d): d is string => !!d);
      if (dirs.length) return dirs;
    }
    // Vacantes antiguas: separar SOLO por " · " para no fragmentar una dirección
    // que lleva comas internas.
    return (p.sucursales || '').split(' · ').map(s => s.trim()).filter(Boolean);
  }

  cerrarEditor() {
    this.mostrarEditor = false;
    this.errorEditor = '';
  }

  async guardar() {
    this.errorEditor = '';
    if (!this.edicion.nombre.trim()) {
      this.errorEditor = 'El nombre del puesto es obligatorio.';
      return;
    }
    if (!this.edicion.descripcion.trim()) {
      this.errorEditor = 'La descripción es obligatoria (se manda al candidato por WhatsApp).';
      return;
    }

    // Sucursales seleccionadas del catálogo, en el orden del catálogo.
    const sucursalesActivas = this.catalogoSucursales.filter(s => this.sucursalesSel.has(s.id));
    const sucursalIds = sucursalesActivas.map(s => s.id);
    const sucursalesTexto = sucursalesActivas.map(s => s.direccion).join(' · ');

    this.guardando = true;
    try {
      const datos: any = {
        nombre: this.edicion.nombre.trim(),
        descripcion: this.edicion.descripcion.trim(),
        sucursalIds,
        sucursales: sucursalesTexto,
        sueldo: (this.edicion.sueldo || '').trim(),
        horario: (this.edicion.horario || '').trim(),
        requisitos: (this.edicion.requisitos || '').trim(),
        imagenUrl: (this.edicion.imagenUrl || '').trim(),
        area: (this.edicion.area || '').trim(),
        activo: this.edicion.activo,
        orden: this.edicion.orden ?? this.puestos.length
      };

      if (this.edicion.id) {
        await this.puestosService.actualizar(this.edicion.id, datos);
      } else {
        await this.puestosService.crear(datos);
      }
      this.mostrarEditor = false;
    } catch (e: any) {
      console.error('Error al guardar puesto:', e);
      const codigo = e?.code || '';
      if (codigo === 'permission-denied') {
        this.errorEditor = 'PERMISO DENEGADO: las reglas de Firestore no permiten escribir en "puestos". Ve a Firebase Console > Firestore > Rules y publica las reglas del archivo firestore.rules.';
      } else if (codigo === 'unauthenticated') {
        this.errorEditor = 'Sesión expirada. Cierra sesión y vuelve a entrar.';
      } else if (codigo) {
        this.errorEditor = `No se pudo guardar (${codigo}). ${e?.message || ''}`;
      } else {
        this.errorEditor = `No se pudo guardar: ${e?.message || 'error desconocido'}`;
      }
    } finally {
      this.guardando = false;
    }
  }

  pedirBorrar(p: Puesto) { this.puestoAEliminar = p; }
  cancelarBorrar() { this.puestoAEliminar = null; }

  async confirmarBorrar() {
    if (!this.puestoAEliminar?.id) return;
    this.borrando = true;
    try {
      await this.puestosService.eliminar(this.puestoAEliminar.id);
      this.puestoAEliminar = null;
    } catch (e) {
      console.error('Error al eliminar puesto:', e);
    } finally {
      this.borrando = false;
    }
  }

  /** Abre el portal público en una nueva pestaña */
  abrirPortal() {
    window.open('/portal', '_blank', 'noopener');
  }

  /** Carga las 8 vacantes del catálogo Mega Dulces que no existan aún */
  async cargarCatalogo() {
    this.cargandoCatalogo = true;
    this.errorCatalogo = '';
    this.resultadoCatalogo = null;
    try {
      this.resultadoCatalogo = await this.puestosService.cargarCatalogoSiFaltan();
    } catch (e: any) {
      console.error('Error al cargar catálogo:', e);
      const codigo = e?.code || '';
      if (codigo === 'permission-denied') {
        this.errorCatalogo = 'Permiso denegado. Verifica las reglas de Firestore.';
      } else {
        this.errorCatalogo = `No se pudo cargar el catálogo: ${e?.message || codigo || 'error desconocido'}`;
      }
    } finally {
      this.cargandoCatalogo = false;
    }
  }

  cerrarResultadoCatalogo() {
    this.resultadoCatalogo = null;
    this.errorCatalogo = '';
  }

  /** Vincula las vacantes existentes con el catálogo de sucursales por su texto. */
  async vincularSucursales() {
    this.vinculando = true;
    this.errorVinculacion = '';
    this.resultadoVinculacion = null;
    try {
      this.resultadoVinculacion = await this.puestosService.vincularSucursalesAutomatico();
    } catch (e: any) {
      console.error('Error al vincular sucursales:', e);
      this.errorVinculacion = `No se pudo vincular: ${e?.message || e?.code || 'error desconocido'}`;
    } finally {
      this.vinculando = false;
    }
  }

  cerrarResultadoVinculacion() {
    this.resultadoVinculacion = null;
    this.errorVinculacion = '';
  }

  /** Recarga la página completa (usado tras error de carga) */
  recargar() {
    window.location.reload();
  }

  /** Sube la foto seleccionada del editor a Cloudinary y guarda la URL */
  async onImagenSelected(event: any) {
    const file = event.target.files?.[0] as File | undefined;
    if (!file) return;

    if (file.size > 5_000_000) {
      this.errorImagen = 'La foto pesa más de 5 MB. Comprime o reduce la calidad antes de subir.';
      event.target.value = '';
      return;
    }
    if (!file.type.startsWith('image/')) {
      this.errorImagen = 'Selecciona una imagen (JPG, PNG, WEBP).';
      event.target.value = '';
      return;
    }

    this.errorImagen = '';
    this.subiendoImagen = true;
    try {
      const url = await subirACloudinary(file, 'puestos');
      this.edicion.imagenUrl = url;
    } catch (e: any) {
      console.error('Error al subir imagen:', e);
      this.errorImagen = 'No se pudo subir la foto. Inténtalo de nuevo.';
    } finally {
      this.subiendoImagen = false;
      event.target.value = '';
    }
  }

  quitarImagen() {
    this.edicion.imagenUrl = '';
    this.errorImagen = '';
  }

  /** Activar/desactivar visibilidad pública sin abrir editor */
  async alternarActivo(p: Puesto) {
    if (!p.id) return;
    try {
      await this.puestosService.actualizar(p.id, { activo: !p.activo });
    } catch (e) {
      console.error('Error al cambiar visibilidad:', e);
    }
  }
}
