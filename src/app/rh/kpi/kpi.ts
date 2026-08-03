import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { KpiService, Concentrado, DiaKpi, TipoEvento, CanalEvento, FueraDeLugar } from '../../core/services/kpi.service';
import { ETAPAS, ETAPA_CONTRATADO } from '../../core/models/proceso.model';

/**
 * =====================================================================
 * KPI · CONCENTRADO DE CANDIDATOS — el tablero operativo de RH
 * =====================================================================
 *
 * Responde, con datos y no con impresiones:
 *   · ¿A cuánta gente se contactó cada día? ¿Cuántos respondieron?
 *   · ¿Cuántas entrevistas se hicieron?
 *   · ¿En cuántos días se cubre una vacante? ¿Cuántas en 7 y cuántas en 15?
 *   · ¿Quién lleva demasiados días atorado y hay que mover HOY?
 *
 * Es distinto del "Concentrado" que ya existía: ese es un RANKING de los mejores
 * candidatos (evaluación + trayectoria). Este mide el TRABAJO y los TIEMPOS.
 *
 * Regla de la pantalla: los `avisos` del API se pintan arriba. Cuando un número
 * está en cero porque nadie ha registrado el dato, hay que decirlo con palabras —
 * un cero sin explicación se lee como "no se trabajó".
 */
@Component({
  selector: 'app-kpi',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './kpi.html',
  styleUrl: './kpi.css'
})
export class KpiComponent implements OnInit {
  private kpiService = inject(KpiService);
  private router = inject(Router);

  cargando = true;
  error = '';
  datos: Concentrado | null = null;

  /** Rango del tablero. 7 y 15 son las metas que pidió RH. */
  rangos = [
    { dias: 7,  label: '7 días' },
    { dias: 15, label: '15 días' },
    { dias: 30, label: '30 días' },
    { dias: 90, label: '90 días' }
  ];
  dias = 7;

  /** Quién está en una fase adelantada sin cumplir los mínimos. */
  fuera: FueraDeLugar | null = null;

  ngOnInit() { this.cargar(); }

  async cargar(dias = this.dias) {
    this.dias = dias;
    this.cargando = true;
    this.error = '';
    try {
      this.datos = await this.kpiService.concentrado(dias);
    } catch (e: any) {
      this.error = e?.status === 401
        ? 'Tu sesión expiró. Vuelve a entrar para ver el tablero.'
        : 'No se pudo cargar el tablero. Reintenta en un momento.';
    } finally {
      this.cargando = false;
    }
    // La revisión de fases va aparte: si falla, el tablero igual sirve.
    this.kpiService.fueraDeLugar()
      .then(f => { this.fuera = f; })
      .catch(() => { this.fuera = null; });
  }

  // ── Gráfica de barras (sin librerías: alto en % del máximo del rango) ──

  /** El día con más actividad, para escalar las barras. Mínimo 1 (evita /0). */
  get maxDia(): number {
    const d = this.datos?.porDia || [];
    return Math.max(1, ...d.map(x => Math.max(x.contactados, x.postulaciones)));
  }

  alto(valor: number): string {
    return `${Math.round((valor / this.maxDia) * 100)}%`;
  }

  /** Días dibujados en la gráfica. */
  private get nDias(): number { return this.datos?.porDia.length || 0; }

  /**
   * Rango largo = columnas delgadas y SIN la cifra encima de cada barra.
   * Con 90 días esas cifras se encimaban unas con otras y dejaban de leerse;
   * el dato exacto de cada día sigue en la tabla de abajo y en el tooltip.
   */
  get densa(): boolean { return this.nDias > 15; }

  /**
   * ¿Esta columna lleva etiqueta en el eje? Noventa etiquetas no caben, así que
   * se rotula una de cada N. Se cuenta DESDE EL FINAL para que el último día
   * —hoy, la referencia de quien mira— siempre quede rotulado.
   */
  mostrarEtiqueta(i: number): boolean {
    const cada = Math.max(1, Math.ceil(this.nDias / 12));
    return (this.nDias - 1 - i) % cada === 0;
  }

  /** Tooltip de la columna: sustituye a las cifras que se ocultan en rango largo. */
  tituloDia(d: DiaKpi): string {
    return `${this.etiquetaDia(d.dia)} · ${d.contactados} contactado(s) · ${d.postulaciones} postulación(es)`;
  }

  /**
   * "mié 29" — etiqueta corta para el eje.
   * El API manda el día como texto 'YYYY-MM-DD' (ver kpi.ts del backend). Se le
   * pega la hora del mediodía para construir la fecha en horario LOCAL: sin eso,
   * 'YYYY-MM-DD' se interpreta como UTC y en México la etiqueta se recorre un día.
   */
  etiquetaDia(dia: string): string {
    const f = new Date(String(dia).slice(0, 10) + 'T12:00:00');
    if (isNaN(f.getTime())) return String(dia).slice(0, 10);
    return f.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric' });
  }

