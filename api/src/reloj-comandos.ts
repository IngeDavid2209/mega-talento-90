import { Router, Request, Response } from 'express';
import { pool } from './db';
import { requireAuth, AuthedRequest } from './auth';

/**
 * CAMBIOS EN LOS RELOJES CHECADORES — la cola entre el portal y el agente.
 *
 * El portal no alcanza los relojes (viven en la red de cada plaza). Cuando RH
 * elimina o renombra a alguien, aquí se hace el cambio EN EL SISTEMA de
 * inmediato y se deja un comando por cada reloj de la plaza; el agente local lo
 * ejecuta en su sesión con el equipo y reporta (ver api/agente/escritura.js).
 *
 * Tabla: db/reloj-comandos.sql.
 */

export const TIPOS_COMANDO = ['borrar_usuario', 'renombrar_usuario'] as const;
type TipoComando = typeof TIPOS_COMANDO[number];

/** Tras estos intentos fallidos el comando se queda en `error` y deja de reintentarse. */
const MAX_INTENTOS = 3;

/**
 * El nombre como lo acepta el reloj: ZKTeco MB360/MB160 con firmware 6.60
 * guarda 24 BYTES ASCII. Una "Ñ" o una "á" salen como basura en la pantalla
 * del equipo, así que se quitan los acentos aquí —donde RH lo ve antes de
 * confirmar— y no en silencio en el agente. 23 y no 24: se deja el cero final.
 */
export function nombreParaReloj(t: string): string {
  return String(t || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 .\-]/g, '')
    .replace(/\s+/g, ' ').trim()
    .slice(0, 23).trim();
}

const mapComando = (r: any) => ({
  id: r.id, serie: r.serie, sucursalId: r.sucursal_id, empleadoCodigo: String(r.empleado_codigo).trim(),
  tipo: r.tipo, payload: r.payload || {}, estado: r.estado, intentos: r.intentos,
  detalle: r.detalle || '', alias: r.alias || '', creadoPor: r.creado_por || '',
  creadoEn: r.creado_en, actualizadoEn: r.actualizado_en,
});

/** Los relojes a los que el agente les puede escribir en esta plaza. */
async function relojesDe(db: { query: typeof pool.query }, sucursalId: string) {
  const { rows } = await db.query(
    `SELECT serie, alias FROM relojes
      WHERE sucursal_id = $1 AND activo = TRUE AND pendiente = FALSE AND modo = 'agente'
      ORDER BY alias`, [sucursalId]);
  return rows as { serie: string; alias: string | null }[];
}

async function encolar(
  db: { query: typeof pool.query }, sucursalId: string, codigo: string,
  tipo: TipoComando, payload: any, quien: string | null,
) {
  const relojes = await relojesDe(db, sucursalId);
  const creados: any[] = [];
  for (const r of relojes) {
    // Un comando igual todavía pendiente se reemplaza: renombrar dos veces
    // seguidas no debe dejar dos escrituras compitiendo en el mismo equipo.
    await db.query(
      `UPDATE reloj_comandos SET estado = 'cancelado', detalle = 'Reemplazado por uno más nuevo', actualizado_en = now()
        WHERE serie = $1 AND sucursal_id = $2 AND empleado_codigo = $3 AND estado = 'pendiente'
          AND (tipo = $4 OR $4 = 'borrar_usuario')`,
      [r.serie, sucursalId, codigo, tipo]);
    const { rows } = await db.query(
      `INSERT INTO reloj_comandos (serie, sucursal_id, empleado_codigo, tipo, payload, creado_por)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING *`,
      [r.serie, sucursalId, codigo, tipo, JSON.stringify(payload || {}), quien]);
    creados.push(mapComando({ ...rows[0], alias: r.alias }));
  }
  return { relojes, creados };
}

// =====================================================================
// FRONT (JWT) — montado en /checador/reloj-comandos
// =====================================================================
export const relojComandosRouter = Router();
relojComandosRouter.use(requireAuth);

/**
 * GET /checador/reloj-comandos?sucursalId&codigo
 * Los relojes de la plaza y los cambios de esta persona, para la ficha.
 */
relojComandosRouter.get('/', async (req: AuthedRequest, res: Response) => {
  try {
    const { sucursalId, codigo } = req.query as any;
    if (!sucursalId) return res.status(400).json({ error: 'Falta sucursalId.' });
    const relojes = await relojesDe(pool, sucursalId);
    const params: any[] = [sucursalId];
    let filtro = '';
    if (codigo) { params.push(String(codigo).trim()); filtro = ' AND c.empleado_codigo = $2'; }
    const { rows } = await pool.query(
      `SELECT c.*, r.alias FROM reloj_comandos c LEFT JOIN relojes r ON r.serie = c.serie
        WHERE c.sucursal_id = $1${filtro}
        ORDER BY c.creado_en DESC LIMIT 50`, params);
    res.json({ relojes, comandos: rows.map(mapComando) });
  } catch (e) {
    console.error('[reloj-comandos] leer', e);
    res.status(500).json({ error: 'No se pudieron leer los cambios en relojes.' });
  }
});

/**
 * POST /checador/reloj-comandos/eliminar  { sucursalId, codigo }
 *
 * Elimina a la persona DEL SISTEMA (queda inactiva y marcada como eliminada:
 * ya no sale en ningún lado) y deja un comando de borrado para cada reloj de
 * la plaza. Todo en una transacción: o quedan las dos cosas o ninguna.
 */
