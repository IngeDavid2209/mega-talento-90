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

  /** Escucha en vivo la lista de puestos */
  listar(callback: (puestos: Puesto[]) => void) {
    const ref = collection(db, 'puestos');
    return onSnapshot(ref, (snap) => {
      const lista = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })) as Puesto[];
      // Orden por campo `orden` (si existe), luego por nombre
      lista.sort((a, b) => {
        const oa = a.orden ?? 999;
        const ob = b.orden ?? 999;
        if (oa !== ob) return oa - ob;
        return (a.nombre || '').localeCompare(b.nombre || '');
      });
      callback(lista);
    }, (err) => console.error('Error al listar puestos:', err));
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
      const id = p.nombre.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
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
}
