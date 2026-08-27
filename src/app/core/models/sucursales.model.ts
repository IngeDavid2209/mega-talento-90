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
  /**
   * Coordenadas para el mapa en vivo (`/rh/mapa`). OPCIONALES a propósito.
   *
   * Una plaza sin `lat`/`lng` NO se pinta: sale en la lista de "sin ubicación"
   * al lado del mapa, con su gente y todo. Es deliberado — un pin en el lugar
   * equivocado se ve igual de convincente que uno correcto, y este módulo ya
   * tiene bastante historia de números que parecían buenos y no lo eran.
   *
   * Se sacan de Google Maps: clic derecho sobre el punto → copiar coordenadas.
   * Van en grados decimales, latitud primero (Michoacán ronda 19-20 de latitud
   * y -101 a -102 de longitud).
   */
  lat?: number;
  lng?: number;
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
  { id: '8-esquinas',      ciudad: '8 Esquinas',  direccion: '', mapsUrl: '' },
  { id: 'morelia-abastos', ciudad: 'Morelia',     direccion: 'Central de Abastos', mapsUrl: '' },

  // ── Los dos relojes que faltaban (17/08/2026) ──────────────────────
  //
  // Son relojes REALES con datos diarios que no aparecían en ninguna pantalla.
  // No están aquí porque sean sucursales nuevas, sino porque cada uno necesita
  // su propio espacio de códigos: mezclarlos con una plaza existente es lo que
  // hace que una marca acabe en la persona equivocada.
  //
  // 192.168.0.81 — FUNDIDO EN CORPORATIVO EL 26/08/2026.
  //
  // Era la MISMA gente de corporativo con otra numeración, y tuvo plaza propia
  // un par de semanas para no revolver códigos: el patrón es +100 (#11 es el
  // #111 de allá) pero DOS códigos están cruzados —#8 es Claudia Martínez, que
  // en corporativo es #126, y #26 es Viviana Flores, que es #108—, así que
  // aplicar el patrón les habría intercambiado las marcas.
  //
  // La traducción código→código vive en `reloj_codigo_map`, armada por NOMBRE y
  // corroborada con el +100 (ver api/tools/fundir-reloj-comida.js): 41 de sus 48
  // códigos, que son 4,722 de sus 4,730 marcas. Sus checadas entran a
  // corporativo, así que la comida sale en la misma fila que la jornada —que es
  // como la pide el reporte de RH— y esta plaza ya no existe como sección.
  //
  // ⚠️ ESTE BLOQUE DECÍA "YA FUNDIDO (21/08/2026)" Y NO ERA CIERTO. La fusión no
  // se había corrido: `reloj_codigo_map` estaba VACÍA y el reloj seguía
  // apuntando a `corporativo-comida`. Como el id sí se había sacado del selector
  // —abajo, en CENTROS_SIN_RELOJ— sus marcas se siguieron recogiendo cinco días
  // cayendo en un id que ninguna pantalla mostraba: 4,730 marcas escondidas, ~96
  // al día, no las "8 históricas" que decía aquí. Se corrió de verdad el
  // 26/08/2026 y los números de arriba están verificados contra la base.
  //
  // La lección: un comentario que describe un estado de la BASE no es
  // documentación, es una afirmación que puede ser falsa. Si vuelve a hacer
  // falta comprobarlo:
  //     SELECT count(*) FROM reloj_codigo_map WHERE serie='CLXK233460626';
  //
  // Se queda en el catálogo, no en el selector: los 8 marcajes que no se
  // pudieron traducir (Andrea #25 y Dayan #34, altas con nombre de pila suelto)
  // siguen guardados con este id y el catálogo es lo que le pone nombre a un id
  // histórico.
  //
  // PENDIENTE DE RH: 7 códigos sin traducir (#25 Andrea, #29 López Guillermo,
  // #33 Montse, #34 Dayan, #42 Danna, #43 Víctor, #48 Nery). Ahora que el reloj
  // reporta a corporativo, si esas personas vuelven a checar sus marcas llegarán
  // con el código crudo y les abrirán ficha aparte en corporativo. Ninguno de
  // los 7 choca hoy con un código existente allá (comprobado), pero corporativo
  // numera desde el 1: una alta futura podría tomar el #33 y entonces sí se le
  // atribuirían a la persona equivocada. Se cierra completando su traducción.
  { id: 'corporativo-comida', ciudad: 'Oficinas', direccion: 'Desayuno y comida', mapsUrl: '' },

  // 192.168.0.196 — 12 personas checando a diario y NO se sabe de qué plaza es;
  // sus nombres empatan parecido con tres sucursales distintas. Se muestra con
  // nombre propio en vez de adivinarle una plaza: verlo sin saber de quién es
  // deja el pendiente a la vista; meterlo bajo una plaza inventada lo escondería
  // dentro de datos que sí se dan por buenos.
  { id: 'reloj-196', ciudad: 'Reloj .196', direccion: 'Sin identificar', mapsUrl: '' },

  // Sucursal PH (20/08/2026). Su reloj (192.168.10.2) se volvió alcanzable desde
  // el corporativo, así que ya baja asistencia. Va aquí —no en SUCURSALES
  // públicas— porque todavía no tenemos su dirección para el portal de empleos;
  // en cuanto RH la dé, se puede mover.
  { id: 'sucursal-ph', ciudad: 'Sucursal PH', direccion: '', mapsUrl: '' }
];

