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

// ── Fase 2b: código para que el jefe justifique por WhatsApp ──
const ALFABETO_CODIGO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin O/0/I/1
function generarCodigo(): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += ALFABETO_CODIGO[Math.floor(Math.random() * ALFABETO_CODIGO.length)];
  return s;
}

/** Devuelve el código de la alerta; si no tiene, le asigna uno y lo guarda. */
export async function asegurarCodigo(id: string): Promise<string> {
  const cur = await pool.query('SELECT codigo FROM asistencia_alertas WHERE id=$1', [id]);
  if (cur.rows[0]?.codigo) return cur.rows[0].codigo;
  for (let i = 0; i < 5; i++) {
    const codigo = generarCodigo();
    const r = await pool.query(
      'UPDATE asistencia_alertas SET codigo=$2 WHERE id=$1 AND codigo IS NULL RETURNING codigo', [id, codigo]
    );
    if (r.rows[0]) return r.rows[0].codigo;
    const again = await pool.query('SELECT codigo FROM asistencia_alertas WHERE id=$1', [id]);
    if (again.rows[0]?.codigo) return again.rows[0].codigo;
  }
  throw new Error('No se pudo asignar código a la alerta.');
}

/**
 * Guarda la justificación que el JEFE mandó por WhatsApp (identificada por el
 * código del aviso). Elige la alerta con ese código que aún no tiene respuesta
 * (o la más reciente). Devuelve la alerta actualizada o null si el código no existe.
 */
