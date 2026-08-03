import { Router, Request, Response } from 'express';
import { pool } from './db';
import { requireAuth, AuthedRequest } from './auth';

/**
 * =====================================================================
 * PERMANENCIA — "¿el que contratamos sigue trabajando a los 90 días?"
 * =====================================================================
 *
 * Lo que pidió Capital Humano: medir a cada persona desde su primer contrato
 * hasta los 90 días. Contratar es la mitad del trabajo; si a los dos meses ya
 * no está, la vacante se vuelve a abrir y el proceso completo se repite.
 *
 * ── TRES REGLAS QUE DEFINEN ESTE TABLERO ────────────────────────────
 *
 * 1. NADIE "FALLA" UN HITO QUE TODAVÍA NO LE TOCA. Al que se contrató hace 10
 *    días no se le puede exigir el hito de 90: no ha tenido tiempo. En cada
 *    hito el denominador son solo los ELEGIBLES —los contratados hace al menos
 *    esos días—. Meter a todos en el denominador haría que contratar gente
 *    nueva empeorara el indicador, que es exactamente al revés.
 *
 * 2. EL PORTAL NO REGISTRA BAJAS; EL RELOJ SÍ. La etiqueta "contratado" se pone
 *    el día que la persona entra y nadie la vuelve a tocar cuando renuncia. Si
 *    se midiera con eso, la permanencia daría 100% siempre y el tablero sería
 *    una mentira cómoda. Por eso cada hito trae DOS cifras:
 *      · `enPortal`    — lo que dice la etiqueta (una suposición).
 *      · `confirmados` — checó en el reloj EN o DESPUÉS del día del hito.
 *    La segunda es un hecho: nadie checa en una sucursal si ya no trabaja ahí.
 *
 * 3. LA LIGA CON EL RELOJ LA CONFIRMA UNA PERSONA. Cruzar por nombre acierta
 *    casi siempre y se equivoca lo suficiente como para no poder afirmar nada
 *    con eso solo (homónimos, apellidos invertidos, apodos en el reloj). El
 *    sistema SUGIERE la liga; hasta que RH la confirma, esa persona cuenta como
 *    "sin verificar" y no suma en `confirmados`. Un indicador construido sobre
 *    coincidencias de texto no aguanta la primera pregunta incómoda.
 */
export const permanenciaRouter = Router();
permanenciaRouter.use(requireAuth);

const TZ = 'America/Mexico_City';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Los cortes que se reportan. El de 90 es el que pidió RH; los previos avisan antes. */
const HITOS = [7, 30, 60, 90];

/** Días sin una sola marca tras los que una persona ligada deja de contar como activa. */
const DIAS_SILENCIO = 7;

function fallo(res: Response, e: any, msg: string) {
  console.error('[permanencia]', msg, e);
  return res.status(500).json({ error: msg });
}

// ── Cruce de nombres ─────────────────────────────────────────────────
//
// El reloj guarda "GARCIA LOPEZ MARIA" y el portal "María García López": mismo
// ser humano, cero coincidencia si se comparan las cadenas tal cual. Se comparan
// CONJUNTOS de palabras, que sobreviven al orden y a los acentos.

const tokens = (s: string): string[] =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3);   // fuera "de", "la", "y"

/**
 * ¿Los dos nombres son la misma persona? Se pide que TODAS las palabras del
 * nombre más corto estén en el más largo, y que sean al menos 2. Con una sola
 * palabra en común ("María") medio padrón haría match.
 */
function mismoNombre(a: string, b: string): boolean {
  const ta = new Set(tokens(a)), tb = new Set(tokens(b));
  if (ta.size < 2 || tb.size < 2) return false;
  const [chico, grande] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  let comunes = 0;
  for (const t of chico) if (grande.has(t)) comunes++;
  return comunes === chico.size && comunes >= 2;
}

