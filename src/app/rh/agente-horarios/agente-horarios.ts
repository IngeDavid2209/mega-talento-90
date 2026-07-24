import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChecadorService, AlertaAgente, ResumenAgente } from '../../core/services/checador.service';
import { CENTROS_CHECADOR } from '../../core/models/sucursales.model';

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

  constructor() {
    // Rango por defecto: los 7 días previos a hoy (ya cerrados).
    const hoy = new Date();
    const fin = new Date(hoy.getTime() - 24 * 3600 * 1000);
    const ini = new Date(fin.getTime() - 6 * 24 * 3600 * 1000);
    this.hasta = fin.toISOString().slice(0, 10);
    this.desde = ini.toISOString().slice(0, 10);
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

  etiquetaRegla(r: string): string { return this.ETIQUETAS[r] || r; }
  colorSeveridad(s: string): string {
    return s === 'alta' ? '#dc2626' : s === 'media' ? '#d97706' : '#6b7280';
  }
  get reglasResumen(): Array<[string, number]> {
    return this.resumen ? Object.entries(this.resumen.porRegla) : [];
  }
}
