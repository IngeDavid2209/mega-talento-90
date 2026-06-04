import { Component, inject, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { PuestosService, Puesto } from '../../core/services/puestos.service';

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
  private unsub: any;

  // Editor (crear / editar)
  mostrarEditor = false;
  edicion: Puesto = this.puestoVacio();
  guardando = false;
  errorEditor = '';

  // Confirmación de borrado
  puestoAEliminar: Puesto | null = null;
  borrando = false;

  private yaIntentadoSembrar = false;

  async ngOnInit() {
    // Empezar a escuchar la lista DE INMEDIATO (no bloquear con sembrado).
    // Si la primera respuesta llega vacía, sembramos en background y los
    // documentos creados aparecerán solos por el mismo listener.
    this.unsub = this.puestosService.listar((lista) => {
      this.ngZone.run(() => {
        this.puestos = lista;
        this.cargando = false;
      });

      if (!this.yaIntentadoSembrar && lista.length === 0) {
        this.yaIntentadoSembrar = true;
        this.puestosService.sembrar().catch(e =>
          console.warn('No se pudo sembrar el catálogo de puestos:', e)
        );
      }
    });
  }

  ngOnDestroy() {
    if (this.unsub) this.unsub();
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
    this.errorEditor = '';
    this.mostrarEditor = true;
  }

  abrirEditar(p: Puesto) {
    this.edicion = { ...p };
    this.errorEditor = '';
    this.mostrarEditor = true;
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

    this.guardando = true;
    try {
      const datos: any = {
        nombre: this.edicion.nombre.trim(),
        descripcion: this.edicion.descripcion.trim(),
        sucursales: (this.edicion.sucursales || '').trim(),
        sueldo: (this.edicion.sueldo || '').trim(),
        horario: (this.edicion.horario || '').trim(),
        activo: this.edicion.activo,
        orden: this.edicion.orden ?? this.puestos.length
      };

      if (this.edicion.id) {
        await this.puestosService.actualizar(this.edicion.id, datos);
      } else {
        await this.puestosService.crear(datos);
      }
      this.mostrarEditor = false;
    } catch (e) {
      console.error('Error al guardar puesto:', e);
      this.errorEditor = 'No se pudo guardar. Verifica tu conexión e intenta de nuevo.';
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