/** Días completos entre dos fechas 'YYYY-MM-DD' (positivo si b es posterior). */
const diasEntre = (a: string, b: string): number =>
  Math.floor((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);

/** Suma días a una fecha 'YYYY-MM-DD' y devuelve otra 'YYYY-MM-DD'. */
const masDias = (f: string, d: number): string =>
  new Date(Date.parse(f + 'T12:00:00Z') + d * 86400000).toISOString().slice(0, 10);

// =====================================================================
// EL TABLERO
// =====================================================================

/** GET /permanencia — todo el panorama en una sola respuesta. */
permanenciaRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const hoy: string = (await pool.query(
      `SELECT to_char((now() AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS d`
    )).rows[0].d;

    // ── 1. Quién fue contratado y cuándo ─────────────────────────────
    //
    // Se incluye a quien YA NO está marcado como contratado: si alguien pasó por
    // el puesto y se fue, tiene que contar en el denominador. Excluirlo sería
    // medir la permanencia solo entre los que permanecieron.
    const { rows: contratados } = await pool.query(
      `WITH base AS (
         SELECT c.id, c.nombre_completo AS nombre, coalesce(c.puesto_interes, '') AS puesto,
                c.portal_status AS estado,
                c.portal_data->>'hiredAt' AS hired_txt,
                (SELECT min(t.cambiado_en) FROM candidatos_transiciones t
                  WHERE t.candidato_id = c.id AND t.etapa_destino = 'contratado') AS transicion
           FROM candidatos c
          WHERE c.deleted_at IS NULL
            AND (c.portal_status = 'contratado'
                 OR c.portal_data->>'hiredAt' IS NOT NULL
                 OR EXISTS (SELECT 1 FROM candidatos_transiciones t
                             WHERE t.candidato_id = c.id AND t.etapa_destino = 'contratado'))
       )
       SELECT id, nombre, puesto, estado,
              -- La fecha capturada al contratar manda. Si no existe (contratados
              -- de antes de que se guardara), sirve la del historial de etapas.
              to_char(
                coalesce(
                  CASE WHEN hired_txt ~ '^\\d{4}-\\d{2}-\\d{2}'
                       THEN substring(hired_txt from 1 for 10)::date END,
                  (transicion AT TIME ZONE '${TZ}')::date
                ), 'YYYY-MM-DD') AS ingreso,
              (hired_txt IS NOT NULL) AS "fechaPropia"
         FROM base
        ORDER BY 5 DESC NULLS LAST, nombre`
    );

    // ── 2. El padrón del reloj, con su última marca ──────────────────
    const { rows: empleados } = await pool.query(
      `SELECT e.id, e.sucursal_id AS "sucursalId", e.codigo_checador AS codigo,
              e.nombre, e.puesto, e.activo, e.candidato_id AS "candidatoId",
              ch.ultima, ch.dias_marcados AS "diasMarcados"
         FROM empleados e
         LEFT JOIN (
           SELECT empleado_codigo, sucursal_id,
                  max(fecha) AS ultima, count(DISTINCT fecha)::int AS dias_marcados
             FROM checadas GROUP BY 1, 2
         ) ch ON ch.empleado_codigo = e.codigo_checador AND ch.sucursal_id = e.sucursal_id`
    );

    const porCandidato = new Map<string, any>();
    for (const e of empleados) if (e.candidatoId) porCandidato.set(String(e.candidatoId), e);
    // Los ya ligados a alguien más no se vuelven a sugerir.
    const libres = empleados.filter((e: any) => !e.candidatoId);

    // ── 3. Persona por persona ───────────────────────────────────────
    const personas = contratados.map((c: any) => {
      const ingreso: string | null = c.ingreso;
      const dias = ingreso ? Math.max(0, diasEntre(ingreso, hoy)) : null;

      const ligado = porCandidato.get(String(c.id)) || null;
      const sugerido = ligado ? null : libres.find((e: any) => mismoNombre(e.nombre, c.nombre)) || null;
      const emp = ligado || sugerido;

      const ultima: string | null = emp?.ultima || null;
      const diasSinChecar = ultima ? diasEntre(ultima, hoy) : null;
      // Hasta qué día de su contrato se puede PROBAR que seguía viniendo.
      const diasProbados = (ligado && ultima && ingreso) ? Math.max(0, diasEntre(ingreso, ultima)) : null;

      const sigueEnPortal = c.estado === 'contratado';
      const estado: string =
        !sigueEnPortal                              ? 'baja_portal'
        : !ligado                                   ? 'sin_verificar'
        : diasSinChecar != null && diasSinChecar <= DIAS_SILENCIO ? 'activo'
        :                                             'sin_marcas';

      return {
        id: c.id, nombre: c.nombre, puesto: c.puesto,
        ingreso, dias, fechaPropia: c.fechaPropia, sigueEnPortal, estado,
        // Último hito cumplido, para la etiqueta de la fila.
        hito: dias == null ? null : [...HITOS].reverse().find(h => dias >= h) ?? null,
        empleado: emp ? {
          id: emp.id, codigo: emp.codigo, nombre: emp.nombre,
          sucursalId: emp.sucursalId, activo: emp.activo,
          confirmado: !!ligado,          // false = es una sugerencia por nombre
          diasMarcados: emp.diasMarcados ?? 0
        } : null,
        ultimaChecada: ultima, diasSinChecar, diasProbados
      };
    });

    const conFecha = personas.filter(p => p.ingreso);
    const sinFecha = personas.length - conFecha.length;

    // ── 4. Los hitos ─────────────────────────────────────────────────
    const hitos = HITOS.map(dia => {
      const elegibles = conFecha.filter(p => (p.dias ?? 0) >= dia);
      const enPortal = elegibles.filter(p => p.sigueEnPortal).length;
      // Prueba dura: checó en o después del día del hito.
      const confirmados = elegibles.filter(p =>
        p.empleado?.confirmado && p.ultimaChecada && p.ingreso &&
        p.ultimaChecada >= masDias(p.ingreso, dia)
      ).length;
      const sinVerificar = elegibles.filter(p => !p.empleado?.confirmado).length;
      return {
        dia,
        elegibles: elegibles.length,
        enPortal, confirmados, sinVerificar,
        pctPortal: elegibles.length ? Math.round((enPortal / elegibles.length) * 100) : null,
        // El % confirmado se calcula sobre los VERIFICABLES, no sobre todos: con
        // 3 de 20 ligados, dividir entre 20 daría 15% y se leería como una
        // rotación catastrófica cuando lo que falta es capturar las ligas.
        verificables: elegibles.length - sinVerificar,
        pctConfirmado: (elegibles.length - sinVerificar)
          ? Math.round((confirmados / (elegibles.length - sinVerificar)) * 100) : null
      };
    });

    // ── 5. Cohortes: cada mes de contratación, cómo le fue ───────────
    const cohortes: any[] = [];
    for (const p of conFecha) {
      const mes = (p.ingreso as string).slice(0, 7);
      let c = cohortes.find(x => x.mes === mes);
      if (!c) { c = { mes, n: 0, hitos: {} as Record<number, any> }; cohortes.push(c); }
      c.n++;
      for (const h of HITOS) {
        c.hitos[h] ||= { elegibles: 0, confirmados: 0, enPortal: 0 };
        if ((p.dias ?? 0) >= h) {
          c.hitos[h].elegibles++;
          if (p.sigueEnPortal) c.hitos[h].enPortal++;
          if (p.empleado?.confirmado && p.ultimaChecada && p.ultimaChecada >= masDias(p.ingreso as string, h)) {
            c.hitos[h].confirmados++;
          }
        }
      }
    }
    cohortes.sort((a, b) => b.mes.localeCompare(a.mes));

    // ── 6. Avisos: por qué un número es lo que es ────────────────────
    const ligados = personas.filter(p => p.empleado?.confirmado).length;
    const sugeridos = personas.filter(p => p.empleado && !p.empleado.confirmado).length;
    const sinLiga = personas.filter(p => !p.empleado).length;

    const avisos: string[] = [];
    if (!personas.length) {
      avisos.push('Todavía no hay nadie marcado como Contratado, así que la permanencia no tiene a quién medir.');
    }
    if (sinFecha) {
      avisos.push(`${sinFecha} contratado(s) no tienen fecha de ingreso registrada: no se les puede contar los días. Se arregla poniéndoles la fecha en su expediente.`);
    }
    if (sugeridos) {
      avisos.push(`Hay ${sugeridos} coincidencia(s) de nombre con el padrón del reloj sin confirmar. Mientras no se confirmen, esas personas no cuentan como verificadas.`);
    }
    // Medido el 03/08/2026: los 385 empleados del padrón están capturados con su
    // NOMBRE DE PILA a secas ("Daniela", "Jessica"). Sin apellidos no hay con qué
    // cruzar, y bajar la exigencia a una sola palabra ligaría a la primera
    // Daniela que aparezca —confundir dos personas aquí significa medirle la
    // permanencia a quien no es—. Así que el cruce automático se queda callado y
    // la pantalla dice por qué, en vez de parecer que está roto.
    const soloNombrePila = empleados.filter((e: any) => String(e.nombre || '').trim().split(/\s+/).length < 2).length;
    if (soloNombrePila && personas.length) {
      avisos.push(`En el padrón del reloj, ${soloNombrePila} de ${empleados.length} empleados están capturados solo con su nombre de pila, sin apellidos. Con eso no se puede cruzar solo sin arriesgar confundir a dos personas: la liga hay que hacerla a mano con el buscador (una vez por persona, queda guardada).`);
    }
    if (sinLiga) {
      avisos.push(`${sinLiga} contratado(s) no aparecen en el padrón del reloj. De ellos solo se sabe lo que dice el portal, que no registra bajas.`);
    }
    if (ligados && !cohortes.length) {
      avisos.push('Aún no hay un mes completo de contrataciones con fecha: las cohortes aparecen conforme se acumulen.');
    }

    return res.json({
      hoy,
      hitosDias: HITOS,
      resumen: {
        total: personas.length,
        conFecha: conFecha.length,
        sinFecha,
        ligados, sugeridos, sinLiga,
        activos: personas.filter(p => p.estado === 'activo').length,
        sinMarcas: personas.filter(p => p.estado === 'sin_marcas').length,
        bajaPortal: personas.filter(p => p.estado === 'baja_portal').length
      },
      hitos,
      cohortes,
      personas,
      avisos
    });
  } catch (e) { return fallo(res, e, 'No se pudo calcular la permanencia.'); }
});

