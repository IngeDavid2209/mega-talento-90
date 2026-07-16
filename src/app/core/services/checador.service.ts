import { Injectable } from '@angular/core';
import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getFirestore, collection, addDoc, doc, updateDoc, deleteDoc, onSnapshot,
  getDocs, query, where, orderBy, writeBatch, serverTimestamp
} from 'firebase/firestore';
import {
  AreaChecador, HorarioArea, Checada, Empleado, dedupDeChecada
} from '../models/checador.model';
import { FilaChecadaCruda } from '../models/parser-attlog';

// Mismo firebaseConfig del resto del proyecto (patrón inline, sin @angular/fire).
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

/** Resultado de una importación de checadas. */
export interface ResultadoImportacion {
  leidas: number;
  nuevas: number;
  duplicadas: number;
  sinEmpleado: number;
}

/** Firestore no acepta `undefined`: elimina esas llaves antes de escribir. */
function sinUndefined<T extends Record<string, any>>(obj: T): T {
  const out: Record<string, any> = {};
  for (const k of Object.keys(obj)) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out as T;
}

@Injectable({ providedIn: 'root' })
export class ChecadorService {

  // ===================== ÁREAS / CHECADORES =====================

  escucharAreas(callback: (areas: AreaChecador[]) => void) {
    const ref = collection(db, 'areas_checador');
    return onSnapshot(ref, (snap) => {
      const lista = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })) as AreaChecador[];
      lista.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
      callback(lista);
    }, (err) => console.error('Error al escuchar áreas:', err));
  }

  async guardarArea(area: AreaChecador): Promise<string> {
    const { id, ...datos } = area;
    if (id) {
      await updateDoc(doc(db, 'areas_checador', id), sinUndefined(datos) as any);
      return id;
    }
    const ref = await addDoc(collection(db, 'areas_checador'), sinUndefined(datos) as any);
    return ref.id;
  }

  async eliminarArea(id: string): Promise<void> {
    await deleteDoc(doc(db, 'areas_checador', id));
  }

  // ===================== HORARIOS =====================

  escucharHorarios(callback: (horarios: HorarioArea[]) => void) {
    const ref = collection(db, 'horarios_sucursal');
    return onSnapshot(ref, (snap) => {
      const lista = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })) as HorarioArea[];
      lista.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
      callback(lista);
    }, (err) => console.error('Error al escuchar horarios:', err));
  }

  async guardarHorario(horario: HorarioArea): Promise<string> {
    const { id, ...datos } = horario;
    if (id) {
      await updateDoc(doc(db, 'horarios_sucursal', id), sinUndefined(datos) as any);
      return id;
    }
    const ref = await addDoc(collection(db, 'horarios_sucursal'), sinUndefined(datos) as any);
    return ref.id;
  }

  async eliminarHorario(id: string): Promise<void> {
    await deleteDoc(doc(db, 'horarios_sucursal', id));
  }

  // ===================== EMPLEADOS =====================

  async getEmpleados(): Promise<Empleado[]> {
    const snap = await getDocs(collection(db, 'empleados'));
    return snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })) as Empleado[];
  }

  escucharEmpleados(callback: (empleados: Empleado[]) => void) {
    const ref = collection(db, 'empleados');
    return onSnapshot(ref, (snap) => {
      const lista = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })) as Empleado[];
      lista.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
      callback(lista);
    }, (err) => console.error('Error al escuchar empleados:', err));
  }

  async guardarEmpleado(empleado: Empleado): Promise<string> {
    const { id, ...datos } = empleado;
    if (id) {
      await updateDoc(doc(db, 'empleados', id), sinUndefined(datos) as any);
      return id;
    }
    const ref = await addDoc(collection(db, 'empleados'), sinUndefined(datos) as any);
    return ref.id;
  }

  async eliminarEmpleado(id: string): Promise<void> {
    await deleteDoc(doc(db, 'empleados', id));
  }

  // ===================== CHECADAS =====================

  /**
   * Checadas de una sucursal en un rango de fechas ['yyyy-MM-dd'].
   * Requiere el índice compuesto (sucursalId ASC, fecha ASC). El orden fino por
   * hora se hace en el cliente para no necesitar un índice de 3 campos.
   */
  async getChecadas(sucursalId: string, desde: string, hasta: string): Promise<Checada[]> {
    const ref = collection(db, 'checadas');
    const q = query(
      ref,
      where('sucursalId', '==', sucursalId),
      where('fecha', '>=', desde),
      where('fecha', '<=', hasta),
      orderBy('fecha')
    );
    const snap = await getDocs(q);
    const lista = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })) as Checada[];
    lista.sort((a, b) => (a.fechaHora < b.fechaHora ? -1 : a.fechaHora > b.fechaHora ? 1 : 0));
    return lista;
  }

  /**
   * Importa checadas ya parseadas:
   *  - mapea el código del reloj → empleado SOLO dentro de esa sucursal,
   *  - deduplica contra lo ya guardado en el rango del archivo Y dentro del
   *    propio archivo (misma marca repetida),
   *  - escribe con writeBatch en lotes de 400.
   */
  async importarChecadas(
    sucursalId: string,
    filas: FilaChecadaCruda[],
    empleados: Empleado[],
    areaId?: string
  ): Promise<ResultadoImportacion> {
    const leidas = filas.length;
    if (!leidas) return { leidas: 0, nuevas: 0, duplicadas: 0, sinEmpleado: 0 };

    // Mapa código → empleado, solo de esta sucursal.
    const mapaEmpleados = new Map<string, Empleado>();
    for (const e of empleados) {
      if (e.sucursalId === sucursalId && e.codigoChecador) {
        mapaEmpleados.set(String(e.codigoChecador).trim(), e);
      }
    }

    // Rango de fechas presente en el archivo (para traer solo lo necesario).
    let minFecha = filas[0].fecha;
    let maxFecha = filas[0].fecha;
    for (const f of filas) {
      if (f.fecha < minFecha) minFecha = f.fecha;
      if (f.fecha > maxFecha) maxFecha = f.fecha;
    }

    // dedupKeys ya existentes en Firestore para ese rango.
    const vistos = new Set<string>();
    const existentes = await this.getChecadas(sucursalId, minFecha, maxFecha);
    for (const c of existentes) if (c.dedupKey) vistos.add(c.dedupKey);

    let nuevas = 0;
    let duplicadas = 0;
    let sinEmpleado = 0;
    const porGuardar: Checada[] = [];

    for (const f of filas) {
      const dedupKey = dedupDeChecada(sucursalId, f.empleadoCodigo, f.fechaHora);
      if (vistos.has(dedupKey)) { duplicadas++; continue; }
      vistos.add(dedupKey); // también deduplica dentro del mismo archivo

      const emp = mapaEmpleados.get(String(f.empleadoCodigo).trim());
      if (!emp) sinEmpleado++;

      porGuardar.push({
        sucursalId,
        areaId: areaId || undefined,
        deviceId: f.deviceId,
        empleadoCodigo: f.empleadoCodigo,
        empleadoNombre: emp?.nombre,
        fechaHora: f.fechaHora,
        fecha: f.fecha,
        hora: f.hora,
        tipo: f.tipo,
        dedupKey
      });
      nuevas++;
    }

    // Escritura en lotes de 400 (límite de Firestore es 500 por batch).
    const ref = collection(db, 'checadas');
    for (let i = 0; i < porGuardar.length; i += 400) {
      const batch = writeBatch(db);
      for (const c of porGuardar.slice(i, i + 400)) {
        batch.set(doc(ref), sinUndefined({ ...c, importadoEn: serverTimestamp() }));
      }
      await batch.commit();
    }

    return { leidas, nuevas, duplicadas, sinEmpleado };
  }
}
