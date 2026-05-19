import { Injectable } from '@angular/core';
import { initializeApp, getApps, getApp } from 'firebase/app';
// Agregamos 'onSnapshot' para el tiempo real
import { getFirestore, collection, addDoc, getDocs, doc, updateDoc, onSnapshot } from 'firebase/firestore';

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
      status: 'nuevo',
      createdAt: new Date()
    };
    console.log("2. Enviando a Firebase...");
    const docRef = await addDoc(collection(db, 'candidates'), newCandidate);
    console.log("3. ¡ÉXITO! ID:", docRef.id);
    return docRef;
  }

  // Mantenemos este por si lo usas en reportes estáticos
  async getCandidates() {
    const snapshot = await getDocs(collection(db, 'candidates'));
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }

  // === NUEVO MÉTODO EN TIEMPO REAL PARA EL TABLERO ===
  listenToCandidates(callback: (candidatos: any[]) => void) {
    const queryRef = collection(db, 'candidates');
    
    // onSnapshot se queda "escuchando" la base de datos 24/7
    const unsubscribe = onSnapshot(queryRef, (snapshot) => {
      const candidatos = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      callback(candidatos); // Enviamos los datos frescos al componente
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
}