import { pool } from '../db';
import { asistenciaPersonas, EXTRA_BLOQUE_MIN } from './asistencia-personas';

/**
 * BANCO DE HORAS EXTRA (08/10/2026).
 *
 * Lo que cada persona GANA quedándose después de su hora de salida (bloques de
 * 30 min, ver EXTRA_BLOQUE_MIN en asistencia-personas.ts) y lo que USA cuando
 * RH captura "Uso de horas extra". El saldo es ganadas − usadas, contado desde
 * `HORAS_EXTRA_DESDE`: antes de esa fecha no había banco, y contar meses atrás
 * daría saldos que nadie autorizó.
 *
 * No se guarda en ninguna tabla: sale del mismo cálculo de asistencia, así que
 * una checada que llega tarde o un "Horario distinto" capturado después
 * corrigen el saldo solos. Lo único guardado son los AJUSTES de RH
 * (`horas_extra_ajustes`): el saldo inicial de quien ya traía horas de antes
 * del banco, o una corrección.
 *
 * Desde el 06/11/2026 el banco también baja cuando RH captura "Pago de horas
 * extras" (tipo `pago_horas_extra`): le pagaron el tiempo en efectivo en vez de
 * tomarlo, así que esas horas salen del banco igual que las usadas. Se registra
 * como un total en una fecha y NO toca la asistencia de ese día.
 *
 * Saldo = ganadas − usadas − pagadas + ajustes.
 */
export const HORAS_EXTRA_DESDE = process.env.HORAS_EXTRA_DESDE || '2026-09-24';

export interface DiaExtra {
  fecha: string;
  entrada: string | null;
  salida: string | null;
  /** A qué hora debía salir ese día. */
  salidaEsperada: string | null;
  extraMin: number;
}

export interface UsoExtra {
  id: string;
  desde: string;
  hasta: string;
  /** Minutos por día. */
  minutos: number;
  /** Días dentro del banco (desde HORAS_EXTRA_DESDE hasta la fecha pedida). */
  dias: number;
  totalMin: number;
  nota: string;
}

export interface PagoExtra {
  id: string;
  /** Día en que se registró el pago. */
  fecha: string;
  /** Total de minutos pagados (descuenta del saldo). */
  minutos: number;
  /** Referencia del pago (p. ej. "nómina del 15"). */
  nota: string;
}

export interface AjusteExtra {
  id: string;
  fecha: string;
  /** Con signo: +330 suma 5 h 30 min; −60 resta 1 h. */
  minutos: number;
  motivo: string;
  creadoPor: string;
  creadoEn: string;
}

export interface PersonaExtra {
  codigo: string;
  nombreCompleto: string;
  departamento: string | null;
  /** Contra qué salida se midió: su horario asignado o el deducido. */
  segun: 'asignado' | 'deducido' | null;
  salida: string | null;
  ganadasMin: number;
  usadasMin: number;
  /** Horas que ya se le pagaron en efectivo (descuentan del saldo). */
  pagadasMin: number;
  /** Saldo inicial y correcciones de RH (con signo). */
  ajustesMin: number;
  saldoMin: number;
  ganadas: DiaExtra[];
  usos: UsoExtra[];
  pagos: PagoExtra[];
  ajustes: AjusteExtra[];
}

export interface BancoHorasExtra {
  sucursalId: string;
  desde: string;
  hasta: string;
  bloqueMin: number;
  /** Personas de planta a las que NO se les calculan (medio tiempo, rotativo o sin horario). */
  sinHorarioFijo: number;
  personas: PersonaExtra[];
}

const diasEntre = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000) + 1;

const aFecha = (v: any): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').slice(0, 10);

/** Los ajustes vigentes (no anulados) de la plaza hasta `hasta`, por código. */
async function ajustesDe(sucursalId: string, hasta: string): Promise<Map<string, AjusteExtra[]>> {
  const out = new Map<string, AjusteExtra[]>();
  try {
    const { rows } = await pool.query(
      `SELECT id, empleado_codigo, fecha, minutos, motivo, creado_por, creado_en
         FROM horas_extra_ajustes
        WHERE sucursal_id = $1 AND anulado_en IS NULL AND fecha <= $2::date
        ORDER BY fecha, creado_en`,
      [sucursalId, hasta]);
    for (const r of rows) {
      const cod = String(r.empleado_codigo).trim();
      if (!out.has(cod)) out.set(cod, []);
      out.get(cod)!.push({
        id: r.id, fecha: aFecha(r.fecha), minutos: Number(r.minutos), motivo: r.motivo || '',
        creadoPor: r.creado_por || '', creadoEn: r.creado_en ? new Date(r.creado_en).toISOString() : '',
      });
    }
  } catch (e: any) {
    if (e?.code !== '42P01') throw e;   // sin la tabla (sin migrar): sin ajustes
  }
  return out;
}

