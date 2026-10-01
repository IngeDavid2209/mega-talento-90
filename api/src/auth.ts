import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from './db';
import { env } from './env';

export const authRouter = Router();

export interface UsuarioToken {
  sub: string;
  email: string;
  rol: string;
}

export interface AuthedRequest extends Request {
  usuario?: UsuarioToken;
}

/**
 * POST /auth/login — valida credenciales y devuelve un JWT.
 * Reusa la tabla `usuarios` existente (la del bot): columnas
 * uid / correo / username / password_hash / nombre / apellido / role.
 * Acepta iniciar sesión con el correo O el username.
 */
authRouter.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body || {};
  const identificador = (email || '').trim();
  if (!identificador || !password) {
    return res.status(400).json({ error: 'Correo/usuario y contraseña son obligatorios.' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT uid, correo, username, nombre, apellido, role, password_hash, activo
       FROM usuarios
       WHERE lower(correo) = lower($1) OR lower(username) = lower($1)
       LIMIT 1`,
      [identificador]
    );
    const u = rows[0];
    if (!u || !u.password_hash) {
      return res.status(401).json({ error: 'Credenciales inválidas.' });
    }
    if (u.activo === false) {
      return res.status(403).json({ error: 'Tu cuenta fue desactivada. Contacta al administrador.' });
    }
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Credenciales inválidas.' });
    }
    const token = jwt.sign(
      { sub: u.uid, email: u.correo, rol: u.role } as UsuarioToken,
      env.JWT_SECRET,
      { expiresIn: '12h' }
    );
    return res.json({
      token,
      usuario: {
        id: u.uid,
        email: u.correo,
        username: u.username,
        nombre: [u.nombre, u.apellido].filter(Boolean).join(' ').trim() || u.username,
        rol: u.role
      }
    });
  } catch (e) {
    console.error('[auth] Error en login:', e);
    return res.status(500).json({ error: 'Error interno al iniciar sesión.' });
  }
});

/** Middleware: exige un Bearer token válido. */
export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) {
    return res.status(401).json({ error: 'No autenticado.' });
  }
  try {
    req.usuario = jwt.verify(token, env.JWT_SECRET) as UsuarioToken;
    return next();
  } catch {
    return res.status(401).json({ error: 'Sesión inválida o expirada.' });
  }
}

/**
 * ¿El usuario del token es administrador? La base guarda el rol en dos
 * escrituras (`admin` y `Administrador`), así que se compara por prefijo.
 */
export function esAdminReq(req: AuthedRequest): boolean {
  return String(req.usuario?.rol || '').toLowerCase().startsWith('admin');
}

/** Quién firma un paso: el correo del token (o su id si no trae correo). */
export function quienReq(req: AuthedRequest): string {
  return req.usuario?.email || req.usuario?.sub || 'desconocido';
}

/** GET /auth/me — datos del usuario del token. */
authRouter.get('/me', requireAuth, (req: AuthedRequest, res: Response) => {
  return res.json({ usuario: req.usuario });
});
