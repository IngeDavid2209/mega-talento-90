import bcrypt from 'bcryptjs';
import { pool } from '../db';

/**
 * Crea o RESETEA la contraseña de un usuario en la tabla `usuarios` existente
 * (la del bot: uid / correo / username / password_hash / nombre / apellido / role).
 *
 * Ojo: las cuentas del bot ya existen. Esto solo es útil para dar de alta un
 * usuario nuevo de RH o resetear una contraseña olvidada.
 *
 * Uso:
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run seed:admin:dev
 */
async function main() {
  const correo = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const nombre = process.env.ADMIN_NOMBRE || 'Administrador';
  const role = process.env.ADMIN_ROLE || 'admin';

  if (!correo || !password) {
    console.error('[seed:admin] Define ADMIN_EMAIL y ADMIN_PASSWORD.');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 10);
  const existe = await pool.query('SELECT uid FROM usuarios WHERE lower(correo) = lower($1) LIMIT 1', [correo]);

  if (existe.rows.length) {
    await pool.query(
      'UPDATE usuarios SET password_hash = $2 WHERE lower(correo) = lower($1)',
      [correo, hash]
    );
    console.log('[seed:admin] Contraseña actualizada para', correo);
  } else {
    const username = correo.split('@')[0];
    await pool.query(
      `INSERT INTO usuarios (uid, correo, username, password_hash, nombre, apellido, role, fecha_creacion)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, '', $5, now())`,
      [correo, username, hash, nombre, role]
    );
    console.log('[seed:admin] Usuario creado:', correo);
  }
  await pool.end();
}

main().catch((e) => {
  console.error('[seed:admin] Falló:', e);
  process.exit(1);
});