// =====================================================================
// LA LIGA CON EL RELOJ
// =====================================================================

/**
 * GET /permanencia/empleados?q=maria — para buscar a mano cuando el nombre no
 * coincide (apodos, apellidos invertidos, capturas con errores de dedo).
 * Devuelve solo los que no están ya ligados a otro candidato.
 */
permanenciaRouter.get('/empleados', async (req: Request, res: Response) => {
  const q = String(req.query.q || '').trim();
  try {
    const { rows } = await pool.query(
      `SELECT e.id, e.nombre, e.puesto, e.sucursal_id AS "sucursalId",
              e.codigo_checador AS codigo, e.activo,
              (SELECT max(fecha) FROM checadas ch
                WHERE ch.empleado_codigo = e.codigo_checador
                  AND ch.sucursal_id = e.sucursal_id) AS ultima
         FROM empleados e
        WHERE e.candidato_id IS NULL
          AND ($1 = '' OR e.nombre ILIKE '%' || $1 || '%')
        ORDER BY e.nombre LIMIT 40`,
      [q]
    );
    return res.json(rows);
  } catch (e) { return fallo(res, e, 'No se pudo buscar en el padrón del reloj.'); }
});

/**
 * POST /permanencia/vincular — confirma (o deshace) que este candidato ES este
 * empleado del reloj.
 * Body: { candidatoId, empleadoId }  ·  empleadoId null = desligar.
 */
