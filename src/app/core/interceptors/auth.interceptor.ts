import { inject } from '@angular/core';
import { HttpInterceptorFn, HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { AuthSession } from '../services/auth-session';
import { ToastService } from '../services/toast.service';

/**
 * Ante un 401/403 del backend (token expirado o inválido) limpia la sesión,
 * avisa una sola vez y manda al login. Evita que el usuario vea errores
 * genéricos ("No se pudieron cargar…") cuando en realidad su sesión venció.
 *
 * No actúa sobre /auth/login (ahí un 401 = credenciales malas, lo maneja la
 * pantalla de login).
 */
let redirigiendo = false;

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const router = inject(Router);
  const sesion = inject(AuthSession);
  const toast = inject(ToastService);

  return next(req).pipe(
    catchError((err: HttpErrorResponse) => {
      const esLogin = req.url.includes('/auth/login');
      if ((err.status === 401 || err.status === 403) && !esLogin && !redirigiendo) {
        redirigiendo = true;
        sesion.limpiar();
        toast.alerta('Tu sesión expiró. Vuelve a iniciar sesión.');
        router.navigate(['/login']).finally(() => { redirigiendo = false; });
      }
      return throwError(() => err);
    })
  );
};
