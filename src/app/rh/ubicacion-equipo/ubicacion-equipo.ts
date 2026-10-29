import { Component, inject, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChecadorService, EquipoAhora, EscenaEquipo, PersonaEquipo, PersonaFaltaEquipo, PersonaSalidaEquipo, TipoIncidencia } from '../../core/services/checador.service';
import { ToastService } from '../../core/services/toast.service';
import { aFechaLocal } from '../../core/models/checador.model';
import { centroChecadorPorId } from '../../core/models/sucursales.model';

/**
 * UBICACIÓN DE MI EQUIPO (29/09/2026).
 *
 * Una escena ilustrada por RELOJ (oficina, comedor, tienda, bodega) con un
 * personaje por cada persona que está ahí ahora. Reemplaza al mapa geográfico
 * de /app/mapa, que nunca se pudo pintar: ninguna plaza tenía coordenadas.
 *
 * Qué se dibuja y qué no, a propósito:
 *   · Se dibuja quien está TRABAJANDO o COMIENDO. Es la foto de ahora.
 *   · Quien ya salió va a un contador: dibujarlo haría creer que está ahí.
 *   · Quien entró y ya pasó su hora de salida sin marcarla tampoco se dibuja
 *     como presente: casi siempre se fue y el lector no leyó la salida. Va
 *     aparte, como aviso, con sus nombres.
 *
 * El cálculo vive en la API (api/src/agente-horarios/equipo.ts). Solo la ven
 * los administradores, y la API lo vuelve a validar.
 */

type TipoLista = 'dentro' | 'comida' | 'salieron' | 'sin_salida' | 'antes' | 'faltan';
interface FilaLista {
  nombre: string; departamento: string | null; lugar: string; detalle: string; color: string; aviso?: boolean;
  /** Para el botón "Justificar" (solo en faltas y salidas anticipadas sin justificar). */
  justificar?: { sucursalId: string; codigo: string; nombre: string; motivo: 'falta' | 'salida' };
  justificada?: string | null;
}

/** Un personaje ya listo para pintar. */
interface Personaje extends PersonaEquipo {
  clave: string;          // sucursal + código: el mismo código existe en plazas distintas
  iniciales: string;
  color: string;
  /** Llegó (o cambió de reloj) hace poco: entra caminando. */
  recien: boolean;
  /** Retraso de su animación de reposo, para que no se muevan todos a la vez. */
  retraso: number;
}

/** El fondo de cada tarjeta, según dónde está la plaza. */
export type Lugar = 'catedral' | 'abastos' | 'acueducto' | 'kiosco' | 'esquinas' | 'colonia' | 'corporativo' | 'cedis' | 'ciudad';

/** Un departamento dentro de una escena, con su gente. */
interface GrupoDepto { nombre: string; color: string; personas: Personaje[]; comiendo: number; }

interface Escena extends Omit<EscenaEquipo, 'personas'> {
  plaza: string;
  lugar: Lugar;
  /**
   * La gente de la escena, SUBDIVIDIDA POR DEPARTAMENTO (29/09/2026): cada
   * grupo con su color, y cada persona con su nombre completo, su hora de
   * llegada y su última checada a la vista, sin tener que pasar el mouse.
   */
  departamentos: GrupoDepto[];
  trabajando: Personaje[];
  comiendo: Personaje[];
  sinSalidaNombres: string;
}

/** Colores por departamento: distintos entre sí y legibles con texto blanco. */
const PALETA = ['#2E6BD9', '#D9642E', '#1F8F5F', '#8E4FD1', '#C23B6E', '#1C7F93', '#A87A12', '#4F5E7A', '#B5452F', '#3F7F2E'];
const SIN_DEPTO = '#8A95A8';
/** Cuántos personajes caben antes de agrupar en "+N". */
const MAX_VISIBLES = 24;

@Component({
  selector: 'app-ubicacion-equipo',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './ubicacion-equipo.html',
  styleUrl: './ubicacion-equipo.css',
})
export class UbicacionEquipoComponent implements OnInit, OnDestroy {
  private checador = inject(ChecadorService);
  private zona = inject(NgZone);
  private toast = inject(ToastService);

