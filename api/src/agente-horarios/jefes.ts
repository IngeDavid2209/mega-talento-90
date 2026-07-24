import { pool } from '../db';

/**
 * Jefe responsable por SUCURSAL: a quién se le avisa por WhatsApp cuando RH
 * aprueba una alerta. Modelo simple (1 por sucursal). El teléfono lo captura RH.
 */
export interface JefeSucursal {
  sucursalId: string;
  nombre: string;
  telefono: string;
  activo: boolean;
}

const mapJefe = (r: any): JefeSucursal => ({
  sucursalId: r.sucursal_id, nombre: r.nombre || '', telefono: r.telefono || '', activo: r.activo !== false,
});

export async function getJefe(sucursalId: string): Promise<JefeSucursal | null> {
  const { rows } = await pool.query('SELECT * FROM jefes_sucursal WHERE sucursal_id=$1', [sucursalId]);
  return rows[0] ? mapJefe(rows[0]) : null;
}

export async function listarJefes(): Promise<JefeSucursal[]> {
  const { rows } = await pool.query('SELECT * FROM jefes_sucursal ORDER BY sucursal_id');
  return rows.map(mapJefe);
}

export async function upsertJefe(j: { sucursalId: string; nombre?: string; telefono?: string; activo?: boolean }): Promise<JefeSucursal> {
  const { rows } = await pool.query(
    `INSERT INTO jefes_sucursal (sucursal_id, nombre, telefono, activo, actualizado_en)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (sucursal_id) DO UPDATE SET
       nombre=EXCLUDED.nombre, telefono=EXCLUDED.telefono, activo=EXCLUDED.activo, actualizado_en=now()
     RETURNING *`,
    [j.sucursalId, j.nombre || null, j.telefono || null, j.activo !== false]
  );
  return mapJefe(rows[0]);
}
