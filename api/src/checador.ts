import { Router, Request, Response } from 'express';
import { pool } from './db';
import { requireAuth } from './auth';

/**
 * Router del módulo Horarios y checadas. Todo protegido con JWT.
 * Montado en /checador → /checador/areas, /checador/horarios,
 * /checador/empleados, /checador/checadas.
 *
 * El front manda/recibe camelCase; la base usa snake_case. Aquí se mapea.
 */
export const checadorRouter = Router();
checadorRouter.use(requireAuth);

// ---------- mapeadores fila DB → objeto camelCase del front ----------
const mapArea = (r: any) => ({
  id: r.id, sucursalId: r.sucursal_id, nombre: r.nombre,
  ipChecador: r.ip_checador || '', deviceId: r.device_id || '', activo: r.activo
});
const mapHorario = (r: any) => ({
  id: r.id, sucursalId: r.sucursal_id, areaId: r.area_id || '', nombre: r.nombre,
  dias: r.dias || [], entrada: r.entrada, inicioComida: r.inicio_comida || '',
  finComida: r.fin_comida || '', salida: r.salida, toleranciaMin: r.tolerancia_min, activo: r.activo
});
const mapEmpleado = (r: any) => ({
  id: r.id, sucursalId: r.sucursal_id, codigoChecador: r.codigo_checador,
  nombre: r.nombre, puesto: r.puesto || '', fotoUrl: r.foto_url || '',
  horarioId: r.horario_id || '', activo: r.activo,
  // Promotora = no es personal de piso y no se mide con la vara de asistencia
  // de la sucursal. Ver api/db/schema.sql y el filtro en agente-horarios/.
  esPromotora: r.es_promotora === true
});
const mapChecada = (r: any) => ({
  id: r.id, sucursalId: r.sucursal_id, areaId: r.area_id || undefined,
  deviceId: r.device_id || undefined, empleadoCodigo: r.empleado_codigo,
  empleadoNombre: r.empleado_nombre || undefined, fechaHora: r.fecha_hora,
  fecha: r.fecha, hora: r.hora, tipo: r.tipo ?? undefined, dedupKey: r.dedup_key
});
const mapRevision = (r: any) => ({
  id: r.id, sucursalId: r.sucursal_id, empleadoCodigo: r.empleado_codigo,
  fecha: r.fecha, justificacion: r.justificacion || '', estado: r.estado || 'pendiente'
});

function fallo(res: Response, e: any, msg: string) {
  console.error('[checador]', msg, e);
  return res.status(500).json({ error: msg });
}

// ===================== ÁREAS =====================
checadorRouter.get('/areas', async (req: Request, res: Response) => {
  try {
    const { sucursalId } = req.query as any;
    const { rows } = sucursalId
      ? await pool.query('SELECT * FROM areas_checador WHERE sucursal_id=$1 ORDER BY nombre', [sucursalId])
      : await pool.query('SELECT * FROM areas_checador ORDER BY nombre');
    res.json(rows.map(mapArea));
  } catch (e) { fallo(res, e, 'No se pudieron leer las áreas.'); }
});

