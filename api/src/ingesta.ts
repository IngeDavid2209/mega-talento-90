import { Router, Request, Response } from 'express';
import { createHash, timingSafeEqual } from 'crypto';
import { pool } from './db';
import { requireAuth } from './auth';

/**
 * ══════════════════════════════════════════════════════════════════
 * INGESTA DE CHECADAS · el dato entra EMPUJADO, no jalado
 * ══════════════════════════════════════════════════════════════════
 *
 * La API vive en Railway y NUNCA va a poder hablarle a un reloj: las IPs son
 * privadas (192.168.x.x) y no hay VPN entre plazas. Antes eso se resolvía
 * corriendo `jalar-todo-zk.js` en una PC de la LAN con el DATABASE_URL de
 * producción en un `.env` — un riesgo de seguridad, y además solo funcionaba
 * mientras alguien dejara la ventana abierta.
 *
 * Aquí se invierte: quien está en la LAN (el agente, o el propio reloj en modo
 * ADMS) hace POST de sus checadas. Las PCs de sucursal ya no necesitan
 * credenciales de Postgres, solo `apiUrl` + `token`.
 *
 * Se monta FUERA de `checadorRouter` porque ese router tiene `requireAuth`
 * global y el agente no tiene JWT de usuario; se autentica con un secreto
 * compartido (`INGESTA_TOKEN`), igual que ya se hizo con
 * /checador/agente/callback para el bot.
 */

// Cada cuánto le toca al agente una lectura verificada completa. NO son 5
// minutos: bajar el log entero de 8-Esquinas son ~50 mil registros (≈2 MB) y no
// cierra de forma confiable en esa ventana. La inmediatez la da el stream en
// vivo; el backfill es la red de seguridad.
const BACKFILL_MIN = parseInt(process.env.BACKFILL_MIN || '60', 10) || 60;

// ---------------------------------------------------------------------
// Autenticación del agente
// ---------------------------------------------------------------------
function tokenValido(recibido: string): boolean {
  const esperado = process.env.INGESTA_TOKEN || '';
  if (!esperado) return false;               // sin token configurado, nadie entra
  // Se comparan los DIGESTS, no los tokens: `timingSafeEqual` exige la misma
  // longitud, y salir antes por longitud distinta filtraría el largo del token
  // por tiempo de respuesta. Un sha256 siempre mide 32 bytes.
  const a = createHash('sha256').update(recibido || '').digest();
  const b = createHash('sha256').update(esperado).digest();
  return timingSafeEqual(a, b);
}

function requireAgente(req: Request, res: Response, next: Function) {
  if (!process.env.INGESTA_TOKEN) {
    return res.status(503).json({
      error: 'La ingesta está apagada: falta INGESTA_TOKEN en el servidor.',
    });
  }
  const t = String(req.headers['x-agente-token'] || '');
  if (!tokenValido(t)) return res.status(401).json({ error: 'Token de agente inválido.' });
  next();
}

function fallo(res: Response, e: any, msg: string) {
  console.error('[ingesta]', msg, e);
  return res.status(500).json({ error: msg });
}

// ---------------------------------------------------------------------
// Tipos del lote
// ---------------------------------------------------------------------
export interface ChecadaEntrante {
  codigo: string;
  /** 'yyyy-MM-ddTHH:mm:ss' en hora LOCAL del reloj. */
  fechaHora: string;
  fecha?: string;
  hora?: string;
  tipo?: number | null;
}

export interface LoteEntrante {
  serie: string;
  ip?: string | null;
  origen: 'agente' | 'push' | 'manual';
  agenteVersion?: string | null;
  agenteHost?: string | null;
  infoReloj?: {
    logCounts?: number; userCounts?: number; horaReloj?: string;
    /**
     * Cuándo leyó el equipo QUIEN NOS PASA EL DATO. No es lo mismo que nuestro
     * latido: si el sistema de origen deja de sondear sus relojes, nuestro
     * agente sigue vivo copiando una base congelada, y sin este dato la
     * pantalla se vería al día estando parada.
     */
    origenVisto?: string | null;
  } | null;
  usuarios?: Array<{ codigo: string; nombre?: string }> | null;
  checadas?: ChecadaEntrante[] | null;
  /** true = viene de una lectura VERIFICADA completa (backfill), no del stream. */
  completa?: boolean;
}