permanenciaRouter.post('/vincular', async (req: AuthedRequest, res: Response) => {
  const b = req.body || {};
  const candidatoId = String(b.candidatoId || '').trim();
  const empleadoId = b.empleadoId ? String(b.empleadoId).trim() : null;

  if (!UUID_RE.test(candidatoId)) return res.status(400).json({ error: 'candidatoId inválido.' });
  if (empleadoId && !UUID_RE.test(empleadoId)) return res.status(400).json({ error: 'empleadoId inválido.' });

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');

    // Una persona es un solo empleado: antes de ligar se suelta cualquier liga
    // anterior de este candidato. Sin esto, corregir una liga equivocada dejaría
    // dos filas apuntando al mismo candidato y lo contaría dos veces.
    await cliente.query('UPDATE empleados SET candidato_id = NULL WHERE candidato_id = $1::uuid', [candidatoId]);

    if (empleadoId) {
      const existe = await cliente.query('SELECT 1 FROM candidatos WHERE id = $1::uuid AND deleted_at IS NULL', [candidatoId]);
      if (!existe.rows.length) { await cliente.query('ROLLBACK'); return res.status(404).json({ error: 'Candidato no encontrado.' }); }

      const r = await cliente.query(
        `UPDATE empleados SET candidato_id = $1::uuid
          WHERE id = $2::uuid AND (candidato_id IS NULL OR candidato_id = $1::uuid)
          RETURNING id, nombre, codigo_checador AS codigo, sucursal_id AS "sucursalId"`,
        [candidatoId, empleadoId]
      );
      if (!r.rowCount) {
        await cliente.query('ROLLBACK');
        return res.status(409).json({ error: 'Ese empleado del reloj ya está ligado a otro candidato.' });
      }

      // Queda en la bitácora del candidato: quién lo ligó y con qué código.
      await cliente.query(
        `INSERT INTO candidatos_eventos (candidato_id, tipo, canal, nota, por)
         VALUES ($1::uuid, 'nota', 'portal', $2, $3)`,
        [candidatoId,
         `Ligado al reloj checador: ${r.rows[0].nombre} (código ${r.rows[0].codigo}, ${r.rows[0].sucursalId})`,
         (req.usuario as any)?.nombre || (req.usuario as any)?.email || 'RH']
      );
      await cliente.query('COMMIT');
      return res.json({ ok: true, empleado: r.rows[0] });
    }

    await cliente.query('COMMIT');
    return res.json({ ok: true, empleado: null });
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    return fallo(res, e, 'No se pudo guardar la liga con el reloj.');
  } finally {
    cliente.release();
  }
});

