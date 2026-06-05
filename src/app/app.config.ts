import { ApplicationConfig } from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';

// NOTA: Firebase NO se inicializa aquí.
// Cada servicio (candidate.ts, puestos.service.ts, usuarios.service.ts,
// guards/auth.guard.ts, login.ts) inicializa Firebase directamente con
// `firebase/app` y `getApps().length ? getApp() : initializeApp(config)`.
// Esto evita el bug donde @angular/fire creaba una instancia separada de
// Auth, dejando request.auth como null en las reglas de Firestore.

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
  ]
};
