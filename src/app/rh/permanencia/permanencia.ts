import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import {
  PermanenciaService, Permanencia, PersonaPermanencia, EmpleadoReloj, EstadoPermanencia
} from '../../core/services/permanencia.service';
import { centroChecadorPorId } from '../../core/models/sucursales.model';
import { ToastService } from '../../core/services/toast.service';
import { CandidateService } from '../../core/services/candidate';
import {
  DIAS_ENCUESTA, DiaEncuesta, EncuestaDePersona, encuestasDe, mensajeEncuesta
} from '../../core/models/encuestas-onboarding.model';

/**
 * =====================================================================
 * PERMANENCIA · ¿el contratado sigue a los 90 días?
 * =====================================================================
 *
 * La pantalla del KPI que pidió Capital Humano: medir a cada persona desde su
 * primer contrato hasta los 90 días.
 *
 * ── LO QUE ESTA PANTALLA SE NIEGA A HACER ───────────────────────────
 *
 * Presentar como "permanencia" lo que solo es una etiqueta. El portal marca a
 * alguien como contratado el día que entra y nadie vuelve a tocar esa etiqueta
 * cuando renuncia: si el indicador se calculara con eso, diría 100% para
 * siempre. Por eso cada hito muestra el número CONFIRMADO con el reloj checador
 * —checó en o después del día 90, eso no se puede fingir— y, al lado y en gris,
 * lo que dice el portal.
 *
 * La diferencia entre las dos cifras no es un defecto que esconder: es el
 * trabajo de captura que falta, y por eso se pone a la vista con su botón para
 * resolverlo (ligar a la persona con su código del reloj).
 */
@Component({
  selector: 'app-permanencia',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './permanencia.html',
  styleUrl: './permanencia.css'
})
export class PermanenciaComponent implements OnInit {
  private servicio = inject(PermanenciaService);
  private toast = inject(ToastService);
  private router = inject(Router);

  cargando = true;
  error = '';
  datos: Permanencia | null = null;

  /** Filtro de la lista de personas. */
  filtro: 'todos' | 'pendientes' | 'riesgo' = 'todos';
  busqueda = '';

  // ── Panel de liga con el reloj (se abre por persona) ──
  ligando: PersonaPermanencia | null = null;
  candidatosReloj: EmpleadoReloj[] = [];
  buscandoReloj = false;
  qReloj = '';
  guardando = false;

  // ── Captura de fecha de ingreso faltante ──
  editandoFecha: PersonaPermanencia | null = null;
  fechaNueva = '';

  ngOnInit() { this.cargar(); }

  async cargar() {
    this.cargando = true;
    this.error = '';
    try {
      this.datos = await this.servicio.tablero();
    } catch (e: any) {
      this.error = e?.status === 401
        ? 'Tu sesión expiró. Vuelve a entrar para ver el tablero.'
        : 'No se pudo cargar la permanencia. Reintenta en un momento.';
    } finally {
      this.cargando = false;
    }
  }

  // ── Lista ──────────────────────────────────────────────────────────

  get personas(): PersonaPermanencia[] {
    const todas = this.datos?.personas || [];
    const q = this.busqueda.trim().toLowerCase();
    return todas.filter(p => {
      if (q && !`${p.nombre} ${p.puesto}`.toLowerCase().includes(q)) return false;
      // "Pendientes" es la lista de trabajo: a quién le falta fecha o liga.
      if (this.filtro === 'pendientes') return !p.ingreso || !p.empleado?.confirmado;
      if (this.filtro === 'riesgo') return p.estado === 'sin_marcas' || p.estado === 'baja_portal';
      return true;
    });
  }

  get hayPendientes(): number {
    return (this.datos?.personas || []).filter(p => !p.ingreso || !p.empleado?.confirmado).length;
  }

  get hayRiesgo(): number {
    return (this.datos?.personas || []).filter(p => p.estado === 'sin_marcas' || p.estado === 'baja_portal').length;
  }

  /** Avance hacia los 90 días, tope 100 para que la barra no se desborde. */
  avance(dias: number | null): number {
    if (!dias) return 0;
    return Math.min(100, Math.round((dias / 90) * 100));
  }

  etiquetaEstado(e: EstadoPermanencia): string {
    return e === 'activo'        ? 'Checando'
         : e === 'sin_marcas'    ? 'Sin marcas'
         : e === 'baja_portal'   ? 'Ya no es contratado'
         :                         'Sin verificar';
  }

  /** Lo que el estado significa en una frase, para el tooltip de la fila. */
  explicaEstado(p: PersonaPermanencia): string {
    switch (p.estado) {
      case 'activo':
        return `Checó ${p.diasSinChecar === 0 ? 'hoy' : `hace ${p.diasSinChecar} día(s)`} en el reloj.`;
      case 'sin_marcas':
        return p.ultimaChecada
          ? `Su última marca fue el ${p.ultimaChecada} (hace ${p.diasSinChecar} días). Puede ser baja, incapacidad o vacaciones.`
          : 'Está ligado al reloj pero no tiene ninguna marca registrada.';
      case 'baja_portal':
        return 'En el portal ya no está en la etapa Contratados.';
      default:
        return 'No está ligado a un código del reloj, así que no se puede comprobar si sigue trabajando.';
    }
  }