  datos: EquipoAhora | null = null;
  escenas: Escena[] = [];
  cargando = false;
  error = '';
  busqueda = '';
  /** Escenas con la lista completa abierta (cuando hay más de MAX_VISIBLES). */
  abiertas = new Set<string>();
  /** Personaje con la tarjeta de detalle abierta (clic / Enter). */
  detalle: string | null = null;

  readonly MAX = MAX_VISIBLES;
  private reloj: any;
  /** Dónde estaba cada quien en la lectura anterior: si cambió, entra caminando. */
  private ubicacionAnterior = new Map<string, string>();
  private colores = new Map<string, string>();

  ngOnInit() {
    this.cargar();
    // Cada minuto, igual que el resto de la sección. Fuera de la zona para no
    // disparar detección de cambios en cada tic.
    this.zona.runOutsideAngular(() => {
      this.reloj = setInterval(() => this.zona.run(() => this.cargar(true)), 60000);
    });
  }

  ngOnDestroy() { clearInterval(this.reloj); }

  async cargar(silencioso = false, fresco = false) {
    if (!silencioso) this.cargando = true;
    try {
      const d = await this.checador.getEquipo(fresco);
      this.datos = d;
      this.escenas = this.armar(d);
      this.aplicarFiltros();
      this.error = '';
    } catch (e: any) {
      if (!silencioso) {
        this.error = e?.status === 403
          ? 'Esta sección es solo para administradores.'
          : 'No se pudo leer la ubicación del equipo. Revisa la conexión e intenta de nuevo.';
      }
    } finally {
      this.cargando = false;
    }
  }

  private armar(d: EquipoAhora): Escena[] {
    const primeraVez = this.ubicacionAnterior.size === 0;
    const ahora = new Map<string, string>();
    const escenas = d.escenas.map((e) => {
      const personajes: Personaje[] = e.personas
        .filter((p) => p.estado !== 'sin_salida')
        .map((p, i) => {
          const clave = `${e.sucursalId}|${p.codigo}`;
          const donde = `${e.id}|${p.estado}`;
          ahora.set(clave, donde);
          const cambio = !primeraVez && this.ubicacionAnterior.get(clave) !== donde;
          return {
            ...p, clave,
            iniciales: this.iniciales(p.nombre),
            color: this.colorDe(p.departamento),
            // Al abrir la pantalla solo camina quien checó en los últimos 3 min;
            // después, quien cambió de lugar desde la lectura anterior.
            recien: primeraVez ? p.hace <= 3 : cambio,
            retraso: (i * 0.37) % 2.4,
          };
        });
      return {
        ...e,
        plaza: this.nombrePlaza(e.sucursalId),
        lugar: this.lugarDe(e),
        trabajando: personajes.filter((p) => p.estado === 'dentro'),
        comiendo: personajes.filter((p) => p.estado === 'comida'),
        departamentos: this.agrupar(personajes),
        sinSalidaNombres: e.personas.filter((p) => p.estado === 'sin_salida')
          .map((p) => `${p.nombre} (entró ${p.entrada})`).join('\n'),
      };
    });
    this.ubicacionAnterior = ahora;
    return escenas;
  }

  /** Por departamento: el más grande primero; SIN DEPARTAMENTO al final; dentro, por hora de llegada. */
  private agrupar(personas: Personaje[]): GrupoDepto[] {
    const m = new Map<string, GrupoDepto>();
    for (const p of personas) {
      const nombre = (p.departamento || '').trim().toUpperCase() || 'SIN DEPARTAMENTO';
      if (!m.has(nombre)) m.set(nombre, { nombre, color: p.color, personas: [], comiendo: 0 });
      const g = m.get(nombre)!;
      g.personas.push(p);
      if (p.estado === 'comida') g.comiendo++;
    }
    for (const g of m.values()) g.personas.sort((a, b) => a.entrada.localeCompare(b.entrada) || a.nombre.localeCompare(b.nombre, 'es'));
    return [...m.values()].sort((a, b) =>
      (a.nombre === 'SIN DEPARTAMENTO' ? 1 : 0) - (b.nombre === 'SIN DEPARTAMENTO' ? 1 : 0) ||
      b.personas.length - a.personas.length || a.nombre.localeCompare(b.nombre, 'es'));
  }

