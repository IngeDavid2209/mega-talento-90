import { Component, inject, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChecadorService } from '../../core/services/checador.service';
import { Empleado } from '../../core/models/checador.model';
import { CENTROS_CON_RELOJ, centroChecadorPorId } from '../../core/models/sucursales.model';
import { ToastService } from '../../core/services/toast.service';
import { subirACloudinary } from '../../core/services/cloudinary';
import { SucursalSelectComponent } from '../ui/sucursal-select/sucursal-select';
import { AsistenciaResumenComponent, VistaAsistencia, ConteosPendientes }
  from '../asistencia-resumen/asistencia-resumen';

/**
 * PROMOTORÍA — su propia sección, fuera de Empleados.
 *
 * ══ POR QUÉ SALIÓ DE HORARIOS ══
 *
 * Vivía como una pestaña dentro de Horarios, al lado del personal de planta. RH
 * pidió sacarla: no son empleados normales de la empresa —andan en calle o en
 * punto de venta, dependen de la marca que representan y no checan en el reloj
 * de la sucursal—, y tenerlas junto a los de piso hacía que se mezclaran en la
 * misma conversación.
 *
 * ══ QUIÉN ENTRA ══
 *
 * La sección se reparte a mano: solo la ven el administrador y los usuarios con
 * rol de Promotoría. El menú la esconde y `rolGuard('promotoria')` bloquea la
 * ruta, así que escribir la URL a mano tampoco sirve.
 *
 * ⚠️ Es control de navegación, no de datos: la API sigue respondiendo el padrón
 * completo a cualquiera con sesión. Para que sea hermético hay que filtrar del
 * lado del servidor.
 *
 * ══ LO QUE NO CAMBIA ══
 *
 * Marcar a alguien como promotora sigue siendo un CAMPO (`es_promotora`), no una
 * baja: la persona conserva su ficha, su código y sus checadas. Lo único que
 * cambia es que deja de medirse con la vara de la asistencia de piso, donde
 * salía con falta todos los días.
 */
@Component({
  selector: 'app-promotoras',
  standalone: true,
  imports: [CommonModule, FormsModule, SucursalSelectComponent, AsistenciaResumenComponent],
  templateUrl: './promotoras.html',
  // LA MISMA hoja de estilos que Horarios, no una copia.
  //
  // Esta pantalla nacio con su propio juego de clases (`pro-*`) y se veia
  // distinta aunque hace lo mismo: otro tono, otros espacios, otra tabla. RH lo
  // dijo de frente. Copiar el CSS habria arreglado el hoy y roto el mañana —dos
  // hojas para la misma apariencia se desincronizan en el primer ajuste—, asi que
  // se reusa la de Horarios y el marcado usa sus mismas clases `hz-*`.
  styleUrl: '../horarios/horarios.css'
})
export class PromotorasComponent implements OnInit, OnDestroy {
  private checador = inject(ChecadorService);
  private ngZone = inject(NgZone);
  private toast = inject(ToastService);

  SUCURSALES = CENTROS_CON_RELOJ;
  sucursalFiltro = CENTROS_CON_RELOJ[0]?.id || '';

  /**
   * La pestaña abierta. Las tres primeras son el MISMO componente de asistencia
   * que usa Horarios, con `soloPromotoras` puesto: misma regla, otra gente.
   * `padron` es la lista para dar de alta y mover entre planta y promotoría.
   */
  tab: VistaAsistencia | 'padron' = 'checadas';

  /** Contadores de las pestañas; los reporta el componente de asistencia. */
  conteos: ConteosPendientes = { rebasados: 0, faltas: 0 };
  onConteos(c: ConteosPendientes) { this.conteos = c; }

  empleados: Empleado[] = [];
  private unsub: any;

  /** Texto del buscador para pasar a alguien de planta a promotoras. */
  buscar = '';
  moviendo = '';
  subiendoFoto = false;
  edit: Empleado | null = null;

  ngOnInit() {
    this.unsub = this.checador.escucharEmpleados(lista => {
      this.ngZone.run(() => this.empleados = lista);
    });
  }
  ngOnDestroy() { if (this.unsub) this.unsub(); }

  // ── Listas ────────────────────────────────────────────────────────

  private get deLaSucursal(): Empleado[] {
    return this.empleados.filter(e =>
      (!this.sucursalFiltro || e.sucursalId === this.sucursalFiltro) && e.activo !== false);
  }

  get promotoras(): Empleado[] {
    return this.deLaSucursal.filter(e => e.esPromotora);
  }

