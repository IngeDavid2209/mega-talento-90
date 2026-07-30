import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import {
  RequisicionesService, Requisicion, EstadoRequisicion, MotivoRequisicion
} from '../../core/services/requisiciones.service';
import { PuestosService, Puesto } from '../../core/services/puestos.service';
import { CENTROS_CHECADOR, centroChecadorPorId } from '../../core/models/sucursales.model';
import { ToastService } from '../../core/services/toast.service';
import { subirACloudinary } from '../../core/services/cloudinary';

/**
 * =====================================================================
 * REQUISICIONES DE PERSONAL
 * =====================================================================
 *
 * Lo que las sucursales pedían por WhatsApp: "necesito a alguien para este
 * puesto". Sin un lugar donde vivan, no se puede contestar cuántas están
 * esperando, desde cuándo, ni cuáles ya se cubrieron.
 *
 * ── TRES DECISIONES DE LA PANTALLA ──────────────────────────────────
 *
 * 1. LO QUE URGE VA ARRIBA Y SE DICE CON PALABRAS. No hay un chip "URGENTE"
 *    fijo: hay "para hoy", "vencida hace 3 días" y "faltan 5 días". Una
 *    etiqueta roja permanente se vuelve paisaje en una semana; una cuenta que
 *    crece, no.
 *
 * 2. EL PUESTO SE ESCRIBE, NO SE ELIGE DE UNA LISTA. Casi siempre se pide
 *    personal para algo que todavía no existe como vacante publicada. Si hay
 *    una vacante que coincide se sugiere y se enlaza, pero nunca bloquea la
 *    captura: la requisición urgente no puede depender de que alguien haya
 *    dado de alta el puesto antes.
 *
 * 3. EL ADJUNTO ES OPCIONAL. El formato firmado a veces llega después, y
 *    obligarlo haría que la petición se quede en WhatsApp "mientras consigo
 *    la firma" — que es exactamente el problema que se está resolviendo.
 */
@Component({
  selector: 'app-requisiciones',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './requisiciones.html',
  styleUrl: './requisiciones.css'
})
export class RequisicionesComponent implements OnInit {
  private servicio = inject(RequisicionesService);
  private puestosService = inject(PuestosService);
  private toast = inject(ToastService);
  private router = inject(Router);

  SUCURSALES = CENTROS_CHECADOR;
  MOTIVOS: { id: MotivoRequisicion; label: string }[] = [
    { id: 'nuevo',     label: 'Puesto nuevo' },
    { id: 'reemplazo', label: 'Reemplazo' },
    { id: 'temporal',  label: 'Temporal / eventual' },
    { id: 'otro',      label: 'Otro' }
  ];
  FILTROS: { id: string; label: string }[] = [
    { id: 'abiertas',   label: 'Abiertas' },
    { id: 'pendiente',  label: 'Por autorizar' },
    { id: 'autorizada', label: 'Autorizadas' },
    { id: 'cubierta',   label: 'Cubiertas' },
    { id: '',           label: 'Todas' }
  ];

  lista: Requisicion[] = [];
  puestos: Puesto[] = [];
  filtro = 'abiertas';
  cargando = true;
  error = '';

  // ── Alta ──
  abierto = false;
  guardando = false;
  subiendo = false;
  nueva = this.enBlanco();

  /** Ids con una acción en vuelo, para no dispararla dos veces. */
  ocupado = new Set<string>();

  ngOnInit() {
    this.cargar();
    this.puestosService.obtener()
      .then(p => { this.puestos = p.filter(x => x.activo !== false); })
      .catch(() => { /* sin catálogo se captura a mano, que es el caso normal */ });
  }

  private enBlanco() {
    return {
      puesto: '', puestoId: null as string | null, sucursalId: '', area: '',
      vacantes: 1, motivo: 'nuevo' as MotivoRequisicion, reemplazaA: '',
      fechaRequerida: this.hoyISO(), justificacion: '', solicita: '',
      archivoUrl: '' as string | null, archivoNombre: '' as string | null
    };
  }

