import { inject } from '@angular/core';
import { Router, CanActivateFn } from '@angular/router';
import { AuthSession } from '../services/auth-session';

/**
 * Guard de sesión (JWT). Antes validaba la sesión de Firebase; ahora comprueba
 * que exista un token en el almacenamiento local. Si no hay, manda al login.
 */
export const authGuard: CanActivateFn = () => {
  const router = inject(Router);
  const sesion = inject(AuthSession);
  if (sesion.estaLogueado()) return true;
  router.navigate(['/login']);
  return false;
};
