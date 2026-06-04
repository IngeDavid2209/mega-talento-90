import { Injectable } from '@angular/core';
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore, collection, addDoc, getDocs, doc, updateDoc, deleteDoc, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { subirACloudinary } from './cloudinary';

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

@Injectable({ providedIn: 'root' })
export class CandidateService {

  async createCandidate(candidateData: any) {
    const newCandidate = {
      ...candidateData,
      status: 'nuevo',
      createdAt: new Date()
    };
    return await addDoc(collection(db, 'candidates'), newCandidate);
  }

  /** Devuelve todos los candidatos VIVOS (excluye los enviados a la papelera) */
  async getCandidates() {
    const snapshot = await getDocs(collection(db, 'candidates'));
    return snapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter((c: any) => !c.deletedAt);
  }

  /** Como getCandidates pero también incluye los borrados (para detectar duplicados) */
  async getCandidatesIncluyendoBorrados() {
    const snapshot = await getDocs(collection(db, 'candidates'));
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }

  listenToCandidates(callback: (candidatos: any[]) => void) {
    const queryRef = collection(db, 'candidates');
    const unsubscribe = onSnapshot(queryRef, (snapshot) => {
      const candidatos = snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() }))
        .filter((c: any) => !c.deletedAt);
      callback(candidatos);
    }, (error) => {
      console.error("Error en la conexión en tiempo real:", error);
    });
    return unsubscribe;
  }

  /** Listener exclusivo para la papelera (solo candidatos con deletedAt) */
  listenToCandidatosBorrados(callback: (candidatos: any[]) => void) {
    const queryRef = collection(db, 'candidates');
    const unsubscribe = onSnapshot(queryRef, (snapshot) => {
      const candidatos = snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() }))
        .filter((c: any) => !!c.deletedAt);
      callback(candidatos);
    }, (error) => {
      console.error("Error al escuchar la papelera:", error);
    });
    return unsubscribe;
  }

  async updateCandidate(id: string, data: any) {
    try {
      const candidateRef = doc(db, 'candidates', id);
      await updateDoc(candidateRef, data);
      return true;
    } catch (error) {
      console.error("Error al actualizar candidato:", error);
      throw error;
    }
  }

  // === SUBIR ARCHIVOS DEL EXPEDIENTE (a Cloudinary, no Firebase Storage) ===
  async uploadDocument(file: File, candidateId: string): Promise<string> {
    return await subirACloudinary(file, `expedientes/${candidateId}`);
  }

  /**
   * Soft delete: marca el candidato como borrado con un timestamp.
   * Queda fuera de los listados normales pero puede restaurarse desde la papelera.
   * Esto evita que el candidato "reaparezca" cuando se vuelve a postular: la
   * lógica de buscarDuplicado ahora lo encuentra incluso si está borrado.
   */
  async eliminarCandidato(id: string): Promise<void> {
    await updateDoc(doc(db, 'candidates', id), {
      deletedAt: serverTimestamp()
    });
  }

  /** Restaura un candidato que estaba en la papelera */
  async restaurarCandidato(id: string): Promise<void> {
    await updateDoc(doc(db, 'candidates', id), {
      deletedAt: null
    });
  }

  /** Borrado físico: solo desde la papelera, no se puede deshacer */
  async eliminarCandidatoDefinitivo(id: string): Promise<void> {
    await deleteDoc(doc(db, 'candidates', id));
  }

  /**
   * Busca si ya existe un candidato (vivo o en papelera) con el mismo teléfono
   * o nombre. Si está en papelera devuelve { ...candidato, estaEnPapelera: true }.
   * - Teléfono: comparación exacta tras quitar todo lo que no sea dígito.
   * - Nombre: comparación normalizada (minúsculas, espacios colapsados).
   * Devuelve el candidato encontrado o null si no hay duplicado.
   */
  async buscarDuplicado(telefono: string, nombre: string): Promise<any | null> {
    const telLimpio = (telefono || '').replace(/\D/g, '');
    const nomNorm = this.normalizarNombre(nombre);
    if (!telLimpio && !nomNorm) return null;

    const todos = await this.getCandidatesIncluyendoBorrados();
    const match: any = todos.find((c: any) => {
      const telExistente = (c.telefono || '').replace(/\D/g, '');
      const nomExistente = this.normalizarNombre(c.nombre);
      // Coincide por teléfono (10 dígitos completos) o por nombre exacto (no muy corto)
      const matchTel = telLimpio.length >= 10 && telLimpio === telExistente;
      const matchNom = nomNorm.length >= 5 && nomNorm === nomExistente;
      return matchTel || matchNom;
    });
    if (!match) return null;
    return { ...match, estaEnPapelera: !!match.deletedAt };
  }

  private normalizarNombre(s: string): string {
    return (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  listenToCandidate(id: string, callback: (candidato: any) => void) {
    const docRef = doc(db, 'candidates', id);
    const unsubscribe = onSnapshot(docRef, (docSnap) => {
      if (docSnap.exists()) {
        callback({ id: docSnap.id, ...docSnap.data() });
      }
    }, (error) => {
      console.error("Error al cargar el expediente:", error);
    });
    return unsubscribe;
  }
}