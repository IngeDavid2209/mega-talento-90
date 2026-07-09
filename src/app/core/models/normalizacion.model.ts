// =====================================================================
// NORMALIZACIÓN DE ETIQUETAS · Mega Talento
// Une variantes equivalentes de puesto y ciudad para que las vistas
// agrupen correctamente, apoyándose en los catálogos oficiales.
//   - Puesto: ignora el marcador de género "(a)"/"(o)" y la puntuación.
//     "Cajero", "Cajero (a)", "Cajero(a)"  →  "Cajero(a)"
//   - Ciudad: reconoce el catálogo de sucursales y une por prefijo.
//     "Santa Ana"  →  "Santa Ana Pacueco"
// Si no hay coincidencia en el catálogo, se conserva el texto original
// tal como se capturó (no inventamos ni fusionamos a ciegas).
// =====================================================================

import { PUESTOS } from './puestos.model';
import { SUCURSALES } from './sucursales.model';

/** Minúsculas, sin acentos, sin espacios de sobra. */
function limpiar(s: string): string {
  return (s || '')
    .toString()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** Clave base de un puesto: sin género (a)/(o)/(o/a), sin puntuación. */
function clavePuesto(s: string): string {
  return limpiar(s)
    .replace(/\(\s*[oa](\s*\/\s*[oa])?\s*\)/g, '')  // (a) (o) (o/a) (a/o)
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Clave base de una ciudad: sin acentos ni puntuación. */
function claveCiudad(s: string): string {
  return limpiar(s)
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const CATALOGO_PUESTOS = PUESTOS.map(p => ({ clave: clavePuesto(p.nombre), nombre: p.nombre }));

const CATALOGO_CIUDADES = Array.from(new Set(SUCURSALES.map(s => s.ciudad)))
  .map(c => ({ clave: claveCiudad(c), nombre: c }));

/** Devuelve el nombre canónico del puesto (o el original si no está en catálogo). */
export function normalizarPuesto(raw: string | undefined | null): string {
  const original = (raw || '').toString().trim();
  if (!original) return 'Sin puesto';
  const clave = clavePuesto(original);
  const cat = CATALOGO_PUESTOS.find(p => p.clave === clave);
  return cat ? cat.nombre : original;
}

/** Devuelve el nombre canónico de la ciudad (o el original si no está en catálogo). */
export function normalizarCiudad(raw: string | undefined | null): string {
  const original = (raw || '').toString().trim();
  if (!original) return 'Sin ciudad';
  const clave = claveCiudad(original);
  // Coincidencia exacta con el catálogo
  let cat = CATALOGO_CIUDADES.find(c => c.clave === clave);
  if (cat) return cat.nombre;
  // Coincidencia por prefijo de palabra completa ("santa ana" ⊂ "santa ana pacueco")
  if (clave.length >= 5) {
    cat = CATALOGO_CIUDADES.find(c =>
      c.clave.startsWith(clave + ' ') || clave.startsWith(c.clave + ' ')
    );
    if (cat) return cat.nombre;
  }
  return original;
}