  /** Hoy en el reloj de quien captura, no en UTC. */
  hoyISO(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  async cargar() {
    this.cargando = true;
    this.error = '';
    try {
      this.lista = await this.servicio.listar(this.filtro || undefined);
    } catch (e: any) {
      this.error = e?.status === 401
        ? 'Tu sesión expiró. Vuelve a entrar.'
        : 'No se pudieron cargar las requisiciones.';
      this.lista = [];
    } finally {
      this.cargando = false;
    }
  }

  cambiarFiltro(id: string) { this.filtro = id; this.cargar(); }

  // ── Alta ───────────────────────────────────────────────────────────

  abrirAlta() { this.nueva = this.enBlanco(); this.abierto = true; }
  cerrarAlta() { this.abierto = false; }

  /** Si el texto del puesto coincide con una vacante abierta, se enlaza sola. */
  alEscribirPuesto() {
    const norm = (s: string) => String(s || '').toLowerCase().trim();
    const match = this.puestos.find(p => norm(p.nombre) === norm(this.nueva.puesto));
    this.nueva.puestoId = match?.id || null;
  }

  async adjuntar(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.subiendo = true;
    try {
      this.nueva.archivoUrl = await subirACloudinary(file, 'requisiciones');
      this.nueva.archivoNombre = file.name;
    } catch {
      this.toast.error('No se pudo subir el archivo. La requisición se puede guardar sin él.');
    } finally {
      this.subiendo = false;
      input.value = '';
    }
  }

  quitarAdjunto() { this.nueva.archivoUrl = ''; this.nueva.archivoNombre = ''; }

  get puedeGuardar(): boolean {
    return !!this.nueva.puesto.trim() && !this.guardando && !this.subiendo;
  }

  async guardar() {
    if (!this.puedeGuardar) return;
    this.guardando = true;
    try {
      await this.servicio.crear({
        ...this.nueva,
        puesto: this.nueva.puesto.trim(),
        sucursalId: this.nueva.sucursalId || null,
        area: this.nueva.area || null,
        reemplazaA: this.nueva.reemplazaA || null,
        justificacion: this.nueva.justificacion || null,
        solicita: this.nueva.solicita || null,
        fechaRequerida: this.nueva.fechaRequerida || null,
        archivoUrl: this.nueva.archivoUrl || null,
        archivoNombre: this.nueva.archivoNombre || null
      } as any);
      this.toast.exito('Requisición registrada.');
      this.abierto = false;
      await this.cargar();
    } catch {
      this.toast.error('No se pudo guardar la requisición.');
    } finally {
      this.guardando = false;
    }
  }

  // ── Decisiones sobre una requisición ───────────────────────────────

  async cambiarEstado(r: Requisicion, estado: EstadoRequisicion) {
    if (this.ocupado.has(r.id)) return;
    this.ocupado.add(r.id);
    try {
      const act = await this.servicio.actualizar(r.id, { estado });
      Object.assign(r, act);
      // La bandeja de "abiertas" ya no debe mostrar lo que acaba de cerrarse.
      if (this.filtro === 'abiertas' && (estado === 'cubierta' || estado === 'rechazada' || estado === 'cancelada')) {
        this.lista = this.lista.filter(x => x.id !== r.id);
      }
    } catch {
      this.toast.error('No se pudo actualizar.');
    } finally {
      this.ocupado.delete(r.id);
    }
  }

  async borrar(r: Requisicion) {
    const ok = await this.toast.confirmar({
      titulo: `Borrar la requisición #${r.folio}`,
      mensaje: 'Se usa solo para capturas equivocadas. Si ya no se necesita, mejor cancélala para que quede el registro.',
      textoConfirmar: 'Borrar',
      destructivo: true
    });
    if (!ok) return;
    try {
      await this.servicio.borrar(r.id);
      this.lista = this.lista.filter(x => x.id !== r.id);
    } catch {
      this.toast.error('No se pudo borrar.');
    }
  }

  /** Abre la bolsa de candidatos filtrada por el puesto pedido. */
  buscarCandidatos(r: Requisicion) {
    this.router.navigate(['/app/etapa', 'filtro_inicial'], { queryParams: { puesto: r.puesto } });
  }

  // ── Cómo se lee cada requisición ───────────────────────────────────

  sucursal(id: string | null): string {
    if (!id) return 'Sin sucursal';
    const s = centroChecadorPorId(id);
    return s ? `${s.ciudad}${s.direccion ? ' · ' + s.direccion.split(',')[0] : ''}` : id;
  }

  motivoLabel(m: string): string {
    return this.MOTIVOS.find(x => x.id === m)?.label || m;
  }

  /**
   * El texto de la urgencia. Es la única columna que la gente va a leer de
   * verdad, así que dice el estado en palabras y no un color a interpretar.
   */
  urgencia(r: Requisicion): string {
    if (r.estado === 'cubierta') return 'Cubierta';
    if (r.estado === 'rechazada') return 'Rechazada';
    if (r.estado === 'cancelada') return 'Cancelada';
    const d = r.diasParaFecha;
    if (d === null) return `${r.diasEsperando} día(s) esperando`;
    if (d < 0) return `Vencida hace ${Math.abs(d)} día(s)`;
    if (d === 0) return 'Para hoy';
    if (d === 1) return 'Para mañana';
    return `Faltan ${d} día(s)`;
  }

  /** bien | atencion | tarde | listo — decide el color de la fila. */
  nivel(r: Requisicion): string {
    if (r.estado === 'cubierta') return 'listo';
    if (r.estado === 'rechazada' || r.estado === 'cancelada') return 'cerrado';
    const d = r.diasParaFecha;
    if (d === null) return r.diasEsperando > 7 ? 'atencion' : 'bien';
    if (d < 0) return 'tarde';
    if (d <= 1) return 'atencion';
    return 'bien';
  }

  fecha(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso.length === 10 ? iso + 'T12:00:00' : iso);
    return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
  }

  // ── Totales del encabezado ─────────────────────────────────────────

  get personasPedidas(): number {
    return this.lista
      .filter(r => r.estado === 'pendiente' || r.estado === 'autorizada')
      .reduce((a, r) => a + r.vacantes, 0);
  }
  get cuantasVencidas(): number {
    return this.lista.filter(r => this.nivel(r) === 'tarde').length;
  }
  get cuantasParaHoy(): number {
    return this.lista.filter(r => r.diasParaFecha === 0 && (r.estado === 'pendiente' || r.estado === 'autorizada')).length;
  }
}
