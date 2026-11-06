import { Component, Input, OnChanges, SimpleChanges, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChecadorService, BancoHorasExtra, PersonaExtra, AjusteExtra } from '../../core/services/checador.service';
import { aFechaLocal } from '../../core/models/checador.model';
import { ToastService } from '../../core/services/toast.service';
import { AuthSession } from '../../core/services/auth-session';
import { mensajeDeError } from '../incidencias-bandeja/incidencias-flujo';

/**
 * PESTAÑA "HORAS EXTRA" (08/10/2026).
 *
 * El banco de cada persona: lo que gana quedándose después de su hora de salida
 * (bloques de 30 min) menos lo que usa cuando RH captura "Uso de horas extra".
 * El cálculo vive en la API (api/src/agente-horarios/horas-extra.ts); aquí solo
 * se enseña, con el detalle de qué días lo ganó y en qué lo usó.
 */
type Filtro = 'saldo' | 'todos' | 'negativo';

@Component({
  selector: 'app-horas-extra',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './horas-extra.html',
  styleUrl: './horas-extra.css',
})
export class HorasExtraComponent implements OnChanges {
  private checador = inject(ChecadorService);
  private toast = inject(ToastService);
  private auth = inject(AuthSession);

  /** Solo servicios al personal ajusta saldos (la API lo exige igual). */
  get puedeAjustar(): boolean { return this.auth.esAdmin(); }

  @Input() sucursalId = '';

  hasta = aFechaLocal(new Date());
  datos: BancoHorasExtra | null = null;
  cargando = false;
  error = '';
  busqueda = '';
  filtro: Filtro = 'saldo';
  abiertos = new Set<string>();

  ngOnChanges(c: SimpleChanges) {
    if (c['sucursalId']) this.cargar();
  }

  async cargar() {
    if (!this.sucursalId || !this.hasta) return;
    this.cargando = true;
    this.error = '';
    try {
      this.datos = await this.checador.getHorasExtra(this.sucursalId, this.hasta);
    } catch (e) {
      console.error(e);
      this.error = 'No se pudieron calcular las horas extra.';
    } finally {
      this.cargando = false;
    }
  }

  get visibles(): PersonaExtra[] {
    const q = this.sinAcentos(this.busqueda.trim());
    return (this.datos?.personas || []).filter((p) => {
      if (this.filtro === 'saldo' && !p.saldoMin && !p.ganadasMin && !p.usadasMin && !p.pagadasMin) return false;
      if (this.filtro === 'negativo' && p.saldoMin >= 0) return false;
      if (!q) return true;
      const t = this.sinAcentos(`${p.codigo} ${p.nombreCompleto} ${p.departamento || ''}`);
      return q.split(/\s+/).every((w) => t.includes(w));
    });
  }

  cuantos(f: Filtro): number {
    const l = this.datos?.personas || [];
    if (f === 'todos') return l.length;
    if (f === 'negativo') return l.filter((p) => p.saldoMin < 0).length;
    return l.filter((p) => p.saldoMin || p.ganadasMin || p.usadasMin || p.pagadasMin).length;
  }

  get totales(): { ganadas: number; usadas: number; pagadas: number; saldo: number } {
    const l = this.visibles;
    return {
      ganadas: l.reduce((t, p) => t + p.ganadasMin, 0),
      usadas: l.reduce((t, p) => t + p.usadasMin, 0),
      pagadas: l.reduce((t, p) => t + p.pagadasMin, 0),
      saldo: l.reduce((t, p) => t + p.saldoMin, 0),
    };
  }

  alternar(p: PersonaExtra) {
    if (this.abiertos.has(p.codigo)) this.abiertos.delete(p.codigo);
    else this.abiertos.add(p.codigo);
  }