  /** Desde cuántas personas una tarjeta ocupa todo el ancho y pone sus departamentos en columnas. */
  readonly ANCHA = 10;

  /** Cuántos se ven por departamento antes de "ver todos". */
  readonly POR_DEPTO = 8;
  deptosAbiertos = new Set<string>();
  claveDepto(e: Escena, g: GrupoDepto) { return `${e.id}|${g.nombre}`; }
  personasDe(e: Escena, g: GrupoDepto): Personaje[] {
    return this.deptosAbiertos.has(this.claveDepto(e, g)) ? g.personas : g.personas.slice(0, this.POR_DEPTO);
  }

  // ══ FILTROS (29/09/2026) ══════════════════════════════════════════
  //
  // Buscador, lugar, departamento (uno o varios), estado y "ocultar lugares
  // sin nadie". A diferencia de la primera versión del buscador —que solo
  // atenuaba—, los filtros ESCONDEN lo que no coincide: con 150 personas en
  // pantalla, atenuar no alcanza para encontrar a nadie.
  //
  // Los números grandes de arriba no cambian: son la foto de toda la empresa.
  // Lo filtrado se dice aparte ("Mostrando 12 de 144").
  lugarSel = '';
  deptosSel = new Set<string>();
  estadoSel: 'todos' | 'dentro' | 'comida' = 'todos';
  ocultarVacios = false;
  /** Lo que se pinta, ya filtrado. Se recalcula al cambiar un filtro o al llegar datos. */
  vista: Escena[] = [];

  get hayFiltros(): boolean {
    return this.buscando || !!this.lugarSel || this.deptosSel.size > 0 || this.estadoSel !== 'todos';
  }
  private get filtraPersonas(): boolean {
    return this.buscando || this.deptosSel.size > 0 || this.estadoSel !== 'todos';
  }

  aplicarFiltros() {
    const pasa = (p: Personaje, e: Escena) =>
      (this.estadoSel === 'todos' || p.estado === this.estadoSel) && this.coincide(p, e);
    const pasaOtro = (x: { nombre: string; codigo: string; departamento: string | null }, e: Escena) => {
      const dep = (x.departamento || '').trim().toUpperCase() || 'SIN DEPARTAMENTO';
      if (this.deptosSel.size && !this.deptosSel.has(dep)) return false;
      if (this.estadoSel !== 'todos') return false;     // "trabajando / en comida" no incluye a quien no está
      const q = this.norm(this.busqueda.trim());
      if (!q) return true;
      const t = this.norm(`${x.nombre} ${x.codigo} ${x.departamento || ''} ${e.alias} ${e.plaza}`);
      return q.split(/\s+/).every((w) => t.includes(w));
    };
    this.vista = this.escenas
      .filter((e) => !this.lugarSel || e.id === this.lugarSel)
      .map((e) => ({
        ...e,
        faltan: e.faltan.filter((x) => pasaOtro(x, e)),
        salidas: e.salidas.filter((x) => pasaOtro(x, e)),
        departamentos: e.departamentos
          .filter((g) => !this.deptosSel.size || this.deptosSel.has(g.nombre))
          .map((g) => {
            const personas = g.personas.filter((p) => pasa(p, e));
            return { ...g, personas, comiendo: personas.filter((p) => p.estado === 'comida').length };
          })
          .filter((g) => g.personas.length),
      }))
      // Un lugar sin nadie que pase los filtros se esconde; sin filtros de
      // persona, solo si se pidió "ocultar lugares sin nadie".
      .filter((e) => e.departamentos.length || e.faltan.length || e.salidas.some((x) => x.antesMin != null)
        || (!this.filtraPersonas && !this.ocultarVacios));
  }

