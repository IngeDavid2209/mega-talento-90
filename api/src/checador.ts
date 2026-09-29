import { Router, Request, Response } from 'express';
import { pool } from './db';
import { requireAuth, AuthedRequest } from './auth';

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
  nombre: r.nombre,
  // El nombre FORMAL, el del reporte de RH ("GARCIA TAPIA LUCIA"). `nombre` es
  // el apodo con el que está enrolada en el reloj ("Luciagarciatapia"): sirve
  // para reconocerla en el equipo, no para un reporte que se firma. La pantalla
  // se quedaba con el apodo porque este campo no se mandaba.
  nombreCompleto: r.nombre_completo || '',
  puesto: r.puesto || '', fotoUrl: r.foto_url || '',
  // La sección del reporte semanal (Compras, Finanzas…). Existía en la base desde
  // el sembrado de los reportes de RH, pero no viajaba al front y no había dónde
  // capturarlo: quien no venía en el reporte se quedaba en SIN DEPARTAMENTO.
  departamento: r.departamento || '',
  horarioId: r.horario_id || '', activo: r.activo,
  // Promotora = no es personal de piso y no se mide con la vara de asistencia
  // de la sucursal. Ver api/db/schema.sql y el filtro en agente-horarios/.
  esPromotora: r.es_promotora === true,
  // Cuándo y quién la dio de baja (Papelera de empleados).
  bajaEn: r.baja_en || null, bajaPor: r.baja_por || '',
});
const mapChecada = (r: any) => ({
  id: r.id, sucursalId: r.sucursal_id, areaId: r.area_id || undefined,
  deviceId: r.device_id || undefined, empleadoCodigo: r.empleado_codigo,
  empleadoNombre: r.empleado_nombre || undefined, fechaHora: r.fecha_hora,
  fecha: r.fecha, hora: r.hora, tipo: r.tipo ?? undefined, dedupKey: r.dedup_key
});
/** Fecha ISO corta, para no dejar que un texto libre llegue a la base. */
const RE_FECHA_REV = /^\d{4}-\d{2}-\d{2}$/;

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
      // Los ELIMINADOS no salen en ningún lado, ni en "Ver dadas de baja": su
      // fila se conserva solo para que el reloj no los vuelva a dar de alta
      // (ver db/reloj-comandos.sql).
      ? await pool.query('SELECT * FROM empleados WHERE sucursal_id=$1 AND eliminado_en IS NULL ORDER BY nombre', [sucursalId])
      : await pool.query('SELECT * FROM empleados WHERE eliminado_en IS NULL ORDER BY nombre');
    res.json(rows.map(mapEmpleado));
  } catch (e) { fallo(res, e, 'No se pudieron leer los empleados.'); }
});