/**
 * PATCH /permanencia/ingreso — corrige la fecha de ingreso de un contratado.
 * Body: { candidatoId, fecha: 'YYYY-MM-DD' }
 *
 * Existe porque sin fecha no hay días que contar, y varios contratados de antes
 * de que se guardara `hiredAt` se quedaron sin ella. Se escribe en `portal_data`
 * —el mismo lugar donde la pone el portal al contratar— para que no haya dos
 * versiones de la verdad.
 */
permanenciaRouter.patch('/ingreso', async (req: AuthedRequest, res: Response) => {
  const b = req.body || {};
  const candidatoId = String(b.candidatoId || '').trim();
  const fecha = String(b.fecha || '').trim();

  if (!UUID_RE.test(candidatoId)) return res.status(400).json({ error: 'candidatoId inválido.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({ error: 'La fecha debe ser YYYY-MM-DD.' });

  try {
    const hoy = (await pool.query(`SELECT to_char((now() AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS d`)).rows[0].d;
    if (fecha > hoy) return res.status(400).json({ error: 'La fecha de ingreso no puede ser futura.' });

    const r = await pool.query(
      `UPDATE candidatos
          SET portal_data = coalesce(portal_data, '{}'::jsonb) || jsonb_build_object('hiredAt', $2::text)
        WHERE id = $1::uuid AND deleted_at IS NULL
        RETURNING id`,
      [candidatoId, fecha]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Candidato no encontrado.' });
    return res.json({ ok: true, ingreso: fecha });
  } catch (e) { return fallo(res, e, 'No se pudo guardar la fecha de ingreso.'); }
});