export interface ResultadoLote {
  estado: 'aplicado' | 'pendiente' | 'serie_desconocida';
  serie: string;
  sucursalId: string | null;
  recibidas: number;
  aceptadas: number;
  duplicadas: number;
  rechazadas: number;
  loteId: string | null;
  siguienteBackfillMin: number;
  mensaje?: string;
}

const RE_FECHA_HORA = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})$/;

/**
 * La zona en la que marcan los relojes. Los equipos mandan hora de pared, sin
 * offset, y la API corre en UTC: sin esto, convertir una a `timestamptz` la
 * corre seis horas. Es un nombre de zona y no `-06:00` a propósito — Postgres
 * trae la base de datos de zonas y aplicaría el cambio solo si México volviera
 * a tener horario de verano.
 *
 * Todas las plazas están en Michoacán. El día que haya uno en otra zona, esto
 * tiene que pasar a ser una columna de `relojes`, no seguir siendo constante.
 */
const ZONA_RELOJES = 'America/Mexico_City';

/**
 * Normaliza y filtra el lote: descarta lo que no se puede usar en vez de
 * insertarlo mal. Una checada con código vacío o con fecha del año 2000 (los
 * relojes sin hora configurada graban 2000-01-01) no es un dato: es basura que
 * después aparece como una falta de alguien.
 */
function normalizar(checadas: ChecadaEntrante[]): { filas: ChecadaEntrante[]; rechazadas: number } {
  const vistos = new Set<string>();
  const filas: ChecadaEntrante[] = [];
  let rechazadas = 0;
  for (const c of checadas) {
    const codigo = String(c?.codigo ?? '').trim();
    const fh = String(c?.fechaHora ?? '').trim().replace(' ', 'T');
    const m = RE_FECHA_HORA.exec(fh);
    if (!codigo || !m) { rechazadas++; continue; }
    if (m[1] < '2001-01-01') { rechazadas++; continue; }
    const clave = `${codigo}__${fh}`;
    if (vistos.has(clave)) { rechazadas++; continue; }   // duplicado dentro del propio lote
    vistos.add(clave);
    filas.push({
      codigo, fechaHora: fh, fecha: m[1], hora: m[2],
      tipo: typeof c.tipo === 'number' ? c.tipo : null,
    });
  }
  return { filas, rechazadas };
}