/**
 * Ubicaciones para el módulo de checador: sucursales públicas + centros internos.
 * Es el catálogo COMPLETO; sirve para resolver el nombre de cualquier id que
 * aparezca en datos históricos, incluso de una plaza que hoy no tiene reloj.
 */
export const CENTROS_CHECADOR: Sucursal[] = [...SUCURSALES, ...CENTROS_INTERNOS];

/**
 * Plazas SIN reloj checador — verificado contra la base el 05/08/2026 y otra vez
 * contra el sistema de origen el 17/08/2026: no tienen ni un empleado en el
 * padrón del checador ni una sola checada.
 *
 * Se filtran del selector del checador: el módulo de asistencia solo ofrece las
 * plazas de las que hay algo que mostrar. Un selector con plazas vacías hace
 * dudar de los números de las que sí tienen datos.
 *
 * (El 17/08/2026 se probó mostrarlas marcadas, con el semáforo explicando el
 * vacío. Se revirtió: aun explicadas, cuatro chips muertos en una fila de doce
 * son ruido en la pantalla que RH usa todos los días. El pendiente de esas
 * plazas se lleva en otro lado, no ocupando lugar aquí.)
 *
 * Siguen en `CENTROS_CHECADOR` a propósito: el catálogo completo se usa para
 * requisiciones de personal —se puede pedir gente para una plaza sin reloj— y
 * para resolver el nombre de cualquier id que aparezca en datos históricos.
 *
 * Para reactivar una: instalar su reloj, darlo de alta en el padrón (`relojes`)
 * y quitarla de esta lista.
 */
export const CENTROS_SIN_RELOJ: string[] = [
  'la-piedad-centro',    // nunca ha tenido reloj ni padrón
  'morelia-figaredo',    // nunca ha tenido reloj ni padrón
  'santa-ana-pacueco',   // nunca ha tenido reloj ni padrón
  // Su reloj sigue vivo, pero reporta DENTRO de corporativo desde el 26/08/2026:
  // la gente es la misma y tener dos secciones obligaba a mirar dos veces a la
  // misma persona. No se borra del catálogo porque quedan 8 marcajes históricos
  // con este id y hay que poder ponerles nombre.
  //
  // OJO AL SACAR UN ID DE AQUÍ: esta línea se puso el 21/08 dando por hecha una
  // fusión que no se había ejecutado, y durante cinco días el reloj siguió
  // mandando ~96 marcas diarias a un id que ya no tenía sección donde salir. No
  // basta con que la fusión esté escrita: hay que comprobar que corrió.
  'corporativo-comida',
  // MORELIA ABASTOS SALIÓ DE ESTA LISTA EL 20/08/2026.
  //
  // Llevaba aquí porque su reloj no contestaba —probado el 28/07, el 05/08 y el
  // 17/08—. El 20/08 sí contestó: la subred 192.168.30.x ya tiene ruta desde el
  // corporativo y el equipo (192.168.30.253, serie 3266161700253) entregó su log
  // completo: 22,888 checadas del 02/01/2026 a la fecha, ~100 marcas diarias.
  //
  // Se confirmó que es SUYO por código, no por nombre: 58 de los 60 códigos de su
  // padrón existen en el reloj y 44 comparten nombre, contra 0-4% en las otras once
  // plazas. El cotejo por nombre completo daba cero y engañaba —la base guarda
  // 'GARCIA TAPIA LUCIA' y el reloj 'Luciagarciatapia'—.
  //
  // Lección para la próxima: 'no responde' caduca. Estas tres de arriba habría que
  // volver a probarlas cuando cambie la red, no darlas por muertas para siempre.
];

/** ¿De esta plaza hay que esperar checadas, o no tiene reloj instalado? */
export function tieneReloj(id: string): boolean {
  return !CENTROS_SIN_RELOJ.includes(id);
}

/**
 * Lo que SÍ se ofrece en el checador: las ocho plazas que hoy tienen reloj y
 * devuelven datos. Morelia Abastos entró el 20/08/2026 y el reloj de comida de
 * oficinas salió el 21/08/2026 —no porque muriera, sino porque ya reporta dentro
 * de corporativo—. Los relojes registrados son doce, pero uno está en pausa
 * (el de comida de oficinas, con numeración propia sin traducir, y el que
 * todavía no se sabe de qué plaza es) y no corresponden a ninguna sucursal del
 * catálogo. Esos dos se vigilan desde el semáforo de relojes, no desde aquí.
 */
export const CENTROS_CON_RELOJ: Sucursal[] =
  CENTROS_CHECADOR.filter(s => tieneReloj(s.id));

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
