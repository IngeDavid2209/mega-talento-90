import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChecadorService, AlertaAgente, ResumenAgente, JefeSucursal } from '../../core/services/checador.service';
import { CENTROS_CHECADOR } from '../../core/models/sucursales.model';

/** Fila editable del panel de jefes: una por centro de trabajo del checador. */
interface FilaJefe {
  sucursalId: string;
  etiqueta: string;
  nombre: string;
  telefono: string;
  activo: boolean;
  registrado: boolean;   // ya existe en la tabla jefes_sucursal
  guardando: boolean;
  guardado: boolean;     // se acaba de guardar (para el ✓ efímero)
  error: string;
}

/**
 * Vista RH del AGENTE DE HORARIOS. Corre el análisis de una sucursal/rango y
 * lista los borradores de inconsistencia para que RH los apruebe/rechace.
 * El agente solo deja 'sugerida_ia'; aquí es donde el HUMANO decide (80/20).
 */
@Component({
  selector: 'app-agente-horarios',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './agente-horarios.html',
  styleUrl: './agente-horarios.css',
})
export class AgenteHorariosComponent {
  private checador = inject(ChecadorService);

  sucursales = CENTROS_CHECADOR;
  sucursalId = '';
  desde = '';
  hasta = '';
  filtroEstado = 'sugerida_ia';

  cargando = false;
  error = '';
  mensaje = '';
  resumen: ResumenAgente | null = null;
  alertas: AlertaAgente[] = [];

  private readonly ETIQUETAS: Record<string, string> = {
    retardo: 'Retardo', falta: 'Falta', checada_duplicada: 'Checada duplicada',
    multiples_entradas: 'Múltiples entradas', entrada_sin_salida: 'Entrada sin salida',
    salida_sin_entrada: 'Salida sin entrada', fuera_de_turno: 'Fuera de turno',
  };

  // ── Jefes por sucursal (a quién avisa el agente al aprobar) ──
  panelJefes = false;
  filasJefes: FilaJefe[] = [];
  cargandoJefes = false;
  private jefes: JefeSucursal[] = [];

  constructor() {
    // Rango por defecto: los 7 días previos a hoy (ya cerrados).
    const hoy = new Date();
    const fin = new Date(hoy.getTime() - 24 * 3600 * 1000);
    const ini = new Date(fin.getTime() - 6 * 24 * 3600 * 1000);
    this.hasta = fin.toISOString().slice(0, 10);
    this.desde = ini.toISOString().slice(0, 10);
    // Se cargan de una: sirven para avisar si la sucursal elegida no tiene jefe.
    void this.cargarJefes();
  }

  async analizar() {
    if (!this.sucursalId) { this.error = 'Elige una sucursal.'; return; }
    this.error = ''; this.mensaje = ''; this.cargando = true; this.resumen = null;
    try {
      const r = await this.checador.analizarAgente(this.sucursalId, this.desde, this.hasta);
      this.resumen = r.resumen;
      this.mensaje = `Análisis listo: ${r.borradores.creadas} nuevas · ${r.borradores.actualizadas} actualizadas · ${r.borradores.eliminadas} limpiadas.`;
      await this.cargarAlertas();
    } catch (e: any) {
      this.error = e?.message || 'No se pudo correr el análisis.';
    } finally {
      this.cargando = false;
    }
  }

  async cargarAlertas() {
    if (!this.sucursalId) { this.alertas = []; return; }
    try {
      this.alertas = await this.checador.getAlertasAgente(
        this.sucursalId, this.desde, this.hasta, this.filtroEstado || undefined
      );
    } catch (e: any) {
      this.error = e?.message || 'No se pudieron leer las alertas.';
    }
  }

  async decidir(a: AlertaAgente, estado: 'aprobada' | 'rechazada' | 'descartada') {
    this.error = '';
    try {
      const upd = await this.checador.decidirAlerta(a.id, estado, a.justificacionSugerida);
      // Si estamos viendo pendientes, la sacamos de la lista; si no, la actualizamos.
      if (this.filtroEstado === 'sugerida_ia') {
        this.alertas = this.alertas.filter((x) => x.id !== a.id);
      } else {
        Object.assign(a, upd);
      }
    } catch (e: any) {
      this.error = e?.message || 'No se pudo actualizar la alerta.';
    }
  }

