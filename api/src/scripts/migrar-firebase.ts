import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';
import { pool } from '../db';

/**
 * Migración de datos Firebase (Firestore) → Postgres.
 *   - candidates → candidatos (cruza por portal_candidate_id; idempotente)
 *   - puestos    → puestos (recarga completa)
 *   - usuarios   → usuarios (solo los que no existan; sin contraseña, se setea aparte)
 *
 * Uso:
 *   FIREBASE_KEY="ruta/al/serviceAccount.json" DATABASE_URL="..." npm run migrar:dry
 *   FIREBASE_KEY="..." DATABASE_URL="..." npm run migrar
 */
const KEY = process.env.FIREBASE_KEY || '';
const DRY = process.argv.includes('--dry');

/** Convierte Timestamps de Firestore a ISO recursivamente. */
function limpiar(v: any): any {
  if (v === null || v === undefined) return v;
  if (typeof v?.toDate === 'function') return v.toDate().toISOString();
  if (Array.isArray(v)) return v.map(limpiar);
  if (typeof v === 'object') {
    const o: any = {};
    for (const k of Object.keys(v)) o[k] = limpiar(v[k]);
    return o;
  }
  return v;
}

const js = (v: any) => (v === undefined || v === null ? null : JSON.stringify(v));

async function main() {
  if (!KEY) { console.error('Falta FIREBASE_KEY (ruta al service account).'); process.exit(1); }
  const sa = JSON.parse(readFileSync(KEY, 'utf8'));
  initializeApp({ credential: cert(sa) });
  const fs = getFirestore();

  const [cand, puestos, usuarios] = await Promise.all([
    fs.collection('candidates').get(),
    fs.collection('puestos').get(),
    fs.collection('usuarios').get()
  ]);
  console.log(`Firestore → candidates: ${cand.size}, puestos: ${puestos.size}, usuarios: ${usuarios.size}`);
  if (DRY) { console.log('(dry run: no se escribió nada)'); await pool.end(); return; }

  // ---------------- CANDIDATOS ----------------
  let insertados = 0, actualizados = 0;
  for (const doc of cand.docs) {
    const d = limpiar(doc.data() || {});
    const fid = doc.id;
    const vals = {
      nombre: d.nombre ?? null,
      telefono: d.telefono != null ? String(d.telefono) : null,
      ciudad: d.ciudad ?? null,
      puesto: d.puesto ?? null,
      status: d.status ?? null,
      fuente: d.fuente ?? null,
      cvUrl: d.cvUrl ?? null,
      cvRev: d.cvUrlReverso ?? null,
      cvFmt: d.cvFormato ?? null,
      lic: d.licenciaUrl ?? null,
      sol: js(d.solicitudElectronica),
      rub: js(d.rubricaAptitudes),
      apt: js(d.aptitudesEval),
      origen: d.origen ?? null,
      ua: d.ultimaActividad ?? null,
      del: d.deletedAt ?? null,
      data: JSON.stringify(d)
    };
    const tel = (vals.telefono || '').replace(/\D/g, '');
    // Cruzar primero por portal_candidate_id; si no, por teléfono (evita chocar
    // con el UNIQUE de teléfono cuando el bot ya tenía a esa persona sin ligar).
    let match = await pool.query('SELECT id FROM candidatos WHERE portal_candidate_id=$1 LIMIT 1', [fid]);
    if (!match.rows.length && tel.length >= 10) {
      match = await pool.query(
        `SELECT id FROM candidatos WHERE regexp_replace(coalesce(telefono,''),'[^0-9]','','g')=$1 LIMIT 1`, [tel]
      );
    }
    if (match.rows.length) {
      // No se toca el teléfono de la fila emparejada (evita chocar con el UNIQUE);
      // solo se agregan los campos del portal.
      await pool.query(
        `UPDATE candidatos SET
           portal_candidate_id = $2,
           portal_data = coalesce(portal_data,'{}'::jsonb) || $3::jsonb,
           nombre_completo = coalesce($4, nombre_completo),
           ciudad_sucursal = coalesce($5, ciudad_sucursal),
           puesto_interes  = coalesce($6, puesto_interes),
           portal_status = $7, fuente = $8, cv_url = $9, cv_url_reverso = $10,
           cv_formato = $11, licencia_url = $12,
           solicitud_electronica = $13::jsonb, rubrica_aptitudes = $14::jsonb, aptitudes_eval = $15::jsonb,
           origen = coalesce($16, origen), ultima_actividad = $17::timestamptz, deleted_at = $18::timestamptz
         WHERE id = $1`,
        [match.rows[0].id, fid, vals.data, vals.nombre, vals.ciudad, vals.puesto, vals.status,
         vals.fuente, vals.cvUrl, vals.cvRev, vals.cvFmt, vals.lic, vals.sol, vals.rub, vals.apt, vals.origen, vals.ua, vals.del]
      );
      actualizados++;
    } else {
      // Teléfono único: si por alguna razón choca (dupe sin teléfono, o carrera),
      // actualiza esa fila en vez de reventar.
      const telIns = (vals.telefono && vals.telefono.trim()) ? vals.telefono : `sin-tel-${fid}`;
      await pool.query(
        `INSERT INTO candidatos
          (telefono, estado, semaforo, nombre_completo, ciudad_sucursal, puesto_interes,
           portal_candidate_id, portal_status, fuente, cv_url, cv_url_reverso, cv_formato, licencia_url,
           solicitud_electronica, rubrica_aptitudes, aptitudes_eval, origen, portal_data,
           documentos, documentos_solicitados, creado_en, ultima_interaccion, ultima_actividad, deleted_at)
         VALUES ($1,'portal','verde',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16::jsonb,
                 '{}'::jsonb,'{}'::jsonb, coalesce($17::timestamptz, now()), now(), $18::timestamptz, $19::timestamptz)
         ON CONFLICT (telefono) DO UPDATE SET
           portal_candidate_id = EXCLUDED.portal_candidate_id,
           nombre_completo = EXCLUDED.nombre_completo,
           ciudad_sucursal = EXCLUDED.ciudad_sucursal,
           puesto_interes  = EXCLUDED.puesto_interes,
           portal_status = EXCLUDED.portal_status, fuente = EXCLUDED.fuente,
           cv_url = EXCLUDED.cv_url, cv_url_reverso = EXCLUDED.cv_url_reverso,
           cv_formato = EXCLUDED.cv_formato, licencia_url = EXCLUDED.licencia_url,
           solicitud_electronica = EXCLUDED.solicitud_electronica,
           rubrica_aptitudes = EXCLUDED.rubrica_aptitudes, aptitudes_eval = EXCLUDED.aptitudes_eval,
           origen = EXCLUDED.origen,
           portal_data = coalesce(candidatos.portal_data,'{}'::jsonb) || EXCLUDED.portal_data,
           ultima_actividad = EXCLUDED.ultima_actividad, deleted_at = EXCLUDED.deleted_at`,
        [telIns, vals.nombre, vals.ciudad, vals.puesto, fid, vals.status, vals.fuente,
         vals.cvUrl, vals.cvRev, vals.cvFmt, vals.lic, vals.sol, vals.rub, vals.apt, vals.origen, vals.data,
         (d.createdAt ?? null), vals.ua, vals.del]
      );
      insertados++;
    }
  }
  console.log(`Candidatos → nuevos: ${insertados}, actualizados (ligados al bot): ${actualizados}`);

  // ---------------- PUESTOS (recarga) ----------------
  await pool.query('DELETE FROM puestos');
  let np = 0;
  for (const doc of puestos.docs) {
    const d = limpiar(doc.data() || {});
    const extra: any = {};
    if (d.aptitudes !== undefined) extra.aptitudes = d.aptitudes;
    if (d.tipoAptitud !== undefined) extra.tipoAptitud = d.tipoAptitud;
    await pool.query(
      `INSERT INTO puestos (nombre, descripcion, sucursal_ids, sucursales, sueldo, horario, requisitos,
         imagen_url, area, activo, orden, hoja_competencias, extra, creado_en)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb, coalesce($14::timestamptz, now()))`,
      [d.nombre || '', d.descripcion || null, Array.isArray(d.sucursalIds) ? d.sucursalIds : null,
       d.sucursales || null, d.sueldo || null, d.horario || null, d.requisitos || null, d.imagenUrl || null,
       d.area || null, d.activo !== false, typeof d.orden === 'number' ? d.orden : 999,
       d.hojaCompetencias || null, JSON.stringify(extra), (d.createdAt ?? null)]
    );
    np++;
  }
  console.log(`Puestos → cargados: ${np}`);

  // ---------------- USUARIOS (solo nuevos, sin contraseña) ----------------
  let nu = 0, om = 0;
  for (const doc of usuarios.docs) {
    const d = doc.data() || {};
    const correo = (d.email || '').trim().toLowerCase();
    const username = (d.username || '').trim().toLowerCase();
    if (!correo && !username) { om++; continue; }
    const ya = await pool.query(
      'SELECT uid FROM usuarios WHERE lower(correo)=$1 OR lower(username)=$2 LIMIT 1',
      [correo, username]
    );
    if (ya.rows.length) { om++; continue; }
    await pool.query(
      `INSERT INTO usuarios (uid, correo, username, password_hash, nombre, apellido, role, activo, fecha_creacion)
       VALUES (gen_random_uuid(), $1, $2, '', $3, '', $4, $5, now())`,
      [correo || `${username}@megatalento.app`, username || correo, d.nombre || username || correo,
       d.rol || 'Reclutador', d.activo !== false]
    );
    nu++;
  }
  console.log(`Usuarios → nuevos (sin contraseña, requieren reset): ${nu}, omitidos (ya existían): ${om}`);

  await pool.end();
  console.log('✔ Migración completa.');
}

main().catch((e) => { console.error('migrar-firebase error:', e); process.exit(1); });
