import { Component, EventEmitter, inject, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChecadorService, EmpleadoPapelera } from '../../core/services/checador.service';
import { ToastService } from '../../core/services/toast.service';
import { centroChecadorPorId } from '../../core/models/sucursales.model';

/**
 * PAPELERA DE EMPLEADOS (29/09/2026).
 *
 * RH quitó el borrado: a quien ya no trabaja se le da de BAJA y viene a parar
 * aquí, de todas las plazas, por si un día se necesita regresarlo. Regresar lo
 * vuelve a contar en la asistencia y lo pone otra vez en su plaza.
 *
 * También están los que se ELIMINARON antes de que se quitara el botón (28/09).
 * A esos se les borró del reloj; regresarlos deja en cola volver a darlos de
 * alta en el equipo con el respaldo que se guardó al borrarlos, pero su huella
 * no venía en él: hay que volver a registrarla. Eso se dice antes de confirmar.
 */
@Component({
  selector: 'app-papelera-empleados',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './papelera-empleados.html',
  styleUrl: './papelera-empleados.css',
})
export class PapeleraEmpleadosComponent implements OnInit {
  private checador = inject(ChecadorService);
  private toast = inject(ToastService);

  /** Avisa a la página que alguien regresó, para que recargue su padrón. */
  @Output() regresado = new EventEmitter<void>();

  lista: EmpleadoPapelera[] = [];
  cargando = true;
  error = '';
  busqueda = '';
  plaza = '';
  regresando = '';
  /** Cuántos se pintan; la papelera trae cientos de las depuraciones del padrón. */
  limite = 60;

  ngOnInit() { this.cargar(); }

  async cargar() {
    this.cargando = true;
    try {
      this.lista = await this.checador.getPapeleraEmpleados();
      this.error = '';
    } catch {
      this.error = 'No se pudo leer la papelera. Intenta de nuevo.';
    } finally {
      this.cargando = false;
    }
  }

  private norm(t: string) { return (t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }

  nombreDe(e: EmpleadoPapelera): string { return (e.nombreCompleto || '').trim() || e.nombre; }

  /** Las plazas que tienen a alguien en la papelera, para el filtro. */
  get plazas(): { id: string; nombre: string; n: number }[] {
    const m = new Map<string, number>();
    for (const e of this.lista) m.set(e.sucursalId, (m.get(e.sucursalId) || 0) + 1);
    return [...m.entries()].map(([id, n]) => ({ id, nombre: this.nombrePlaza(id), n }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  }

  get filtrados(): EmpleadoPapelera[] {
    const q = this.norm(this.busqueda.trim());
    return this.lista.filter((e) => {
      if (this.plaza && e.sucursalId !== this.plaza) return false;
      if (!q) return true;
      const t = this.norm(`${this.nombreDe(e)} ${e.nombre} ${e.codigoChecador} ${e.departamento || ''} ${e.puesto || ''}`);
      return q.split(/\s+/).every((p) => t.includes(p));
    });
  }

  get visibles(): EmpleadoPapelera[] { return this.filtrados.slice(0, this.limite); }

  nombrePlaza(id: string): string {
    const s = centroChecadorPorId(id);
    if (!s) return id;
    return s.direccion ? `${s.ciudad} · ${s.direccion.split(',')[0]}` : s.ciudad;
  }

  fecha(iso: string | null | undefined): string {
    if (!iso) return '—';
    const d = new Date(String(iso).length <= 10 ? iso + 'T12:00:00' : iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' }).replace('.', '');
  }

  /** Cuándo y quién, en una línea. Las depuraciones viejas no dejaron fecha. */
  cuando(e: EmpleadoPapelera): string {
    if (e.eliminadoEn) return `Eliminado el ${this.fecha(e.eliminadoEn)}${e.eliminadoPor ? ' · ' + e.eliminadoPor : ''}`;
    if (e.bajaEn) return `${this.fecha(e.bajaEn)}${e.bajaPor ? ' · ' + e.bajaPor : ''}`;
    return 'Depuración del padrón (sin fecha)';
  }

  async regresar(e: EmpleadoPapelera) {
    if (this.regresando) return;
    const nombre = this.nombreDe(e);
    const plaza = this.nombrePlaza(e.sucursalId);
    const ok = await this.toast.confirmar({
      titulo: 'Regresar de la papelera',
      mensaje: `¿Seguro que quieres regresar a ${nombre} (#${e.codigoChecador}) a ${plaza}? ` +
        'Vuelve a contar en la asistencia desde hoy.' +
        (e.borradoDeReloj
          ? ' Se le había borrado del reloj: el agente lo vuelve a dar de alta ahí en unos minutos, ' +
            'pero su HUELLA hay que registrarla otra vez en el equipo.'
          : ''),
      textoConfirmar: 'Sí, regresar',
    });
    if (!ok) return;
    this.regresando = `${e.sucursalId}|${e.codigoChecador}`;
    try {
      const r = await this.checador.restaurarEmpleado(e.sucursalId, String(e.codigoChecador).trim());
      this.lista = this.lista.filter((x) => x !== e);
      this.toast.exito(r.relojes
        ? `${nombre} regresó. Se da de alta otra vez en ${r.relojes} reloj(es); falta registrar su huella.`
        : `${nombre} regresó a ${plaza}.`);
      this.regresado.emit();
    } catch (err) {
      console.error(err);
      this.toast.error('No se pudo regresar a la persona.');
    } finally {
      this.regresando = '';
    }
  }

  clave(e: EmpleadoPapelera) { return `${e.sucursalId}|${e.codigoChecador}`; }
}
