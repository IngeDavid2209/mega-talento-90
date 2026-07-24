import { pool } from '../db';
import { cargarConfig } from './config';
import { analizarDia } from './reglas';
import {
  BorradorAlerta, ChecadaMin, EmpleadoMin, HorarioMin, Inconsistencia, ReglaConfig,
} from './tipos';

/**
 * ORQUESTACIÓN del agente: carga datos de lo que YA existe (checadas, empleados,
 * horarios_sucursal), agrupa por empleado-día, corre el motor puro (reglas.ts) y
 * arma los borradores. NO persiste (eso lo hace persistencia.ts) ni notifica
 * (ver notificador.ts / handoff). Solo lee y detecta.
 */

// ---------- utilidades de fecha (sin dependencias externas) ----------
/** Día de la semana (0=domingo..6=sábado) de una fecha 'yyyy-MM-dd', a mediodía UTC. */
function diaSemanaDe(fecha: string): number {
  return new Date(`${fecha}T12:00:00Z`).getUTCDay();
}
/** Lista de fechas 'yyyy-MM-dd' entre desde y hasta (inclusive). */
function rangoFechas(desde: string, hasta: string): string[] {
  const out: string[] = [];
  let d = new Date(`${desde}T12:00:00Z`);
  const fin = new Date(`${hasta}T12:00:00Z`);
  let guarda = 0;
  while (d <= fin && guarda++ < 4000) {
    out.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 24 * 3600 * 1000);
  }
  return out;
}
/** 'yyyy-MM-dd' de HOY en zona de México (para saber si un día ya "cerró"). */
function hoyMexico(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/** Convierte una fila de horarios_sucursal a HorarioMin. */
function filaAHorarioMin(h: any, ambiguo: boolean): HorarioMin {
  return {
    nombre: h.nombre,
    dias: h.dias || [],
    entrada: h.entrada,
    salida: h.salida,
    inicioComida: h.inicio_comida,
    finComida: h.fin_comida,
    toleranciaMin: h.tolerancia_min || 0,
    ambiguo,
  };
}

/**
 * Horario GENERAL de la sucursal para un día de la semana (fallback cuando el
 * empleado NO tiene turno asignado). Si hay varios candidatos, prefiere el
 * general (area_id NULL) y marca `ambiguo=true` para que RH lo sepa.
 */
function horarioGeneral(horarios: any[], diaSemana: number): HorarioMin | null {
  const candidatos = horarios.filter(
    (h) => h.activo !== false && Array.isArray(h.dias) && h.dias.includes(diaSemana)
  );
  if (!candidatos.length) return null;
  const generales = candidatos.filter((h) => !h.area_id);
  const elegido = (generales[0] || candidatos[0]);
  return filaAHorarioMin(elegido, candidatos.length > 1);
}

export interface ParametrosAnalisis {
  sucursalId: string;
  desde: string;   // 'yyyy-MM-dd'
  hasta: string;   // 'yyyy-MM-dd'
}

export interface ResultadoAnalisis {
  borradores: BorradorAlerta[];
  resumen: {
    sucursalId: string;
    desde: string;
    hasta: string;
    empleadosAnalizados: number;
    diasAnalizados: number;
    checadasLeidas: number;
    totalInconsistencias: number;
    porRegla: Record<string, number>;
    empleadosSinTurno: number; // empleados-día sin horario aplicable (no se pudo evaluar retardo/turno/falta)
  };
}

/**
 * Corre la detección para una sucursal y un rango. Devuelve los borradores y un
 * resumen. NO escribe en la base (lo hace el llamador con persistencia.ts).
 */
export async function detectar({ sucursalId, desde, hasta }: ParametrosAnalisis): Promise<ResultadoAnalisis> {
  const config: ReglaConfig = await cargarConfig(sucursalId);
  const hoy = hoyMexico();

  // 1) Empleados activos de la sucursal (para faltas, nombre y turno asignado).
  const empRes = await pool.query(
    'SELECT codigo_checador, nombre, horario_id FROM empleados WHERE sucursal_id=$1 AND activo=TRUE',
    [sucursalId]
  );
  const empleados: EmpleadoMin[] = empRes.rows.map((r) => ({
    sucursalId, codigo: String(r.codigo_checador).trim(), nombre: r.nombre,
  }));
  const horarioIdPorCodigo = new Map<string, string | null>();
  for (const r of empRes.rows) horarioIdPorCodigo.set(String(r.codigo_checador).trim(), r.horario_id || null);

  // 2) Horarios de la sucursal (para turno/retardo/falta), indexados por id.
  const horRes = await pool.query('SELECT * FROM horarios_sucursal WHERE sucursal_id=$1', [sucursalId]);
  const horarios = horRes.rows;
  const horariosPorId = new Map<string, any>(horarios.map((h) => [h.id, h]));

  // 3) Checadas del rango.
  const chkRes = await pool.query(
    `SELECT empleado_codigo, empleado_nombre, fecha, fecha_hora, hora, tipo
       FROM checadas
      WHERE sucursal_id=$1 AND fecha>=$2 AND fecha<=$3
      ORDER BY empleado_codigo, fecha, fecha_hora`,
    [sucursalId, desde, hasta]
  );
  const checadasLeidas = chkRes.rowCount || 0;

  // Índice: codigo -> fecha -> ChecadaMin[], y codigo -> nombre visto en checadas.
  const porEmpleadoDia = new Map<string, Map<string, ChecadaMin[]>>();
  const nombrePorCodigo = new Map<string, string>();
  for (const e of empleados) nombrePorCodigo.set(e.codigo, e.nombre);
  for (const r of chkRes.rows) {
    const codigo = String(r.empleado_codigo).trim();
    if (r.empleado_nombre && !nombrePorCodigo.has(codigo)) nombrePorCodigo.set(codigo, r.empleado_nombre);
    if (!porEmpleadoDia.has(codigo)) porEmpleadoDia.set(codigo, new Map());
    const porDia = porEmpleadoDia.get(codigo)!;
    if (!porDia.has(r.fecha)) porDia.set(r.fecha, []);
    porDia.get(r.fecha)!.push({ fechaHora: r.fecha_hora, hora: r.hora, tipo: r.tipo ?? null });
  }

  // Universo de empleados a evaluar = activos ∪ los que aparecen en checadas.
  const codigos = new Set<string>([...empleados.map((e) => e.codigo), ...porEmpleadoDia.keys()]);
  const fechas = rangoFechas(desde, hasta);

  // Pre-cálculo del horario GENERAL por día de la semana (fallback para empleados
  // SIN turno asignado; se reutiliza entre empleados).
  const generalPorDia = new Map<number, HorarioMin | null>();
  for (const f of fechas) {
    const ds = diaSemanaDe(f);
    if (!generalPorDia.has(ds)) generalPorDia.set(ds, horarioGeneral(horarios, ds));
  }

  const borradores: BorradorAlerta[] = [];
  const porRegla: Record<string, number> = {};
  let empleadosSinTurno = 0;

  for (const codigo of codigos) {
    const nombre = nombrePorCodigo.get(codigo) || codigo;
    const porDia = porEmpleadoDia.get(codigo) || new Map<string, ChecadaMin[]>();
    // ¿Tuvo alguna checada en TODO el rango? (anti-ruido de faltas).
    const conActividad = porDia.size > 0;
    // Turno ASIGNADO al empleado (si lo tiene): manda sobre el general.
    const asignadoId = horarioIdPorCodigo.get(codigo) || null;
    const asignadoRow = asignadoId ? horariosPorId.get(asignadoId) : null;

    for (const fecha of fechas) {
      const ds = diaSemanaDe(fecha);
      // Turno del día: el asignado (si aplica ese día) o el general de la sucursal.
      let horario: HorarioMin | null;
      if (asignadoRow) {
        horario = (asignadoRow.activo !== false && Array.isArray(asignadoRow.dias) && asignadoRow.dias.includes(ds))
          ? filaAHorarioMin(asignadoRow, false)
          : null; // ese día no es laborable para su turno asignado (descanso)
      } else {
        horario = generalPorDia.get(ds) ?? null;
      }
      const checadas = (porDia.get(fecha) || []).slice().sort((a, b) => a.fechaHora.localeCompare(b.fechaHora));

      // Sin turno y sin checadas: nada que evaluar (día de descanso / no laboral).
      if (!horario && checadas.length === 0) continue;
      if (!horario && checadas.length > 0) empleadosSinTurno++;

      const inconsistencias: Inconsistencia[] = analizarDia({
        empleado: { sucursalId, codigo, nombre },
        fecha, diaSemana: ds, cerrado: fecha < hoy,
        checadas, horario, config,
        empleadoConActividadRango: conActividad,
      });

      for (const inc of inconsistencias) {
        porRegla[inc.regla] = (porRegla[inc.regla] || 0) + 1;
        borradores.push({ ...inc, sucursalId, empleadoCodigo: codigo, empleadoNombre: nombre, fecha });
      }
    }
  }

  return {
    borradores,
    resumen: {
      sucursalId, desde, hasta,
      empleadosAnalizados: codigos.size,
      diasAnalizados: fechas.length,
      checadasLeidas,
      totalInconsistencias: borradores.length,
      porRegla,
      empleadosSinTurno,
    },
  };
}
