import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { CvArmadosService, CvArmado } from '../../core/services/cv-armados.service';

/**
 * CURRÍCULUMS QUE ARMÓ EL BOT.
 *
 * Hay gente que quiere trabajar y no tiene CV. No es que no lo quiera mandar: no
 * lo tiene. Antes esa persona se quedaba fuera del proceso por un archivo. Ahora
 * el bot le hace las preguntas por WhatsApp, dibuja la hoja y se la manda; si el
 * candidato la aprueba, esa hoja se vuelve su CV.
 *
 * Esta pantalla los junta aparte a propósito: los escribió el bot con lo que
 * dictó una persona, y RH debe revisarlos sabiéndolo, no mezclados con los que
 * alguien redactó y subió.
 *
 * Lo que de verdad hay que atender aquí son los BORRADORES: el bot ya se los
 * mandó y esperan un "sí" que quizá nunca llegue. Mientras estén así, esa
 * postulación sigue incompleta aunque la persona ya haya contestado todo.
 */
@Component({
  selector: 'app-cv-armados',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './cv-armados.html',
  styleUrl: './cv-armados.css'
})
export class CvArmadosComponent implements OnInit {
  private servicio = inject(CvArmadosService);

  cargando = true;
  error = '';
  todos: CvArmado[] = [];
  total = 0;
  aprobados = 0;
  borradores = 0;

  /** 'todos' | 'borrador' | 'aprobado' — arranca en lo que hay que atender. */
  filtro: 'todos' | 'borrador' | 'aprobado' = 'todos';
  busqueda = '';

  /** Abierto: se muestran los datos que dictó, sin abrir el PDF. */
  abiertos = new Set<string>();

  async ngOnInit() { await this.cargar(); }

  async cargar() {
    this.cargando = true;
    this.error = '';
    try {
      const r = await this.servicio.listar();
      this.todos = r.candidatos;
      this.total = r.total;
      this.aprobados = r.aprobados;
      this.borradores = r.borradores;
    } catch (e: any) {
      this.error = e?.message || 'No se pudieron cargar los currículums.';
      this.todos = [];
    } finally {
      this.cargando = false;
    }
  }

  get lista(): CvArmado[] {
    const t = this.busqueda.trim().toLowerCase();
    return this.todos
      .filter(c => this.filtro === 'todos' || c.estado === this.filtro)
      .filter(c => !t || `${c.nombre} ${c.telefono} ${c.ciudad}`.toLowerCase().includes(t));
  }

  toggle(c: CvArmado) {
    if (this.abiertos.has(c.id)) this.abiertos.delete(c.id);
    else this.abiertos.add(c.id);
  }
  abierto(c: CvArmado): boolean { return this.abiertos.has(c.id); }

  /**
   * Un resumen legible de las ~130 respuestas. Mostrarlas todas sería ruido:
   * esto es lo que se mira para decidir si vale la pena abrir el PDF.
   */
  resumen(c: CvArmado): { etiqueta: string; valor: string }[] {
    const r = c.respuestas || {};
    const v = (...llaves: string[]) => {
      for (const k of llaves) {
        const x = r[k];
        if (x !== undefined && x !== null && String(x).trim() !== '') return String(x).trim();
      }
      return '';
    };
    const filas = [
      ['Puesto que pide', v('puesto_solicitado', 'puesto')],
      ['Edad', v('edad')],
      ['Escolaridad', this.escolaridad(r)],
      ['Último empleo', [v('emp1_compania'), v('emp1_puesto')].filter(Boolean).join(' · ')],
      ['Sueldo deseado', v('sueldo_deseado')],
      ['Correo', v('email')],
      ['Domicilio', [v('colonia'), v('codigo_postal')].filter(Boolean).join(' · ')],
      ['Cómo supo de la vacante', v('como_supo')],
    ];
    return filas.filter(([, valor]) => valor).map(([etiqueta, valor]) => ({ etiqueta, valor }));
  }

  /** El grado más alto que declaró: se lee mejor que cinco campos sueltos. */
  private escolaridad(r: Record<string, any>): string {
    const si = (x: any) => /^(s[ií]|true|1)$/i.test(String(x || ''));
    if (si(r['esc_profesional_hubo'])) return `Profesional · ${r['esc_profesional_escuela'] || ''}`.trim();
    if (si(r['esc_comercial_hubo'])) return 'Comercial / técnica';
    if (si(r['esc_prepa_hubo'])) return `Preparatoria · ${r['esc_prepa_escuela'] || ''}`.trim();
    if (si(r['esc_secundaria_hubo'])) return 'Secundaria';
    if (si(r['esc_primaria_hubo'])) return 'Primaria';
    return '';
  }

  /** Cuántos datos alcanzó a contestar: dice qué tan completa está la hoja. */
  camposContestados(c: CvArmado): number {
    return Object.values(c.respuestas || {}).filter(v => v !== null && v !== undefined && String(v).trim() !== '').length;
  }

  fecha(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: '2-digit' })
      + ' · ' + d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  }

  /** Días que lleva el borrador esperando el "sí" del candidato. */
  diasEsperando(c: CvArmado): number | null {
    if (c.estado !== 'borrador' || !c.armadoEn) return null;
    const d = new Date(c.armadoEn);
    if (isNaN(d.getTime())) return null;
    return Math.floor((Date.now() - d.getTime()) / 86400000);
  }

  iniciales(nombre: string): string {
    if (!nombre) return '?';
    return nombre.trim().split(/\s+/).slice(0, 2).map(p => p.charAt(0).toUpperCase()).join('');
  }
}