// ---------------------------------------------------------------------
// aplicarLote — el único camino por el que entran checadas empujadas.
// Lo usan /checador/ingesta (agente) y /iclock (relojes en modo push).
// ---------------------------------------------------------------------
export async function aplicarLote(lote: LoteEntrante): Promise<ResultadoLote> {
  const serie = String(lote.serie || '').trim();
  const origen = lote.origen || 'agente';
  const entrantes = Array.isArray(lote.checadas) ? lote.checadas : [];
  const base: ResultadoLote = {
    estado: 'aplicado', serie, sucursalId: null,
    recibidas: entrantes.length, aceptadas: 0, duplicadas: 0, rechazadas: 0,
    loteId: null, siguienteBackfillMin: BACKFILL_MIN,
  };
  if (!serie) throw new Error('El lote no trae número de serie.');

  const { rows: relojes } = await pool.query(
    'SELECT serie, sucursal_id, alias, pendiente, activo FROM relojes WHERE serie=$1', [serie]
  );
  const reloj = relojes[0];

  // ── Serie desconocida ────────────────────────────────────────────
  // NO se inventa sucursal. Atribuir las marcas a la plaza equivocada no se
  // nota mirando la pantalla, y después no hay cómo deshacerlo. El lote se
  // guarda crudo para que RH pueda dar de alta el reloj y reprocesarlo sin
  // haber perdido el dato.
  if (!reloj) {
    const { rows } = await pool.query(
      `INSERT INTO ingesta_lotes (serie, origen, registros, aceptados, crudo, error)
       VALUES ($1,$2,$3,0,$4,'serie desconocida') RETURNING id`,
      [serie, origen, entrantes.length, JSON.stringify(lote)]
    );
    return { ...base, estado: 'serie_desconocida', loteId: rows[0].id,
      mensaje: `La serie ${serie} no está en el padrón de relojes. El lote se guardó sin aplicar.` };
  }

  base.sucursalId = reloj.sucursal_id;

  // ── Reloj en pausa ───────────────────────────────────────────────
  // Caso 192.168.0.81: misma gente de corporativo con OTRA numeración. Jalarlo
  // por código le atribuye las marcas a la persona equivocada. Se acepta el
  // envío (para que el agente no reintente en vano) pero NO entra a `checadas`.
  if (reloj.pendiente || reloj.activo === false) {
    const { rows } = await pool.query(
      `INSERT INTO ingesta_lotes (serie, origen, registros, aceptados, crudo, error)
       VALUES ($1,$2,$3,0,$4,$5) RETURNING id`,
      [serie, origen, entrantes.length, JSON.stringify(lote),
       reloj.pendiente ? 'reloj en pausa (pendiente de identificar/mapear)' : 'reloj inactivo']
    );
    await tocarEstado(lote, reloj.sucursal_id, null, 0);
    return { ...base, estado: 'pendiente', loteId: rows[0].id,
      mensaje: `El reloj ${reloj.alias || serie} está en pausa: se guardó el lote pero no se aplicó.` };
  }

  const sucursalId: string = reloj.sucursal_id;
  const { filas, rechazadas } = normalizar(entrantes);
  base.rechazadas = rechazadas;

  // ── Traducción de códigos ────────────────────────────────────────
  const { rows: mapRows } = await pool.query(
    'SELECT codigo_reloj, codigo_empleado FROM reloj_codigo_map WHERE serie=$1', [serie]
  );
  const traduccion = new Map<string, string>(
    mapRows.map((r: any) => [String(r.codigo_reloj), String(r.codigo_empleado)])
  );
  const codigoFinal = (c: string) => traduccion.get(c) ?? c;

  // ── Padrón que manda el reloj ────────────────────────────────────
  // El nombre del reloj solo RELLENA, nunca pisa: si RH corrige "Franciscomtz"
  // a "Francisco Martínez" en el portal, el siguiente lote no se lo deshace.
  const nombres = new Map<string, string>();
  for (const u of lote.usuarios || []) {
    const cod = codigoFinal(String(u?.codigo ?? '').trim());
    const nom = String(u?.nombre ?? '').trim();
    if (!cod) continue;
    nombres.set(cod, nom || `Empleado ${cod}`);
    // `activo` NO se pone en true a ciegas: si la ficha está en `padron_depurado`
    // (RH la dio de baja del padrón) vuelve INACTIVA.
    //
    // Sin esto el borrado se deshacía solo. Medido el 21/08/2026: se depuraron 503
    // fichas y diez minutos después las 10 de Zamora Catedral estaban de vuelta,
    // con `creado_en` de esa tarde. La persona sigue enrolada en el reloj y el
    // equipo manda su padrón completo en cada lote, así que el INSERT las reponía
    // activas una y otra vez, sin error y sin que nadie se enterara.
    //
    // Se repone la ficha a propósito, en vez de saltarla: así sus checadas tienen
    // a quién colgarse y queda el rastro. Lo que no recupera es el estatus.
    await pool.query(
      `INSERT INTO empleados (sucursal_id, codigo_checador, nombre, activo)
       SELECT $1, $2, $3, NOT EXISTS (
                SELECT 1 FROM padron_depurado d
                 WHERE d.sucursal_id = $1 AND d.codigo_checador = $2)
       ON CONFLICT (sucursal_id, codigo_checador) DO UPDATE
          SET nombre = CASE
                WHEN empleados.nombre IS NULL
                  OR btrim(empleados.nombre) = ''
                  OR empleados.nombre LIKE 'Empleado %'
                THEN EXCLUDED.nombre
                ELSE empleados.nombre
              END`,
      [sucursalId, cod, nombres.get(cod)]
    );
  }

  // ── Inserción ────────────────────────────────────────────────────
  //
  // dedup_key = serie__codigo__fechaHora. La clave vieja era
  // sucursal__codigo__fechaHora, y con ella la checada del SEGUNDO reloj de
  // corporativo (.81, comida) se descartaba como duplicado de la del primero
  // (.80, entrada/salida) cuando caían en el mismo segundo. Ver el comentario
  // largo en db/checadas-vivo.sql.
  //
  // El NOT EXISTS es el puente con el histórico: las filas ya cargadas tienen
  // `serie_reloj` NULL y una dedup_key con otro formato, así que sin este
  // filtro el primer backfill del agente las volvería a insertar todas.
  let aceptadas = 0;
  const LOTE = 200;
  for (let i = 0; i < filas.length; i += LOTE) {
    const grupo = filas.slice(i, i + LOTE);
    const tuplas: string[] = [];
    const params: any[] = [];
    grupo.forEach((c, j) => {
      const cod = codigoFinal(c.codigo);
      const b = j * 10;
      tuplas.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10})`);
      params.push(
        sucursalId, cod, nombres.get(cod) ?? null, c.fechaHora, c.fecha, c.hora,
        c.tipo, `${serie}__${cod}__${c.fechaHora}`, serie, origen
      );
    });
    const r = await pool.query(
      `INSERT INTO checadas
         (sucursal_id, empleado_codigo, empleado_nombre, fecha_hora, fecha, hora, tipo,
          dedup_key, serie_reloj, origen, recibido_en)
       SELECT v.sucursal_id, v.empleado_codigo, v.empleado_nombre, v.fecha_hora, v.fecha, v.hora,
              v.tipo::int, v.dedup_key, v.serie_reloj, v.origen, now()
       FROM (VALUES ${tuplas.join(',')}) AS v
              (sucursal_id, empleado_codigo, empleado_nombre, fecha_hora, fecha, hora,
               tipo, dedup_key, serie_reloj, origen)
       WHERE NOT EXISTS (
         SELECT 1 FROM checadas c
          WHERE c.sucursal_id    = v.sucursal_id
            AND c.empleado_codigo = v.empleado_codigo
            AND c.fecha_hora      = v.fecha_hora
            AND (c.serie_reloj IS NULL OR c.serie_reloj = v.serie_reloj)
       )
       ON CONFLICT (dedup_key) DO NOTHING`,
      params
    );
    aceptadas += r.rowCount || 0;
  }

  base.aceptadas = aceptadas;
  base.duplicadas = filas.length - aceptadas;

  // ── Latido + bitácora ────────────────────────────────────────────
  await tocarEstado(lote, sucursalId, filas.length ? filas[filas.length - 1] : null, aceptadas);

  // El `crudo` NO se guarda cuando el lote se aplicó: un backfill de 8-Esquinas
  // son ~50 mil registros, y archivarlos cada hora llenaría la base con una
  // copia de lo que ya está en `checadas`. Se guarda solo cuando NO se pudo
  // aplicar, que es justo cuando hace falta para reprocesar.
  const { rows: loteRows } = await pool.query(
    `INSERT INTO ingesta_lotes (serie, origen, registros, aceptados, crudo, error)
     VALUES ($1,$2,$3,$4,NULL,NULL) RETURNING id`,
    [serie, origen, entrantes.length, aceptadas]
  );
  base.loteId = loteRows[0].id;
  return base;
}

/**
 * Actualiza el latido. Se llama SIEMPRE, aunque el lote venga vacío: un lote
 * vacío es exactamente lo que dice "el reloj está vivo y no ha checado nadie",
 * y es lo que separa "sin movimiento" de "sin señal".
 */
async function tocarEstado(
  lote: LoteEntrante, sucursalId: string, ultima: ChecadaEntrante | null, _aceptadas: number
) {
  const serie = String(lote.serie || '').trim();
  const info = lote.infoReloj || {};
  let desfase: number | null = null;
  if (info.horaReloj) {
    const t = new Date(info.horaReloj).getTime();
    if (Number.isFinite(t)) desfase = Math.round((t - Date.now()) / 1000);
  }

  // `logs_en_base` solo se recalcula tras un backfill verificado: es un COUNT
  // sobre una tabla grande y no vale la pena por cada evento del stream.
  //
  // Cuenta las de ESTA serie MÁS el histórico sin serie de la misma sucursal.
  // Ese histórico se cargó antes de que existiera el padrón por serie, así que
  // atribuirlo a nadie haría que un reloj con 50 mil checadas cargadas se
  // reportara con "0 en base" y pareciera roto.
  let logsEnBase: number | null = null;
  if (lote.completa) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM checadas
        WHERE serie_reloj = $1 OR (serie_reloj IS NULL AND sucursal_id = $2)`,
      [serie, sucursalId]
    );
    logsEnBase = rows[0]?.n ?? null;
  }

  const origenVisto = info.origenVisto ? new Date(info.origenVisto) : null;

  await pool.query(
    `INSERT INTO relojes_estado
       (serie, ultima_senal, ultima_checada, ultimo_backfill, ip_vista,
        logs_en_reloj, logs_en_base, desfase_reloj_seg, ultimo_error, agente_version, agente_host,
        origen_visto)
     VALUES ($1, now(), ($2::timestamp AT TIME ZONE '${ZONA_RELOJES}'), $3, $4, $5, $6, $7, NULL, $8, $9, $10)
     ON CONFLICT (serie) DO UPDATE SET
       origen_visto   = COALESCE(EXCLUDED.origen_visto, relojes_estado.origen_visto),
       ultima_senal   = now(),
       ultima_checada = GREATEST(relojes_estado.ultima_checada, EXCLUDED.ultima_checada),
       ultimo_backfill = COALESCE(EXCLUDED.ultimo_backfill, relojes_estado.ultimo_backfill),
       ip_vista        = COALESCE(EXCLUDED.ip_vista, relojes_estado.ip_vista),
       logs_en_reloj   = COALESCE(EXCLUDED.logs_en_reloj, relojes_estado.logs_en_reloj),
       logs_en_base    = COALESCE(EXCLUDED.logs_en_base, relojes_estado.logs_en_base),
       desfase_reloj_seg = COALESCE(EXCLUDED.desfase_reloj_seg, relojes_estado.desfase_reloj_seg),
       ultimo_error    = NULL,
       agente_version  = COALESCE(EXCLUDED.agente_version, relojes_estado.agente_version),
       agente_host     = COALESCE(EXCLUDED.agente_host, relojes_estado.agente_host)`,
    [
      serie,
      // ══ SE MANDA LA HORA DE PARED, NO UN Date ══════════════════════
      //
      // Aquí estaba `new Date(ultima.fechaHora)`, y `fechaHora` es siempre
      // `YYYY-MM-DDTHH:mm:ss` SIN offset (`RE_FECHA_HORA` está anclado, así que
      // nunca trae zona): es la hora que marca el reloj de la plaza. Node
      // resuelve una cadena así con la zona del PROCESO, y la API corre en
      // Railway con TZ=UTC — así que las 08:17 de 8-Esquinas se guardaban como
      // 08:17Z, o sea las 02:17 de la mañana en Michoacán.
      //
      // La franja de relojes del portal mostraba entonces una "última checada"
      // seis horas más vieja que la real, justo en la pantalla cuyo trabajo es
      // decir qué tan atrasada va la asistencia. La asistencia en sí NUNCA se
      // vio afectada: en `checadas`, `fecha`, `hora` y `fecha_hora` son TEXT y
      // guardan la hora de pared tal cual. Por eso el error pasó desapercibido
      // tanto tiempo — solo se notaba en una columna que nadie cotejaba.
      //
      // Se arma desde `fecha` y `hora` (los que `normalizar` ya validó y los
      // mismos que van a `checadas`) y se deja que Postgres haga la conversión:
      // sabe de zonas horarias y sobreviviría a que México reinstaurara el
      // horario de verano, cosa que un `-06:00` a mano no.
      ultima?.fecha && ultima?.hora ? `${ultima.fecha} ${ultima.hora}` : null,
      lote.completa ? new Date() : null,
      lote.ip || null,
      typeof info.logCounts === 'number' ? info.logCounts : null,
      logsEnBase,
      desfase,
      lote.agenteVersion || null,
      lote.agenteHost || null,
      origenVisto && Number.isFinite(origenVisto.getTime()) ? origenVisto : null,
    ]
  );

  // La IP del padrón se actualiza sola cuando el agente encuentra el reloj en
  // otra dirección: es informativa, la identidad sigue siendo la serie.
  if (lote.ip) {
    await pool.query('UPDATE relojes SET ip=$2 WHERE serie=$1 AND (ip IS DISTINCT FROM $2)', [serie, lote.ip]);
  }
}

