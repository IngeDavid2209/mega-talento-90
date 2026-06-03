import { Injectable } from '@angular/core';
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore, collection, addDoc, getDocs, doc, updateDoc, deleteDoc, onSnapshot } from 'firebase/firestore';
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

  async getCandidates() {
    const snapshot = await getDocs(collection(db, 'candidates'));
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }

  listenToCandidates(callback: (candidatos: any[]) => void) {
    const queryRef = collection(db, 'candidates');
    const unsubscribe = onSnapshot(queryRef, (snapshot) => {
      const candidatos = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      callback(candidatos);
    }, (error) => {
      console.error("Error en la conexión en tiempo real:", error);
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

  // === ELIMINAR CANDIDATO ===
  async eliminarCandidato(id: string): Promise<void> {
    await deleteDoc(doc(db, 'candidates', id));
  }

  /**
   * Busca si ya existe un candidato con el mismo teléfono o nombre.
   * - Teléfono: comparación exacta tras quitar todo lo que no sea dígito.
   * - Nombre: comparación normalizada (minúsculas, espacios colapsados).
   * Devuelve el candidato encontrado o null si no hay duplicado.
   */
  async buscarDuplicado(telefono: string, nombre: string): Promise<any | null> {
    const telLimpio = (telefono || '').replace(/\D/g, '');
    const nomNorm = this.normalizarNombre(nombre);
    if (!telLimpio && !nomNorm) return null;

    const todos = await this.getCandidates();
    return todos.find((c: any) => {
      const telExistente = (c.telefono || '').replace(/\D/g, '');
      const nomExistente = this.normalizarNombre(c.nombre);
      // Coincide por teléfono (10 dígitos completos) o por nombre exacto (no muy corto)
      const matchTel = telLimpio.length >= 10 && telLimpio === telExistente;
      const matchNom = nomNorm.length >= 5 && nomNorm === nomExistente;
      return matchTel || matchNom;
    }) || null;
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