  alternarDeptoFiltro(nombre: string) {
    if (this.deptosSel.has(nombre)) this.deptosSel.delete(nombre); else this.deptosSel.add(nombre);
    this.aplicarFiltros();
  }

  limpiarFiltros() {
    this.busqueda = ''; this.lugarSel = ''; this.deptosSel.clear();
    this.estadoSel = 'todos'; this.ocultarVacios = false;
    this.aplicarFiltros();
  }

  /** Personas a la vista y en total (para "Mostrando N de M"). */
  get mostrando(): number { return this.vista.reduce((t, e) => t + e.departamentos.reduce((s, g) => s + g.personas.length, 0), 0); }
  get totalPersonas(): number { return this.escenas.reduce((t, e) => t + e.trabajando.length + e.comiendo.length, 0); }
  cuantosEn(e: Escena): number { return e.departamentos.reduce((s, g) => s + g.personas.length, 0); }

  // ══ LAS LISTAS DE LOS RECUADROS (29/09/2026) ══════════════════════
  // Cada recuadro de arriba se puede tocar y enseña a esas personas, con dónde
  // están y sus horas. Salen de TODOS los lugares (no de lo filtrado): los
  // números del recuadro son de toda la empresa, y la lista tiene que cuadrar.
  lista: { clave: TipoLista; titulo: string; filas: FilaLista[] } | null = null;

  abrirLista(clave: TipoLista) {
    const d = this.datos;
    if (!d) return;
    const filas: FilaLista[] = [];
    for (const e of this.escenas) {
      const lugar = e.alias;
      if (clave === 'dentro' || clave === 'comida') {
        for (const p of (clave === 'dentro' ? e.trabajando : e.comiendo)) {
          filas.push({ nombre: p.nombre, departamento: p.departamento, lugar,
            detalle: `Llegó ${p.entrada}${p.ultima !== p.entrada ? ' · marcó ' + p.ultima : ''}`, color: p.color });
        }
      } else if (clave === 'sin_salida') {
        for (const p of (d.escenas.find((x) => x.id === e.id)?.personas || []).filter((x) => x.estado === 'sin_salida')) {
          filas.push({ nombre: p.nombre, departamento: p.departamento, lugar,
            detalle: `Entró ${p.entrada} · no hay checada de salida`, color: this.colorDe(p.departamento), aviso: true });
        }
      } else if (clave === 'salieron' || clave === 'antes') {
        for (const x of e.salidas) {
          if (clave === 'antes' && x.antesMin == null) continue;
          const antes = x.antesMin != null;
          filas.push({ nombre: x.nombre, departamento: x.departamento, lugar,
            detalle: `Entró ${x.entrada} · salió ${x.salida}` + (antes ? ` · ${this.duracion(x.antesMin!)} antes de su jornada (${x.jornadaHabitual})` : ''),
            color: this.colorDe(x.departamento), aviso: antes && !x.justificacion,
            justificada: antes ? x.justificacion : null,
            justificar: antes && !x.justificacion ? { sucursalId: x.sucursalId, codigo: x.codigo, nombre: x.nombre, motivo: 'salida' } : undefined });
        }
      } else if (clave === 'faltan') {
        for (const x of e.faltan) {
          filas.push({ nombre: x.nombre, departamento: x.departamento, lugar,
            detalle: `Entra ${x.entraA} · lleva ${this.duracion(x.retrasoMin)} sin checar`, color: this.colorDe(x.departamento), aviso: true,
            justificar: { sucursalId: x.sucursalId, codigo: x.codigo, nombre: x.nombre, motivo: 'falta' } });
        }
      }
    }
    filas.sort((a, b) => a.lugar.localeCompare(b.lugar, 'es') || a.nombre.localeCompare(b.nombre, 'es'));
    const titulos: Record<TipoLista, string> = {
      dentro: 'Trabajando ahora', comida: 'En comida', salieron: 'Ya salieron',
      sin_salida: 'Sin salida registrada', antes: 'Salieron antes de su hora', faltan: 'No se han presentado',
    };
    this.lista = { clave, titulo: titulos[clave], filas };
  }
  cerrarLista() { this.lista = null; }

