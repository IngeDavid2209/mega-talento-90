import { Injectable } from '@angular/core';
import { initializeApp, getApps, getApp } from 'firebase/app';
// Agregamos 'doc' y 'updateDoc' a la lista de importaciones
import { getFirestore, collection, addDoc, getDocs, doc, updateDoc } from 'firebase/firestore';

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
    console.log("1. Servicio contactado...");
    const newCandidate = {
      ...candidateData,
      status: 'nuevo', // Lo dejamos como 'nuevo' para que caiga en la primera columna
      createdAt: new Date()
    };
    console.log("2. Enviando a Firebase...");
    const docRef = await addDoc(collection(db, 'candidates'), newCandidate);
    console.log("3. ¡ÉXITO! ID:", docRef.id);
    return docRef;
  }

  async getCandidates() {
    const snapshot = await getDocs(collection(db, 'candidates'));
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }

  // === NUEVO MÉTODO PARA EL KANBAN ===
  async updateCandidate(id: string, data: any) {
    try {
      // Creamos la referencia al documento específico usando el ID
      const candidateRef = doc(db, 'candidates', id);
      
      // Aplicamos la actualización en Firebase
      await updateDoc(candidateRef, data);
      
      return true;
    } catch (error) {
      console.error("Error al actualizar candidato:", error);
      throw error;
    }
  }
}