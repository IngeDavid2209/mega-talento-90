import bcrypt from 'bcryptjs';
import { pool } from '../db';

/** Crea (o resetea) la cuenta admin del portal. */
async function main() {
  const username = process.env.U || 'admin';
  const password = process.env.P || 'admin123';
  const correo = process.env.C || 'admin@megatalento.app';
  const hash = await bcrypt.hash(password, 10);

  const ex = await pool.query(
    'SELECT uid FROM usuarios WHERE lower(username)=lower($1) OR lower(correo)=lower($2) LIMIT 1',
    [username, correo]
  );
  if (ex.rows.length) {
    await pool.query(
      "UPDATE usuarios SET password_hash=$2, role='Administrador', activo=true WHERE uid=$1",
      [ex.rows[0].uid, hash]
    );
    console.log(`Cuenta actualizada: ${username} (rol Administrador)`);
  } else {
    await pool.query(
      `INSERT INTO usuarios (uid, correo, username, password_hash, nombre, apellido, role, activo, fecha_creacion)
       VALUES (gen_random_uuid(), $1, $2, $3, 'Administrador', '', 'Administrador', true, now())`,
      [correo, username, hash]
    );
    console.log(`Cuenta creada: ${username} (rol Administrador)`);
  }
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
