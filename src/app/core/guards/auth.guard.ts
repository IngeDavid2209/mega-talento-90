import { inject } from '@angular/core';
import { Router, CanActivateFn } from '@angular/router';
import { Auth, authState } from '@angular/fire/auth';
import { map, take } from 'rxjs';

export const authGuard: CanActivateFn = (route, state) => {
  const auth = inject(Auth);
  const router = inject(Router);

  // Verificamos el estado de autenticación en Firebase
  return authState(auth).pipe(
    take(1),
    map(user => {
      if (user) {
        // Tiene sesión activa, lo dejamos pasar a la ruta
        return true;
      } else {
        // No hay sesión, es un intruso. Lo mandamos al login.
        router.navigate(['/login']);
        return false;
      }
    })
  );
};