checadorRouter.post('/areas', async (req: Request, res: Response) => {
  try {
    const a = req.body || {};
    const { rows } = await pool.query(
      `INSERT INTO areas_checador (sucursal_id, nombre, ip_checador, device_id, activo)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [a.sucursalId, a.nombre, a.ipChecador || null, a.deviceId || null, a.activo !== false]
    );
    res.json(mapArea(rows[0]));
  } catch (e) { fallo(res, e, 'No se pudo crear el área.'); }
});

checadorRouter.put('/areas/:id', async (req: Request, res: Response) => {
  try {
    const a = req.body || {};
    const { rows } = await pool.query(
      `UPDATE areas_checador SET sucursal_id=$2, nombre=$3, ip_checador=$4, device_id=$5, activo=$6
       WHERE id=$1 RETURNING *`,
      [req.params.id, a.sucursalId, a.nombre, a.ipChecador || null, a.deviceId || null, a.activo !== false]
    );
    if (!rows.length) return res.status(404).json({ error: 'Área no encontrada.' });
    res.json(mapArea(rows[0]));
  } catch (e) { fallo(res, e, 'No se pudo actualizar el área.'); }
});

checadorRouter.delete('/areas/:id', async (req: Request, res: Response) => {
  try {
    await pool.query('DELETE FROM areas_checador WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { fallo(res, e, 'No se pudo eliminar el área.'); }
});

// ===================== HORARIOS =====================
checadorRouter.get('/horarios', async (req: Request, res: Response) => {
  try {
    const { sucursalId } = req.query as any;
    const { rows } = sucursalId
      ? await pool.query('SELECT * FROM horarios_sucursal WHERE sucursal_id=$1 ORDER BY nombre', [sucursalId])
      : await pool.query('SELECT * FROM horarios_sucursal ORDER BY nombre');
    res.json(rows.map(mapHorario));
  } catch (e) { fallo(res, e, 'No se pudieron leer los horarios.'); }
});

checadorRouter.post('/horarios', async (req: Request, res: Response) => {
  try {
    const h = req.body || {};
    const { rows } = await pool.query(
      `INSERT INTO horarios_sucursal
        (sucursal_id, area_id, nombre, dias, entrada, inicio_comida, fin_comida, salida, tolerancia_min, activo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [h.sucursalId, h.areaId || null, h.nombre, h.dias || [], h.entrada,
       h.inicioComida || null, h.finComida || null, h.salida, h.toleranciaMin || 0, h.activo !== false]
    );
    res.json(mapHorario(rows[0]));
  } catch (e) { fallo(res, e, 'No se pudo crear el horario.'); }
});

checadorRouter.put('/horarios/:id', async (req: Request, res: Response) => {
  try {
    const h = req.body || {};
    const { rows } = await pool.query(
      `UPDATE horarios_sucursal SET
        sucursal_id=$2, area_id=$3, nombre=$4, dias=$5, entrada=$6,
        inicio_comida=$7, fin_comida=$8, salida=$9, tolerancia_min=$10, activo=$11
       WHERE id=$1 RETURNING *`,
      [req.params.id, h.sucursalId, h.areaId || null, h.nombre, h.dias || [], h.entrada,
       h.inicioComida || null, h.finComida || null, h.salida, h.toleranciaMin || 0, h.activo !== false]
    );
    if (!rows.length) return res.status(404).json({ error: 'Horario no encontrado.' });
    res.json(mapHorario(rows[0]));
  } catch (e) { fallo(res, e, 'No se pudo actualizar el horario.'); }
});

checadorRouter.delete('/horarios/:id', async (req: Request, res: Response) => {
  try {
    await pool.query('DELETE FROM horarios_sucursal WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { fallo(res, e, 'No se pudo eliminar el horario.'); }
});

// ===================== EMPLEADOS =====================
checadorRouter.get('/empleados', async (req: Request, res: Response) => {
  try {
    const { sucursalId } = req.query as any;
    const { rows } = sucursalId
      ? await pool.query('SELECT * FROM empleados WHERE sucursal_id=$1 ORDER BY nombre', [sucursalId])
      : await pool.query('SELECT * FROM empleados ORDER BY nombre');
    res.json(rows.map(mapEmpleado));
  } catch (e) { fallo(res, e, 'No se pudieron leer los empleados.'); }
});

checadorRouter.post('/empleados', async (req: Request, res: Response) => {
  try {
    const e = req.body || {};
    const { rows } = await pool.query(
      `INSERT INTO empleados (sucursal_id, codigo_checador, nombre, puesto, foto_url, horario_id, activo, es_promotora)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (sucursal_id, codigo_checador)
         DO UPDATE SET nombre=EXCLUDED.nombre, puesto=EXCLUDED.puesto, foto_url=EXCLUDED.foto_url,
                       horario_id=EXCLUDED.horario_id, activo=EXCLUDED.activo,
                       es_promotora=EXCLUDED.es_promotora
       RETURNING *`,
      [e.sucursalId, e.codigoChecador, e.nombre, e.puesto || null, e.fotoUrl || null, e.horarioId || null,
       e.activo !== false, e.esPromotora === true]
    );
    res.json(mapEmpleado(rows[0]));
  } catch (err) { fallo(res, err, 'No se pudo guardar el empleado.'); }
});

/**
 * Actualizar un empleado.
 *
 * Se registra en PUT **y en PATCH** porque el front manda PATCH desde que se
 * escribió (checador.service.ts: `guardarEmpleado`), y aquí solo existía PUT: la
 * petición no empataba con ninguna ruta y Express devolvía 404, así que editar
 * a un empleado ya dado de alta no guardaba nada. Se descubrió al agregar la
 * marca de promotora, que se guarda justamente por esta ruta.
 */
const actualizarEmpleado = async (req: Request, res: Response) => {
  try {
    const e = req.body || {};
    const { rows } = await pool.query(
      `UPDATE empleados SET sucursal_id=$2, codigo_checador=$3, nombre=$4, puesto=$5,
              foto_url=$6, horario_id=$7, activo=$8, es_promotora=$9
       WHERE id=$1 RETURNING *`,
      [req.params.id, e.sucursalId, e.codigoChecador, e.nombre, e.puesto || null,
       e.fotoUrl || null, e.horarioId || null, e.activo !== false, e.esPromotora === true]
    );
    if (!rows.length) return res.status(404).json({ error: 'Empleado no encontrado.' });
    res.json(mapEmpleado(rows[0]));
  } catch (err) { fallo(res, err, 'No se pudo actualizar el empleado.'); }
};
checadorRouter.put('/empleados/:id', actualizarEmpleado);
checadorRouter.patch('/empleados/:id', actualizarEmpleado);

checadorRouter.delete('/empleados/:id', async (req: Request, res: Response) => {
  try {
    await pool.query('DELETE FROM empleados WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { fallo(res, err, 'No se pudo eliminar el empleado.'); }
});

// ===================== CHECADAS =====================
// Rango de fechas con datos para una sucursal (para poner un default útil).
checadorRouter.get('/checadas/rango', async (req: Request, res: Response) => {
  try {
    const { sucursalId } = req.query as any;
    if (!sucursalId) return res.status(400).json({ error: 'Falta sucursalId.' });
    const { rows } = await pool.query(
      'SELECT min(fecha) AS min, max(fecha) AS max FROM checadas WHERE sucursal_id=$1',
      [sucursalId]
    );
    res.json({ min: rows[0]?.min || null, max: rows[0]?.max || null });
  } catch (e) { fallo(res, e, 'No se pudo leer el rango.'); }
});

checadorRouter.get('/checadas', async (req: Request, res: Response) => {
  try {
    const { sucursalId, desde, hasta, codigo } = req.query as any;
    if (!sucursalId || !desde || !hasta) {
      return res.status(400).json({ error: 'Faltan sucursalId, desde y hasta.' });
    }
    const params: any[] = [sucursalId, desde, hasta];
    let filtroCodigo = '';
    if (codigo) { params.push(codigo); filtroCodigo = ` AND empleado_codigo = $${params.length}`; }
    const { rows } = await pool.query(
      `SELECT * FROM checadas
       WHERE sucursal_id=$1 AND fecha>=$2 AND fecha<=$3${filtroCodigo}
       ORDER BY fecha, fecha_hora`,
      params
    );
    res.json(rows.map(mapChecada));
  } catch (e) { fallo(res, e, 'No se pudieron leer las checadas.'); }
});

// ===================== REVISIÓN (justificación + verificación) =====================
// Revisiones de un empleado en un rango (para pintar el detalle).
checadorRouter.get('/revision', async (req: Request, res: Response) => {
  try {
    const { sucursalId, codigo, desde, hasta } = req.query as any;
    if (!sucursalId || !codigo) return res.status(400).json({ error: 'Faltan sucursalId y codigo.' });
    const params: any[] = [sucursalId, codigo];
    let filtroFechas = '';
    if (desde && hasta) { params.push(desde, hasta); filtroFechas = ` AND fecha>=$3 AND fecha<=$4`; }
    const { rows } = await pool.query(
      `SELECT * FROM asistencia_revision
       WHERE sucursal_id=$1 AND empleado_codigo=$2${filtroFechas} ORDER BY fecha`,
      params
    );
    res.json(rows.map(mapRevision));
  } catch (e) { fallo(res, e, 'No se pudo leer la revisión.'); }
});

// Upsert de la revisión de un día (justificación y/o estado).
checadorRouter.put('/revision', async (req: Request, res: Response) => {
  try {
    const { sucursalId, empleadoCodigo, fecha, justificacion, estado } = req.body || {};
    if (!sucursalId || !empleadoCodigo || !fecha) {
      return res.status(400).json({ error: 'Faltan sucursalId, empleadoCodigo o fecha.' });
    }
    const est = estado || 'pendiente';
    const { rows } = await pool.query(
      `INSERT INTO asistencia_revision (sucursal_id, empleado_codigo, fecha, justificacion, estado, actualizado_en)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (sucursal_id, empleado_codigo, fecha)
         DO UPDATE SET justificacion=EXCLUDED.justificacion, estado=EXCLUDED.estado, actualizado_en=now()
       RETURNING *`,
      [sucursalId, empleadoCodigo, fecha, justificacion ?? null, est]
    );
    res.json(mapRevision(rows[0]));
  } catch (e) { fallo(res, e, 'No se pudo guardar la revisión.'); }
});

/**
 * POST /checador/checadas/importar
 * body: { sucursalId, areaId?, filas: [{ empleadoCodigo, fechaHora, fecha, hora, deviceId?, tipo? }] }
 * Mapea código→empleado, deduplica (dentro del archivo y contra la base) e inserta.
 */
checadorRouter.post('/checadas/importar', async (req: Request, res: Response) => {
  try {
    const { sucursalId, areaId, filas } = req.body || {};
    if (!sucursalId || !Array.isArray(filas)) {
      return res.status(400).json({ error: 'Faltan sucursalId o filas.' });
    }
    const leidas = filas.length;
    if (!leidas) return res.json({ leidas: 0, nuevas: 0, duplicadas: 0, sinEmpleado: 0 });

    // Mapa código → nombre, solo de esta sucursal.
    const emp = await pool.query('SELECT codigo_checador, nombre FROM empleados WHERE sucursal_id=$1', [sucursalId]);
    const mapa = new Map<string, string>();
    for (const e of emp.rows) mapa.set(String(e.codigo_checador).trim(), e.nombre);

    // Dedup dentro del propio archivo.
    const vistos = new Set<string>();
    let sinEmpleado = 0;
    const unicas: any[] = [];
    for (const f of filas) {
      const codigo = String(f.empleadoCodigo || '').trim();
      const dedupKey = `${sucursalId}__${codigo}__${f.fechaHora}`;
      if (vistos.has(dedupKey)) continue;
      vistos.add(dedupKey);
      const nombre = mapa.get(codigo);
      if (!nombre) sinEmpleado++;
      unicas.push({
        sucursalId, areaId: areaId || null, deviceId: f.deviceId || null,
        empleadoCodigo: codigo, empleadoNombre: nombre || null,
        fechaHora: f.fechaHora, fecha: f.fecha, hora: f.hora,
        tipo: (typeof f.tipo === 'number' ? f.tipo : null), dedupKey
      });
    }

    // Inserción por lotes con ON CONFLICT (dedup_key) DO NOTHING.
    let nuevas = 0;
    const LOTE = 200;
    for (let i = 0; i < unicas.length; i += LOTE) {
      const grupo = unicas.slice(i, i + LOTE);
      const valores: string[] = [];
      const params: any[] = [];
      grupo.forEach((c, j) => {
        const b = j * 10;
        valores.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10})`);
        params.push(c.sucursalId, c.areaId, c.deviceId, c.empleadoCodigo, c.empleadoNombre,
                    c.fechaHora, c.fecha, c.hora, c.tipo, c.dedupKey);
      });
      const r = await pool.query(
        `INSERT INTO checadas
          (sucursal_id, area_id, device_id, empleado_codigo, empleado_nombre, fecha_hora, fecha, hora, tipo, dedup_key)
         VALUES ${valores.join(',')}
         ON CONFLICT (dedup_key) DO NOTHING`,
        params
      );
      nuevas += r.rowCount || 0;
    }

    const duplicadas = leidas - nuevas;
    res.json({ leidas, nuevas, duplicadas, sinEmpleado });
  } catch (e) { fallo(res, e, 'No se pudieron importar las checadas.'); }
});