relojComandosRouter.post('/eliminar', async (req: AuthedRequest, res: Response) => {
  const { sucursalId } = req.body || {};
  const codigo = String(req.body?.codigo ?? '').trim();
  if (!sucursalId || !codigo) return res.status(400).json({ error: 'Faltan sucursalId y codigo.' });
  const quien = req.usuario?.email || null;
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    // Upsert: también sirve para un código que checa SIN ficha. Sin la fila
    // inactiva, el próximo lote del reloj lo volvería a dar de alta.
    await cliente.query(
      `INSERT INTO empleados (sucursal_id, codigo_checador, nombre, activo, eliminado_en, eliminado_por)
       VALUES ($1, $2, $3, FALSE, now(), $4)
       ON CONFLICT (sucursal_id, codigo_checador)
         DO UPDATE SET activo = FALSE, eliminado_en = now(), eliminado_por = $4`,
      [sucursalId, codigo, `Empleado ${codigo}`, quien]);
    const r = await encolar(cliente, sucursalId, codigo, 'borrar_usuario', {}, quien);
    await cliente.query('COMMIT');
    res.json({ ok: true, relojes: r.relojes.length, comandos: r.creados });
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    console.error('[reloj-comandos] eliminar', e);
    res.status(500).json({ error: 'No se pudo eliminar.' });
  } finally {
    cliente.release();
  }
});

/**
 * POST /checador/reloj-comandos/renombrar  { sucursalId, codigo, nombre }
 *
 * Cambia el nombre con el que la persona está enrolada en el reloj: en el
 * padrón del sistema de inmediato, y en cada reloj de la plaza vía el agente.
 */
relojComandosRouter.post('/renombrar', async (req: AuthedRequest, res: Response) => {
  const { sucursalId } = req.body || {};
  const codigo = String(req.body?.codigo ?? '').trim();
  const nombre = nombreParaReloj(req.body?.nombre);
  if (!sucursalId || !codigo || !nombre) {
    return res.status(400).json({ error: 'Faltan sucursalId, codigo o un nombre válido.' });
  }
  const quien = req.usuario?.email || null;
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const upd = await cliente.query(
      `UPDATE empleados SET nombre = $3 WHERE sucursal_id = $1 AND codigo_checador = $2 AND eliminado_en IS NULL`,
      [sucursalId, codigo, nombre]);
    if (!upd.rowCount) {
      await cliente.query('ROLLBACK');
      return res.status(404).json({ error: 'No encontré a esa persona en el padrón de la plaza.' });
    }
    const r = await encolar(cliente, sucursalId, codigo, 'renombrar_usuario', { nombre }, quien);
    await cliente.query('COMMIT');
    res.json({ ok: true, nombre, relojes: r.relojes.length, comandos: r.creados });
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    console.error('[reloj-comandos] renombrar', e);
    res.status(500).json({ error: 'No se pudo cambiar el nombre.' });
  } finally {
    cliente.release();
  }
});

/** POST /checador/reloj-comandos/:id/cancelar — solo mientras siga pendiente. */
relojComandosRouter.post('/:id/cancelar', async (req: AuthedRequest, res: Response) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE reloj_comandos SET estado = 'cancelado', detalle = $2, actualizado_en = now()
        WHERE id = $1 AND estado = 'pendiente'`,
      [req.params.id, `Cancelado por ${req.usuario?.email || 'RH'}`]);
    if (!rowCount) return res.status(409).json({ error: 'Ya no está pendiente: el agente lo tomó o ya terminó.' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[reloj-comandos] cancelar', e);
    res.status(500).json({ error: 'No se pudo cancelar.' });
  }
});

// =====================================================================
// AGENTE (token compartido) — se monta DENTRO de ingestaRouter, que ya trae
// `requireAgente`: /checador/ingesta/comandos
// =====================================================================
export const comandosAgenteRouter = Router();

/** GET /checador/ingesta/comandos?serie — lo pendiente para ese reloj, del más viejo al más nuevo. */
comandosAgenteRouter.get('/', async (req: Request, res: Response) => {
  try {
    const serie = String((req.query as any).serie || '').trim();
    if (!serie) return res.status(400).json({ error: 'Falta serie.' });
    const { rows } = await pool.query(
      `SELECT * FROM reloj_comandos WHERE serie = $1 AND estado = 'pendiente'
        ORDER BY creado_en LIMIT 20`, [serie]);
    res.json(rows.map(mapComando));
  } catch (e) {
    console.error('[reloj-comandos] agente leer', e);
    res.status(500).json({ error: 'No se pudieron leer los comandos.' });
  }
});

/**
 * POST /checador/ingesta/comandos/:id  { estado: 'hecho'|'error', detalle, respaldo? }
 * Un error se reintenta hasta MAX_INTENTOS; después se queda en `error` a la vista.
 */
comandosAgenteRouter.post('/:id', async (req: Request, res: Response) => {
  try {
    const { estado, detalle, respaldo } = req.body || {};
    if (estado !== 'hecho' && estado !== 'error') return res.status(400).json({ error: 'estado inválido' });
    await pool.query(
      `UPDATE reloj_comandos
          SET intentos = intentos + 1,
              estado = CASE WHEN $2 = 'hecho' THEN 'hecho'
                            WHEN intentos + 1 >= $5 THEN 'error' ELSE 'pendiente' END,
              detalle = $3,
              respaldo = COALESCE($4::jsonb, respaldo),
              actualizado_en = now()
        WHERE id = $1 AND estado = 'pendiente'`,
      [req.params.id, estado, String(detalle || '').slice(0, 500),
       respaldo ? JSON.stringify(respaldo) : null, MAX_INTENTOS]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[reloj-comandos] agente reportar', e);
    res.status(500).json({ error: 'No se pudo guardar el resultado.' });
  }
});
