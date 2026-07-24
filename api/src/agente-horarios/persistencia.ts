import { pool } from '../db';
import { BorradorAlerta } from './tipos';

/**
 * Persistencia de los borradores del agente en `asistencia_alertas`.
 *
 * Idempotencia clave: el UPSERT solo refresca filas que SIGUEN en 'sugerida_ia'.
 * Si RH ya la movió a aprobada/rechazada/descartada, el `WHERE` del ON CONFLICT
 * la deja intacta → el agente NUNCA pisa una decisión humana (regla 80/20).
 */

export interface ResultadoPersistencia {
  creadas: number;
  actualizadas: number;
  sinCambio: number; // conflictos que ya estaban decididos por RH (no se tocaron)
}

export async function guardarBorradores(borradores: BorradorAlerta[]): Promise<ResultadoPersistencia> {
  if (!borradores.length) return { creadas: 0, actualizadas: 0, sinCambio: 0 };

  let creadas = 0, actualizadas = 0;
  const LOTE = 100;

  for (let i = 0; i < borradores.length; i += LOTE) {
    const grupo = borradores.slice(i, i + LOTE);
    const valores: string[] = [];
    const params: any[] = [];
    grupo.forEach((b, j) => {
      const p = j * 8;
      valores.push(`($${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6},$${p+7},$${p+8}::jsonb)`);
      params.push(
        b.sucursalId, b.empleadoCodigo, b.empleadoNombre || null, b.fecha,
        b.regla, b.severidad, b.detalle, JSON.stringify(b.evidencia || {})
      );
    });
    // `xmax = 0` distingue fila INSERTADA (true) de ACTUALIZADA (false) en el upsert.
    // Las filas que chocan pero fallan el WHERE (ya decididas) NO se devuelven.
    const sql = `
      INSERT INTO asistencia_alertas
        (sucursal_id, empleado_codigo, empleado_nombre, fecha, regla, severidad, detalle, evidencia)
      VALUES ${valores.join(',')}
      ON CONFLICT (sucursal_id, empleado_codigo, fecha, regla) DO UPDATE SET
        empleado_nombre = EXCLUDED.empleado_nombre,
        severidad       = EXCLUDED.severidad,
        detalle         = EXCLUDED.detalle,
        evidencia       = EXCLUDED.evidencia,
        analizado_en    = now()
      WHERE asistencia_alertas.estado = 'sugerida_ia'
      RETURNING (xmax = 0) AS insertada`;
    const r = await pool.query(sql, params);
    for (const row of r.rows) row.insertada ? creadas++ : actualizadas++;
  }

  // La justificación sugerida se guarda por separado para no aplastarla si RH ya
  // la editó (solo se pone cuando la fila está en 'sugerida_ia' y aún vacía).
  for (let i = 0; i < borradores.length; i += LOTE) {
    const grupo = borradores.slice(i, i + LOTE);
    for (const b of grupo) {
      await pool.query(
        `UPDATE asistencia_alertas
            SET justificacion_sugerida = $5
          WHERE sucursal_id=$1 AND empleado_codigo=$2 AND fecha=$3 AND regla=$4
            AND estado='sugerida_ia'
            AND (justificacion_sugerida IS NULL OR justificacion_sugerida = '')`,
        [b.sucursalId, b.empleadoCodigo, b.fecha, b.regla, b.justificacionSugerida || null]
      );
    }
  }

  const sinCambio = borradores.length - creadas - actualizadas;
  return { creadas, actualizadas, sinCambio: sinCambio < 0 ? 0 : sinCambio };
}

/**
 * Reconciliación: tras re-analizar un rango, borra los borradores 'sugerida_ia'
 * de ese (sucursal, rango) que YA NO se detectan (se corrigieron o eran ruido).
 * NUNCA toca las que RH ya movió a aprobada/rechazada/descartada.
 */
export async function reconciliarBorradores(
  sucursalId: string, desde: string, hasta: string, borradores: BorradorAlerta[]
): Promise<number> {
  const claves = new Set(borradores.map((b) => `${b.empleadoCodigo}|${b.fecha}|${b.regla}`));
  const { rows } = await pool.query(
    `SELECT id, empleado_codigo, fecha, regla FROM asistencia_alertas
      WHERE sucursal_id=$1 AND fecha>=$2 AND fecha<=$3 AND estado='sugerida_ia'`,
    [sucursalId, desde, hasta]
  );
  const aBorrar = rows
    .filter((r) => !claves.has(`${r.empleado_codigo}|${r.fecha}|${r.regla}`))
    .map((r) => r.id);
  for (let i = 0; i < aBorrar.length; i += 200) {
    await pool.query('DELETE FROM asistencia_alertas WHERE id = ANY($1::uuid[])', [aBorrar.slice(i, i + 200)]);
  }
  return aBorrar.length;
}

/**
 * RH resuelve una alerta: la mueve a aprobada|rechazada|descartada y registra
 * quién y cuándo. Opcionalmente edita la justificación. Este es el lado HUMANO
 * del handoff: el agente nunca llega aquí.
 */
export async function decidirAlerta(
  id: string, estado: 'aprobada' | 'rechazada' | 'descartada',
  decididoPor: string, justificacion?: string
) {
  const sets = ['estado=$2', 'decidido_por=$3', 'decidido_en=now()'];
  const params: any[] = [id, estado, decididoPor];
  if (justificacion !== undefined) {
    params.push(justificacion);
    sets.push(`justificacion_sugerida=$${params.length}`);
  }
  const { rows } = await pool.query(
    `UPDATE asistencia_alertas SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, params
  );
  return rows[0] || null;
}

/** Lista alertas (para que RH las VEA). Solo lectura. */
export async function listarAlertas(filtros: {
  sucursalId: string; desde?: string; hasta?: string; estado?: string; empleadoCodigo?: string;
}) {
  const params: any[] = [filtros.sucursalId];
  const conds: string[] = ['sucursal_id = $1'];
  if (filtros.desde) { params.push(filtros.desde); conds.push(`fecha >= $${params.length}`); }
  if (filtros.hasta) { params.push(filtros.hasta); conds.push(`fecha <= $${params.length}`); }
  if (filtros.estado) { params.push(filtros.estado); conds.push(`estado = $${params.length}`); }
  if (filtros.empleadoCodigo) { params.push(filtros.empleadoCodigo); conds.push(`empleado_codigo = $${params.length}`); }
  const { rows } = await pool.query(
    `SELECT * FROM asistencia_alertas WHERE ${conds.join(' AND ')}
      ORDER BY fecha DESC, empleado_nombre, regla`,
    params
  );
  return rows;
}
