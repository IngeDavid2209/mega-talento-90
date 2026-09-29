import { Router, Response } from 'express';
import { pool } from './db';
import { requireAuth, AuthedRequest } from './auth';

/**
 * INCIDENCIAS DE PERSONAL: vacaciones, permisos, incapacidades, faltas
 * injustificadas, amonestaciones… por un día o por un periodo.
 *
 * El catálogo vive AQUÍ y no en texto libre porque el cálculo de asistencia
 * decide por el TIPO si un día deja de contar como falta (`excusaFalta`). Con
 * texto libre, "vacasiones" escrito a mano no excusaba nada y "permiso sin
 * goce" excusaba lo mismo que "con goce" solo porque dice "permiso".
 *
 *   excusaFalta = true  → la persona NO tenía que estar: el día sin marcas deja
 *                         de ser falta (se pinta con el código de la incidencia).
 *   excusaFalta = false → queda registrada y se ve en el tablero, pero no cambia
 *                         el cálculo (una amonestación no borra un retardo).
 *
 * `falta_injustificada` es la excepción al revés: RH confirma que SÍ es falta.
 * No cambia el número (ya era falta), pero la saca de "por revisar".
 *
 * Tabla: db/incidencias.sql.
 */
export interface TipoIncidencia {
  tipo: string;
  etiqueta: string;
  /** Código de 2-3 letras que cabe en la celda del reporte. */
  codigo: string;
  excusaFalta: boolean;
}

export const TIPOS_INCIDENCIA: TipoIncidencia[] = [
  { tipo: 'vacaciones',          etiqueta: 'Vacaciones',                 codigo: 'VAC', excusaFalta: true },
  { tipo: 'permiso_sin_goce',    etiqueta: 'Permiso sin goce de sueldo', codigo: 'PSG', excusaFalta: true },
  { tipo: 'permiso_con_goce',    etiqueta: 'Permiso con goce de sueldo', codigo: 'PCG', excusaFalta: true },
  { tipo: 'falta_injustificada', etiqueta: 'Falta injustificada',        codigo: 'FI',  excusaFalta: false },
  { tipo: 'incapacidad',         etiqueta: 'Incapacidad',                codigo: 'INC', excusaFalta: true },
  { tipo: 'paternidad',          etiqueta: 'Paternidad',                 codigo: 'PAT', excusaFalta: true },
  { tipo: 'maternidad',          etiqueta: 'Maternidad',                 codigo: 'MAT', excusaFalta: true },
  { tipo: 'riesgo_trabajo',      etiqueta: 'Riesgo de trabajo',          codigo: 'RT',  excusaFalta: true },
  { tipo: 'amonestacion',        etiqueta: 'Amonestación',               codigo: 'AMO', excusaFalta: false },
  { tipo: 'semana_reducida',     etiqueta: 'Semana reducida',            codigo: 'SR',  excusaFalta: true },
  // Usó horas que tenía a favor: justifica el día y sus minutos SE SUMAN a las
  // horas trabajadas de ese día (29/09/2026). Lleva `minutos` obligatorio.
  { tipo: 'horas_extra',         etiqueta: 'Uso de horas extra',         codigo: 'HE',  excusaFalta: true },
  // "Otros" JUSTIFICA desde el 29/09/2026: el portal exige escribir el motivo, y
  // RH lo usa para lo que no tiene tipo propio (una junta, un trámite).
  { tipo: 'otros',               etiqueta: 'Otros',                      codigo: 'OTR', excusaFalta: true },
];

const POR_TIPO = new Map(TIPOS_INCIDENCIA.map((t) => [t.tipo, t]));
export const tipoIncidencia = (tipo: string) => POR_TIPO.get(tipo);

export interface Incidencia {
  id: string;
  sucursalId: string;
  empleadoCodigo: string;
  tipo: string;
  desde: string;
  hasta: string;
  nota: string;
  /** Solo en "Uso de horas extra": minutos usados por día. */
  minutos: number | null;
  creadoPor: string;
  creadoEn: string;
}

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
/** Un dedazo en el año (2062) no debe escribir un periodo de 36 años. */
const TOPE_DIAS = 366;

const aFecha = (v: any): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').slice(0, 10);

const mapIncidencia = (r: any): Incidencia => ({
  id: r.id,
  sucursalId: r.sucursal_id,
  empleadoCodigo: String(r.empleado_codigo).trim(),
  tipo: r.tipo,
  desde: aFecha(r.desde),
  hasta: aFecha(r.hasta),
  nota: r.nota || '',
  minutos: r.minutos == null ? null : Number(r.minutos),
  creadoPor: r.creado_por || '',
  creadoEn: r.creado_en,
});

/**
 * Las incidencias que TOCAN el rango (no solo las que empiezan en él): unas
 * vacaciones del 28 al 5 tienen que verse si se está mirando del 1 al 7.
 *
 * Si la tabla todavía no existe (migración sin aplicar) no es un error: no hay
 * incidencias, y la asistencia sigue saliendo como antes.
 */
