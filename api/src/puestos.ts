import { Router, Request, Response } from 'express';
import { pool } from './db';
import { requireAuth } from './auth';

/**
 * Router de puestos/vacantes. Lectura pública (la cartelera /empleos y el
 * formulario /unete la usan sin sesión); escritura solo RH.
 */
export const puestosRouter = Router();

function mapPuesto(r: any) {
  const extra = (r.extra && typeof r.extra === 'object') ? r.extra : {};
  return {
    id: r.id,
    nombre: r.nombre,
    descripcion: r.descripcion || '',
    sucursalIds: r.sucursal_ids || [],
    sucursales: r.sucursales || '',
    sueldo: r.sueldo || '',
    horario: r.horario || '',
    requisitos: r.requisitos || '',
    imagenUrl: r.imagen_url || '',
    area: r.area || '',
    activo: r.activo,
    orden: r.orden ?? 999,
    hojaCompetencias: r.hoja_competencias || '',
    aptitudes: extra.aptitudes,
    tipoAptitud: extra.tipoAptitud,
    createdAt: r.creado_en
  };
}

function fallo(res: Response, e: any, msg: string) {
  console.error('[puestos]', msg, e);
  return res.status(500).json({ error: msg });
}

// Extrae columnas + arma el `extra` con los campos legado.
function aColumnas(p: any) {
  const extra: any = {};
  if (p.aptitudes !== undefined) extra.aptitudes = p.aptitudes;
  if (p.tipoAptitud !== undefined) extra.tipoAptitud = p.tipoAptitud;
  return {
    nombre: p.nombre || '',
    descripcion: p.descripcion || null,
    sucursal_ids: Array.isArray(p.sucursalIds) ? p.sucursalIds : null,
    sucursales: p.sucursales || null,
    sueldo: p.sueldo || null,
    horario: p.horario || null,
    requisitos: p.requisitos || null,
    imagen_url: p.imagenUrl || null,
    area: p.area || null,
    activo: p.activo !== false,
    orden: typeof p.orden === 'number' ? p.orden : 999,
    hoja_competencias: p.hojaCompetencias || null,
    extra
  };
}

// Listado público (cartelera / formulario).
puestosRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT * FROM puestos ORDER BY orden ASC, nombre ASC');
    return res.json(rows.map(mapPuesto));
  } catch (e) { return fallo(res, e, 'Error al listar puestos.'); }
});

puestosRouter.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const c = aColumnas(req.body || {});
    const { rows } = await pool.query(
      `INSERT INTO puestos
        (nombre, descripcion, sucursal_ids, sucursales, sueldo, horario, requisitos,
         imagen_url, area, activo, orden, hoja_competencias, extra)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [c.nombre, c.descripcion, c.sucursal_ids, c.sucursales, c.sueldo, c.horario, c.requisitos,
       c.imagen_url, c.area, c.activo, c.orden, c.hoja_competencias, JSON.stringify(c.extra)]
    );
    return res.json(mapPuesto(rows[0]));
  } catch (e) { return fallo(res, e, 'Error al crear puesto.'); }
});

puestosRouter.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const c = aColumnas(req.body || {});
    const { rows } = await pool.query(
      `UPDATE puestos SET
         nombre=$2, descripcion=$3, sucursal_ids=$4, sucursales=$5, sueldo=$6, horario=$7,
         requisitos=$8, imagen_url=$9, area=$10, activo=$11, orden=$12, hoja_competencias=$13,
         extra = coalesce(extra,'{}'::jsonb) || $14::jsonb
       WHERE id=$1 RETURNING *`,
      [req.params.id, c.nombre, c.descripcion, c.sucursal_ids, c.sucursales, c.sueldo, c.horario,
       c.requisitos, c.imagen_url, c.area, c.activo, c.orden, c.hoja_competencias, JSON.stringify(c.extra)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Puesto no encontrado.' });
    return res.json(mapPuesto(rows[0]));
  } catch (e) { return fallo(res, e, 'Error al actualizar puesto.'); }
});

puestosRouter.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    await pool.query('DELETE FROM puestos WHERE id=$1', [req.params.id]);
    return res.json({ ok: true });
  } catch (e) { return fallo(res, e, 'Error al eliminar puesto.'); }
});