// =====================================================================
// ROUTER DEL AGENTE (sin JWT · token compartido)
// Se monta en /checador/ingesta
// =====================================================================
export const ingestaRouter = Router();
ingestaRouter.use(requireAgente);

/** POST /checador/ingesta — un lote de checadas. Idempotente. */
ingestaRouter.post('/', async (req: Request, res: Response) => {
  try {
    const lote = (req.body || {}) as LoteEntrante;
    if (!lote.serie) return res.status(400).json({ error: 'Falta la serie del reloj.' });
    lote.origen = lote.origen === 'push' ? 'push' : 'agente';

    const r = await aplicarLote(lote);
    if (r.estado === 'serie_desconocida') return res.status(409).json(r);
    if (r.estado === 'pendiente') return res.status(202).json(r);
    res.json(r);
  } catch (e) { fallo(res, e, 'No se pudo procesar el lote de checadas.'); }
});

/** POST /checador/ingesta/latido — el agente reporta que sigue vivo y qué falla. */
ingestaRouter.post('/latido', async (req: Request, res: Response) => {
  try {
    const { serie, ip, error, agenteVersion, agenteHost, infoReloj } = req.body || {};
    if (!serie) return res.status(400).json({ error: 'Falta la serie del reloj.' });
    const { rows } = await pool.query('SELECT sucursal_id FROM relojes WHERE serie=$1', [serie]);
    if (!rows.length) return res.status(409).json({ error: `La serie ${serie} no está en el padrón.` });

    if (error) {
      // Un latido CON error también es señal de vida del agente, pero el error
      // se conserva: es lo que el semáforo del front tiene que poder explicar.
      await pool.query(
        `INSERT INTO relojes_estado (serie, ultima_senal, ip_vista, ultimo_error, agente_version, agente_host)
         VALUES ($1, now(), $2, $3, $4, $5)
         ON CONFLICT (serie) DO UPDATE SET
           ultima_senal = now(),
           ip_vista = COALESCE(EXCLUDED.ip_vista, relojes_estado.ip_vista),
           ultimo_error = EXCLUDED.ultimo_error,
           agente_version = COALESCE(EXCLUDED.agente_version, relojes_estado.agente_version),
           agente_host = COALESCE(EXCLUDED.agente_host, relojes_estado.agente_host)`,
        [serie, ip || null, String(error).slice(0, 500), agenteVersion || null, agenteHost || null]
      );
    } else {
      await tocarEstado(
        { serie, ip, agenteVersion, agenteHost, infoReloj, origen: 'agente' } as LoteEntrante,
        rows[0].sucursal_id, null, 0
      );
    }
    res.json({ ok: true, siguienteBackfillMin: BACKFILL_MIN });
  } catch (e) { fallo(res, e, 'No se pudo registrar el latido.'); }
});