  // ══ SALDO INICIAL Y CORRECCIONES ══
  // Quien ya traía horas extra de antes del banco (o un error que corregir):
  // RH suma o resta horas con su motivo. No se borra: se anula.
  ajuste: { codigo: string; signo: 1 | -1; horas: number | null; mins: number | null; motivo: string } | null = null;
  guardando = false;

  abrirAjuste(p: PersonaExtra) {
    this.ajuste = { codigo: p.codigo, signo: 1, horas: null, mins: null, motivo: p.ajustes.length ? '' : 'Saldo que traía antes del banco' };
  }

  get minutosAjuste(): number {
    const a = this.ajuste;
    return a ? a.signo * Math.round((Number(a.horas) || 0) * 60 + (Number(a.mins) || 0)) : 0;
  }

  async guardarAjuste(p: PersonaExtra) {
    const a = this.ajuste, min = this.minutosAjuste;
    if (!a || this.guardando) return;
    if (!min) { this.toast.alerta('Escribe cuántas horas suma o resta.'); return; }
    if (a.motivo.trim().length < 5) { this.toast.alerta('Escribe el motivo del ajuste.'); return; }
    const ok = await this.toast.confirmar({
      titulo: min > 0 ? 'Sumar horas extra' : 'Restar horas extra',
      mensaje: `¿Seguro? A ${p.nombreCompleto} se le ${min > 0 ? 'suman' : 'restan'} ${this.horas(Math.abs(min))} a su saldo ` +
        `de horas extra (quedaría en ${this.horas(p.saldoMin + min)}). Motivo: ${a.motivo.trim()}.`,
      textoConfirmar: min > 0 ? 'Sí, sumar' : 'Sí, restar',
    });
    if (!ok) return;
    this.guardando = true;
    try {
      await this.checador.crearAjusteHorasExtra({ sucursalId: this.sucursalId, codigo: p.codigo, minutos: min, motivo: a.motivo.trim() });
      this.ajuste = null;
      this.toast.exito(`${p.nombreCompleto}: ${min > 0 ? '+' : '−'}${this.horas(Math.abs(min))} a su saldo.`);
      await this.cargar();
    } catch (e) {
      console.error(e);
      this.toast.error(mensajeDeError(e, 'No se pudo guardar el ajuste.'));
    } finally {
      this.guardando = false;
    }
  }

  async quitarAjuste(p: PersonaExtra, j: AjusteExtra) {
    const motivo = await this.toast.pedirTexto({
      titulo: 'Quitar ajuste',
      mensaje: `¿Quitar el ajuste de ${this.horas(j.minutos)} a ${p.nombreCompleto}? Su saldo quedaría en ${this.horas(p.saldoMin - j.minutos)}. ` +
        'No se borra: queda anulado en el registro.',
      destructivo: true, textoConfirmar: 'Quitar',
      campo: { etiqueta: '¿Por qué se quita?', placeholder: 'Ej. se capturó a la persona equivocada', obligatorio: true },
    });
    if (!motivo) return;
    try {
      await this.checador.anularAjusteHorasExtra(j.id, motivo);
      await this.cargar();
    } catch (e) {
      console.error(e);
      this.toast.error(mensajeDeError(e, 'No se pudo quitar el ajuste.'));
    }
  }

  /** 90 → "1 h 30 min"; −90 → "−1 h 30 min". */
  horas(m: number): string {
    if (!m) return '0';
    const s = m < 0 ? '−' : '';
    const a = Math.abs(m), h = Math.floor(a / 60), r = a % 60;
    return s + (h ? `${h} h${r ? ' ' + r + ' min' : ''}` : `${r} min`);
  }

  /** "jue 25 sep". */
  fecha(iso: string): string {
    const d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' }).replace(/\./g, '');
  }

  periodoUso(u: { desde: string; hasta: string; dias: number }): string {
    return u.desde === u.hasta ? this.fecha(u.desde) : `${this.fecha(u.desde)} → ${this.fecha(u.hasta)} (${u.dias} días)`;
  }

  private sinAcentos(s: string): string {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }
}