  /** Cuántas promotoras hay en TODAS las plazas: el tamaño real del padrón. */
  get totalPromotoras(): number {
    return this.empleados.filter(e => e.esPromotora && e.activo !== false).length;
  }

  /** Candidatas: personal de planta de esta plaza que empata la búsqueda. */
  get candidatas(): Empleado[] {
    const base = this.deLaSucursal.filter(e => !e.esPromotora);
    const q = this.buscar.trim().toLowerCase();
    if (!q) return base.slice(0, 12);
    return base.filter(e =>
      `${e.nombre} ${e.nombreCompleto || ''} ${e.codigoChecador} ${e.puesto || ''}`.toLowerCase().includes(q)
    ).slice(0, 12);
  }

  // ── Acciones ──────────────────────────────────────────────────────

  /** Mueve a alguien entre planta y promotoras. Es un campo, no un borrado. */
  async marcar(e: Empleado, esPromotora: boolean) {
    if (!e.id || this.moviendo) return;
    this.moviendo = e.id;
    try {
      await this.checador.guardarEmpleado({ ...e, esPromotora });
      // Se refleja al instante para que el clic no se sienta perdido; el sondeo
      // lo confirma después.
      e.esPromotora = esPromotora;
      this.toast.exito(esPromotora
        ? `${this.nombreDe(e)} pasó a Promotoría y ya no cuenta en la asistencia de piso.`
        : `${this.nombreDe(e)} volvió a personal de planta.`);
      this.buscar = '';
    } catch (err) {
      console.error(err);
      this.toast.error('No se pudo mover a la persona. Intenta de nuevo.');
    } finally {
      this.moviendo = '';
    }
  }

  nueva() {
    this.edit = {
      sucursalId: this.sucursalFiltro || CENTROS_CON_RELOJ[0].id,
      codigoChecador: '', nombre: '', nombreCompleto: '', puesto: '', fotoUrl: '',
      activo: true, esPromotora: true
    };
  }
  editar(e: Empleado) { this.edit = { ...e }; }
  cerrar() { this.edit = null; }

  async guardar() {
    if (!this.edit) return;
    const e = this.edit;
    const nombre = (e.nombreCompleto || '').trim() || e.nombre;
    if (!nombre.trim() || !e.codigoChecador.trim() || !e.sucursalId) {
      this.toast.alerta('Hace falta el nombre, el código del reloj y la sucursal.');
      return;
    }
    // Si solo se escribió el nombre formal, el del reloj se rellena con él: la
    // ficha no puede quedarse sin `nombre`, que es la columna obligatoria.
    if (!e.nombre.trim()) e.nombre = nombre;
    try {
      await this.checador.guardarEmpleado({ ...e, esPromotora: true });
      this.toast.exito('Promotora guardada.');
      this.edit = null;
    } catch (err) {
      console.error(err);
      this.toast.error('No se pudo guardar.');
    }
  }

  async onFoto(event: any) {
    const file: File | undefined = event.target.files?.[0];
    if (!file || !this.edit) return;
    if (file.size > 5_000_000) {
      this.toast.alerta('La foto supera los 5 MB. Usa una más ligera.');
      event.target.value = '';
      return;
    }
    this.subiendoFoto = true;
    try {
      this.edit.fotoUrl = await subirACloudinary(file, 'empleados');
      this.toast.exito('Foto lista.');
    } catch (e) {
      console.error(e);
      this.toast.error('No se pudo subir la foto.');
    } finally {
      this.subiendoFoto = false;
      event.target.value = '';
    }
  }

  // ── Presentación ──────────────────────────────────────────────────

  nombreSucursal(id: string): string {
    const s = centroChecadorPorId(id);
    if (!s) return id || '—';
    return s.direccion ? `${s.ciudad} · ${s.direccion.split(',')[0]}` : s.ciudad;
  }

  /** El nombre formal si lo hay; si no, el apodo del reloj. */
  nombreDe(e: Empleado): string {
    return (e.nombreCompleto || '').trim() || e.nombre;
  }

  /** ¿Vale la pena enseñar también el del reloj? Solo si dice otra cosa. */
  apodoDistinto(e: Empleado): boolean {
    const formal = (e.nombreCompleto || '').trim();
    if (!formal || !e.nombre) return false;
    const pega = (t: string) => t.toLowerCase().normalize('NFD')
      .replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
    return pega(formal) !== pega(e.nombre);
  }

  iniciales(nombre: string): string {
    if (!nombre) return '?';
    return nombre.trim().split(/\s+/).slice(0, 2).map(p => p.charAt(0).toUpperCase()).join('');
  }
}