/**
 * GET /checador/ingesta/relojes — el padrón que le toca a este agente.
 * Es lo que le permite descubrir por serie sin llevar la lista en su config, y
 * lo que hace que cambiar una IP sea trabajo de RH y no de campo.
 */
ingestaRouter.get('/relojes', async (req: Request, res: Response) => {
  try {
    const { sucursalId, modo } = req.query as any;
    const cond: string[] = ['activo = TRUE'];
    const params: any[] = [];
    if (sucursalId) { params.push(sucursalId); cond.push(`sucursal_id = $${params.length}`); }
    if (modo) { params.push(modo); cond.push(`modo = $${params.length}`); }
    const { rows } = await pool.query(
      `SELECT serie, sucursal_id, alias, ip, puerto, modo, comm_key, pendiente, nota
         FROM relojes WHERE ${cond.join(' AND ')} ORDER BY sucursal_id, alias`, params
    );
    res.json(rows.map((r: any) => ({
      serie: r.serie, sucursalId: r.sucursal_id, alias: r.alias, ip: r.ip, puerto: r.puerto,
      modo: r.modo, commKey: r.comm_key, pendiente: r.pendiente, nota: r.nota,
    })));
  } catch (e) { fallo(res, e, 'No se pudo leer el padrón de relojes.'); }
});