export async function bancoHorasExtra(sucursalId: string, hasta: string, codigo?: string): Promise<BancoHorasExtra> {
  const desde = HORAS_EXTRA_DESDE;
  const vacio = { sucursalId, desde, hasta, bloqueMin: EXTRA_BLOQUE_MIN, sinHorarioFijo: 0, personas: [] };
  if (hasta < desde) return vacio;
  const [a, ajustes] = await Promise.all([asistenciaPersonas({ sucursalId, desde, hasta }), ajustesDe(sucursalId, hasta)]);
  const personas: PersonaExtra[] = [];
  let sinHorarioFijo = 0;
  for (const p of a.personas) {
    if (!codigo && !p.horasExtraSegun && p.registrado) sinHorarioFijo++;
    if (codigo && p.codigo !== codigo) continue;
    const ganadas: DiaExtra[] = [];
    for (const s of p.semanas) for (const d of s.dias) {
      if (d.extraMin) {
        ganadas.push({
          fecha: d.fecha, entrada: d.entrada ?? null, salida: d.salida ?? null,
          salidaEsperada: d.salidaEsperada ?? null, extraMin: d.extraMin,
        });
      }
    }
    // El uso sale de las incidencias, no de los días armados: quien usó horas
    // un día que no checó también las gastó.
    const usos: UsoExtra[] = p.incidencias
      .filter((i) => i.tipo === 'horas_extra' && Number(i.minutos) > 0)
      .map((i) => {
        const ini = i.desde > desde ? i.desde : desde;
        const fin = i.hasta < hasta ? i.hasta : hasta;
        const dias = fin >= ini ? diasEntre(ini, fin) : 0;
        return { id: i.id, desde: i.desde, hasta: i.hasta, minutos: Number(i.minutos), dias, totalMin: dias * Number(i.minutos), nota: i.nota || '' };
      })
      .filter((u) => u.dias > 0);
    // Pago de horas extra: total en una fecha. A diferencia del uso, no se
    // multiplica por días; cada registro descuenta sus `minutos` del saldo.
    const pagos: PagoExtra[] = p.incidencias
      .filter((i) => i.tipo === 'pago_horas_extra' && Number(i.minutos) > 0 && i.desde >= desde && i.desde <= hasta)
      .map((i) => ({ id: i.id, fecha: i.desde, minutos: Number(i.minutos), nota: i.nota || '' }));
    const ganadasMin = ganadas.reduce((t, x) => t + x.extraMin, 0);
    const usadasMin = usos.reduce((t, x) => t + x.totalMin, 0);
    const pagadasMin = pagos.reduce((t, x) => t + x.minutos, 0);
    const susAjustes = ajustes.get(p.codigo) || [];
    const ajustesMin = susAjustes.reduce((t, x) => t + x.minutos, 0);
    if (!p.horasExtraSegun && !ganadasMin && !usadasMin && !pagadasMin && !susAjustes.length) continue;
    personas.push({
      codigo: p.codigo, nombreCompleto: p.nombreCompleto, departamento: p.departamento,
      segun: p.horasExtraSegun, salida: p.salida,
      ganadasMin, usadasMin, pagadasMin, ajustesMin, saldoMin: ganadasMin - usadasMin - pagadasMin + ajustesMin,
      ganadas, usos, pagos, ajustes: susAjustes,
    });
  }
  personas.sort((x, y) => y.saldoMin - x.saldoMin || x.nombreCompleto.localeCompare(y.nombreCompleto, 'es'));
  return { ...vacio, sinHorarioFijo, personas };
}

/** Captura un ajuste (saldo inicial o corrección). Devuelve el ajuste guardado. */
export async function crearAjuste(a: {
  sucursalId: string; codigo: string; minutos: number; motivo: string; fecha: string; quien: string;
}): Promise<AjusteExtra> {
  const { rows } = await pool.query(
    `INSERT INTO horas_extra_ajustes (sucursal_id, empleado_codigo, minutos, fecha, motivo, creado_por)
     VALUES ($1, $2, $3, $4::date, $5, $6)
     RETURNING id, fecha, minutos, motivo, creado_por, creado_en`,
    [a.sucursalId, a.codigo, a.minutos, a.fecha, a.motivo, a.quien]);
  const r = rows[0];
  return { id: r.id, fecha: aFecha(r.fecha), minutos: Number(r.minutos), motivo: r.motivo, creadoPor: r.creado_por || '', creadoEn: new Date(r.creado_en).toISOString() };
}

/** Anula un ajuste (no se borra). false si no existía o ya estaba anulado. */
export async function anularAjuste(id: string, motivo: string, quien: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE horas_extra_ajustes SET anulado_en = now(), anulado_por = $2, motivo_anulacion = $3
      WHERE id = $1 AND anulado_en IS NULL`,
    [id, quien, motivo]);
  return (rowCount || 0) > 0;
}

/** Hoy en México, 'yyyy-MM-dd'. */
export function hoyMexico(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
