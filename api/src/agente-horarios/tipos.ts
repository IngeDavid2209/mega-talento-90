/**
 * Tipos del Agente de Horarios (Fase 1).
 * Dominio puro: NO importa Express ni pg. Se usa en reglas.ts (lógica testeable).
 */

/** Reglas soportadas por el detector. */
export type Regla =
  | 'retardo'
  | 'falta'
  | 'checada_duplicada'
  | 'multiples_entradas'
  | 'entrada_sin_salida'
  | 'salida_sin_entrada'
  | 'fuera_de_turno';

export type Severidad = 'baja' | 'media' | 'alta';

/** Configuración de umbrales de las reglas (NO hardcodeada; viene de asistencia_config). */
export interface ReglaConfig {
  /** Regla 2: dos checadas separadas por <= X minutos se consideran duplicadas. */
  duplicadaMinutos: number;
  /** Regla 1: dos "entradas" (tipo=0) separadas por > X horas el mismo día. */
  saltoEntradasHoras: number;
  /** Regla 4: una checada fuera de [entrada - X, salida + X] es "fuera de turno". */
  ventanaFueraTurnoMin: number;
  /** Regla 5: si true, usa horarios_sucursal.tolerancia_min por turno. */
  usarToleranciaHorario: boolean;
  /** Regla 5: override global de tolerancia (min). Si null, usa la del horario. */
  toleranciaRetardoMin: number | null;
  /** Regla 5: marcar FALTA en día laborable sin ninguna checada. */
  marcarFaltas: boolean;
  /**
   * Regla 5 (anti-ruido): si true, NO marca falta a un empleado que no tuvo
   * NINGUNA checada en todo el rango analizado (probablemente no trabajó / sin
   * datos). Sigue marcando la falta de quien sí checó otros días del rango.
   */
  faltaSoloConActividadEnRango: boolean;
  /** Regla 3: "entrada sin salida" solo se marca en días ya cerrados (fecha < hoy). */
  soloDiasCerrados: boolean;
  /** Interruptores por regla (permite apagar reglas por sucursal). */
  reglasActivas: Record<Regla, boolean>;
}

/** Checada mínima que necesita la lógica pura. */
export interface ChecadaMin {
  fechaHora: string;        // 'yyyy-MM-ddTHH:mm:ss' (hora local del reloj)
  hora: string;             // 'HH:mm:ss'
  tipo: number | null;      // 0=Entrada, 1=Salida, 2=Salida a comer, 3=Regreso (o null si el reloj no lo manda)
}

/** Turno aplicable a un empleado-día (derivado de horarios_sucursal). */
export interface HorarioMin {
  nombre: string;
  dias: number[];           // 0=domingo .. 6=sábado
  entrada: string;          // 'HH:mm'
  salida: string;           // 'HH:mm'
  inicioComida?: string | null;
  finComida?: string | null;
  toleranciaMin: number;
  /** true si hubo más de un horario candidato y se eligió por heurística. */
  ambiguo?: boolean;
}

/** Empleado bajo análisis. */
export interface EmpleadoMin {
  sucursalId: string;
  codigo: string;
  nombre: string;
}

/** Entrada de la lógica pura: todo lo necesario para analizar UN empleado en UN día. */
export interface EntradaDia {
  empleado: EmpleadoMin;
  fecha: string;            // 'yyyy-MM-dd'
  diaSemana: number;        // 0=domingo .. 6=sábado
  cerrado: boolean;         // fecha < hoy (día ya terminó)
  checadas: ChecadaMin[];   // ordenadas ascendente por hora
  horario: HorarioMin | null;
  config: ReglaConfig;
  /** ¿El empleado tuvo AL MENOS una checada en todo el rango analizado? (anti-ruido de faltas) */
  empleadoConActividadRango: boolean;
}

/** Inconsistencia detectada (aún sin persistir). */
export interface Inconsistencia {
  regla: Regla;
  severidad: Severidad;
  detalle: string;
  evidencia: Record<string, any>;
  justificacionSugerida: string;
}

/** Borrador listo para persistir en asistencia_alertas. */
export interface BorradorAlerta extends Inconsistencia {
  sucursalId: string;
  empleadoCodigo: string;
  empleadoNombre: string;
  fecha: string;
}