  // ===================== JEFES POR SUCURSAL =====================
  /**
   * Trae los jefes registrados y arma una fila por CADA centro del checador
   * (las sucursales sin jefe salen vacías, listas para capturar).
   */
  async cargarJefes() {
    this.cargandoJefes = true;
    try {
      this.jefes = await this.checador.getJefes();
      this.filasJefes = this.sucursales.map((s) => {
        const j = this.jefes.find((x) => x.sucursalId === s.id);
        return {
          sucursalId: s.id,
          etiqueta: `${s.ciudad} · ${s.id}`,
          nombre: j?.nombre || '',
          telefono: j?.telefono || '',
          activo: j ? j.activo : true,
          registrado: !!j,
          guardando: false, guardado: false, error: '',
        };
      });
    } catch (e: any) {
      this.error = e?.message || 'No se pudieron leer los jefes.';
    } finally {
      this.cargandoJefes = false;
    }
  }

  togglePanelJefes() {
    this.panelJefes = !this.panelJefes;
    if (this.panelJefes && !this.filasJefes.length) void this.cargarJefes();
  }

  /**
   * Normaliza a formato internacional MX: 10 dígitos → 52XXXXXXXXXX. Acepta ya
   * normalizados (52 + 10) y el formato que entrega WhatsApp (521 + 10). Devuelve
   * '' si no cuadra (el jefe se puede guardar sin teléfono, pero no se le avisa).
   */
  private normalizarTelefono(tel: string): string {
    const d = String(tel || '').replace(/\D/g, '');
    if (/^\d{10}$/.test(d)) return '52' + d;
    if (/^52\d{10}$/.test(d)) return d;
    if (/^521\d{10}$/.test(d)) return '52' + d.slice(3);
    return '';
  }

  async guardarJefe(f: FilaJefe) {
    f.error = ''; f.guardado = false;
    const nombre = f.nombre.trim();
    if (!nombre) { f.error = 'Escribe el nombre del jefe.'; return; }
    const telefono = this.normalizarTelefono(f.telefono);
    if (f.telefono.trim() && !telefono) {
      f.error = 'Teléfono inválido. Usa 10 dígitos (ej. 3511234567).';
      return;
    }
    f.guardando = true;
    try {
      const saved = await this.checador.guardarJefe({
        sucursalId: f.sucursalId, nombre, telefono, activo: f.activo,
      });
      f.nombre = saved.nombre; f.telefono = saved.telefono; f.activo = saved.activo;
      f.registrado = true; f.guardado = true;
      // Refresca la copia en memoria para el aviso de "sin jefe".
      const i = this.jefes.findIndex((x) => x.sucursalId === saved.sucursalId);
      if (i >= 0) this.jefes[i] = saved; else this.jefes.push(saved);
    } catch (e: any) {
      f.error = e?.message || 'No se pudo guardar el jefe.';
    } finally {
      f.guardando = false;
    }
  }

  /** true si la sucursal elegida NO tiene a quién avisar (jefe activo con teléfono). */
  get sucursalSinJefe(): boolean {
    if (!this.sucursalId || this.cargandoJefes) return false;
    const j = this.jefes.find((x) => x.sucursalId === this.sucursalId);
    return !j || !j.activo || !j.telefono;
  }

  /** Pasa la justificación que mandó el jefe al campo que RH va a guardar. */
  usarJustificacionJefe(a: AlertaAgente) {
    if (a.justificacionJefe) a.justificacionSugerida = a.justificacionJefe;
  }

  etiquetaRegla(r: string): string { return this.ETIQUETAS[r] || r; }
  colorSeveridad(s: string): string {
    return s === 'alta' ? '#dc2626' : s === 'media' ? '#d97706' : '#6b7280';
  }
  get reglasResumen(): Array<[string, number]> {
    return this.resumen ? Object.entries(this.resumen.porRegla) : [];
  }
}