export async function justificarPorCodigo(codigo: string, justificacion: string, quien: string) {
  const { rows } = await pool.query(
    `UPDATE asistencia_alertas
        SET justificacion_jefe=$2, respondido_por=$3, respondido_en=now()
      WHERE id = (
        SELECT id FROM asistencia_alertas
         WHERE upper(codigo)=upper($1)
         ORDER BY (justificacion_jefe IS NULL) DESC, analizado_en DESC
         LIMIT 1
      )
      RETURNING *`,
    [codigo, justificacion, quien]
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

// ══════════════════════════════════════════════════════════════════
// LA COLA AGRUPADA POR CAUSA
//
// Al 30/07/2026 hay 2,510 borradores esperando a RH, y son de solo dos reglas:
// `entrada_sin_salida` (1,397) y `checada_duplicada` (1,113). Pedirle a alguien
// que apruebe o rechace 2,510 tarjetas, una por una, garantiza que no lo haga
// nunca — y no hace falta: **esas dos reglas no describen 2,510 decisiones, sino
// un puñado de causas**.
//
//   · checada_duplicada = el lector leyó el dedo dos veces. Es del APARATO. La
//     decisión es por sucursal ("este lector duplica"), no por día.
//   · entrada_sin_salida = alguien no marca al salir. Es de la PERSONA (o de su
//     rutina), y está concentrado: en Zamora Canindo, 9 de las 11 personas
//     crónicas. La decisión es por persona.
//
// Así que se agrupa por regla + sucursal + persona: 2,510 tarjetas se vuelven
// unas decenas de líneas, cada una con su cuenta y su rango de fechas.
// ══════════════════════════════════════════════════════════════════

export interface GrupoAlertas {
  regla: string;
  sucursalId: string;
  /** Vacío cuando el nivel es 'sucursal': la línea cubre a toda la plaza. */
  empleadoCodigo: string;
  empleadoNombre: string;
  /** Cuántas personas distintas cubre la línea (1 en el nivel 'persona'). */
  personas?: number;
  total: number;
  primeraFecha: string;
  ultimaFecha: string;
  /** Cuántas ya tienen la justificación del jefe (no hay que volver a preguntar). */
  conJustificacion: number;
}

/**
 * Agrupa los borradores pendientes. `estado` por omisión es 'sugerida_ia': lo
 * que espera decisión. Sin `sucursalId` agrupa todas las plazas.
 */
export async function agruparAlertas(filtros: {
  sucursalId?: string; desde?: string; hasta?: string; estado?: string;
  /**
   * A qué nivel agrupar, y no es un detalle: cambia de qué es la decisión.
   *   'persona'  (default) — regla + sucursal + persona. 2,510 alertas dan 339
   *              líneas: es el nivel correcto para `entrada_sin_salida`, que es
   *              la rutina de alguien en concreto.
   *   'sucursal' — regla + sucursal. Da ~16 líneas, y es el nivel correcto para
   *              `checada_duplicada`: si el lector de una plaza lee doble, no es
   *              una decisión por cada una de sus 47 personas.
   */
  nivel?: 'persona' | 'sucursal';
} = {}): Promise<{ grupos: GrupoAlertas[]; porRegla: Record<string, number>; total: number; nivel: string; personas?: number }> {
  const params: any[] = [filtros.estado || 'sugerida_ia'];
  const conds: string[] = ['estado = $1'];
  if (filtros.sucursalId) { params.push(filtros.sucursalId); conds.push(`sucursal_id = $${params.length}`); }
  if (filtros.desde) { params.push(filtros.desde); conds.push(`fecha >= $${params.length}`); }
  if (filtros.hasta) { params.push(filtros.hasta); conds.push(`fecha <= $${params.length}`); }

  const porSucursal = filtros.nivel === 'sucursal';
  const { rows } = await pool.query(
    `SELECT regla, sucursal_id,
            ${porSucursal ? "'' AS empleado_codigo" : 'empleado_codigo'},
            ${porSucursal
              ? "count(DISTINCT btrim(empleado_codigo))::int || ' persona(s)' AS empleado_nombre"
              : 'max(empleado_nombre) AS empleado_nombre'},
            count(DISTINCT btrim(empleado_codigo))::int AS personas,
            count(*)::int AS total,
            min(fecha)::text AS primera,
            max(fecha)::text AS ultima,
            count(*) FILTER (WHERE justificacion_jefe IS NOT NULL)::int AS con_justificacion
       FROM asistencia_alertas
      WHERE ${conds.join(' AND ')}
      GROUP BY regla, sucursal_id${porSucursal ? '' : ', empleado_codigo'}
      ORDER BY count(*) DESC`,
    params
  );

  const grupos: GrupoAlertas[] = rows.map((r) => ({
    regla: r.regla,
    sucursalId: r.sucursal_id,
    empleadoCodigo: String(r.empleado_codigo || '').trim(),
    empleadoNombre: r.empleado_nombre || '',
    personas: r.personas,
    total: r.total,
    primeraFecha: r.primera,
    ultimaFecha: r.ultima,
    conJustificacion: r.con_justificacion,
  }));

  const porRegla: Record<string, number> = {};
  for (const g of grupos) porRegla[g.regla] = (porRegla[g.regla] || 0) + g.total;

  return {
    grupos, porRegla,
    total: grupos.reduce((s, g) => s + g.total, 0),
    nivel: porSucursal ? 'sucursal' : 'persona',
  };
}

/**
 * Decide un GRUPO completo de una vez.
 *
 * A propósito NO admite 'aprobada'. Aprobar dispara el aviso por WhatsApp al
 * jefe de la sucursal: aprobar un grupo de 400 mandaría 400 mensajes a una
 * persona real. Aprobar sigue siendo de una en una, donde se ve a quién se le
 * avisa. En bloque solo se puede **rechazar** (no es una inconsistencia real) o
 * **descartar** (es real, pero no se va a perseguir: el lector duplica lecturas).
 *
 * Solo toca las que siguen en 'sugerida_ia': jamás pisa una decisión humana ya
 * tomada, ni siquiera con el mismo filtro corriendo dos veces.
 */
export async function decidirGrupo(args: {
  regla: string; sucursalId: string; empleadoCodigo?: string;
  desde?: string; hasta?: string;
  estado: 'rechazada' | 'descartada';
  decididoPor: string; justificacion?: string;
}): Promise<{ afectadas: number }> {
  if (args.estado !== 'rechazada' && args.estado !== 'descartada') {
    throw new Error('En bloque solo se puede rechazar o descartar; aprobar es de una en una porque avisa al jefe.');
  }
  const params: any[] = [args.estado, args.decididoPor, args.regla, args.sucursalId];
  const sets = ['estado=$1', 'decidido_por=$2', 'decidido_en=now()'];
  const conds = ["estado='sugerida_ia'", 'regla=$3', 'sucursal_id=$4'];
  if (args.empleadoCodigo) { params.push(args.empleadoCodigo); conds.push(`btrim(empleado_codigo)=btrim($${params.length})`); }
  if (args.desde) { params.push(args.desde); conds.push(`fecha >= $${params.length}`); }
  if (args.hasta) { params.push(args.hasta); conds.push(`fecha <= $${params.length}`); }
  if (args.justificacion) {
    params.push(args.justificacion);
    sets.push(`justificacion_sugerida=$${params.length}`);
  }

  const { rowCount } = await pool.query(
    `UPDATE asistencia_alertas SET ${sets.join(', ')} WHERE ${conds.join(' AND ')}`, params
  );
  return { afectadas: rowCount || 0 };
}
