import bcrypt from 'bcryptjs';
import { randomInt } from 'crypto';
import { pool } from '../db';

/** Pone una contraseña temporal a los usuarios que no tienen (password_hash=''). */
async function main() {
  const objetivo = ['tania.solorio', 'lic.omar', 'lupita.macias', 'lesly.berber'];
  console.log('Usuario                | Contraseña temporal');
  console.log('-----------------------+---------------------');
  for (const username of objetivo) {
    const temp = `Mega${randomInt(1000, 9999)}!`;
    const hash = await bcrypt.hash(temp, 10);
    const r = await pool.query(
      'UPDATE usuarios SET password_hash=$2 WHERE lower(username)=lower($1) RETURNING username',
      [username, hash]
    );
    if (r.rows.length) console.log(`${username.padEnd(22)} | ${temp}`);
    else console.log(`${username.padEnd(22)} | (no encontrado)`);
  }
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
