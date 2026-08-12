/**
 * =====================================================================
 * ENCUESTAS DE ONBOARDING (Google Forms)
 * =====================================================================
 *
 * Capital Humano ya tenía sus cinco encuestas de nuevo ingreso en Google
 * Forms —día 3, 7, 15, 30 y 90— y pidió conectarlas para que se generen
 * solas conforme cada persona cumple días.
 *
 * ── LO QUE SE DESCUBRIÓ AL ABRIRLAS (12/08/2026) ────────────────────
 *
 * Los cinco formularios son COPIAS del mismo: comparten los seis campos de
 * identificación Y sus identificadores internos (`entry.*`). Eso es lo que
 * hace posible todo lo demás, porque permite armar una liga PRELLENADA con
 * los mismos parámetros para las cinco.
 *
 * ── POR QUÉ PRELLENAR Y NO SOLO MANDAR LA LIGA ──────────────────────
 *
 * 1. El formulario pregunta "¿Qué encuesta vas a responder?" con las cinco
 *    opciones. Como las ligas se ven idénticas, es cuestión de tiempo que
 *    alguien de día 30 conteste marcando "DÍA 3" y ensucie el corte.
 *
 * 2. Si cada quien teclea su nombre, cruzar las respuestas contra los
 *    expedientes es trabajo manual eterno y con errores de dedo. Prellenado,
 *    la respuesta llega ya amarrada a la persona que la contestó.
 *
 * 3. Son seis campos menos que contestar. Una encuesta de satisfacción que
 *    empieza pidiendo datos que la empresa ya tiene se contesta menos.
 */

/** Los cortes que definió RH. No coinciden exactos con los hitos de
 *  Permanencia (7/30/60/90) a propósito: son dos cosas distintas —uno mide
 *  si sigue, el otro cómo se siente— y RH quiso preguntar antes, al día 3. */
export const DIAS_ENCUESTA = [3, 7, 15, 30, 90] as const;
export type DiaEncuesta = typeof DIAS_ENCUESTA[number];

/** Campos de identificación. Son los MISMOS en las cinco (verificado). */
export const CAMPOS_FORM = {
  nombre:   'entry.1886016675',
  puesto:   'entry.1652986177',
  sucursal: 'entry.2049177136',
  jefe:     'entry.1068800151',
  ingreso:  'entry.345419657',
  cual:     'entry.396823540',
} as const;

/** La liga de cada corte, tal como las pasó Capital Humano. */
export const FORMS_ONBOARDING: Record<DiaEncuesta, string> = {
  3:  'https://docs.google.com/forms/d/e/1FAIpQLScOtYref1t_oMTBxDZ98qBWcXL86G9KA47DECY43UQv5nB9Fg/viewform',
  7:  'https://docs.google.com/forms/d/e/1FAIpQLScbDQ6QT1AzHg3OTRW-Yyf5Z3cWqYN8ZfFwnvarmjb7P333aw/viewform',
  15: 'https://docs.google.com/forms/d/e/1FAIpQLScwwQtjtnY2Sz1WOZ7DD4LyHzVB31ZqyJiCWLP9AsJcvBXWog/viewform',
  30: 'https://docs.google.com/forms/d/e/1FAIpQLScC2Z13w1kLmSbffAjGYi8PBE8ZLq0hLzPqQer_tpa4bQ662g/viewform',
  90: 'https://docs.google.com/forms/d/e/1FAIpQLSfTbu2OunR-gXsSdFVChaGZiRB1WANhhTt6d6hivqF6YpoxZQ/viewform',
};

export interface DatosPersona {
  nombre?: string;
  puesto?: string;
  sucursal?: string;
  jefe?: string;
  /** 'YYYY-MM-DD' o ISO: el día que entró a trabajar. */
  ingreso?: string | null;
}

/** Suma días a una fecha 'YYYY-MM-DD' sin que el huso la corra de día. */
export function masDias(fecha: string, dias: number): string {
  const base = Date.parse(String(fecha).slice(0, 10) + 'T12:00:00Z');
  if (isNaN(base)) return '';
  return new Date(base + dias * 86400000).toISOString().slice(0, 10);
}

/** Días completos entre dos fechas 'YYYY-MM-DD' (positivo si b es posterior). */
export function diasEntre(a: string, b: string): number {
  const x = Date.parse(String(a).slice(0, 10) + 'T12:00:00Z');
  const y = Date.parse(String(b).slice(0, 10) + 'T12:00:00Z');
  if (isNaN(x) || isNaN(y)) return 0;
  return Math.round((y - x) / 86400000);
}

