import { Injectable } from '@angular/core';
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore, collection, addDoc, getDocs, doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, serverTimestamp } from 'firebase/firestore';
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
      // Primera etapa vigente del proceso (antes era 'nuevo'/Solicitud, ya retirada)
      status: candidateData?.status || 'filtro_inicial',
      createdAt: new Date()
    };
    const ref = await addDoc(collection(db, 'candidates'), newCandidate);

    // Registrar el teléfono en el índice público `telefonos/{numero}` para que
    // buscarDuplicado pueda detectar repostulaciones SIN listar la colección
    // completa de candidatos (que el flujo público /unete no puede leer).
    // Es "mejor esfuerzo": si falla no rompemos la postulación ya creada.
    const telNorm = (candidateData?.telefono || '').replace(/\D/g, '');
    if (telNorm.length >= 10) {
      try {
        await setDoc(doc(db, 'telefonos', telNorm), {
          candidateId: ref.id,
          nombre: candidateData?.nombre || '',
          createdAt: new Date()
        });
      } catch (e) {
        console.warn('No se pudo registrar el índice de teléfono (no bloquea la postulación):', e);
      }
    }
    return ref;
  }

  /**
   * Rellena el índice `telefonos/{numero}` con los candidatos ya existentes.
   * Se ejecuta desde un contexto autenticado (RH) porque necesita LISTAR
   * candidates. Es idempotente: sobreescribir un índice existente no molesta.
   * Sirve para que los candidatos que se postularon ANTES de este arreglo
   * también queden protegidos contra repostulación.
   */
  async backfillTelefonos(): Promise<number> {
    const todos = await this.getCandidatesIncluyendoBorrados();
    let escritos = 0;
    for (const c of todos as any[]) {
      const telNorm = (c.telefono || '').replace(/\D/g, '');
      if (telNorm.length < 10) continue;
      try {
        await setDoc(doc(db, 'telefonos', telNorm), {
          candidateId: c.id,
          nombre: c.nombre || '',
          createdAt: c.createdAt || new Date()
        });
        escritos++;
      } catch (e) {
        console.warn('backfillTelefonos: no se pudo escribir', telNorm, e);
      }
    }
    return escritos;
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
   *
   * NOTA: esta función la llama el flujo público /unete SIN autenticación.
   * Por eso NO lista la colección `candidates` (las reglas de Firestore lo
   * prohíben a usuarios sin sesión y siempre fallaría con permission-denied,
   * dejando pasar todos los duplicados). En su lugar lee un único documento
   * del índice público `telefonos/{numero}` con getDoc (que sí es público y
   * no permite enumerar datos de nadie). Devuelve el registro encontrado o
   * null si no hay duplicado.
   */
  async buscarDuplicado(telefono: string, _nombre?: string): Promise<any | null> {
    const telLimpio = (telefono || '').replace(/\D/g, '');
    // El índice se llavea por teléfono de 10 dígitos; sin teléfono válido no
    // podemos verificar de forma pública, así que dejamos pasar.
    if (telLimpio.length < 10) return null;

    try {
      const snap = await getDoc(doc(db, 'telefonos', telLimpio));
      if (!snap.exists()) return null;
      const data: any = snap.data() || {};
      return { id: data.candidateId, ...data, estaEnPapelera: false };
    } catch (e) {
      // Si por alguna razón la lectura falla, no bloqueamos la postulación.
      // El RH puede limpiar duplicados después desde /app/duplicados.
      console.warn('buscarDuplicado: no se pudo leer el índice de teléfonos:', e);
      return null;
    }
  }

  listenToCandidate(id: string, callback: (candidato: any) => void, onError?: (error: any) => void) {
    const docRef = doc(db, 'candidates', id);
    const unsubscribe = onSnapshot(docRef, (docSnap) => {
      if (docSnap.exists()) {
        callback({ id: docSnap.id, ...docSnap.data() });
      } else if (onError) {
        onError({ code: 'not-found' });
      }
    }, (error) => {
      console.error("Error al cargar el expediente:", error);
      if (onError) onError(error);
    });
    return unsubscribe;
  }
}