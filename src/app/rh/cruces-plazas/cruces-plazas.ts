import { Component, inject, OnInit, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import * as XLSX from 'xlsx';
import { ChecadorService, CrucesPlazas, PersonaCruce, DiaCruce, ClaseCruce } from '../../core/services/checador.service';
import { aFechaLocal } from '../../core/models/checador.model';
import { centroChecadorPorId } from '../../core/models/sucursales.model';
import { ToastService } from '../../core/services/toast.service';

/**
 * QUIÉN CHECÓ EN EL RELOJ DE OTRA PLAZA.
 *
 * Es la única vista del módulo que NO va por sucursal, y no es un descuido: el
 * cruce solo existe comparando una plaza contra otra. Por eso esta pestaña
 * ignora el selector de sucursal de la página y mira las doce a la vez.
 *
 * Todo el cálculo vive en `api/src/agente-horarios/cruces-plazas.ts`, incluida
 * la razón de cada clase. Aquí solo se pinta y se ordena.
 *
 * Lo que hace útil a esta pantalla no es la lista, es la CLASIFICACIÓN: de los
 * casos medidos, unos son gente cubriendo dos tiendas —y entonces el problema no
 * es disciplina, es que su jornada aparece partida y cae en "días no medibles"—,
 * otros son marcas sueltas en el reloj ajeno, y unos pocos son jornadas
 * encimadas que nadie puede explicar. Revueltos no sirven de nada.
 */
@Component({
  selector: 'app-cruces-plazas',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './cruces-plazas.html',
  styleUrl: './cruces-plazas.css'
})
export class CrucesPlazasComponent implements OnInit {
  private checador = inject(ChecadorService);
  private toast = inject(ToastService);

  /** Cuántas personas salieron, para el contador de la pestaña. */
  @Output() total = new EventEmitter<number>();

  desde = '';
  hasta = '';
  cargando = false;
  datos: CrucesPlazas | null = null;
  error = '';

  /** Código de la persona cuyo detalle por día está abierto. */
  abierta = '';

  /** Clases que se muestran. Las rutas de promotora arrancan apagadas: son normales. */
  filtro: Record<ClaseCruce, boolean> = {
    traslape: true, marca_ajena: true, jornada_partida: true, sueltas: true, ruta_promotora: false,
  };

  readonly CLASES: { v: ClaseCruce; l: string; ayuda: string }[] = [
    { v: 'traslape', l: 'Jornadas encimadas',
      ayuda: 'Dos jornadas completas que se pisan en el tiempo. Nadie está en dos plazas a la vez: o alguien checa por esa persona, o su código lo usa alguien más.' },
    { v: 'marca_ajena', l: 'Marca en plaza ajena',
      ayuda: 'Una marca suelta en el reloj de otra plaza, a media jornada de la suya. Puede ser una visita legítima (un pedido, un apoyo) — por eso no se llama imposible.' },
    { v: 'jornada_partida', l: 'Jornada partida',
      ayuda: 'Cubrió dos tiendas el mismo día, sin encimarse. Ojo: hoy su día aparece cortado y en cada plaza parece "una sola marca", así que cae en días no medibles.' },
    { v: 'sueltas', l: 'Presencias sueltas',
      ayuda: 'Marcas en dos plazas el mismo día, muy separadas entre sí. No se puede armar una jornada con eso.' },
    { v: 'ruta_promotora', l: 'Rutas de promotora',
      ayuda: 'Andar entre plazas es su trabajo. Se listan aparte para que no ensucien lo demás; se apagan por omisión.' },
  ];

  ngOnInit() {
    const hoy = new Date();
    const hace30 = new Date();
    hace30.setDate(hoy.getDate() - 29);
    this.hasta = aFechaLocal(hoy);
    this.desde = aFechaLocal(hace30);
    this.cargar();
  }

  async cargar() {
    if (!this.desde || !this.hasta) return;
    this.cargando = true;
    this.error = '';
    try {
      this.datos = await this.checador.getCruces(this.desde, this.hasta);
      this.total.emit(this.visibles.length);
    } catch (e) {
      console.error(e);
      this.error = 'No se pudieron calcular los cruces entre plazas.';
      this.datos = null;
    } finally {
      this.cargando = false;
    }
  }

  /** Atajo de periodo: últimos N días. */
  aplicarRango(dias: number) {
    const hoy = new Date();
    const ini = new Date(hoy);
    ini.setDate(hoy.getDate() - (dias - 1));
    this.desde = aFechaLocal(ini);
    this.hasta = aFechaLocal(hoy);
    this.cargar();
  }

  get visibles(): PersonaCruce[] {
    return (this.datos?.personas || []).filter(p => this.filtro[p.clase]);
  }

  /** Cuántas personas hay de cada clase, para las casillas del filtro. */
  cuenta(c: ClaseCruce): number {
    return (this.datos?.personas || []).filter(p => p.clase === c).length;
  }

  toggleFiltro(c: ClaseCruce) {
    this.filtro[c] = !this.filtro[c];
    this.total.emit(this.visibles.length);
  }

  toggleAbierta(clave: string) {
    this.abierta = this.abierta === clave ? '' : clave;
  }

  etiquetaClase(c: ClaseCruce): string {
    return this.CLASES.find(x => x.v === c)?.l || c;
  }
  ayudaClase(c: ClaseCruce): string {
    return this.CLASES.find(x => x.v === c)?.ayuda || '';
  }

  nombreSucursal(id: string): string {
    const s = centroChecadorPorId(id);
    if (!s) return id || '—';
    return s.direccion ? `${s.ciudad} · ${s.direccion.split(',')[0]}` : s.ciudad;
  }

  /** "Morelia Madero #18 · Abastos #236" — dónde está dada de alta. */
  altasTexto(p: PersonaCruce): string {
    return p.altas.map(a => `${this.nombreSucursal(a.sucursalId)} #${a.codigo}`).join(' · ');
  }

  /** "Mié 20 ago" */
  etiquetaDia(fecha: string): string {
    const d = new Date(fecha + 'T00:00:00');
    const limpia = (s: string) => s.replace(/\.$/, '');
    const dow = limpia(d.toLocaleDateString('es-MX', { weekday: 'short' }));
    const mes = limpia(d.toLocaleDateString('es-MX', { month: 'short' }));
    return `${dow.charAt(0).toUpperCase()}${dow.slice(1)} ${String(d.getDate()).padStart(2, '0')} ${mes}`;
  }

  /**
   * El hueco, dicho en palabras. Un número negativo no se lee: "se encimaron 2 h
   * 15 min" sí, y es lo que decide si el caso es explicable o no.
   */
  huecoTexto(d: DiaCruce): string {
    if (d.huecoMin === null) return '';
    const m = Math.abs(d.huecoMin);
    const txt = m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ' ' + (m % 60) + ' min' : ''}` : `${m} min`;
    if (d.huecoMin < 0) return `se encimaron ${txt}`;
    if (d.huecoMin === 0) return 'una pegada a la otra';
    return `${txt} entre una y otra`;
  }

  /** Una estancia de una sola marca no es una estancia: es un instante. */
  esInstante(marcas: number): boolean { return marcas <= 1; }

  exportar() {
    const filas: any[] = [];
    for (const p of this.visibles) {
      for (const d of p.dias) {
        filas.push({
          'Persona': p.nombre,
          'Dada de alta en': this.altasTexto(p),
          'Clase del caso': this.etiquetaClase(p.clase),
          'Fecha': d.fecha,
          'Clase del día': this.etiquetaClase(d.clase),
          'Estancias': d.estancias
            .map(e => `${this.nombreSucursal(e.sucursalId)} #${e.codigo} ${e.primera}→${e.ultima} (${e.marcas} marca${e.marcas === 1 ? '' : 's'})`)
            .join(' | '),
          'Hueco': this.huecoTexto(d),
          'Es promotora': p.esPromotora ? 'Sí' : 'No',
        });
      }
    }
    if (!filas.length) { this.toast.alerta('No hay cruces que exportar en este periodo.'); return; }
    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(filas), 'Cruces entre plazas');
    XLSX.writeFile(libro, `Cruces_entre_plazas_${this.desde}_a_${this.hasta}.xlsx`);
  }
}
