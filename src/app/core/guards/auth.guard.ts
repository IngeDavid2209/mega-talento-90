import { inject } from '@angular/core';
import { Router, CanActivateFn } from '@angular/router';
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, onAuthStateChanged } from 'firebase/auth';

// Usar la MISMA instancia de Firebase que los servicios (candidate, puestos,
// usuarios). Si usáramos @angular/fire/auth, las sesiones quedarían en otra
// instancia y las reglas de Firestore evaluarían request.auth como null.
const firebaseConfig = {
  apiKey: "AIzaSyCZ2ADjjBFWgwPybDxwFSUg_lzWDO_Y5lI",
  authDomain: "megatalento-a3450.firebaseapp.com",
  projectId: "megatalento-a3450",
  storageBucket: "megatalento-a3450.firebasestorage.app",
  messagingSenderId: "794979076803",
  appId: "1:794979076803:web:034f492c57852ad3c3b076"
};
const _app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const _auth = getAuth(_app);

export const authGuard: CanActivateFn = (route, state) => {
  const router = inject(Router);

  // Devolvemos una promesa que se resuelve cuando Firebase reporta el estado
  // de autenticación. Si onAuthStateChanged tarda en cargar (primera carga
  // tras un refresh), el guard espera hasta que tenga la respuesta real.
  return new Promise<boolean>((resolve) => {
    const unsubscribe = onAuthStateChanged(_auth, (user) => {
      unsubscribe();
      if (user) {
        resolve(true);
      } else {
        router.navigate(['/login']);
        resolve(false);
      }
    });
  });
};
