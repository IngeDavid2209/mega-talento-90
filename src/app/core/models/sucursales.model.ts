// =====================================================================
// CATÁLOGO DE SUCURSALES · Mega Dulces de Los Altos
// Lista fija de dulcerías. En el editor de vacantes se activa/desactiva
// por puesto cuáles aplican; lo seleccionado se guarda en el puesto.
// EDITABLE: ajusta la dirección o agrega/quita sucursales aquí.
// =====================================================================

export interface Sucursal {
  id: string;        // identificador estable (no cambiar una vez en uso)
  ciudad: string;    // ciudad/municipio (para el filtro del formulario público)
  direccion: string; // dirección completa (es lo que se muestra como ubicación)
  mapsUrl: string;   // enlace a Google Maps
}

/** Arma una URL de búsqueda en Google Maps a partir de la dirección. */
function maps(direccion: string): string {
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(direccion);
}

export const SUCURSALES: Sucursal[] = [
  {
    id: 'morelia-vicente-guerrero',
    ciudad: 'Morelia',
    direccion: 'Av Francisco I. Madero Pte 3600, Vicente Guerrero, 58189 Morelia, Mich.',
    mapsUrl: maps('Av Francisco I. Madero Pte 3600, Vicente Guerrero, 58189 Morelia, Mich.')
  },
  {
    id: 'morelia-figaredo',
    ciudad: 'Morelia',
    direccion: 'Soledad Gutiérrez de Figaredo 510, 58218 Morelia, Mich.',
    mapsUrl: maps('Soledad Gutiérrez de Figaredo 510, 58218 Morelia, Mich.')
  },
  {
    id: 'zamora-canindo',
    ciudad: 'Zamora',
    direccion: 'Block P Bodega 6, Canindo, 59757 Zamora de Hidalgo, Mich.',
    mapsUrl: maps('Block P Bodega 6, Canindo, 59757 Zamora de Hidalgo, Mich.')
  },
  {
    id: 'zamora-catedral',
    ciudad: 'Zamora',
    direccion: 'C. Dámaso Cárdenas 7, Jardines de Catedral, 59670 Zamora de Hidalgo, Mich.',
    mapsUrl: maps('C. Dámaso Cárdenas 7, Jardines de Catedral, 59670 Zamora de Hidalgo, Mich.')
  },
  {
    id: 'santa-ana-pacueco',
    ciudad: 'Santa Ana Pacueco',
    direccion: 'Av Padre Hidalgo 322, Sta Ana Pacueco, 36910 Santa Ana Pacueco, Gto.',
    mapsUrl: maps('Av Padre Hidalgo 322, Sta Ana Pacueco, 36910 Santa Ana Pacueco, Gto.')
  },
  {
    id: 'la-piedad-abastos',
    ciudad: 'La Piedad',
    direccion: 'Abastos, Av. Mariano Jiménez 1582, Peña, 59389 La Piedad de Cabadas, Mich.',
    mapsUrl: maps('Abastos, Av. Mariano Jiménez 1582, Peña, 59389 La Piedad de Cabadas, Mich.')
  },
  {
    id: 'la-piedad-centro',
    ciudad: 'La Piedad',
    direccion: 'Pino Suárez 259, Centro, 59300 La Piedad de Cabadas, Mich.',
    mapsUrl: maps('Pino Suárez 259, Centro, 59300 La Piedad de Cabadas, Mich.')
  },
  {
    id: 'yurecuaro-centro',
    ciudad: 'Yurécuaro',
    direccion: 'Sr. Cura Don Miguel Hidalgo 22, Centro, 59250 Yurécuaro, Mich.',
    mapsUrl: maps('Sr. Cura Don Miguel Hidalgo 22, Centro, 59250 Yurécuaro, Mich.')
  }
];

/**
 * Centros de trabajo INTERNOS (corporativo, bodegas, etc.) que NO son sucursales
 * públicas: sirven para el módulo de Horarios/checadas pero NO deben aparecer en
 * el portal de candidatos (/unete, /empleos).
 */
export const CENTROS_INTERNOS: Sucursal[] = [
  { id: 'corporativo',     ciudad: 'Corporativo', direccion: 'Oficinas Corporativas', mapsUrl: '' },
  { id: 'cedis',           ciudad: 'CEDIS',       direccion: 'Centro de Distribución', mapsUrl: '' },
  { id: '8-esquinas',      ciudad: 'Morelia',     direccion: '8 Esquinas', mapsUrl: '' },
  { id: 'morelia-abastos', ciudad: 'Morelia',     direccion: 'Central de Abastos', mapsUrl: '' }
];

/** Ubicaciones para el módulo de checador: sucursales públicas + centros internos. */
export const CENTROS_CHECADOR: Sucursal[] = [...SUCURSALES, ...CENTROS_INTERNOS];

/** Busca una ubicación de checador (sucursal pública o centro interno) por id. */
export function centroChecadorPorId(id: string): Sucursal | undefined {
  return CENTROS_CHECADOR.find(s => s.id === id);
}

/** Ciudades únicas del catálogo, en el orden en que aparecen. */
export function ciudadesUnicas(): string[] {
  const out: string[] = [];
  for (const s of SUCURSALES) if (!out.includes(s.ciudad)) out.push(s.ciudad);
  return out;
}

/** Busca una sucursal del catálogo por su id. */
export function sucursalPorId(id: string): Sucursal | undefined {
  return SUCURSALES.find(s => s.id === id);
}

/**
 * Infiere los ids de sucursal a partir del texto libre antiguo de una vacante
 * (cuando aún no tiene sucursalIds). Coincide si el texto contiene la dirección
 * completa del catálogo o, al menos, su calle+número (la parte antes de la
 * primera coma). Sirve para migrar/pre-seleccionar sin adivinar nada nuevo.
 */
export function inferirSucursalIds(texto: string): string[] {
  const t = (texto || '').toLowerCase();
  if (!t.trim()) return [];
  const ids: string[] = [];
  for (const s of SUCURSALES) {
    const dir = s.direccion.toLowerCase();
    const calle = dir.split(',')[0].trim();
    if (t.includes(dir) || (calle.length > 6 && t.includes(calle))) {
      ids.push(s.id);
    }
  }
  return ids;
}
