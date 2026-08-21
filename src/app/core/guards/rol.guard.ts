import { inject } from '@angular/core';
import { CanActivateChildFn, CanActivateFn, Router } from '@angular/router';
import { AuthSession } from '../services/auth-session';

/**
 * Cadenero por CAPACIDAD, no por rol.
 *
 * `authGuard` solo pregunta si hay sesión; hasta ahora ninguna ruta miraba QUIÉN
 * entra, así que cualquier usuario con sesión llegaba a cualquier pantalla. Esto
 * cierra las que se reparten a mano.
 *
 * Se pregunta por capacidad (`'promotoria'`) y no por rol (`'admin'`) a
 * propósito: el mapa de qué puede cada rol vive en `AuthSession` y en un solo
 * lugar. Comparar roles en cada ruta es como se llega a que un permiso quede
 * escrito de tres formas distintas.
 *
 * ⚠️ ESTO NO ES SEGURIDAD DE DATOS. Es control de navegación: esconde la sección
 * y bloquea la ruta, pero la API sigue respondiendo a cualquiera con sesión
 * válida. Para que sea hermético hay que filtrar del lado del servidor.
 */
export function rolGuard(capacidad: string): CanActivateFn {
  return () => {
    const auth = inject(AuthSession);
    const router = inject(Router);
    if (auth.puede(capacidad)) return true;
    // Se manda al panel, no al login: la sesión es válida, lo que falta es el
    // permiso. Rebotar al login haría creer que la sesión se cayó.
    router.navigate(['/app/dashboard']);
    return false;
  };
}

/**
 * Encierra a los roles ACOTADOS en su sección.
 *
 * Va en la ruta PADRE (`/app`) y no en cada hija: son treinta rutas y poner el
 * permiso en cada una es garantizar que a la treintaiuna se le olvide. Aquí
 * cualquier ruta nueva queda cerrada por omisión para esos roles, que es el
 * comportamiento que uno quiere de un permiso.
 *
 * Para los roles NO acotados (admin, reclutador) esto no hace nada: devuelve
 * true y ya. No se les cambia lo que veían.
 */
export const seccionUnicaGuard: CanActivateChildFn = (ruta) => {
  const auth = inject(AuthSession);
  const router = inject(Router);
  const solo = auth.soloSeccion();
  if (!solo) return true;

  // La ruta permitida se compara por su primer segmento: así `/app/promotoras`
  // y cualquier cosa debajo de ella pasan, y el resto no.
  const permitido = solo.ruta.split('/').filter(Boolean).pop();
  const pedido = ruta.url[0]?.path;
  if (pedido === permitido) return true;

  router.navigate([solo.ruta]);
  return false;
};