export async function incidenciasEnRango(
  sucursalId: string, desde: string, hasta: string, codigo?: string,
): Promise<Incidencia[]> {
  const params: any[] = [sucursalId, desde, hasta];
  let filtro = '';
  if (codigo) { params.push(codigo); filtro = ` AND empleado_codigo = $4`; }
  try {
    const { rows } = await pool.query(
      `SELECT * FROM asistencia_incidencias
        WHERE sucursal_id = $1 AND desde <= $3::date AND hasta >= $2::date${filtro}
        ORDER BY desde, creado_en`,
      params);
    return rows.map(mapIncidencia);
  } catch (e: any) {
    if (e?.code === '42P01') return [];   // undefined_table
    throw e;
  }
}

export const incidenciasRouter = Router();
incidenciasRouter.use(requireAuth);

/** GET /checador/incidencias/tipos — el catálogo, para que el front no lo copie a mano. */
incidenciasRouter.get('/tipos', (_req, res) => { res.json(TIPOS_INCIDENCIA); });

/** GET /checador/incidencias?sucursalId&desde&hasta[&codigo] */
incidenciasRouter.get('/', async (req: AuthedRequest, res: Response) => {
  try {
    const { sucursalId, desde, hasta, codigo } = req.query as any;
    if (!sucursalId || !RE_FECHA.test(String(desde)) || !RE_FECHA.test(String(hasta))) {
      return res.status(400).json({ error: 'Faltan sucursalId, desde y hasta (yyyy-MM-dd).' });
    }
    res.json(await incidenciasEnRango(sucursalId, desde, hasta, codigo || undefined));
  } catch (e) {
    console.error('[incidencias] leer', e);
    res.status(500).json({ error: 'No se pudieron leer las incidencias.' });
  }
});

/**
 * POST /checador/incidencias
 * body: { sucursalId, empleadoCodigo, tipo, desde, hasta?, nota? }
 * `hasta` vacío = un solo día.
 */
incidenciasRouter.post('/', async (req: AuthedRequest, res: Response) => {
  try {
    const { sucursalId, empleadoCodigo, tipo, desde, nota } = req.body || {};
    // Uso de horas extra: cuántos minutos por día (entre 1 min y 12 h).
    let minutos: number | null = null;
    if (tipo === 'horas_extra') {
      minutos = Math.round(Number(req.body?.minutos));
      if (!Number.isFinite(minutos) || minutos < 1 || minutos > 720) {
        return res.status(400).json({ error: 'Indica cuántas horas extra usó (entre 1 minuto y 12 horas).' });
      }
    }
    if (tipo === 'otros' && !String(nota || '').trim()) {
      return res.status(400).json({ error: 'Con "Otros" hay que escribir el motivo.' });
    }
    const hasta = req.body?.hasta || desde;
    if (!sucursalId || !empleadoCodigo || !tipo || !desde) {
      return res.status(400).json({ error: 'Faltan sucursalId, empleadoCodigo, tipo o desde.' });
    }
    if (!tipoIncidencia(String(tipo))) {
      return res.status(400).json({ error: `Tipo de incidencia desconocido: ${tipo}.` });
    }
    if (!RE_FECHA.test(String(desde)) || !RE_FECHA.test(String(hasta))) {
      return res.status(400).json({ error: 'Las fechas deben venir como yyyy-MM-dd.' });
    }
    if (String(hasta) < String(desde)) {
      return res.status(400).json({ error: 'La fecha final no puede ser anterior a la inicial.' });
    }
    const dias = Math.round(
      (Date.parse(`${hasta}T12:00:00Z`) - Date.parse(`${desde}T12:00:00Z`)) / 86400000) + 1;
    if (dias > TOPE_DIAS) {
      return res.status(400).json({ error: `El periodo son ${dias} días y el tope es ${TOPE_DIAS}. Revisa las fechas.` });
    }
    const { rows } = await pool.query(
      `INSERT INTO asistencia_incidencias (sucursal_id, empleado_codigo, tipo, desde, hasta, nota, creado_por, minutos)
       VALUES ($1, $2, $3, $4::date, $5::date, NULLIF(btrim($6), ''), $7, $8)
       RETURNING *`,
      [sucursalId, String(empleadoCodigo).trim(), tipo, desde, hasta, nota ?? '', req.usuario?.email || null, minutos]);
    res.json(mapIncidencia(rows[0]));
  } catch (e) {
    console.error('[incidencias] crear', e);
    res.status(500).json({ error: 'No se pudo guardar la incidencia.' });
  }
});

/** DELETE /checador/incidencias/:id */
incidenciasRouter.delete('/:id', async (req: AuthedRequest, res: Response) => {
  try {
    await pool.query('DELETE FROM asistencia_incidencias WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[incidencias] borrar', e);
    res.status(500).json({ error: 'No se pudo borrar la incidencia.' });
  }
});
