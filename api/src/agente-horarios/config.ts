import { pool } from '../db';
import { ReglaConfig, Regla } from './tipos';

/**
 * Configuración de reglas del agente. Los umbrales viven en la tabla
 * `asistencia_config` (NO hardcodeados). Aquí solo está el RESPALDO por si la
 * tabla estuviera vacía, y el merge: defaults → global ('__global__') → sucursal.
 */

const REGLAS: Regla[] = [
  'retardo', 'falta', 'checada_duplicada',
  'multiples_entradas', 'entrada_sin_salida', 'fuera_de_turno',
  'desayuno_excedido',
];

/** Respaldo en código (espejo de la semilla en db/agente-horarios.sql). */
export const CONFIG_DEFAULT: ReglaConfig = {
  duplicadaMinutos: 5,
  saltoEntradasHoras: 4,
  ventanaFueraTurnoMin: 120,
  usarToleranciaHorario: true,
  toleranciaRetardoMin: null,
  marcarFaltas: true,
  soloDiasCerrados: true,
  faltaSoloConActividadEnRango: true,
  // 30 min es el default de la empresa; corporativo lleva 25 en su propia fila
  // de `asistencia_config` (ver db/agente-horarios.sql).
  desayunoTopeMin: 30,
  desayunoAlertaMin: 10,
  desayunoHastaHora: '13:00',
  desayunoMaxPlausibleMin: 120,
  desayunoCuentaComoJornada: false,
  // true en TODAS las plazas (28/09/2026): cada quien se mide contra su propio
  // turno. Se deja el interruptor por si alguna plaza hubiera que apagarla.
  medirRetardo: true,
  reglasActivas: {
    retardo: true,
    falta: true,
    checada_duplicada: true,
    multiples_entradas: true,
    entrada_sin_salida: true,
    salida_sin_entrada: true,
    fuera_de_turno: true,
    desayuno_excedido: true,
  },
};

/**
 * Lo que una sucursal trae por POLÍTICA aunque su fila de `asistencia_config`
 * no lo diga todavía. Se aplica entre el global y la fila propia, así que la
 * tabla sigue mandando: esto solo evita que una regla nueva dependa de que
 * alguien corra la migración para empezar a valer.
 */
const POLITICA_POR_SUCURSAL: Record<string, Partial<ReglaConfig>> = {
  corporativo: { desayunoCuentaComoJornada: true },
};

/** Merge superficial + merge de reglasActivas. `parcial` puede venir de la BD. */
function fusionar(base: ReglaConfig, parcial: any): ReglaConfig {
  if (!parcial || typeof parcial !== 'object') return base;
  const salida: ReglaConfig = { ...base, ...parcial };
  salida.reglasActivas = { ...base.reglasActivas, ...(parcial.reglasActivas || {}) };
  // Normaliza: asegura una entrada por regla (salida_sin_entrada sigue a entrada_sin_salida).
  for (const r of REGLAS) {
    if (typeof salida.reglasActivas[r] !== 'boolean') salida.reglasActivas[r] = base.reglasActivas[r];
  }
  if (typeof salida.reglasActivas.salida_sin_entrada !== 'boolean') {
    salida.reglasActivas.salida_sin_entrada = salida.reglasActivas.entrada_sin_salida;
  }
  return salida;
}

/**
 * Carga la config efectiva para una sucursal: default de código → fila global
 * de la tabla → fila de la sucursal. Nunca lanza (si la tabla no existe aún,
 * regresa el default de código).
 */
export async function cargarConfig(sucursalId: string): Promise<ReglaConfig> {
  try {
    const { rows } = await pool.query(
      `SELECT sucursal_id, config FROM asistencia_config
       WHERE sucursal_id = '__global__' OR sucursal_id = $1`,
      [sucursalId]
    );
    const global = rows.find((r) => r.sucursal_id === '__global__')?.config;
    const propia = rows.find((r) => r.sucursal_id === sucursalId)?.config;
    return fusionar(fusionar(fusionar(CONFIG_DEFAULT, global), POLITICA_POR_SUCURSAL[sucursalId]), propia);
  } catch (e) {
    console.warn('[agente-horarios] No se pudo leer asistencia_config; uso defaults.', (e as any)?.message);
    return fusionar(CONFIG_DEFAULT, POLITICA_POR_SUCURSAL[sucursalId]);
  }
}
