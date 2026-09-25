// =====================================================================
// HORARIOS Y CHECADAS · Mega Talento 90
// Modelos para gestionar horarios de sucursales/áreas y la asistencia
// (checadas) que se IMPORTA desde los relojes checadores ZKTeco.
//
// IMPORTANTE: la app NO se conecta a los relojes (están en VPN con IPs
// privadas). Las checadas entran por importación de archivo (attlog.dat,
// CSV o Excel). Los campos `ipChecador` y `deviceId` son documentales.
// =====================================================================

/** Un área con checador dentro de una sucursal (ej. "Piso de venta", "Almacén"). */
export interface AreaChecador {
  id?: string;
  sucursalId: string;
  nombre: string;
  ipChecador?: string;   // documental (el reloj vive en la VPN, no lo consultamos)
  deviceId?: string;     // id del reloj tal como aparece en el archivo del checador
  activo: boolean;
}

/**
 * Turno/horario. Si `areaId` viene vacío, aplica como horario GENERAL de la
 * sucursal; si trae un área, es el horario específico de esa área (tiene
 * prioridad sobre el general al calcular retardos).
 */
export interface HorarioArea {
  id?: string;
  sucursalId: string;
  areaId?: string;
  nombre: string;
  dias: number[];          // días que aplica (0=domingo .. 6=sábado)
  entrada: string;         // 'HH:mm'
  inicioComida?: string;   // 'HH:mm'
  finComida?: string;      // 'HH:mm'
  salida: string;          // 'HH:mm'
  toleranciaMin: number;   // minutos de tolerancia antes de marcar retardo
  activo: boolean;
}

/** Una marca de asistencia YA importada desde el reloj. */
export interface Checada {
  id?: string;
  sucursalId: string;
  areaId?: string;
  deviceId?: string;
  empleadoCodigo: string;    // código tal como lo emite el reloj
  empleadoNombre?: string;   // resuelto contra el catálogo de empleados (si mapea)
  fechaHora: string;         // ISO completo
  fecha: string;             // 'yyyy-MM-dd' (local)
  hora: string;              // 'HH:mm:ss'
  tipo?: number;             // ver TIPOS_CHECADA (si el reloj lo aporta)
  dedupKey: string;          // clave estable para evitar duplicados
  importadoEn?: any;         // Timestamp de la importación
}

/**
 * Mapea el código del reloj a un nombre. Los empleados son FIJOS por sucursal:
 * el mismo código puede repetirse entre sucursales distintas, por eso siempre
 * se distinguen por `sucursalId` + `codigoChecador`.
 */
export interface Empleado {
  id?: string;
  sucursalId: string;
  codigoChecador: string;
  /** El apodo con el que está enrolada en el reloj: "Luciagarciatapia". */
  nombre: string;
  /**
   * El nombre FORMAL, el del reporte semanal de RH: "GARCIA TAPIA LUCIA".
   *
   * Va aparte de `nombre` a propósito: el del reloj sirve para reconocer a la
   * persona en el equipo, no para un documento que se firma. Cuando existe, es el
   * que se muestra. Puede venir vacío —la fuente son los reportes semanales y no
   * todas las plazas los tienen completos—, y entonces se cae al del reloj.
   */
  nombreCompleto?: string;
  puesto?: string;
  /**
   * La sección del reporte semanal (COMPRAS, FINANZAS…). Sin él la persona cae
   * en SIN DEPARTAMENTO. Vacío = sin asignar.
   */
  departamento?: string;
  fotoUrl?: string;
  activo: boolean;
  /**
   * Promotora: no es personal de piso ni de planta. Anda en calle o en punto de
   * venta y no checa en el reloj de la sucursal, así que se saca del análisis de
   * asistencia — medida con esa vara salía con falta todos los días. Vive en su
   * propio apartado dentro de Horarios.
   */
  esPromotora?: boolean;
}

/** Tipos de marca que reporta ZKTeco (columna de estado). */
export const TIPOS_CHECADA: Record<number, string> = {
  0: 'Entrada',
  1: 'Salida',
  2: 'Salida a comer',
  3: 'Regreso de comer'
};

/** Etiquetas cortas de los días (índice = día de la semana JS). */
export const DIAS_SEMANA = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

/**
 * Fecha local en formato 'yyyy-MM-dd' SIN corrimiento de zona horaria.
 * (No usar toISOString(), que convierte a UTC y puede saltar de día.)
 */
export function aFechaLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dia}`;
}

/**
 * Clave de deduplicación de una checada. Una misma marca (misma sucursal, mismo
 * empleado, mismo instante) produce siempre la misma clave, aunque se importe
 * el archivo dos veces o el reloj repita el renglón.
 */
export function dedupDeChecada(sucursalId: string, empleadoCodigo: string, fechaHoraIso: string): string {
  return `${sucursalId}__${(empleadoCodigo || '').trim()}__${fechaHoraIso}`;
}
