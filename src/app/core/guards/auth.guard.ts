import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

export const authGuard: CanActivateFn = (route, state) => {
  const router = inject(Router);
  
  // Revisamos si el navegador tiene el "gafete" de RH
  // (Después conectaremos esto con Firebase Auth real)
  const isLogged = localStorage.getItem('rh_logged') === 'true';

  if (isLogged) {
    return true; // ¡Adelante, pásale!
  } else {
    console.warn('¡Intruso detectado! Redirigiendo a la puerta principal...');
    router.navigate(['/login']); // Lo patea de regreso al login
    return false;
  }
};