// =====================================================================
// ROUTER DEL FRONT (con JWT) — el semáforo
// Se monta en /checador/relojes
// =====================================================================
export const relojesRouter = Router();
relojesRouter.use(requireAuth);

const mapReloj = (r: any) => ({
  serie: r.serie, sucursalId: r.sucursal_id, alias: r.alias || '', ip: r.ip || '',
  puerto: r.puerto, modo: r.modo, commKey: r.comm_key, activo: r.activo,
  pendiente: r.pendiente, nota: r.nota || '',
});

/** GET /checador/relojes — el padrón, para administrarlo desde el portal. */
relojesRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT * FROM relojes ORDER BY sucursal_id, alias');
    res.json(rows.map(mapReloj));
  } catch (e) { fallo(res, e, 'No se pudo leer el padrón de relojes.'); }
});

/**
 * GET /checador/relojes/estado — el semáforo.
 *
 * REGLA DE PRODUCTO: la pantalla nunca debe parecer al día cuando no lo está.
 *
 * Por dentro esto ya se maneja bien —el corredor del agente de horarios mide
 * contra `max(checadas.fecha)` de cada sucursal y NO contra CURRENT_DATE, justo
 * para que un reloj sin bajar no invente faltas—. Lo que faltaba era que ese
 * atraso fuera VISIBLE para quien mira la pantalla. Esto no autoriza a suponer
 * presencia: falta de dato ≠ falta del empleado.
 */
