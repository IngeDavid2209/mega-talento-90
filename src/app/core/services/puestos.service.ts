import { Injectable } from '@angular/core';
import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getFirestore, collection, addDoc, doc, updateDoc, deleteDoc, onSnapshot,
  getDocs, setDoc
} from 'firebase/firestore';
import { PUESTOS as PUESTOS_SEMILLA } from '../models/puestos.model';

const firebaseConfig = {
  apiKey: "AIzaSyCZ2ADjjBFWgwPybDxwFSUg_lzWDO_Y5lI",
  authDomain: "megatalento-a3450.firebaseapp.com",
  projectId: "megatalento-a3450",
  storageBucket: "megatalento-a3450.firebasestorage.app",
  messagingSenderId: "794979076803",
  appId: "1:794979076803:web:034f492c57852ad3c3b076"
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const db = getFirestore(app);

export interface Puesto {
  id?: string;
  nombre: string;
  descripcion: string;
  sucursales?: string;       // texto libre con sucursales
  sueldo?: string;            // texto libre (puede ser rango)
  horario?: string;
  activo: boolean;            // si está visible en la cartelera pública
  orden?: number;
  createdAt?: any;
}

@Injectable({ providedIn: 'root' })
export class PuestosService {

  private readonly CACHE_KEY = 'mt_puestos_cache_v1';

  /**
   * Escucha en vivo la lista de puestos. Para que la UI se sienta instantánea
   * incluso cuando Firestore tarda en responder, primero entrega lo último
   * guardado en localStorage (si lo hay) y después la versión fresca cuando
   * llega del servidor.
   *
   * Si Firestore responde con error (reglas bloquean, sin red, etc.) se llama
   * al onError opcional para que la UI pueda mostrar el problema en lugar de
   * quedarse cargando para siempre.
   */
  listar(
    callback: (puestos: Puesto[]) => void,
    onError?: (error: any) => void
  ) {
    // 1. Respuesta INSTANTÁNEA con cache local (si tenemos algo guardado)
    const cached = this.leerCache();
    if (cached.length > 0) {
      // Microtask para no llamar al callback dentro del mismo tick que el ngOnInit
      Promise.resolve().then(() => callback(cached));
    }

    // 2. Suscripción real a Firestore (actualiza cuando llegue la respuesta)
    const ref = collection(db, 'puestos');
    return onSnapshot(ref, (snap) => {
      const lista = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })) as Puesto[];
      lista.sort((a, b) => {
        const oa = a.orden ?? 999;
        const ob = b.orden ?? 999;
        if (oa !== ob) return oa - ob;
        return (a.nombre || '').localeCompare(b.nombre || '');
      });
      this.escribirCache(lista);
      callback(lista);
    }, (err) => {
      console.error('Error al listar puestos:', err);
      if (onError) onError(err);
    });
  }

  private leerCache(): Puesto[] {
    try {
      const raw = localStorage.getItem(this.CACHE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private escribirCache(lista: Puesto[]) {
    try {
      localStorage.setItem(this.CACHE_KEY, JSON.stringify(lista));
    } catch {
      // localStorage lleno o deshabilitado — no es crítico, seguimos
    }
  }

  /** Carga los puestos una vez (no en vivo). Útil para sembrado inicial. */
  async obtener(): Promise<Puesto[]> {
    const snap = await getDocs(collection(db, 'puestos'));
    return snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })) as Puesto[];
  }

  async crear(p: Omit<Puesto, 'id'>): Promise<void> {
    await addDoc(collection(db, 'puestos'), {
      ...p,
      createdAt: new Date()
    });
  }

  async actualizar(id: string, cambios: Partial<Puesto>): Promise<void> {
    await updateDoc(doc(db, 'puestos', id), cambios as any);
  }

  async eliminar(id: string): Promise<void> {
    await deleteDoc(doc(db, 'puestos', id));
  }

  /**
   * Siembra el catálogo estático en Firestore SIN verificar si ya hay datos.
   * El componente que llame esto debe confirmar primero que la colección
   * está vacía (típicamente a partir de la primera respuesta de listar()).
   * Esto evita hacer un getDocs extra en cada carga de la vista admin.
   */
  async sembrar(): Promise<void> {
    let i = 0;
    for (const p of PUESTOS_SEMILLA) {
      const id = this.slugDePuesto(p.nombre);
      await setDoc(doc(db, 'puestos', id), {
        nombre: p.nombre,
        descripcion: p.descripcion,
        sucursales: '',
        sueldo: '',
        horario: '',
        activo: true,
        orden: i++,
        createdAt: new Date()
      });
    }
    console.log('Catálogo de puestos sembrado con', PUESTOS_SEMILLA.length, 'puestos.');
  }

  /**
   * Carga las vacantes del catálogo SOLO si no existen ya (por nombre normalizado).
   * Devuelve { creados, omitidos } para que la UI muestre el resultado.
   * Útil cuando el RH ya tiene algunas vacantes manuales y quiere completar
   * el catálogo sin sobreescribir lo que ya configuró.
   */
  async cargarCatalogoSiFaltan(): Promise<{ creados: string[]; omitidos: string[] }> {
    const existentes = await this.obtener();
    const nombresExistentes = new Set(
      existentes.map(p => (p.nombre || '').trim().toLowerCase())
    );
    const creados: string[] = [];
    const omitidos: string[] = [];
    let ordenBase = existentes.length;

    for (const p of PUESTOS_SEMILLA) {
      const clave = p.nombre.trim().toLowerCase();
      if (nombresExistentes.has(clave)) {
        omitidos.push(p.nombre);
        continue;
      }
      const id = this.slugDePuesto(p.nombre);
      await setDoc(doc(db, 'puestos', id), {
        nombre: p.nombre,
        descripcion: p.descripcion,
        sucursales: '',
        sueldo: '',
        horario: '',
        activo: true,
        orden: ordenBase++,
        createdAt: new Date()
      });
      creados.push(p.nombre);
    }
    return { creados, omitidos };
  }

  /** Slug seguro para usar como ID de documento de Firestore */
  private slugDePuesto(nombre: string): string {
    // Rango ̀-ͯ cubre los marcadores combinantes (acentos)
    const acentos = new RegExp('[\\u0300-\\u036f]', 'g');
    return nombre
      .toLowerCase()
      .normalize('NFD').replace(acentos, '')
      .replace(/[()]/g, '')
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '');
  }
}
