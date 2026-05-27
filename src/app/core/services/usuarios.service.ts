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

// Dominio interno con el que se genera el correo técnico a partir del alias.
// El usuario nunca lo ve: inicia sesión solo con su nombre de usuario.
export const DOMINIO_INTERNO = 'megatalento.app';

/** Convierte un alias en el correo técnico usado por Firebase Auth */
export function aliasAEmail(alias: string): string {
  return `${alias.trim().toLowerCase()}@${DOMINIO_INTERNO}`;
}

export interface NuevoUsuario {
  nombreCompleto: string;
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
    const username = datos.username.trim().toLowerCase();
    // El correo se genera del alias: el usuario solo necesita su nombre de usuario.
    const email = aliasAEmail(username);
    const secondaryName = 'UserCreation-' + Date.now();
    const secondaryApp = initializeApp(firebaseConfig, secondaryName);
    const secondaryAuth = getAuth(secondaryApp);

    try {
      // 1. Crear la cuenta en Firebase Auth (esto es lo crítico para poder entrar)
      const cred = await createUserWithEmailAndPassword(secondaryAuth, email, datos.password);

      // 2. Guardar el perfil en Firestore. Si las reglas lo bloquean, NO es fatal:
      //    la cuenta ya existe en Auth y el usuario puede iniciar sesión.
      try {
        await setDoc(doc(db, 'usuarios', cred.user.uid), {
          uid: cred.user.uid,
          nombre: datos.nombreCompleto.trim(),
          email,
          username,
          rol: datos.rol === 'admin' ? 'Administrador' : 'Reclutador',
          activo: true,
          createdAt: new Date()
        });
      } catch (firestoreError) {
        console.warn('Cuenta creada en Auth, pero no se pudo guardar el perfil en Firestore:', firestoreError);
      }

      await signOut(secondaryAuth).catch(() => {});
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
   * Resuelve el correo real con el que se autentica en Firebase.
   * - Si el usuario escribió un correo completo (con @), se usa tal cual.
   * - Si escribió un alias corto (username), busca su correo real en Firestore
   *   (así no importa el dominio: .com, .com.mx, gmail, etc.).
   * - Si no se encuentra, cae al dominio por defecto como último recurso.
   */
  async obtenerEmailLogin(entrada: string): Promise<string> {
    const v = entrada.trim().toLowerCase();
    if (v.includes('@')) return v; // ya escribió un correo completo

    // Si existe un perfil con ese alias y un correo distinto (cuentas antiguas
    // con correo personalizado), se respeta ese correo.
    try {
      const snap = await getDocs(query(collection(db, 'usuarios'), where('username', '==', v)));
      if (!snap.empty) {
        const perfil = snap.docs[0].data() as any;
        if (perfil.email) return perfil.email;
      }
    } catch (e) {
      console.warn('Login: no se pudo leer la tabla de usuarios:', e);
    }

    // Caso normal: el correo se deriva del alias con el dominio interno.
    return aliasAEmail(v);
  }

  /**
   * Verifica si un correo está habilitado para entrar.
   * Tolerante: si NO existe perfil en Firestore (cuentas viejas como el admin
   * original), se permite el acceso. Solo bloquea perfiles marcados activo:false.
   */
  async puedeIniciarSesion(email: string): Promise<boolean> {
    const correo = email.trim().toLowerCase();
    try {
      const snap = await getDocs(query(collection(db, 'usuarios'), where('email', '==', correo)));
      if (snap.empty) return true; // sin perfil → cuenta heredada, se permite
      const perfil = snap.docs[0].data() as any;
      return perfil.activo !== false;
    } catch {
      return true; // ante error de lectura, no bloquear
    }
  }
}
