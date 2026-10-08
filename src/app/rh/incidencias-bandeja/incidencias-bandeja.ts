import { Component, inject, Input, OnChanges, OnInit, Output, EventEmitter, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import * as XLSX from 'xlsx';
import {
  ChecadorService, Incidencia, CierreSemana, PasoBitacora, TipoIncidencia, EstadoIncidencia,
} from '../../core/services/checador.service';
import { Empleado, aFechaLocal } from '../../core/models/checador.model';
import { centroChecadorPorId } from '../../core/models/sucursales.model';
import { semanaFiscal } from '../../core/models/semana-fiscal';
import { PeriodoAsistenciaService } from '../../core/services/periodo-asistencia.service';
import { ToastService } from '../../core/services/toast.service';
import { ETIQUETA_ESTADO_INC, ETIQUETA_BANDERA, mensajeDeError } from './incidencias-flujo';

type Filtro = 'pendientes' | 'vigentes' | 'banderas' | 'auditar' | 'rechazadas' | 'anuladas' | 'todas';

/** Una semana de nómina en la lista de cierres. */
interface SemanaCierre {
  numero: number; desde: string; hasta: string;
  cierre: CierreSemana | null;
  /** Incidencias por calificar en esa semana: con alguna, no se puede cerrar. */
  pendientes: number;
}

/**
 * BANDEJA DE INCIDENCIAS Y CIERRE DE SEMANA (01/10/2026).
 *
 * El lugar de trabajo de dos puestos que no tenían pantalla:
 *
 *   · SERVICIOS AL PERSONAL recibe lo que entregan los encargados, lo CALIFICA
 *     o lo RECHAZA, y CIERRA la semana para prenómina (eso guarda la foto del
 *     cálculo y bloquea la semana).
 *   · CONTABILIDAD revisa lo cerrado, mira las banderas (horario corrido una
 *     hora, autocalificadas, sin respaldo, tardías) y lo AUDITA. No puede
 *     auditar lo que ella misma capturó o calificó: la API lo impide.
 *
 * Nada se borra: quitar es ANULAR con motivo, y cada paso queda en la bitácora
 * que se abre en cada renglón. El flujo vive en api/src/incidencias.ts y el
 * cierre en api/src/cierres.ts.
 */
@Component({
  selector: 'app-incidencias-bandeja',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './incidencias-bandeja.html',
  styleUrl: './incidencias-bandeja.css',
})
export class IncidenciasBandejaComponent implements OnInit, OnChanges {
  private checador = inject(ChecadorService);
  private periodo = inject(PeriodoAsistenciaService);
  private toast = inject(ToastService);

  @Input() sucursalId = '';
  /** El padrón, para poner nombre a cada código. */
  @Input() empleados: Empleado[] = [];
  /** Cuántas esperan calificación (para el contador de la pestaña). */
  @Output() pendientes = new EventEmitter<number>();

  readonly ETIQUETA_ESTADO_INC = ETIQUETA_ESTADO_INC;
  readonly ETIQUETA_BANDERA = ETIQUETA_BANDERA;
  /** La semana de nómina abre en jueves. */
  private readonly DIA_CORTE = 4;
  /** Cuántas semanas pasadas se ofrecen para cerrar. */
  private readonly SEMANAS_A_LA_VISTA = 6;

  desde = '';
  hasta = '';
  lista: Incidencia[] = [];
  cargando = false;
  error = '';
  filtro: Filtro = 'pendientes';
  tipos: TipoIncidencia[] = [];
  semanas: SemanaCierre[] = [];
  /** Renglón ocupado (para apagar sus botones mientras guarda). */
  trabajando = '';
  bitacoras = new Map<string, PasoBitacora[] | 'cargando'>();

  ngOnInit() {
    const hoy = new Date();
    const hace = new Date(); hace.setDate(hoy.getDate() - 14);
    this.desde = this.periodo.desde || aFechaLocal(hace);
    this.hasta = this.periodo.hasta || aFechaLocal(hoy);
    this.checador.getTiposIncidencia().then((t) => this.tipos = t).catch(() => undefined);
    this.cargar();
  }

  ngOnChanges(c: SimpleChanges) {
    if (c['sucursalId'] && !c['sucursalId'].firstChange) this.cargar();
  }

  cambiarPeriodo() {
    if (!this.desde || !this.hasta || this.hasta < this.desde) return;
    this.periodo.fijar(this.desde, this.hasta);
    this.cargarLista();
  }

  async cargar() {
    await Promise.all([this.cargarLista(), this.cargarSemanas()]);
  }

  async cargarLista() {
    if (!this.sucursalId || !this.desde || !this.hasta) { this.lista = []; return; }
    this.cargando = true;
    this.error = '';
    try {
      // 'todas' trae también las anuladas: la auditoría tiene que verlas.
      this.lista = await this.checador.getIncidencias(this.sucursalId, this.desde, this.hasta, { estados: 'todas' });
      this.pendientes.emit(this.lista.filter((i) => i.estado === 'capturada').length);
    } catch (e) {
      console.error(e);
      this.error = mensajeDeError(e, 'No se pudieron leer las incidencias.');
      this.lista = [];
    } finally {
      this.cargando = false;
    }
  }

  // ══ LISTA ══════════════════════════════════════════════════════════

  private pasa(i: Incidencia, f: Filtro): boolean {
    switch (f) {
      case 'pendientes': return i.estado === 'capturada';
      case 'vigentes':   return i.estado === 'calificada' || i.estado === 'cerrada' || i.estado === 'auditada';
      case 'banderas':   return !!i.banderas?.length && i.estado !== 'anulada' && i.estado !== 'rechazada';
      case 'auditar':    return i.estado === 'cerrada';
      case 'rechazadas': return i.estado === 'rechazada';
      case 'anuladas':   return i.estado === 'anulada';
      default:           return true;
    }
  }

  get visibles(): Incidencia[] { return this.lista.filter((i) => this.pasa(i, this.filtro)); }
  cuantas(f: Filtro): number { return this.lista.filter((i) => this.pasa(i, f)).length; }

  readonly FILTROS: { f: Filtro; l: string; t: string }[] = [
    { f: 'pendientes', l: 'Por calificar', t: 'Lo que entregaron y todavía no cuenta en el número.' },
    { f: 'vigentes', l: 'Cuentan', t: 'Calificadas, cerradas y auditadas: las que cambian la asistencia.' },
    { f: 'banderas', l: 'Con bandera', t: 'Horario corrido una hora o más, frecuentes, autocalificadas, sin respaldo o tardías.' },
    { f: 'auditar', l: 'Por auditar', t: 'Cerradas en prenómina, esperando a contabilidad.' },
    { f: 'rechazadas', l: 'Rechazadas', t: '' },
    { f: 'anuladas', l: 'Anuladas', t: 'Se quitaron: siguen aquí con quién y por qué.' },
    { f: 'todas', l: 'Todas', t: '' },
  ];

  nombre(codigo: string): string {
    const e = this.empleados.find((x) => x.sucursalId === this.sucursalId && String(x.codigoChecador).trim() === codigo);
    return (e?.nombreCompleto || '').trim() || e?.nombre || `#${codigo}`;
  }

  tipoInfo(tipo: string): { codigo: string; etiqueta: string } {
    const t = this.tipos.find((x) => x.tipo === tipo);
    return { codigo: t?.codigo || (tipo === 'horario_distinto' ? 'HD' : 'OTR'), etiqueta: t?.etiqueta || tipo };
  }

  quien(correo?: string): string { return (correo || '').split('@')[0] || '—'; }

  fechaCorta(iso: string): string {
    const d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' }).replace(/\./g, '');
  }
  periodoDe(i: Incidencia): string {
    return i.desde === i.hasta ? this.fechaCorta(i.desde) : `${this.fechaCorta(i.desde)} → ${this.fechaCorta(i.hasta)}`;
  }
  cuandoFue(ts?: string | null): string {
    if (!ts) return '';
    return new Date(ts).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).replace(/\./g, '');
  }
  hora(min: number | null | undefined): string {
    if (min == null) return '—';
    return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  }
  /** "+1 h 30 min" para el Horario distinto. */
  corrimiento(i: Incidencia): string {
    if (i.tipo !== 'horario_distinto' || i.minutos == null || i.horarioBaseMin == null) return '';
    const d = i.minutos - i.horarioBaseMin, a = Math.abs(d), h = Math.floor(a / 60), m = a % 60;
    return `${d < 0 ? '−' : '+'}${h ? h + ' h' + (m ? ' ' + m + ' min' : '') : m + ' min'}`;
  }

  // ══ PASOS ═════════════════════════════════════════════════════════

  private async paso(i: Incidencia, accion: 'calificar' | 'rechazar' | 'anular' | 'auditar', motivo = '') {
    if (!i.id || this.trabajando) return false;
    this.trabajando = i.id;
    try {
      const r = await this.checador.pasoIncidencia(i.id, accion, motivo);
      Object.assign(i, r);
      this.bitacoras.delete(i.id);
      this.pendientes.emit(this.lista.filter((x) => x.estado === 'capturada').length);
      return true;
    } catch (e) {
      console.error(e);
      this.toast.error(mensajeDeError(e, 'No se pudo guardar el cambio.'));
      return false;
    } finally {
      this.trabajando = '';
    }
  }

  async calificar(i: Incidencia) {
    const ok = await this.toast.confirmar({
      titulo: 'Calificar incidencia',
      mensaje: `${this.tipoInfo(i.tipo).etiqueta} de ${this.nombre(i.empleadoCodigo)} (${this.periodoDe(i)}). ` +
        'Al calificarla empieza a contar en la asistencia y entra a la prenómina de su semana.',
      textoConfirmar: 'Sí, calificar',
    });
    if (ok && await this.paso(i, 'calificar')) this.toast.exito('Calificada: ya cuenta en la asistencia.');
  }

  async rechazar(i: Incidencia) {
    const motivo = await this.toast.pedirTexto({
      titulo: 'Rechazar incidencia',
      mensaje: `${this.tipoInfo(i.tipo).etiqueta} de ${this.nombre(i.empleadoCodigo)}. No va a contar; quien la entregó ve el motivo.`,
      destructivo: true, textoConfirmar: 'Rechazar',
      campo: { etiqueta: '¿Por qué se rechaza?', placeholder: 'Ej. falta el comprobante de la incapacidad', obligatorio: true },
    });
    if (motivo && await this.paso(i, 'rechazar', motivo)) this.toast.exito('Rechazada.');
  }

  async anular(i: Incidencia) {
    const motivo = await this.toast.pedirTexto({
      titulo: 'Quitar incidencia',
      mensaje: `${this.tipoInfo(i.tipo).etiqueta} de ${this.nombre(i.empleadoCodigo)}. Deja de contar, pero no se borra: queda anulada en el registro.`,
      destructivo: true, textoConfirmar: 'Quitar',
      campo: { etiqueta: '¿Por qué se quita?', placeholder: 'Ej. se capturó a la persona equivocada', obligatorio: true },
    });
    if (motivo && await this.paso(i, 'anular', motivo)) this.toast.exito('Anulada.');
  }

  async auditar(i: Incidencia) {
    const nota = await this.toast.pedirTexto({
      titulo: 'Auditar incidencia',
      mensaje: `${this.tipoInfo(i.tipo).etiqueta} de ${this.nombre(i.empleadoCodigo)} (${this.periodoDe(i)}). ` +
        `Capturó ${this.quien(i.creadoPor)}, calificó ${this.quien(i.calificadoPor)}.`,
      textoConfirmar: 'Marcar auditada',
      campo: { etiqueta: 'Observación', placeholder: 'Ej. coincide con el formato firmado' },
    });
    if (nota !== null && await this.paso(i, 'auditar', nota)) this.toast.exito('Auditada.');
  }

  /**
   * Califica de un jalón lo que NO trae bandera. Lo que trae bandera se queda
   * para verlo una por una: es justo lo que hay que mirar con calma.
   */
  get calificablesSinBandera(): Incidencia[] {
    return this.lista.filter((i) => i.estado === 'capturada' && !i.banderas?.length);
  }
  async calificarSinBandera() {
    const l = this.calificablesSinBandera;
    if (!l.length) return;
    const ok = await this.toast.confirmar({
      titulo: 'Calificar sin bandera',
      mensaje: `¿Calificar las ${l.length} incidencias por calificar que no traen ninguna bandera? Las que traen bandera se quedan para revisarlas una por una.`,
      textoConfirmar: `Sí, calificar ${l.length}`,
    });
    if (!ok) return;
    let bien = 0;
    for (const i of l) if (await this.paso(i, 'calificar')) bien++;
    this.toast.exito(`${bien} de ${l.length} calificadas.`);
  }

  async verBitacora(i: Incidencia) {
    if (!i.id) return;
    if (this.bitacoras.has(i.id)) { this.bitacoras.delete(i.id); return; }
    this.bitacoras.set(i.id, 'cargando');
    try { this.bitacoras.set(i.id, await this.checador.getBitacoraIncidencia(i.id)); }
    catch { this.bitacoras.delete(i.id); this.toast.error('No se pudo leer la bitácora.'); }
  }
  bitacoraDe(i: Incidencia): PasoBitacora[] | 'cargando' | undefined { return i.id ? this.bitacoras.get(i.id) : undefined; }

  readonly ACCION_TXT: Record<string, string> = {
    creada: 'Capturó', calificada: 'Calificó', rechazada: 'Rechazó', anulada: 'Quitó',
    cerrada: 'Cerró la semana', reabierta: 'Reabrió la semana', auditada: 'Auditó',
  };

  /** Excel de lo que se ve, con todos los pasos: es el papel de trabajo de la auditoría. */
  exportar() {
    const filas = this.visibles.map((i) => ({
      'Código': i.empleadoCodigo, 'Persona': this.nombre(i.empleadoCodigo),
      'Tipo': this.tipoInfo(i.tipo).etiqueta, 'Desde': i.desde, 'Hasta': i.hasta,
      'Entrada de ese día': i.tipo === 'horario_distinto' ? this.hora(i.minutos) : '',
      'Su horario': i.tipo === 'horario_distinto' ? this.hora(i.horarioBaseMin) : '',
      'Corrimiento': this.corrimiento(i),
      'Minutos (horas extra)': i.tipo === 'horas_extra' ? i.minutos ?? '' : '',
      'Nota': i.nota || '', 'Autorizó': i.autorizo || '',
      'Estado': ETIQUETA_ESTADO_INC[i.estado || 'calificada'],
      'Capturó': i.creadoPor || '', 'Capturada el': i.creadoEn ? new Date(i.creadoEn).toLocaleString('es-MX') : '',
      'Calificó': i.calificadoPor || '', 'Motivo de rechazo': i.motivoRechazo || '',
      'Auditó': i.auditadoPor || '', 'Observación de auditoría': i.notaAuditoria || '',
      'Anuló': i.anuladoPor || '', 'Motivo de anulación': i.motivoAnulacion || '',
      'Banderas': (i.banderas || []).map((b) => ETIQUETA_BANDERA[b].larga).join('; '),
    }));
    if (!filas.length) { this.toast.alerta('No hay incidencias en este filtro.'); return; }
    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(filas), 'Incidencias');
    XLSX.writeFile(libro, `Incidencias_${this.sucursalId}_${this.desde}_a_${this.hasta}.xlsx`);
  }

  // ══ CIERRE DE SEMANA ══════════════════════════════════════════════

  async cargarSemanas() {
    if (!this.sucursalId) { this.semanas = []; return; }
    const actual = semanaFiscal(aFechaLocal(new Date()), this.DIA_CORTE);
    const base: SemanaCierre[] = [];
    for (let k = 1; k <= this.SEMANAS_A_LA_VISTA; k++) {
      const ini = new Date(actual.inicio + 'T12:00:00'); ini.setDate(ini.getDate() - 7 * k);
      const s = semanaFiscal(aFechaLocal(ini), this.DIA_CORTE);
      base.push({ numero: s.numero, desde: s.inicio, hasta: s.fin, cierre: null, pendientes: 0 });
    }
    try {
      const [cierres, pend] = await Promise.all([
        this.checador.getCierres(this.sucursalId),
        this.checador.getIncidencias(this.sucursalId, base[base.length - 1].desde, base[0].hasta, { estados: 'capturada' }),
      ]);
      for (const s of base) {
        s.cierre = cierres.find((c) => c.vigente && c.desde === s.desde) || null;
        s.pendientes = pend.filter((i) => i.desde <= s.hasta && i.hasta >= s.desde).length;
      }
      this.historialCierres = cierres.filter((c) => !c.vigente);
    } catch (e) {
      console.error(e);
      this.toast.error(mensajeDeError(e, 'No se pudo leer el estado de las semanas.'));
    }
    this.semanas = base;
  }

  /** Cierres que se reabrieron (con su motivo), para la auditoría. */
  historialCierres: CierreSemana[] = [];

  async cerrar(s: SemanaCierre) {
    if (s.pendientes) {
      this.toast.alerta(`La semana ${s.numero} tiene ${s.pendientes} por calificar. Califícalas o recházalas primero.`);
      return;
    }
    const ok = await this.toast.confirmar({
      titulo: `Cerrar la semana ${s.numero}`,
      mensaje: `${this.nombreSucursal()} · ${this.fechaCorta(s.desde)} → ${this.fechaCorta(s.hasta)}. ` +
        'Se guarda la foto de la asistencia tal como está ahora y la semana se bloquea: ya no se podrá capturar, calificar ni quitar nada en ella sin reabrirla.',
      textoConfirmar: 'Sí, cerrar para prenómina',
    });
    if (!ok) return;
    this.trabajando = s.desde;
    try {
      await this.checador.cerrarSemana(this.sucursalId, s.desde);
      this.toast.exito(`Semana ${s.numero} cerrada. La foto quedó guardada.`);
      await this.cargar();
    } catch (e: any) {
      // Gente que checó y no está identificada (08/10/2026): se dice quién, y
      // solo se cierra si se escribe por qué.
      const sinId: { codigo: string; nombre: string; sinNombre: boolean; sinDepartamento: boolean }[] | undefined = e?.error?.sinIdentificar;
      if (sinId?.length) {
        await this.cerrarConSinIdentificar(s, sinId);
      } else {
        console.error(e);
        this.toast.error(mensajeDeError(e, 'No se pudo cerrar la semana.'));
      }
    } finally {
      this.trabajando = '';
    }
  }

  private async cerrarConSinIdentificar(s: SemanaCierre,
      sinId: { codigo: string; nombre: string; sinNombre: boolean; sinDepartamento: boolean }[]) {
    const lista = sinId.slice(0, 8).map((p) =>
      `#${p.codigo} ${p.nombre} (${[p.sinNombre ? 'sin nombre completo' : '', p.sinDepartamento ? 'sin departamento' : ''].filter(Boolean).join(', ') || 'sin ficha'})`
    ).join(' · ') + (sinId.length > 8 ? ` · y ${sinId.length - 8} más` : '');
    const motivo = await this.toast.pedirTexto({
      titulo: `${sinId.length} sin identificar en la semana ${s.numero}`,
      mensaje: `Checaron esta semana y no se sabe bien quiénes son: ${lista}. ` +
        'Lo mejor es completarlos en Horarios → Empleados ("Por identificar") y volver a cerrar. Si de todos modos hay que cerrar ya, escribe por qué: queda guardado en el cierre.',
      textoConfirmar: 'Cerrar de todos modos',
      campo: { etiqueta: '¿Por qué se cierra así?', placeholder: 'Ej. RH confirma sus nombres el lunes', obligatorio: true },
    });
    if (!motivo) return;
    try {
      await this.checador.cerrarSemana(this.sucursalId, s.desde, { motivo });
      this.toast.exito(`Semana ${s.numero} cerrada, con ${sinId.length} sin identificar anotados en el cierre.`);
      await this.cargar();
    } catch (e) {
      console.error(e);
      this.toast.error(mensajeDeError(e, 'No se pudo cerrar la semana.'));
    }
  }

  async reabrir(s: SemanaCierre) {
    if (!s.cierre) return;
    const motivo = await this.toast.pedirTexto({
      titulo: `Reabrir la semana ${s.numero}`,
      mensaje: 'La foto del cierre se conserva. Sus incidencias vuelven a calificada y se pueden cambiar; luego hay que volver a cerrarla.',
      destructivo: true, textoConfirmar: 'Reabrir',
      campo: { etiqueta: '¿Por qué se reabre?', placeholder: 'Ej. faltó capturar una incapacidad', obligatorio: true },
    });
    if (!motivo) return;
    this.trabajando = s.desde;
    try {
      await this.checador.reabrirSemana(s.cierre.id, motivo);
      this.toast.exito(`Semana ${s.numero} reabierta.`);
      await this.cargar();
    } catch (e) {
      console.error(e);
      this.toast.error(mensajeDeError(e, 'No se pudo reabrir la semana.'));
    } finally {
      this.trabajando = '';
    }
  }

  /**
   * La foto del cierre en Excel: un renglón por persona (lo que va a prenómina)
   * y otro libro por día (para auditar de dónde salió cada número).
   */
  async descargarFoto(c: CierreSemana) {
    this.trabajando = c.id;
    try {
      const full = await this.checador.getCierre(c.id);
      const personas = full.foto?.personas || [];
      const resumen = personas.map((p) => ({
        'Código': p.codigo, 'Persona': p.nombreCompleto || p.nombre, 'Departamento': p.departamento || '',
        'Su horario': p.horario || '', 'Días evaluados': p.diasEvaluados,
        'Faltas': p.faltas, 'Faltas justificadas': p.faltasJustificadas,
        'Días con retardo': p.diasConRetardo, 'Retardo real (min)': p.retardoRealMin,
        'Horas trabajadas': p.horasTrabajadas, 'Días con incidencia': p.diasConIncidencia ?? 0,
        'Incidencias': (p.incidencias || []).map((i) => i.codigo).join(', '),
        'Número utilizable': p.usable ? 'Sí' : `No — ${(p.bloqueadoPor || []).join(', ')}`,
      }));
      const dias: any[] = [];
      for (const p of personas) for (const s of p.semanas || []) for (const d of s.dias || []) {
        dias.push({
          'Código': p.codigo, 'Persona': p.nombreCompleto || p.nombre, 'Fecha': d.fecha, 'Estado': d.estado,
          'Entrada': d.entrada || '', 'Salida': d.salida || '', 'Medido contra': d.referencia || '',
          'Retardo real (min)': d.retardoRealMin ?? 0,
          'Incidencias': (d.incidencias || []).map((i) => i.codigo).join(', '),
        });
      }
      const libro = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(resumen.length ? resumen : [{ 'Sin personas': '' }]), 'Por persona');
      XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(dias.length ? dias : [{ 'Sin días': '' }]), 'Por día');
      XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet([{
        'Plaza': this.nombreSucursal(), 'Desde': c.desde, 'Hasta': c.hasta,
        'Cerró': c.cerradoPor, 'Cerrada el': new Date(c.cerradoEn).toLocaleString('es-MX'),
        'Reabierta por': c.reabiertoPor || '', 'Motivo de reapertura': c.motivoReapertura || '',
      }]), 'Cierre');
      XLSX.writeFile(libro, `Cierre_${this.sucursalId}_${c.desde}_a_${c.hasta}.xlsx`);
    } catch (e) {
      console.error(e);
      this.toast.error(mensajeDeError(e, 'No se pudo descargar la foto del cierre.'));
    } finally {
      this.trabajando = '';
    }
  }

  nombreSucursal(): string {
    const s = centroChecadorPorId(this.sucursalId);
    return s ? s.ciudad + (s.direccion ? ' · ' + s.direccion.split(',')[0] : '') : this.sucursalId;
  }

  estadoDe(i: Incidencia): EstadoIncidencia { return i.estado || 'calificada'; }
}