relojesRouter.get('/estado', async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.serie, r.sucursal_id, r.alias, r.ip, r.modo, r.pendiente, r.activo, r.nota,
              e.ultima_senal, e.ultima_checada, e.ultimo_backfill, e.ip_vista,
              e.logs_en_reloj, e.logs_en_base, e.desfase_reloj_seg, e.ultimo_error,
              e.agente_version, e.agente_host, e.origen_visto,
              EXTRACT(EPOCH FROM (now() - e.ultima_senal))::int AS segundos_sin_senal,
              EXTRACT(EPOCH FROM (now() - e.origen_visto))::int AS segundos_origen
         FROM relojes r
         LEFT JOIN relojes_estado e ON e.serie = r.serie
        WHERE r.activo = TRUE
        ORDER BY r.sucursal_id, r.alias`
    );

    const MUDO_SEG = 2 * 60 * 60;   // 2 h sin señal = rojo
    const OK_SEG = 10 * 60;         // < 10 min = verde

    res.json(rows.map((r: any) => {
      const s: number | null = r.segundos_sin_senal;
      // Cuánto lleva SIN LEERSE el reloj del lado de quien nos pasa el dato.
      const o: number | null = r.segundos_origen;

      // ══ SE MANDA LO PEOR DE LAS DOS SEÑALES ══════════════════════════
      //
      // `ultima_senal` dice que nuestro agente está vivo. `origen_visto` dice
      // que el sistema del que lee sigue sondeando sus relojes. Con solo la
      // primera, un origen congelado se ve VERDE: el agente sigue reportando
      // puntualmente que no hay nada nuevo, y "no hay nada nuevo" es
      // indistinguible de "nadie ha checado".
      //
      // La regla del módulo es que la pantalla nunca parezca al día cuando no
      // lo está, así que la cadena se mide por su eslabón más débil.
      const peor = [s, o].filter((x): x is number => x != null);
      const atraso = peor.length ? Math.max(...peor) : null;

      let semaforo: 'ok' | 'atrasado' | 'mudo' | 'pendiente';
      if (r.pendiente) semaforo = 'pendiente';
      else if (atraso == null || atraso >= MUDO_SEG) semaforo = 'mudo';
      else if (atraso < OK_SEG) semaforo = 'ok';
      else semaforo = 'atrasado';

      // Cuando el eslabón flojo es el origen, hay que decirlo: revisar nuestro
      // agente no arreglaría nada, y perseguir el problema del lado equivocado
      // es justo lo que hace que estas cosas duren días.
      const origenAtrasado = o != null && s != null && o > s && o >= OK_SEG;

      return {
        serie: r.serie, sucursalId: r.sucursal_id, alias: r.alias || '',
        modo: r.modo, ip: r.ip_vista || r.ip || '', nota: r.nota || '',
        ultimaSenal: r.ultima_senal, ultimaChecada: r.ultima_checada,
        ultimoBackfill: r.ultimo_backfill,
        origenVisto: r.origen_visto,
        segundosOrigen: o,
        origenAtrasado,
        segundosSinSenal: s,
        logsEnReloj: r.logs_en_reloj, logsEnBase: r.logs_en_base,
        desfaseRelojSeg: r.desfase_reloj_seg,
        ultimoError: r.ultimo_error || '',
        agenteVersion: r.agente_version || '', agenteHost: r.agente_host || '',
        semaforo,
      };
    }));
  } catch (e) { fallo(res, e, 'No se pudo leer el estado de los relojes.'); }
});

/** PUT /checador/relojes/:serie — alta/edición del padrón (RH). */
relojesRouter.put('/:serie', async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    if (!b.sucursalId) return res.status(400).json({ error: 'Falta sucursalId.' });
    const { rows } = await pool.query(
      `INSERT INTO relojes (serie, sucursal_id, alias, ip, puerto, modo, comm_key, activo, pendiente, nota)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (serie) DO UPDATE SET
         sucursal_id=EXCLUDED.sucursal_id, alias=EXCLUDED.alias, ip=EXCLUDED.ip,
         puerto=EXCLUDED.puerto, modo=EXCLUDED.modo, comm_key=EXCLUDED.comm_key,
         activo=EXCLUDED.activo, pendiente=EXCLUDED.pendiente, nota=EXCLUDED.nota
       RETURNING *`,
      [req.params.serie, b.sucursalId, b.alias || null, b.ip || null, b.puerto || 4370,
       b.modo || 'agente', b.commKey ?? null, b.activo !== false, b.pendiente === true, b.nota || null]
    );
    res.json(mapReloj(rows[0]));
  } catch (e) { fallo(res, e, 'No se pudo guardar el reloj.'); }
});

/**
 * GET /checador/relojes/lotes-pendientes — lo que llegó y NO se aplicó.
 * Series sin registrar y relojes en pausa. Es trabajo de RH, y sin esta lista
 * el dato existe pero nadie sabe que existe.
 */
relojesRouter.get('/lotes-pendientes', async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT serie, origen, error, count(*)::int AS lotes,
              sum(registros)::int AS registros,
              min(recibido_en) AS primero, max(recibido_en) AS ultimo
         FROM ingesta_lotes
        WHERE error IS NOT NULL
        GROUP BY serie, origen, error
        ORDER BY max(recibido_en) DESC`
    );
    res.json(rows.map((r: any) => ({
      serie: r.serie, origen: r.origen, error: r.error, lotes: r.lotes,
      registros: r.registros, primero: r.primero, ultimo: r.ultimo,
    })));
  } catch (e) { fallo(res, e, 'No se pudieron leer los lotes pendientes.'); }
});