  salidasAntes(e: Escena): PersonaSalidaEquipo[] { return e.salidas.filter((x) => x.antesMin != null); }
  /** Las que siguen pendientes (sin justificar): son las que cuentan en el aviso. */
  salidasPendientes(e: Escena): number { return e.salidas.filter((x) => x.antesMin != null && !x.justificacion).length; }

  // ══ JUSTIFICAR DESDE AQUÍ (29/09/2026) ══════════════════════════════
  //
  // Quien no se presentó o salió antes puede tener una razón: un permiso, una
  // cita, una comisión. Se registra como INCIDENCIA del día (la misma de la
  // pestaña Checadas), así que cuenta igual en todos lados: la falta deja de
  // contar en el reporte y la salida anticipada deja de ser aviso.
  tiposIncidencia: TipoIncidencia[] = [];
  justificando: {
    sucursalId: string; codigo: string; nombre: string;
    motivo: 'falta' | 'salida'; detalle: string;
    tipo: string; nota: string; guardando: boolean;
    /** "Uso de horas extra": cuántas usó. */
    horas?: number | null; mins?: number | null;
  } | null = null;
  get esHorasExtra(): boolean { return this.justificando?.tipo === 'horas_extra'; }
  private get minutosJust(): number {
    const j = this.justificando;
    return j ? Math.round((Number(j.horas) || 0) * 60 + (Number(j.mins) || 0)) : 0;
  }

  /**
   * Los tipos que se ofrecen al justificar. "Amonestación" también va (22/10/2026,
   * RH la pidió en todas las listas): no justifica, solo queda registrada.
   * Los ajustes de un día (horario, desayuno, comida) se capturan desde la ficha.
   */
  get tiposQueJustifican(): TipoIncidencia[] {
    // 'visita_fuera' también se excluye: necesita recogida/entrega/autorizó, y
    // esta pantalla no tiene esos campos (se captura desde "+ Incidencia" en
    // Horarios y checadas). Dejarlo aquí daría un 400 sin salida.
    return this.tiposIncidencia.filter((t) => t.tipo !== 'falta_injustificada'
      && !['horario_distinto', 'desayuno_distinto', 'comida_distinta', 'visita_fuera'].includes(t.tipo));
  }

  async justificar(x: { sucursalId: string; codigo: string; nombre: string }, motivo: 'falta' | 'salida', detalle: string) {
    if (!this.tiposIncidencia.length) {
      try { this.tiposIncidencia = await this.checador.getTiposIncidencia(); } catch { /* se avisa abajo */ }
    }
    if (!this.tiposIncidencia.length) { this.toast.error('No se pudieron leer los tipos de incidencia. Intenta de nuevo.'); return; }
    this.justificando = {
      sucursalId: x.sucursalId, codigo: x.codigo, nombre: x.nombre, motivo, detalle,
      tipo: motivo === 'salida' ? 'permiso_con_goce' : 'permiso_con_goce', nota: '', guardando: false,
    };
  }

  get notaObligatoria(): boolean { return this.justificando?.tipo === 'otros'; }