  /** Hoy según el reloj de quien mira la pantalla, no según UTC. */
  esHoy(dia: string): boolean {
    const local = new Date();
    const hoy = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
    return String(dia).slice(0, 10) === hoy;
  }

  // ── Embudo y etapas ──

  nombreEtapa(id: string): string {
    if (id === ETAPA_CONTRATADO.id) return ETAPA_CONTRATADO.title;
    if (id === 'rechazado') return 'Rechazados';
    return ETAPAS.find(e => e.id === id)?.title || id;
  }

  colorEtapa(id: string): string {
    if (id === ETAPA_CONTRATADO.id) return ETAPA_CONTRATADO.color;
    if (id === 'rechazado') return '#94a3b8';
    return ETAPAS.find(e => e.id === id)?.color || '#64748b';
  }

  /** El SLA en horas que la empresa se fijó para la etapa (ya estaba definido). */
  slaEtapa(id: string): number | null {
    return ETAPAS.find(e => e.id === id)?.slaHoras ?? null;
  }

  /** ¿La etapa se está tardando más de su propio SLA? */
  fueraDeSla(etapa: string, promHoras: number): boolean {
    const sla = this.slaEtapa(etapa);
    return sla != null && promHoras > sla;
  }

  horasBonitas(h: number): string {
    if (h == null) return '—';
    if (h < 24) return `${Math.round(h)} h`;
    return `${Math.round((h / 24) * 10) / 10} días`;
  }

  // ── Semáforo de días en proceso (la meta es 7, el límite 15) ──

  nivelDias(dias: number): 'bien' | 'atencion' | 'tarde' {
    if (dias <= 7) return 'bien';
    if (dias <= 15) return 'atencion';
    return 'tarde';
  }

  /** % del total en proceso que está fuera de la meta de 15 días. */
  get pctFueraDeMeta(): number {
    const p = this.datos?.enProceso;
    if (!p || !p.total) return 0;
    return Math.round((p.masDe15 / p.total) * 100);
  }

  /** Ancho de cada tramo de la barra de cumplimiento. */
  anchoProceso(n: number): string {
    const total = this.datos?.enProceso?.total || 1;
    return `${(n / total) * 100}%`;
  }

  diasDesde(iso: string | null): string {
    if (!iso) return 'nunca';
    const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    return d === 0 ? 'hoy' : d === 1 ? 'ayer' : `hace ${d} días`;
  }

  // ── Registrar el trabajo AQUÍ MISMO ────────────────────────────────
  //
  // Los botones viven en la lista de atorados a propósito: es la pantalla donde
  // RH ya está viendo a quién le falta atención. Obligar a entrar al expediente
  // para anotar una llamada es la forma más segura de que nadie la anote — y sin
  // eso el KPI de contactos se queda contando solo lo del bot.

  /** Ids con una petición en vuelo (para deshabilitar el botón). */
  registrando = new Set<string>();
  /** Ids recién registrados (para el ✓ de confirmación). */
  registrado = new Set<string>();
  errorRegistro = '';

  async registrar(c: { id: string; ultimoContacto: string | null }, tipo: TipoEvento, canal?: CanalEvento, ev?: Event) {
    ev?.stopPropagation(); // el clic en la fila abre el expediente; el botón no
    const clave = `${c.id}:${tipo}`;
    if (this.registrando.has(clave)) return;
    this.registrando.add(clave);
    this.errorRegistro = '';
    try {
      await this.kpiService.registrarEvento(c.id, tipo, { canal });
      // Se refleja al instante sin recargar todo el tablero: el dato que cambia
      // en esta fila es "último contacto".
      if (tipo === 'contacto') c.ultimoContacto = new Date().toISOString();
      this.registrado.add(clave);
      setTimeout(() => this.registrado.delete(clave), 2500);
      // Los totales de arriba sí necesitan recalcularse; se hace en segundo plano.
      this.kpiService.concentrado(this.dias)
        .then(d => { if (this.datos) { this.datos.totales = d.totales; this.datos.porDia = d.porDia; this.datos.conversion = d.conversion; } })
        .catch(() => { /* el tablero sigue usable con los totales anteriores */ });
    } catch {
      this.errorRegistro = 'No se pudo registrar. Revisa tu conexión e intenta de nuevo.';
    } finally {
      this.registrando.delete(clave);
    }
  }

  ocupado(id: string, tipo: TipoEvento): boolean { return this.registrando.has(`${id}:${tipo}`); }
  listo(id: string, tipo: TipoEvento): boolean { return this.registrado.has(`${id}:${tipo}`); }

  abrirExpediente(id: string) { this.router.navigate(['/app/expediente', id]); }

  /** Suma de una columna de la serie (para los pies de tabla). */
  suma(campo: keyof DiaKpi): number {
    return (this.datos?.porDia || []).reduce((a, d) => a + (Number(d[campo]) || 0), 0);
  }
}