/**
 * POST /checador/relojes/lotes/:serie/reprocesar — aplica los lotes que se
 * habían guardado sin aplicar, ya que la serie está dada de alta o el reloj
 * salió de pausa. Esto es lo que hace que "no perder el dato" sea verdad y no
 * una promesa.
 */
relojesRouter.post('/lotes/:serie/reprocesar', async (req: Request, res: Response) => {
  try {
    const serie = req.params.serie;
    const { rows } = await pool.query(
      `SELECT id, crudo FROM ingesta_lotes
        WHERE serie=$1 AND error IS NOT NULL AND crudo IS NOT NULL
        ORDER BY recibido_en`, [serie]
    );
    let aceptadas = 0, aplicados = 0;
    for (const fila of rows) {
      const r = await aplicarLote({ ...(fila.crudo as any), serie });
      if (r.estado !== 'aplicado') break;      // sigue en pausa o sin registrar: no seguir
      aceptadas += r.aceptadas;
      aplicados++;
      await pool.query(
        `UPDATE ingesta_lotes SET error=NULL, aceptados=$2, crudo=NULL WHERE id=$1`,
        [fila.id, r.aceptadas]
      );
    }
    res.json({ lotes: rows.length, aplicados, aceptadas });
  } catch (e) { fallo(res, e, 'No se pudieron reprocesar los lotes.'); }
});
