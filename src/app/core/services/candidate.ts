import { Injectable } from '@angular/core';
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore, collection, addDoc, getDocs, doc, updateDoc, onSnapshot } from 'firebase/firestore';
// Importamos las herramientas para guardar archivos
import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';

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
const storage = getStorage(app); // Inicializamos el disco duro

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

  // === FUNCIÓN PARA SUBIR ARCHIVOS AL EXPEDIENTE ===
  async uploadDocument(file: File, candidateId: string): Promise<string> {
    const filePath = `expedientes/${candidateId}/${new Date().getTime()}_${file.name}`;
    const storageRef = ref(storage, filePath);

    await uploadBytes(storageRef, file);
    return await getDownloadURL(storageRef);
  }
  // Agrega esta importación arriba si no la tienes: import { doc, onSnapshot } from 'firebase/firestore';

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