/**
 * Arma la liga prellenada de un corte para una persona.
 *
 * El campo de FECHA de Google Forms no se prellena con la cadena completa:
 * quiere año, mes y día por separado (`entry.X_year`, `_month`, `_day`).
 * Mandarlo como texto deja el campo vacío y el candidato tiene que teclearlo.
 */
export function ligaEncuesta(dia: DiaEncuesta, p: DatosPersona): string {
  const base = FORMS_ONBOARDING[dia];
  if (!base) return '';
  const q = new URLSearchParams();
  q.set('usp', 'pp_url');
  if (p.nombre)   q.set(CAMPOS_FORM.nombre, p.nombre);
  if (p.puesto)   q.set(CAMPOS_FORM.puesto, p.puesto);
  if (p.sucursal) q.set(CAMPOS_FORM.sucursal, p.sucursal);
  if (p.jefe)     q.set(CAMPOS_FORM.jefe, p.jefe);
  q.set(CAMPOS_FORM.cual, `DIA ${dia}`);

  const ing = String(p.ingreso || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(ing)) {
    const [a, m, d] = ing.split('-');
    q.set(`${CAMPOS_FORM.ingreso}_year`, a);
    q.set(`${CAMPOS_FORM.ingreso}_month`, String(Number(m)));
    q.set(`${CAMPOS_FORM.ingreso}_day`, String(Number(d)));
  }
  return `${base}?${q.toString()}`;
}

export type EstadoEncuesta =
  | 'contestada'   // llegó su respuesta
  | 'enviada'      // se le mandó y no ha contestado
  | 'toca_hoy'     // hoy cumple los días
  | 'vencida'      // ya pasó su día y nadie se la mandó
  | 'futura';      // todavía no le toca

export interface EncuestaDePersona {
  dia: DiaEncuesta;
  /** 'YYYY-MM-DD': el día en que le toca contestarla. */
  fecha: string;
  estado: EstadoEncuesta;
  /** Días que faltan (negativo = ya se pasó). */
  faltan: number;
  enviadaEn?: string;
  contestadaEn?: string;
  liga: string;
}

/**
 * El calendario de encuestas de una persona.
 *
 * `hoy` se recibe en vez de calcularse aquí para que toda la pantalla mida
 * contra el mismo día: si cada fila leyera el reloj por su cuenta, una
 * pantalla abierta a medianoche mostraría unas filas de ayer y otras de hoy.
 */
export function encuestasDe(
  p: DatosPersona,
  hoy: string,
  registro: Record<string, { enviadaEn?: string; contestadaEn?: string }> = {}
): EncuestaDePersona[] {
  const ing = String(p.ingreso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ing)) return [];

  return DIAS_ENCUESTA.map((dia) => {
    const fecha = masDias(ing, dia);
    const faltan = diasEntre(hoy, fecha);
    const r = registro[String(dia)] || {};
    const estado: EstadoEncuesta =
      r.contestadaEn ? 'contestada'
      : r.enviadaEn  ? 'enviada'
      : faltan > 0   ? 'futura'
      : faltan === 0 ? 'toca_hoy'
      :                'vencida';
    return { dia, fecha, estado, faltan, enviadaEn: r.enviadaEn, contestadaEn: r.contestadaEn, liga: ligaEncuesta(dia, p) };
  });
}

/** Mensaje de WhatsApp con el que se le manda su encuesta. */
export function mensajeEncuesta(nombre: string, dia: DiaEncuesta, liga: string): string {
  const saludo = (nombre || '').trim().split(/\s+/)[0] || '';
  const cuando =
    dia === 3  ? 'tus primeros días'
    : dia === 7 ? 'tu primera semana'
    : dia === 15 ? 'tus primeras dos semanas'
    : dia === 30 ? 'tu primer mes'
    :              'tus primeros tres meses';
  return (
    `Hola ${saludo}, soy de Capital Humano de Mega Dulces. ` +
    `Queremos saber cómo te ha ido en ${cuando} con nosotros. ` +
    `Son unas preguntas rápidas y tus datos ya vienen puestos:\n\n${liga}\n\n` +
    `Tu respuesta nos ayuda a mejorar. ¡Gracias!`
  );
}
