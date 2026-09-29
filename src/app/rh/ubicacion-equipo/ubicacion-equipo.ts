import { Component, inject, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChecadorService, EquipoAhora, EscenaEquipo, PersonaEquipo } from '../../core/services/checador.service';
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

  async cargar(silencioso = false) {
    if (!silencioso) this.cargando = true;
    try {
      const d = await this.checador.getEquipo();
      this.datos = d;
      this.escenas = this.armar(d);
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
    const lista = this.buscando
      ? g.personas.filter((p) => this.coincide(p)).concat(g.personas.filter((p) => !this.coincide(p)))
      : g.personas;
    return this.deptosAbiertos.has(this.claveDepto(e, g)) ? lista : lista.slice(0, this.POR_DEPTO);
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

  coincide(p: Personaje): boolean {
    const q = this.norm(this.busqueda.trim());
    if (!q) return true;
    const t = this.norm(`${p.nombre} ${p.codigo} ${p.departamento || ''}`);
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
      if (this.coincide(p)) out.push({ nombre: p.nombre, donde: e.alias, estado: p.estado === 'comida' ? 'en comida' : 'trabajando' });
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
