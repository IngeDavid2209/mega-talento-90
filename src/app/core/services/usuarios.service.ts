import { Injectable } from '@angular/core';
import { initializeApp, getApps, getApp, deleteApp } from 'firebase/app';
import {
  getFirestore, collection, doc, setDoc, updateDoc, onSnapshot, getDocs, query, where
} from 'firebase/firestore';
import { getAuth, createUserWithEmailAndPassword, signOut } from 'firebase/auth';

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

export interface NuevoUsuario {
  nombreCompleto: string;
  email: string;
  username: string;
  rol: string;       // 'reclutador' | 'admin'
  password: string;
}

@Injectable({ providedIn: 'root' })
export class UsuariosService {

  /**
   * Crea un usuario REAL en Firebase Auth + guarda su perfil en Firestore.
   * Usa una instancia secundaria de Firebase para NO cerrar la sesión del
   * administrador que está creando la cuenta (createUserWithEmailAndPassword
   * inicia sesión automáticamente con el nuevo usuario en la instancia donde corre).
   */
  async crearUsuario(datos: NuevoUsuario): Promise<void> {
    const email = datos.email.trim().toLowerCase();
    const secondaryName = 'UserCreation-' + Date.now();
    const secondaryApp = initializeApp(firebaseConfig, secondaryName);
    const secondaryAuth = getAuth(secondaryApp);

    try {
      const cred = await createUserWithEmailAndPassword(secondaryAuth, email, datos.password);

      await setDoc(doc(db, 'usuarios', cred.user.uid), {
        uid: cred.user.uid,
        nombre: datos.nombreCompleto.trim(),
        email,
        username: datos.username.trim().toLowerCase(),
        rol: datos.rol === 'admin' ? 'Administrador' : 'Reclutador',
        activo: true,
        createdAt: new Date()
      });

      await signOut(secondaryAuth);
    } finally {
      // Limpiar la instancia secundaria siempre
      await deleteApp(secondaryApp).catch(() => {});
    }
  }

  /** Escucha la lista de usuarios en tiempo real */
  listarUsuarios(callback: (usuarios: any[]) => void) {
    const ref = collection(db, 'usuarios');
    return onSnapshot(ref, (snap) => {
      const lista = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      callback(lista);
    }, (error) => console.error('Error al listar usuarios:', error));
  }

  /** Desactiva un usuario (revoca su acceso sin borrar el registro de auditoría) */
  async desactivarUsuario(uid: string): Promise<void> {
    await updateDoc(doc(db, 'usuarios', uid), { activo: false, desactivadoAt: new Date() });
  }

  /** Reactiva un usuario previamente desactivado */
  async reactivarUsuario(uid: string): Promise<void> {
    await updateDoc(doc(db, 'usuarios', uid), { activo: true });
  }

  /**
   * Verifica si un correo está habilitado para entrar.
   * Tolerante: si NO existe perfil en Firestore (cuentas viejas como el admin
   * original), se permite el acceso. Solo bloquea perfiles marcados activo:false.
   */
  async puedeIniciarSesion(email: string): Promise<boolean> {
    const correo = email.trim().toLowerCase();
    const snap = await getDocs(query(collection(db, 'usuarios'), where('email', '==', correo)));
    if (snap.empty) return true; // sin perfil → cuenta heredada, se permite
    const perfil = snap.docs[0].data() as any;
    return perfil.activo !== false;
  }
}