  /** Mismo formato que en Requisiciones y el Dashboard: "Ciudad · calle". */
  nombreSucursal(id: string | undefined): string {
    if (!id) return '';
    const s = centroChecadorPorId(id);
    return s ? `${s.ciudad}${s.direccion ? ' · ' + s.direccion.split(',')[0] : ''}` : id;
  }

  fechaCorta(iso: string | null): string {
    if (!iso) return '—';
    const f = new Date(iso.slice(0, 10) + 'T12:00:00');
    if (isNaN(f.getTime())) return iso;
    return f.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: '2-digit' });
  }

  /** 'agosto 2026' a partir de '2026-08'. */
  nombreMes(mes: string): string {
    const f = new Date(mes + '-15T12:00:00');
    if (isNaN(f.getTime())) return mes;
    const t = f.toLocaleDateString('es-MX', { month: 'long', year: 'numeric' });
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  abrirExpediente(id: string) { this.router.navigate(['/app/expediente', id]); }

  // ── ENCUESTAS DE ONBOARDING ────────────────────────────────────────
  //
  // Las cinco encuestas de Google Forms que ya tenía Capital Humano (día 3, 7,
  // 15, 30 y 90), enganchadas a la fecha de ingreso de cada quien. La liga sale
  // PRELLENADA con su nombre, puesto, sucursal, fecha y qué corte le toca: son
  // seis campos menos que contestar, y sobre todo hace que la respuesta llegue
  // ya amarrada a la persona (ver encuestas-onboarding.model.ts).
  //
  // Falta el último tramo para que salgan solas: el bot no tiene endpoint para
  // mandar un mensaje cualquiera (se probó el 12/08: /api/mensaje da 404, solo
  // existen /api/decidir y /api/aviso-asistencia). Mientras tanto se mandan
  // desde aquí con un clic, que ya es infinitamente mejor que a mano.

  private candidatos = inject(CandidateService);
  DIAS_ENCUESTA = DIAS_ENCUESTA;
  marcandoEncuesta = '';
  /** Solo las que ya tocan: la lista de trabajo del día. */
  soloPendientes = true;

  /** El calendario de encuestas de una persona. */
  encuestasDe(p: PersonaPermanencia): EncuestaDePersona[] {
    return encuestasDe(
      {
        nombre: p.nombre, puesto: p.puesto, ingreso: p.ingreso,
        sucursal: p.empleado ? this.nombreSucursal(p.empleado.sucursalId) : '',
      },
      this.datos?.hoy || '',
      p.encuestas || {}
    );
  }

  /** Las que hay que mandar hoy o que ya se pasaron y nadie mandó. */
  pendientesDe(p: PersonaPermanencia): EncuestaDePersona[] {
    return this.encuestasDe(p).filter(e => e.estado === 'toca_hoy' || e.estado === 'vencida');
  }

  /** Personas que tienen algo que mandar. Es la lista accionable de la pantalla. */
  get conEncuestaPendiente(): PersonaPermanencia[] {
    return (this.datos?.personas || []).filter(p => p.ingreso && this.pendientesDe(p).length);
  }

  get personasConEncuestas(): PersonaPermanencia[] {
    const base = (this.datos?.personas || []).filter(p => p.ingreso);
    return this.soloPendientes ? this.conEncuestaPendiente : base;
  }

  etiquetaEncuesta(e: EncuestaDePersona): string {
    switch (e.estado) {
      case 'contestada': return 'Contestada';
      case 'enviada':    return 'Enviada';
      case 'toca_hoy':   return 'Toca hoy';
      case 'vencida':    return `Vencida hace ${Math.abs(e.faltan)} d`;
      default:           return `En ${e.faltan} d`;
    }
  }

  /** Abre WhatsApp con el mensaje y la liga listos, y la deja marcada como enviada. */
  async mandarPorWhatsApp(p: PersonaPermanencia, e: EncuestaDePersona) {
    const tel = String(p.telefono || '').replace(/\D/g, '');
    if (!tel) {
      this.toast.alerta(`${p.nombre} no tiene teléfono capturado. Copia la liga y mándasela por otro medio.`, 'Sin teléfono');
      return;
    }
    const numero = tel.length === 10 ? `52${tel}` : tel;
    const texto = encodeURIComponent(mensajeEncuesta(p.nombre, e.dia, e.liga));
    window.open(`https://wa.me/${numero}?text=${texto}`, '_blank');
    await this.marcarEncuesta(p, e.dia, 'enviada');
  }

  async copiarLiga(e: EncuestaDePersona) {
    try {
      await navigator.clipboard.writeText(e.liga);
      this.toast.exito('Liga copiada, ya viene con sus datos puestos.', `Encuesta día ${e.dia}`);
    } catch {
      this.toast.alerta('El navegador no dejó copiar. Abre la liga y cópiala de la barra.', 'No se pudo copiar');
    }
  }

  /**
   * Deja constancia de que se mandó (o de que contestó, cuando RH lo confirma a
   * mano). Se guarda en el candidato, en `portal_data.encuestas`, con la misma
   * mecánica que el resto de las marcas de la ficha.
   */
  async marcarEncuesta(p: PersonaPermanencia, dia: DiaEncuesta, que: 'enviada' | 'contestada') {
    const clave = `${p.id}:${dia}`;
    if (this.marcandoEncuesta === clave) return;
    this.marcandoEncuesta = clave;
    const previas = { ...(p.encuestas || {}) };
    try {
      const reg = { ...previas };
      const actual = { ...(reg[String(dia)] || {}) };
      if (que === 'enviada') actual.enviadaEn = new Date().toISOString();
      else actual.contestadaEn = new Date().toISOString();
      reg[String(dia)] = actual;
      p.encuestas = reg;   // se refleja al instante
      await this.candidatos.updateCandidate(p.id, { encuestas: reg });
    } catch {
      p.encuestas = previas;
      this.toast.error('No se pudo guardar el registro de la encuesta.', 'Error');
    } finally {
      this.marcandoEncuesta = '';
    }
  }

  // ── Liga con el reloj ──────────────────────────────────────────────

  async abrirLiga(p: PersonaPermanencia, ev?: Event) {
    ev?.stopPropagation();
    this.ligando = p;
    // El primer apellido suele bastar para encontrarlo en el padrón.
    this.qReloj = (p.nombre || '').split(/\s+/).slice(-2).join(' ');
    await this.buscarReloj();
  }

  cerrarLiga() { this.ligando = null; this.candidatosReloj = []; this.qReloj = ''; }

  async buscarReloj() {
    this.buscandoReloj = true;
    try {
      this.candidatosReloj = await this.servicio.buscarEmpleados(this.qReloj.trim());
    } catch {
      this.candidatosReloj = [];
      this.toast.error('No se pudo leer el padrón del reloj.', 'Error de conexión');
    } finally {
      this.buscandoReloj = false;
    }
  }

  /** Confirma la liga (o la sugerencia que ya venía pintada). */
  async confirmarLiga(empleadoId: string | null, ev?: Event) {
    ev?.stopPropagation();
    const p = this.ligando;
    if (!p || this.guardando) return;
    this.guardando = true;
    try {
      await this.servicio.vincular(p.id, empleadoId);
      this.toast.exito(
        empleadoId ? `${p.nombre} quedó ligado al reloj.` : `Se quitó la liga de ${p.nombre}.`,
        'Listo'
      );
      this.cerrarLiga();
      await this.cargar();   // los hitos cambian: hay que recalcular
    } catch (e: any) {
      this.toast.error(e?.error?.error || 'No se pudo guardar la liga.', 'No se guardó');
    } finally {
      this.guardando = false;
    }
  }

  /** Acepta de un clic la coincidencia que el sistema ya encontró por nombre. */
  async aceptarSugerencia(p: PersonaPermanencia, ev?: Event) {
    ev?.stopPropagation();
    if (!p.empleado || p.empleado.confirmado || this.guardando) return;
    this.guardando = true;
    try {
      await this.servicio.vincular(p.id, p.empleado.id);
      this.toast.exito(`${p.nombre} quedó ligado a ${p.empleado.nombre}.`, 'Liga confirmada');
      await this.cargar();
    } catch (e: any) {
      this.toast.error(e?.error?.error || 'No se pudo guardar la liga.', 'No se guardó');
    } finally {
      this.guardando = false;
    }
  }

  async quitarLiga(p: PersonaPermanencia, ev?: Event) {
    ev?.stopPropagation();
    if (this.guardando) return;
    this.guardando = true;
    try {
      await this.servicio.vincular(p.id, null);
      await this.cargar();
    } catch {
      this.toast.error('No se pudo quitar la liga.', 'Error');
    } finally {
      this.guardando = false;
    }
  }

  // ── Fecha de ingreso ───────────────────────────────────────────────

  abrirFecha(p: PersonaPermanencia, ev?: Event) {
    ev?.stopPropagation();
    this.editandoFecha = p;
    this.fechaNueva = p.ingreso || this.datos?.hoy || '';
  }

  cerrarFecha() { this.editandoFecha = null; this.fechaNueva = ''; }

  async guardarFecha() {
    const p = this.editandoFecha;
    if (!p || !this.fechaNueva || this.guardando) return;
    this.guardando = true;
    try {
      await this.servicio.fijarIngreso(p.id, this.fechaNueva);
      this.toast.exito(`Fecha de ingreso de ${p.nombre} guardada.`, 'Listo');
      this.cerrarFecha();
      await this.cargar();
    } catch (e: any) {
      this.toast.error(e?.error?.error || 'No se pudo guardar la fecha.', 'No se guardó');
    } finally {
      this.guardando = false;
    }
  }
}