checadorRouter.post('/empleados', async (req: AuthedRequest, res: Response) => {
  try {
    const e = req.body || {};
    const { rows } = await pool.query(
      `INSERT INTO empleados (sucursal_id, codigo_checador, nombre, nombre_completo, puesto, foto_url, horario_id, activo, es_promotora, departamento, baja_en, baja_por)
       VALUES ($1,$2,$3,NULLIF(btrim($9),''),$4,$5,$6,$7,$8,NULLIF(upper(btrim($10)),''),
               CASE WHEN $7 THEN NULL ELSE now() END, CASE WHEN $7 THEN NULL ELSE $11 END)
       ON CONFLICT (sucursal_id, codigo_checador)
         DO UPDATE SET nombre=EXCLUDED.nombre, puesto=EXCLUDED.puesto, foto_url=EXCLUDED.foto_url,
                       horario_id=EXCLUDED.horario_id, activo=EXCLUDED.activo,
                       baja_en=CASE WHEN EXCLUDED.activo THEN NULL WHEN empleados.activo THEN now() ELSE empleados.baja_en END,
                       baja_por=CASE WHEN EXCLUDED.activo THEN NULL WHEN empleados.activo THEN $11 ELSE empleados.baja_por END,
                       es_promotora=EXCLUDED.es_promotora,
                       -- Solo se pisa si llega algo: ver el comentario del UPDATE.
                       nombre_completo=COALESCE(EXCLUDED.nombre_completo, empleados.nombre_completo),
                       -- Darla de alta A MANO otra vez es una decisión explícita
                       -- de RH: deja de estar eliminada.
                       eliminado_en=NULL, eliminado_por=NULL,
                       departamento=COALESCE(EXCLUDED.departamento, empleados.departamento)
       RETURNING *`,
      [e.sucursalId, e.codigoChecador, e.nombre, e.puesto || null, e.fotoUrl || null, e.horarioId || null,
       e.activo !== false, e.esPromotora === true, e.nombreCompleto ?? null, e.departamento ?? null,
       req.usuario?.email || null]
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
const actualizarEmpleado = async (req: AuthedRequest, res: Response) => {
  try {
    const e = req.body || {};
    const { rows } = await pool.query(
      // `nombre_completo` NO se pisa cuando llega vacío, y eso es lo importante.
      //
      // Esta ruta escribe TODAS las columnas del cuerpo, y hay llamadas que
      // reenvían el empleado entero para cambiar una sola cosa —`marcarPromotora`
      // manda `{ ...e, esPromotora }`—. Con un SET a secas, cualquiera de esas
      // llamadas borraría el nombre formal del reporte de RH sin querer y sin
      // aviso: un clic en "pasar a promotoras" costaría el nombre bueno.
      //
      // `departamento` es distinto a propósito: si el cuerpo NO lo trae (una
      // llamada vieja), se respeta el que hay; si lo trae vacío, RH lo quitó y
      // se borra. Se guarda en mayúsculas porque así vienen los del reporte y
      // "Compras" y "COMPRAS" serían dos secciones distintas en la tabla.
      `UPDATE empleados SET sucursal_id=$2, codigo_checador=$3, nombre=$4, puesto=$5,
              foto_url=$6, horario_id=$7, activo=$8, es_promotora=$9,
              nombre_completo=COALESCE(NULLIF(btrim($10),''), nombre_completo),
              departamento=CASE WHEN $11::boolean THEN NULLIF(upper(btrim($12)),'') ELSE departamento END,
              -- La baja deja rastro (Papelera de empleados). En el SET, \`activo\`
              -- todavía es el valor de ANTES: así se sabe si esto es una baja nueva.
              baja_en=CASE WHEN $8 THEN NULL WHEN activo THEN now() ELSE baja_en END,
              baja_por=CASE WHEN $8 THEN NULL WHEN activo THEN $13 ELSE baja_por END
       WHERE id=$1 RETURNING *`,
      [req.params.id, e.sucursalId, e.codigoChecador, e.nombre, e.puesto || null,
       e.fotoUrl || null, e.horarioId || null, e.activo !== false, e.esPromotora === true,
       e.nombreCompleto ?? null, e.departamento !== undefined, e.departamento ?? '',
       req.usuario?.email || null]
    );
    if (!rows.length) return res.status(404).json({ error: 'Empleado no encontrado.' });
    res.json(mapEmpleado(rows[0]));
  } catch (err) { fallo(res, err, 'No se pudo actualizar el empleado.'); }
};
checadorRouter.put('/empleados/:id', actualizarEmpleado);
checadorRouter.patch('/empleados/:id', actualizarEmpleado);

// ══ NO SE BORRA A NADIE (29/09/2026) ══
// RH quitó el borrado: a quien ya no trabaja se le da de BAJA y se va a la
// Papelera de empleados, de donde se le puede regresar. La ruta DELETE se quitó
// a propósito, no solo el botón: esconder un botón no impide llamar a la ruta.
// (Además, borrar la fila nunca sirvió: la ingesta la recreaba en minutos.)

/**
 * GET /checador/empleados/papelera — la Papelera de empleados, de TODAS las
 * plazas: los dados de baja y los que se eliminaron antes de que se quitara el
 * botón. Con su última checada, para decidir si alguien debe regresar.
 */
checadorRouter.get('/empleados/papelera', async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.*, u.ultima AS ultima_checada,
              EXISTS (SELECT 1 FROM reloj_comandos c
                       WHERE c.sucursal_id = e.sucursal_id AND c.empleado_codigo = e.codigo_checador
                         AND c.tipo = 'borrar_usuario' AND c.estado = 'hecho' AND c.respaldo IS NOT NULL
                         AND c.actualizado_en >= COALESCE(e.eliminado_en, 'epoch')) AS borrado_de_reloj
         FROM empleados e
         LEFT JOIN LATERAL (
           -- max(fecha_hora) y no max(fecha): la primera sale del índice
           -- (sucursal_id, empleado_codigo, fecha_hora) sin leer la tabla. Con
           -- 550 personas en la papelera, eso es de ~5 s a menos de uno.
           SELECT max(c.fecha_hora) AS ultima FROM checadas c
            WHERE c.sucursal_id = e.sucursal_id AND c.empleado_codigo = e.codigo_checador
         ) u ON TRUE
        WHERE e.activo = FALSE OR e.eliminado_en IS NOT NULL
        ORDER BY COALESCE(e.eliminado_en, e.baja_en) DESC NULLS LAST, e.sucursal_id, e.nombre`);
    res.json(rows.map((r: any) => ({
      ...mapEmpleado(r),
      ultimaChecada: r.ultima_checada ? String(r.ultima_checada instanceof Date ? r.ultima_checada.toISOString() : r.ultima_checada).slice(0, 10) : null,
      eliminadoEn: r.eliminado_en || null,
      eliminadoPor: r.eliminado_por || '',
      borradoDeReloj: r.borrado_de_reloj === true,
    })));
  } catch (err) { fallo(res, err, 'No se pudo leer la papelera de empleados.'); }
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

/**
 * PUT /checador/revision/rango
 * body: { sucursalId, empleadoCodigo, desde, hasta, justificacion, estado? }
 *
 * Justifica un RANGO de días de una vez. Nació para las vacaciones: capturarlas
 * día por día son siete u ocho guardados para una sola decisión, y a la tercera
 * persona nadie lo hace. Sirve igual para una incapacidad de dos semanas.
 *
 * El estado por omisión es `aprobada` y no `pendiente`: quien captura un periodo
 * de vacaciones ya lo autorizó —no está anotando una duda—, y solo lo aprobado
 * deja de contar como falta (ver JUSTIFICAN_AUSENCIA en asistencia-personas.ts).
 *
 * Se topa el rango a 120 días: un dedazo en el año (2062 en vez de 2026) escribiría
 * decenas de miles de renglones antes de que alguien lo notara.
 */
checadorRouter.put('/revision/rango', async (req: Request, res: Response) => {
  try {
    const { sucursalId, empleadoCodigo, desde, hasta, justificacion, estado } = req.body || {};
    if (!sucursalId || !empleadoCodigo || !desde || !hasta || !justificacion) {
      return res.status(400).json({ error: 'Faltan sucursalId, empleadoCodigo, desde, hasta o justificacion.' });
    }
    if (!RE_FECHA_REV.test(String(desde)) || !RE_FECHA_REV.test(String(hasta))) {
      return res.status(400).json({ error: 'Las fechas deben venir como yyyy-MM-dd.' });
    }
    if (String(hasta) < String(desde)) {
      return res.status(400).json({ error: 'La fecha final no puede ser anterior a la inicial.' });
    }
    const dias = Math.round(
      (Date.parse(String(hasta) + 'T12:00:00Z') - Date.parse(String(desde) + 'T12:00:00Z')) / 86400000) + 1;
    if (dias > 120) {
      return res.status(400).json({ error: `El rango son ${dias} días y el tope es 120. Revisa las fechas.` });
    }

    // generate_series arma los días en la base: hacerlo aquí serían N viajes.
    const { rows } = await pool.query(
      `INSERT INTO asistencia_revision (sucursal_id, empleado_codigo, fecha, justificacion, estado, actualizado_en)
       SELECT $1, $2, to_char(d, 'YYYY-MM-DD'), $4, $5, now()
         FROM generate_series($3::date, $6::date, interval '1 day') AS d
       ON CONFLICT (sucursal_id, empleado_codigo, fecha)
         DO UPDATE SET justificacion=EXCLUDED.justificacion, estado=EXCLUDED.estado, actualizado_en=now()
       RETURNING *`,
      [sucursalId, empleadoCodigo, desde, justificacion, estado || 'aprobada', hasta]
    );
    res.json({ dias: rows.length, revisiones: rows.map(mapRevision) });
  } catch (e) { fallo(res, e, 'No se pudo justificar el rango.'); }
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