  async guardarJustificacion() {
    const j = this.justificando;
    if (!j || j.guardando) return;
    if (this.notaObligatoria && !j.nota.trim()) { this.toast.alerta('Escribe el motivo: con "Otros" es lo único que explica la justificación.'); return; }
    if (this.esHorasExtra && (this.minutosJust < 1 || this.minutosJust > 720)) { this.toast.alerta('Escribe cuántas horas extra usó (entre 1 minuto y 12 horas).'); return; }
    const t = this.tiposIncidencia.find((x) => x.tipo === j.tipo);
    const ok = await this.toast.confirmar({
      titulo: 'Justificar',
      mensaje: `¿Seguro? Se registra "${t?.etiqueta || j.tipo}" para ${j.nombre} hoy` +
        (j.nota.trim() ? ` (${j.nota.trim()})` : '') + '. ' +
        (this.esHorasExtra ? `Se le suman ${this.duracion(this.minutosJust)} a sus horas de hoy. ` : '') +
        (!t?.excusaFalta ? 'Queda registrada, pero no justifica: ' + (j.motivo === 'falta' ? 'sigue contando como falta.' : 'la salida sigue como aviso.')
          : j.motivo === 'falta' ? 'Deja de contar como falta.' : 'La salida anticipada deja de contar como aviso.'),
      textoConfirmar: t?.excusaFalta === false ? 'Sí, registrar' : 'Sí, justificar',
    });
    if (!ok) return;
    j.guardando = true;
    const hoy = this.datos?.fecha || aFechaLocal(new Date());
    try {
      await this.checador.crearIncidencia({
        sucursalId: j.sucursalId, empleadoCodigo: j.codigo, tipo: j.tipo,
        desde: hoy, hasta: hoy, nota: j.nota.trim(),
        minutos: this.esHorasExtra ? this.minutosJust : null,
      });
      this.toast.exito(`${j.nombre}: ${t?.excusaFalta === false ? (t?.etiqueta || 'incidencia') + ' registrada' : 'justificado'}.`);
      this.justificando = null;
      const abierta = this.lista?.clave;
      await this.cargar(true, true);
      if (abierta) this.abrirLista(abierta);
    } catch (err) {
      console.error(err);
      this.toast.error('No se pudo guardar la justificación.');
      if (this.justificando) this.justificando.guardando = false;
    }
  }

  /** 186 → "3 h 06 min". */
  duracion(min: number): string {
    if (min < 60) return `${min} min`;
    return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
  }

