import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  ChecadorService, AlertaAgente, ResumenAgente, JefeSucursal,
  EstadoAgente, CorridaSucursal, GrupoAlertas, AlertasAgrupadas,
} from '../../core/services/checador.service';
import { CENTROS_CON_RELOJ } from '../../core/models/sucursales.model';

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

/** Tarjeta de la tira de indicadores. */
interface Kpi { n: string; u: string; l: string; pie: string; tono?: 'alerta' }

type Tab = 'causas' | 'pendientes' | 'resueltas' | 'todas';

/** Una linea de la cola agrupada, con lo que la vista necesita encima. */
interface FilaGrupo extends GrupoAlertas {
  trabajando: boolean;
  justificacion: string;
  hecho: number;        // cuantas se decidieron (para el mensaje efimero)
  error: string;
}

/**
 * Vista RH del AGENTE DE HORARIOS. Muestra lo que el agente ya revisó por su
 * cuenta y lista los borradores de inconsistencia para que RH los apruebe o
 * rechace. El agente solo deja 'sugerida_ia'; aquí es donde decide el HUMANO.
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

  sucursales = CENTROS_CON_RELOJ;
  sucursalId = '';
  desde = '';
  hasta = '';

  tab: Tab = 'causas';
  cargando = false;
  cargandoAlertas = false;
  error = '';
  mensaje = '';
  resumen: ResumenAgente | null = null;
  alertas: AlertaAgente[] = [];
  /** Alertas con el panel de justificación abierto. */
  abiertas = new Set<string>();

  /** Bitácora del corredor automático (Fase 3). */
  estadoAgente: EstadoAgente | null = null;

  // ── La cola agrupada POR CAUSA ──
  // 2,510 borradores esperando y cero decididos: la lista de uno en uno no se
  // trabaja nunca. Agrupada por regla + persona son decenas de lineas.
  grupos: FilaGrupo[] = [];
  agrupadas: AlertasAgrupadas | null = null;
  cargandoGrupos = false;
  /**
   * A qué nivel se agrupa, y cambia de QUÉ es la decisión:
   *   'sucursal' (default) — 2,510 alertas caben en 16 líneas. Es el nivel
   *      correcto para `checada_duplicada`: si el lector de una plaza lee doble,
   *      no son 47 decisiones, es una.
   *   'persona' — 339 líneas. Es el nivel correcto para `entrada_sin_salida`,
   *      que es la rutina de alguien en concreto.
   */
  nivelGrupos: 'persona' | 'sucursal' = 'sucursal';

  private readonly ETIQUETAS: Record<string, string> = {
    retardo: 'Retardo', falta: 'Falta', checada_duplicada: 'Checada duplicada',
    multiples_entradas: 'Múltiples entradas', entrada_sin_salida: 'Entrada sin salida',
    salida_sin_entrada: 'Salida sin entrada', fuera_de_turno: 'Fuera de turno',
  };
  private readonly MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

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
    void this.cargarEstado();
    void this.cargarGrupos();
  }

  /** Lee la bitácora del corredor para poder mostrar resultados al entrar. */
  async cargarEstado() {
    try {
      this.estadoAgente = await this.checador.getEstadoAgente();
    } catch {
      // Si la API no expone el estado, la pantalla sigue sirviendo en modo manual.
      this.estadoAgente = null;
    }
  }

  onSucursalChange() {
    this.resumen = null;
    this.abiertas.clear();
    void this.cargarAlertas();
    void this.cargarGrupos();
  }

  async analizar() {
    if (!this.sucursalId) { this.error = 'Elige una sucursal.'; return; }
    this.error = ''; this.mensaje = ''; this.cargando = true; this.resumen = null;
    try {
      const r = await this.checador.analizarAgente(this.sucursalId, this.desde, this.hasta);
      this.resumen = r.resumen;
      this.mensaje = `Análisis listo: ${r.borradores.creadas} nuevas · ${r.borradores.actualizadas} actualizadas · ${r.borradores.eliminadas} limpiadas.`;
      await this.cargarAlertas();
      void this.cargarEstado();
    } catch (e: any) {
      this.error = e?.message || 'No se pudo correr el análisis.';
    } finally {
      this.cargando = false;
    }
  }

  async cargarAlertas() {
    if (!this.sucursalId) { this.alertas = []; return; }
    this.cargandoAlertas = true;
    try {
      // 'Resueltas' se pide sin filtro y se separa aquí: la API filtra por un
      // estado exacto y resuelta = aprobada | rechazada | descartada.
      const estado = this.tab === 'pendientes' ? 'sugerida_ia' : undefined;
      this.alertas = await this.checador.getAlertasAgente(
        this.sucursalId, this.desde, this.hasta, estado
      );
    } catch (e: any) {
      this.error = e?.message || 'No se pudieron leer las alertas.';
    } finally {
      this.cargandoAlertas = false;
    }
  }

  async cambiarTab(t: Tab) {
    if (this.tab === t) return;
    this.tab = t;
    this.abiertas.clear();
    if (t === 'causas') await this.cargarGrupos();
    else await this.cargarAlertas();
  }

  // ══════════════════════════════════════════════════════════════════
  // LA COLA AGRUPADA POR CAUSA
  //
  // Las dos reglas que quedan activas no describen 2,510 problemas distintos:
  //   · `checada_duplicada` = el lector leyo el dedo dos veces. Es del APARATO;
  //     la decision es por sucursal, no por dia.
  //   · `entrada_sin_salida` = alguien no marca al salir. Es de la rutina de una
  //     PERSONA, y esta concentrado en pocas.
  // ══════════════════════════════════════════════════════════════════

  /** Trae la cola agrupada (de la sucursal elegida, o de todas si no hay). */
  async cargarGrupos() {
    this.cargandoGrupos = true;
    try {
      const r = await this.checador.getAlertasAgrupadas(
        this.sucursalId || undefined, undefined, undefined, undefined, this.nivelGrupos);
      this.agrupadas = r;
      this.grupos = r.grupos.map((g) => ({
        ...g, trabajando: false, justificacion: '', hecho: 0, error: '',
      }));
    } catch (e: any) {
      this.error = e?.message || 'No se pudo agrupar la cola.';
      this.grupos = [];
      this.agrupadas = null;
    } finally {
      this.cargandoGrupos = false;
    }
  }

  /**
   * Decide un grupo completo. Solo rechazar o descartar: aprobar manda un
   * WhatsApp por alerta al jefe, asi que eso sigue siendo de una en una (y por
   * eso el boton de aprobar no existe aqui, sino en la lista).
   */
  async decidirGrupoFila(f: FilaGrupo, estado: 'rechazada' | 'descartada') {
    f.error = '';
    f.trabajando = true;
    try {
      const r = await this.checador.decidirGrupo({
        regla: f.regla, sucursalId: f.sucursalId, empleadoCodigo: f.empleadoCodigo,
        estado, justificacion: f.justificacion || undefined,
      });
      f.hecho = r.afectadas;
      // Se quita de la lista: ya no espera decision.
      this.grupos = this.grupos.filter((x) => x !== f);
      if (this.agrupadas) {
        this.agrupadas.total -= r.afectadas;
        this.agrupadas.porRegla[f.regla] = (this.agrupadas.porRegla[f.regla] || 0) - r.afectadas;
      }
      this.mensaje = `${r.afectadas} alerta(s) de ${this.etiquetaRegla(f.regla)} marcadas como ${estado}.`;
      void this.cargarEstado();
    } catch (e: any) {
      f.error = e?.message || 'No se pudo decidir el grupo.';
    } finally {
      f.trabajando = false;
    }
  }

  /** Cambia el nivel de agrupado y recarga. */
  async cambiarNivel(n: 'persona' | 'sucursal') {
    if (this.nivelGrupos === n) return;
    this.nivelGrupos = n;
    await this.cargarGrupos();
  }

  /** Qué significa cada regla en una frase, y qué conviene hacer con ella. */
  causaDe(regla: string): string {
    switch (regla) {
      case 'checada_duplicada':
        return 'El lector leyó el dedo dos veces. Es del aparato, no de la persona: '
             + 'la decisión es por sucursal, y lo que corresponde es descartarlas y revisar el lector.';
      case 'entrada_sin_salida':
        return 'No marcó al salir, así que ese día no se le puede medir el retardo. '
             + 'Si es su costumbre, hay que hablar con la persona; descartar solo esconde el hueco.';
      case 'multiples_entradas':
        return 'Dos entradas separadas por horas: puede ser turno partido o dos personas usando el mismo código.';
      case 'salida_sin_entrada':
        return 'Hay salida pero no entrada: falta la primera marca del día.';
      default:
        return '';
    }
  }

  /** Total de líneas agrupadas (para el encabezado). */
  get totalGrupos(): number { return this.grupos.length; }
  /** Las reglas presentes en la cola, con su cuenta. */
  get reglasEnCola(): { regla: string; n: number }[] {
    const p = this.agrupadas?.porRegla || {};
    return Object.keys(p).filter((k) => p[k] > 0).map((k) => ({ regla: k, n: p[k] })).sort((a, b) => b.n - a.n);
  }

  /** Lo que se pinta en la tabla según la pestaña. */
  get alertasVisibles(): AlertaAgente[] {
    if (this.tab === 'resueltas') return this.alertas.filter((a) => a.estado !== 'sugerida_ia');
    return this.alertas;
  }

  async decidir(a: AlertaAgente, estado: 'aprobada' | 'rechazada' | 'descartada') {
    this.error = '';
    try {
      const upd = await this.checador.decidirAlerta(a.id, estado, a.justificacionSugerida);
      this.abiertas.delete(a.id);
      // Si estamos viendo pendientes, la sacamos de la lista; si no, la actualizamos.
      if (this.tab === 'pendientes') {
        this.alertas = this.alertas.filter((x) => x.id !== a.id);
      } else {
        Object.assign(a, upd);
      }
    } catch (e: any) {
      this.error = e?.message || 'No se pudo actualizar la alerta.';
    }
  }

  // ===================== PRESENTACIÓN =====================

  toggleAbierta(a: AlertaAgente) {
    if (this.abiertas.has(a.id)) this.abiertas.delete(a.id);
    else this.abiertas.add(a.id);
  }
  estaAbierta(a: AlertaAgente): boolean { return this.abiertas.has(a.id); }

  etiquetaRegla(r: string): string { return this.ETIQUETAS[r] || r; }

  /** Iniciales para el avatar (sin fotos: el padrón del reloj no las trae). */
  iniciales(nombre: string): string {
    const p = String(nombre || '?').trim().split(/\s+/);
    return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase() || '?';
  }

  /** 'yyyy-MM-dd' → '28 jul 2026'. */
  fechaLarga(f: string): string {
    if (!f || f.length < 10) return f || '—';
    const [a, m, d] = f.slice(0, 10).split('-');
    return `${d} ${this.MESES[Number(m) - 1] || m} ${a}`;
  }
  /** ISO → 'hoy 17:42' / '28 jul 17:42'. */
  cuando(iso?: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    const hora = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const hoy = new Date();
    const mismoDia = d.getDate() === hoy.getDate() && d.getMonth() === hoy.getMonth() && d.getFullYear() === hoy.getFullYear();
    return mismoDia ? `hoy ${hora}` : `${d.getDate()} ${this.MESES[d.getMonth()]} ${hora}`;
  }

  /** La corrida automática de la sucursal elegida. */
  get corridaActual(): CorridaSucursal | null {
    if (!this.sucursalId || !this.estadoAgente) return null;
    return this.estadoAgente.sucursales.find((s) => s.sucursalId === this.sucursalId) || null;
  }

  /**
   * Indicadores. Con un análisis manual corrido se muestran sus totales; si no,
   * los de la última corrida automática. Nunca se inventan cifras: lo que la
   * bitácora no trae sale como '—'.
   */
  get kpis(): Kpi[] {
    const r = this.resumen;
    if (r) {
      return [
        { n: String(r.totalInconsistencias), u: 'inconsistencias', l: 'Alertas detectadas', pie: this.pieReglaTop, tono: 'alerta' },
        { n: String(r.empleadosAnalizados), u: 'empleados', l: 'Empleados analizados', pie: r.empleadosSinTurno ? `Sin turno asignado: ${r.empleadosSinTurno}` : '' },
        { n: String(r.diasAnalizados), u: 'días', l: 'Días de cobertura', pie: `${this.fechaLarga(r.desde)} → ${this.fechaLarga(r.hasta)}` },
        { n: String(r.checadasLeidas), u: 'checadas', l: 'Checadas leídas', pie: this.duplicadas ? `Duplicadas: ${this.duplicadas}` : '' },
      ];
    }
    const c = this.corridaActual;
    if (c) {
      return [
        { n: String(c.pendientes), u: 'pendientes', l: 'Alertas por revisar', pie: 'Del ciclo automático', tono: 'alerta' },
        { n: c.empleados != null ? String(c.empleados) : '—', u: 'empleados', l: 'Empleados analizados', pie: c.omitidosEx ? `Ex trabajadores omitidos: ${c.omitidosEx}` : '' },
        { n: String(this.diasEntre(c.desde, c.hasta)), u: 'días', l: 'Días de cobertura', pie: `${this.fechaLarga(c.desde)} → ${this.fechaLarga(c.hasta)}` },
        { n: c.creadas != null ? String(c.creadas) : '—', u: 'nuevas', l: 'Alertas del último ciclo', pie: c.eliminadas ? `Limpiadas: ${c.eliminadas}` : '' },
      ];
    }
    return [];
  }

  private diasEntre(a: string, b: string): number {
    const d1 = new Date(a + 'T00:00:00'), d2 = new Date(b + 'T00:00:00');
    if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return 0;
    return Math.round((d2.getTime() - d1.getTime()) / 86400000) + 1;
  }

  get duplicadas(): number { return this.resumen?.porRegla?.['checada_duplicada'] || 0; }

  /** La regla más frecuente del análisis, para el pie de la primera tarjeta. */
  private get pieReglaTop(): string {
    const top = this.reglasResumen.slice().sort((x, y) => y[1] - x[1])[0];
    return top ? `${this.etiquetaRegla(top[0])}: ${top[1]}` : '';
  }

  get reglasResumen(): Array<[string, number]> {
    return this.resumen ? Object.entries(this.resumen.porRegla) : [];
  }

  /** Texto de la tira de estado: qué hizo el agente por su cuenta. */
  get lineaCiclo(): string {
    const e = this.estadoAgente;
    if (!e) return '';
    const c = this.corridaActual;
    if (c?.error) return `La última revisión de esta sucursal falló: ${c.error}`;
    if (e.corriendo) return 'Revisión en curso…';
    const cuando = c ? this.cuando(c.corridaEn) : this.cuando(e.ultimaCorrida);
    if (!e.auto) return `Revisión automática apagada. Última corrida: ${cuando}.`;
    return `Ciclo de análisis completado · última revisión ${cuando} · se repite cada ${e.cadaMin} min.`;
  }
  get cicloConFalla(): boolean { return !!this.corridaActual?.error; }

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
}
