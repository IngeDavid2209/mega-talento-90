import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from './db';
import { requireAuth, esAdminReq, AuthedRequest } from './auth';

/**
 * Router de usuarios de RH. Reusa la tabla `usuarios` del bot
 * (uid/correo/username/password_hash/nombre/apellido/role + activo).
 * Reemplaza el alta vía Firebase Auth (instancia secundaria) por un simple
 * INSERT con contraseña hasheada. El login sigue por /auth/login.
 */
export const usuariosRouter = Router();
usuariosRouter.use(requireAuth);
// Sólo un administrador da de alta usuarios, cambia contraseñas o roles, o borra cuentas.
// Antes bastaba cualquier sesión (incluida Promotoría) para crearse un administrador.
usuariosRouter.use((req: AuthedRequest, res: Response, next) => {
  if (!esAdminReq(req)) return res.status(403).json({ error: 'Solo un administrador puede gestionar usuarios' });
  next();
});

const DOMINIO_INTERNO = 'megatalento.app';

function mapUsuario(r: any) {
  return {
    id: r.uid,
    uid: r.uid,
    nombre: [r.nombre, r.apellido].filter(Boolean).join(' ').trim() || r.username,
    email: r.correo,
    username: r.username,
    rol: r.role,
    activo: r.activo !== false
  };
}

function fallo(res: Response, e: any, msg: string) {
  console.error('[usuarios]', msg, e);
  return res.status(500).json({ error: msg });
}

/**
 * Guarda el rol con su nombre para mostrar. Ojo con esto: la tabla trae DOS
 * escrituras del mismo rol —`admin` en los usuarios sembrados a mano y
 * `Administrador` en los creados por aquí—, así que NADIE debe comparar
 * `rol === 'admin'` contra el valor crudo. El front lo normaliza al leer
 * (AuthSession.rolCanonico). Se conserva el formato de siempre para no tocar
 * las ocho filas que ya existen.
 */
const normalizaRol = (rol: string) => {
  const r = (rol || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (r.startsWith('admin')) return 'Administrador';
  if (r.startsWith('promotor')) return 'Promotoria';
  if (r.startsWith('reclut')) return 'Reclutador';
  return rol || 'Reclutador';
};

usuariosRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT * FROM usuarios ORDER BY fecha_creacion NULLS LAST, nombre');
    return res.json(rows.map(mapUsuario));
  } catch (e) { return fallo(res, e, 'Error al listar usuarios.'); }
});

usuariosRouter.post('/', async (req: Request, res: Response) => {
  try {
    const { nombreCompleto, username, rol, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Usuario y contraseña obligatorios.' });
    const user = String(username).trim().toLowerCase();
    const correo = user.includes('@') ? user : `${user}@${DOMINIO_INTERNO}`;
    const hash = await bcrypt.hash(password, 10);
    const nombre = (nombreCompleto || user).trim();
    const { rows } = await pool.query(
      `INSERT INTO usuarios (uid, correo, username, password_hash, nombre, apellido, role, activo, fecha_creacion)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, '', $5, true, now())
       RETURNING *`,
      [correo, user, hash, nombre, normalizaRol(rol)]
    );
    return res.json(mapUsuario(rows[0]));
  } catch (e: any) {
    if (e?.code === '23505') return res.status(409).json({ error: 'Ese usuario o correo ya existe.' });
    // 23514 = la fila no pasó un CHECK. Aquí solo puede ser el rol, y decirlo
    // ahorra la depuración a ciegas que costó este caso: el alta fallaba y la
    // pantalla solo ofrecía "verifica los datos", sin mencionar el rol.
    if (e?.code === '23514') {
      return res.status(400).json({
        error: `El rol "${req.body?.rol}" no está permitido en la base todavía. ` +
               'Hay que agregarlo al CHECK de usuarios.role (ver api/db/schema-portal.sql).',
      });
    }
    return fallo(res, e, 'Error al crear usuario.');
  }
});

usuariosRouter.patch('/:id', async (req: Request, res: Response) => {
  try {
    const { nombre, username, rol, password } = req.body || {};
    const sets: string[] = [];
    const params: any[] = [req.params.id];
    if (nombre !== undefined) { params.push(String(nombre).trim()); sets.push(`nombre=$${params.length}`); }
    if (username !== undefined) { params.push(String(username).trim().toLowerCase()); sets.push(`username=$${params.length}`); }
    if (rol !== undefined) { params.push(normalizaRol(rol)); sets.push(`role=$${params.length}`); }
    if (password) { params.push(await bcrypt.hash(password, 10)); sets.push(`password_hash=$${params.length}`); }
    if (!sets.length) return res.json({ ok: true });
    const { rows } = await pool.query(
      `UPDATE usuarios SET ${sets.join(', ')} WHERE uid=$1 RETURNING *`, params
    );
    if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado.' });
    return res.json(mapUsuario(rows[0]));
  } catch (e) { return fallo(res, e, 'Error al actualizar usuario.'); }
});

usuariosRouter.post('/:id/desactivar', async (req: Request, res: Response) => {
  try {
    await pool.query('UPDATE usuarios SET activo=false, desactivado_at=now() WHERE uid=$1', [req.params.id]);
    return res.json({ ok: true });
  } catch (e) { return fallo(res, e, 'Error al desactivar usuario.'); }
});

usuariosRouter.post('/:id/reactivar', async (req: Request, res: Response) => {
  try {
    await pool.query('UPDATE usuarios SET activo=true, desactivado_at=NULL WHERE uid=$1', [req.params.id]);
    return res.json({ ok: true });
  } catch (e) { return fallo(res, e, 'Error al reactivar usuario.'); }
});

usuariosRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    await pool.query('DELETE FROM usuarios WHERE uid=$1', [req.params.id]);
    return res.json({ ok: true });
  } catch (e) { return fallo(res, e, 'Error al eliminar usuario.'); }
});
