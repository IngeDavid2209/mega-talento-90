import { Injectable, inject } from '@angular/core';
import { ApiService } from './api.service';
import { PUESTOS as PUESTOS_SEMILLA } from '../models/puestos.model';
import { inferirSucursalIds, sucursalPorId } from '../models/sucursales.model';
import { AptitudItem } from '../models/proceso.model';

export interface Puesto {
  id?: string;
  nombre: string;
  descripcion: string;
  sucursalIds?: string[];
  sucursales?: string;
  sueldo?: string;
  horario?: string;
  requisitos?: string;
  imagenUrl?: string;
  area?: string;
  activo: boolean;
  orden?: number;
  createdAt?: any;
  hojaCompetencias?: string;
  aptitudes?: AptitudItem[];
  tipoAptitud?: 'operativo' | 'administrativo' | 'ventas' | 'jefatura';
}

/**
 * Quita puestos DUPLICADOS por nombre normalizado (sin acentos/espacios). Si hay
 * duplicado, conserva el que tenga `sucursalIds`. USAR SOLO en vistas de
 * candidatos (/empleos y /unete).
 */
export function dedupPuestos(lista: Puesto[]): Puesto[] {
  const norm = (s: string) =>
    (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '');
  const porNombre = new Map<string, Puesto>();
  for (const p of lista) {
    const k = norm(p.nombre);
    if (!k) continue;
    const previo = porNombre.get(k);
    if (!previo) { porNombre.set(k, p); continue; }
    const previoTiene = Array.isArray(previo.sucursalIds) && previo.sucursalIds.length > 0;
    const actualTiene = Array.isArray(p.sucursalIds) && p.sucursalIds.length > 0;
    if (!previoTiene && actualTiene) porNombre.set(k, p);
  }
  return Array.from(porNombre.values());
}

@Injectable({ providedIn: 'root' })
export class PuestosService {
  private api = inject(ApiService);
  private readonly CACHE_KEY = 'mt_puestos_cache_v1';
  private readonly POLL_MS = 15000;

  private ordenar(lista: Puesto[]): Puesto[] {
    return [...lista].sort((a, b) => {
      const oa = a.orden ?? 999, ob = b.orden ?? 999;
      if (oa !== ob) return oa - ob;
      return (a.nombre || '').localeCompare(b.nombre || '');
    });
  }

  /**
   * Escucha la lista de puestos. Entrega primero el cache local (respuesta
   * instantánea) y luego refresca por polling desde la API.
   */
  listar(callback: (puestos: Puesto[]) => void, onError?: (error: any) => void) {
    const cached = this.leerCache();
    if (cached.length) Promise.resolve().then(() => callback(cached));

    let activo = true;
    const tick = async () => {
      if (!activo) return;
      try {
        const lista = this.ordenar(await this.api.get<Puesto[]>('/puestos'));
        this.escribirCache(lista);
        callback(lista);
      } catch (err) {
        console.error('Error al listar puestos:', err);
        if (onError) onError(err);
      }
    };
    tick();
    const id = setInterval(tick, this.POLL_MS);
    return () => { activo = false; clearInterval(id); };
  }

  private leerCache(): Puesto[] {
    try {
      const raw = localStorage.getItem(this.CACHE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  private escribirCache(lista: Puesto[]) {
    try { localStorage.setItem(this.CACHE_KEY, JSON.stringify(lista)); } catch { /* noop */ }
  }

  async obtener(): Promise<Puesto[]> {
    return this.ordenar(await this.api.get<Puesto[]>('/puestos'));
  }

  async crear(p: Omit<Puesto, 'id'>): Promise<void> {
    await this.api.post('/puestos', p);
  }

  async actualizar(id: string, cambios: Partial<Puesto>): Promise<void> {
    await this.api.patch(`/puestos/${id}`, cambios);
  }

  async eliminar(id: string): Promise<void> {
    await this.api.delete(`/puestos/${id}`);
  }

  /** Siembra el catálogo estático (crea cada puesto vía API). */
  async sembrar(): Promise<void> {
    let i = 0;
    for (const p of PUESTOS_SEMILLA) {
      await this.crear({
        nombre: p.nombre, descripcion: p.descripcion, sucursales: '',
        sueldo: '', horario: '', activo: true, orden: i++
      } as Omit<Puesto, 'id'>);
    }
  }

  /** Crea del catálogo solo los que faltan (por nombre). */
  async cargarCatalogoSiFaltan(): Promise<{ creados: string[]; omitidos: string[] }> {
    const existentes = await this.obtener();
    const nombres = new Set(existentes.map(p => (p.nombre || '').trim().toLowerCase()));
    const creados: string[] = [], omitidos: string[] = [];
    let orden = existentes.length;
    for (const p of PUESTOS_SEMILLA) {
      const clave = p.nombre.trim().toLowerCase();
      if (nombres.has(clave)) { omitidos.push(p.nombre); continue; }
      await this.crear({
        nombre: p.nombre, descripcion: p.descripcion, sucursales: '',
        sueldo: '', horario: '', activo: true, orden: orden++
      } as Omit<Puesto, 'id'>);
      creados.push(p.nombre);
    }
    return { creados, omitidos };
  }

  /** Vincula automáticamente sucursales a partir del texto libre. */
  async vincularSucursalesAutomatico(): Promise<{ vinculados: string[]; sinCoincidencia: string[]; yaTenian: string[] }> {
    const puestos = await this.obtener();
    const vinculados: string[] = [], sinCoincidencia: string[] = [], yaTenian: string[] = [];
    for (const p of puestos) {
      if (!p.id) continue;
      if (Array.isArray(p.sucursalIds) && p.sucursalIds.length) { yaTenian.push(p.nombre); continue; }
      const ids = inferirSucursalIds(p.sucursales || '');
      if (!ids.length) { sinCoincidencia.push(p.nombre); continue; }
      const texto = ids.map(id => sucursalPorId(id)?.direccion).filter(Boolean).join(' · ');
      await this.actualizar(p.id, { sucursalIds: ids, sucursales: texto });
      vinculados.push(p.nombre);
    }
    return { vinculados, sinCoincidencia, yaTenian };
  }
}
