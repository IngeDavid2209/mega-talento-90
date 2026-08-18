// =====================================================================
// ¿YA TRABAJÓ AQUÍ? · Mega Talento
// =====================================================================
//
// Lo pidió Capital Humano tras un caso concreto: alguien que estuvo unas
// semanas en Yurécuaro se volvió a postular, y solo se detectó porque una
// persona lo reconoció.
//
// ── POR QUÉ ESTO VIVE EN UN ARCHIVO Y NO DENTRO DE UNA PANTALLA ──
//
// La regla nació dentro de `expediente.ts` como un getter. En cuanto el
// dashboard necesitó la MISMA pregunta, copiarla habría creado dos criterios
// para decir quién es reingreso — y el día que uno se ajuste, las dos
// pantallas dirían cosas distintas de la misma persona. Este proyecto ya pagó
// ese precio con los puestos viviendo a la vez en Firestore y en Postgres.
//
// El bot tiene su propia copia en `src/dictamen.js::esReingreso`, y eso es
// deliberado: son dos repos y dos lenguajes. Si tocas las negaciones de aquí,
// tócalas allá. Es el único lugar donde se admite la duplicación.
//
// ── LA TRAMPA DEL CAMPO VACÍO ──
//
// Vacío significa **"no se le preguntó"**, no "no trabajó aquí": la pregunta
// se agregó el 12/08/2026 y los registros anteriores no la traen. Al
// 18/08/2026 eran 209 candidatos sin el dato contra 77 que sí contestaron.
// Confundir las dos cosas marcaría como reingreso a medio padrón, o —peor—
// dejaría pasar a uno de verdad.

/** Respuestas que significan "nunca trabajé aquí". */
const NEGACIONES = /^(no|nunca|ninguno|ninguna|n\/a|na|no aplica|jamas|jamás|es la primera)\b/;

/**
 * ¿Declaró que ya trabajó en Mega Dulces?
 *
 * Cualquier cosa que NO sea una negación cuenta como sí, y eso es a propósito:
 * la pregunta del bot pide "dime en qué sucursal, qué puesto tenías, quién era
 * tu jefe y cuánto tiempo estuviste", así que un "Cajera" a secas es un sí
 * legítimo —está contestando el puesto—, no un dato basura.
 */
export function esReingreso(valor: string | null | undefined): boolean {
  const t = String(valor || '').trim().toLowerCase();
  if (!t) return false;
  return !NEGACIONES.test(t);
}

/** ¿Se le llegó a preguntar? Distinto de haber contestado que no. */
export function seLePregunto(valor: string | null | undefined): boolean {
  return String(valor || '').trim().length > 0;
}

/**
 * Lo que dijo, listo para mostrar. Si solo escribió "sí" no aporta nada, y es
 * más honesto decir que no dio detalles que pintar un "Sí" que parece un dato.
 */
export function detalleReingreso(valor: string | null | undefined): string {
  const t = String(valor || '').trim();
  if (!t) return '';
  return /^(s[ií]|s[ií]\.?|as[ií] es|correcto)$/i.test(t) ? 'Dijo que sí, sin dar detalles' : t;
}