  /** Los lugares para el selector, con cuánta gente hay en cada uno. */
  get lugares(): { id: string; nombre: string; n: number }[] {
    return this.escenas.map((e) => ({ id: e.id, nombre: e.alias, n: e.trabajando.length + e.comiendo.length }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  }
  alternarDepto(e: Escena, g: GrupoDepto) {
    const k = this.claveDepto(e, g);
    if (this.deptosAbiertos.has(k)) this.deptosAbiertos.delete(k); else this.deptosAbiertos.add(k);
  }
  grupoCoincide(g: GrupoDepto): boolean { return !this.buscando || g.personas.some((p) => this.coincide(p)); }

  // ── Presentación ──────────────────────────────────────────────────

  /**
   * EL FONDO DE CADA TARJETA, SEGÚN EL LUGAR (29/09/2026).
   *
   * Cada plaza se reconoce por lo que tiene alrededor: la catedral de Zamora,
   * los puestos de la Central de Abastos, los arcos del acueducto de Morelia,
   * el kiosco de la plaza del centro, la esquina de 8 Esquinas. Se decide por
   * el id y el nombre del reloj; una plaza nueva que no encaje cae en "ciudad".
   */
  lugarDe(e: EscenaEquipo): Lugar {
    const t = `${e.sucursalId} ${e.alias}`.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (e.tipo === 'bodega') return 'cedis';
    if (e.tipo === 'oficina' || e.tipo === 'comedor') return 'corporativo';
    if (t.includes('catedral')) return 'catedral';
    if (t.includes('abastos')) return 'abastos';
    if (t.includes('esquina')) return 'esquinas';
    if (t.includes('centro')) return 'kiosco';
    if (t.includes('morelia')) return 'acueducto';
    if (t.includes('canindo') || t.includes('pacueco')) return 'colonia';
    return 'ciudad';
  }

  /** "GARCIA TAPIA LUCIA" → "GT"; "Luciagarcia" → "LU". */
  iniciales(nombre: string): string {
    const partes = (nombre || '').trim().split(/\s+/).filter(Boolean);
    if (!partes.length) return '?';
    if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
    return (partes[0][0] + partes[1][0]).toUpperCase();
  }

  /** El mismo departamento siempre del mismo color, en esta pantalla y en la leyenda. */
  colorDe(depto: string | null): string {
    const d = (depto || '').trim().toUpperCase();
    if (!d) return SIN_DEPTO;
    if (!this.colores.has(d)) {
      let h = 0;
      for (const c of d) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      // Se evita repetir color mientras quede alguno libre.
      const usados = new Set(this.colores.values());
      let idx = h % PALETA.length;
      for (let n = 0; n < PALETA.length && usados.has(PALETA[idx]); n++) idx = (idx + 1) % PALETA.length;
      this.colores.set(d, PALETA[idx]);
    }
    return this.colores.get(d)!;
  }

  /** Los departamentos que están en pantalla, para la leyenda. */
  get leyenda(): { nombre: string; color: string; n: number }[] {
    const m = new Map<string, { nombre: string; color: string; n: number }>();
    for (const e of this.escenas) for (const p of [...e.trabajando, ...e.comiendo]) {
      const nombre = (p.departamento || 'Sin departamento').toUpperCase();
      if (!m.has(nombre)) m.set(nombre, { nombre, color: p.color, n: 0 });
      m.get(nombre)!.n++;
    }
    return [...m.values()].sort((a, b) => b.n - a.n);
  }

  nombrePlaza(id: string): string {
    const s = centroChecadorPorId(id);
    if (!s) return id;
    return s.direccion ? `${s.ciudad} · ${s.direccion.split(',')[0]}` : s.ciudad;
  }

  /** "hace 3 min", "hace 2 h 10 min". */
  hace(min: number): string {
    if (min < 1) return 'hace un momento';
    if (min < 60) return `hace ${min} min`;
    const h = Math.floor(min / 60), m = min % 60;
    return `hace ${h} h${m ? ' ' + m + ' min' : ''}`;
  }

  // ── Buscador ──────────────────────────────────────────────────────

  private norm(t: string) { return (t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }

  get buscando(): boolean { return !!this.busqueda.trim(); }

  coincide(p: Personaje, e?: Escena): boolean {
    const q = this.norm(this.busqueda.trim());
    if (!q) return true;
    const t = this.norm(`${p.nombre} ${p.codigo} ${p.departamento || ''} ${e ? e.alias + ' ' + e.plaza : ''}`);
    return q.split(/\s+/).every((x) => t.includes(x));
  }

  escenaCoincide(e: Escena): boolean {
    return !this.buscando || [...e.trabajando, ...e.comiendo].some((p) => this.coincide(p));
  }

  /** "Lucía está en Oficinas · en comida" — la respuesta directa a la búsqueda. */
  get encontrados(): { nombre: string; donde: string; estado: string }[] {
    if (!this.buscando) return [];
    const out: { nombre: string; donde: string; estado: string }[] = [];
    for (const e of this.escenas) for (const p of [...e.trabajando, ...e.comiendo]) {
      if (this.coincide(p, e)) out.push({ nombre: p.nombre, donde: e.alias, estado: p.estado === 'comida' ? 'en comida' : 'trabajando' });
    }
    return out.slice(0, 6);
  }

  /** Los que se pintan en la escena (con "+N" si son muchos, salvo que esté abierta). */
  visibles(e: Escena, lista: Personaje[]): Personaje[] {
    if (this.buscando) return lista.filter((p) => this.coincide(p)).concat(lista.filter((p) => !this.coincide(p))).slice(0, this.abiertas.has(e.id) ? lista.length : MAX_VISIBLES);
    return this.abiertas.has(e.id) ? lista : lista.slice(0, MAX_VISIBLES);
  }

  alternarEscena(e: Escena) {
    if (this.abiertas.has(e.id)) this.abiertas.delete(e.id); else this.abiertas.add(e.id);
  }

  alternarDetalle(p: Personaje) { this.detalle = this.detalle === p.clave ? null : p.clave; }

  trackPj = (_: number, p: Personaje) => p.clave;
}
