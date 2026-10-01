import { Injectable, signal } from '@angular/core';

export type TipoToast = 'success' | 'info' | 'warning' | 'error';

export interface Toast {
  id: number;
  texto: string;
  tipo: TipoToast;
  /** Si se da, reemplaza el primer renglón en bold del toast */
  titulo?: string;
}

export interface ConfirmacionConfig {
  titulo: string;
  mensaje: string;
  textoConfirmar?: string;
  textoCancelar?: string;
  /** Si es true, el botón de confirmar se muestra en rojo (destructivo) */
  destructivo?: boolean;
  /**
   * Un renglón para escribir (un motivo, una nota). Con `obligatorio`, el botón
   * de confirmar no se habilita hasta que se escribe algo. Ver `pedirTexto`.
   */
  campo?: { etiqueta: string; placeholder?: string; obligatorio?: boolean };
}

interface ConfirmacionPendiente extends ConfirmacionConfig {
  resolve: (v: boolean) => void;
  /** Lo escrito en `campo`. */
  valor: string;
}

/**
 * Sistema de toasts y modales de confirmación con estilo corporativo
 * (navy + dorado), montado globalmente.
 *
 * Reemplaza los alert() / confirm() nativos del navegador:
 *
 *   toast.exito('Link copiado');
 *   toast.error('No se pudo guardar', 'Error de red');
 *   const ok = await toast.confirmar({ titulo: 'Borrar?', mensaje: '...' });
 *
 * El componente <app-toast-container> debe montarse una sola vez en app.html
 * para que los toasts se rendericen.
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  /** Lista reactiva de toasts visibles ahora mismo */
  toasts = signal<Toast[]>([]);

  /** Configuración del modal de confirmación activo (null si no hay) */
  confirmacion = signal<ConfirmacionPendiente | null>(null);

  private siguienteId = 1;

  /** Toast verde de éxito (auto-dismiss en 4s) */
  exito(texto: string, titulo?: string): void {
    this.mostrar({ texto, titulo, tipo: 'success' });
  }

  /** Toast azul informativo (auto-dismiss en 4s) */
  info(texto: string, titulo?: string): void {
    this.mostrar({ texto, titulo, tipo: 'info' });
  }

  /** Toast ámbar de advertencia (auto-dismiss en 6s) */
  alerta(texto: string, titulo?: string): void {
    this.mostrar({ texto, titulo, tipo: 'warning' });
  }

  /** Toast rojo de error (NO se auto-dismissea, el usuario lo cierra) */
  error(texto: string, titulo?: string): void {
    this.mostrar({ texto, titulo, tipo: 'error' });
  }

  /**
   * Modal centrado de Sí/No. Devuelve true si el usuario confirma,
   * false si cancela o cierra con Escape.
   */
  confirmar(cfg: ConfirmacionConfig): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.confirmacion.set({ ...cfg, resolve, valor: '' });
    });
  }

  /**
   * Como `confirmar`, pero con un renglón para escribir. Devuelve lo escrito
   * (sin espacios a los lados) o null si se cancela.
   *
   *   const motivo = await toast.pedirTexto({ titulo: 'Quitar', mensaje: '…',
   *     campo: { etiqueta: '¿Por qué?', obligatorio: true } });
   */
  async pedirTexto(cfg: ConfirmacionConfig & { campo: NonNullable<ConfirmacionConfig['campo']> }): Promise<string | null> {
    let valor = '';
    const ok = await new Promise<boolean>((resolve) => {
      const pendiente: ConfirmacionPendiente = { ...cfg, valor: '', resolve: (v) => { valor = pendiente.valor; resolve(v); } };
      this.confirmacion.set(pendiente);
    });
    return ok ? valor.trim() : null;
  }

  /** Lo escrito en el renglón del modal (lo llama el componente). */
  escribir(texto: string): void {
    const c = this.confirmacion();
    if (c) c.valor = texto;
  }

  /** Llamado por el componente cuando el usuario elige */
  resolverConfirmacion(valor: boolean): void {
    const c = this.confirmacion();
    if (!c) return;
    this.confirmacion.set(null);
    c.resolve(valor);
  }

  /** Cierra un toast manualmente (usado por la X del componente) */
  cerrar(id: number): void {
    this.toasts.update(lista => lista.filter(t => t.id !== id));
  }

  private mostrar(t: Omit<Toast, 'id'>): void {
    const id = this.siguienteId++;
    const toast: Toast = { ...t, id };
    this.toasts.update(lista => [...lista, toast]);

    // Auto-dismiss según tipo
    if (t.tipo !== 'error') {
      const ms = t.tipo === 'warning' ? 6000 : 4000;
      setTimeout(() => this.cerrar(id), ms);
    }
  }
}
