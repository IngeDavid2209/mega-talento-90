// =====================================================================
// CATÁLOGO DE PUESTOS · Mega Dulces de Los Altos
// Descripción breve que se envía al candidato por WhatsApp.
// EDITABLE: ajusta los textos según las funciones reales de cada puesto.
// =====================================================================

export interface PuestoInfo {
  nombre: string;
  descripcion: string;
}

export const PUESTOS: PuestoInfo[] = [
  {
    nombre: 'Cajero(a)',
    descripcion: 'Cobro en caja, manejo de efectivo y terminal, corte de caja al cierre y atención amable al cliente. Se requiere responsabilidad con el dinero, rapidez y honestidad.'
  },
  {
    nombre: 'Surtidor',
    descripcion: 'Surtido de pedidos en almacén, verificación de productos y cantidades solicitadas, etiquetado y preparación para envío. Trabajo físico, atención al detalle y rapidez.'
  },
  {
    nombre: 'Aux de chofer',
    descripcion: 'Apoyo en la ruta de reparto: carga y descarga de mercancía, entrega documentada al cliente, cuidado del producto en tránsito. Disponibilidad para viajar y buena condición física.'
  },
  {
    nombre: 'Chofer',
    descripcion: 'Traslado de mercancía a sucursales o clientes, carga y descarga, cuidado de la unidad y entrega documentada. Se requiere licencia vigente y conocimiento de rutas.'
  },
  {
    nombre: 'Vendedor',
    descripcion: 'Atención y venta directa al cliente en piso, manejo de productos de dulcería, acomodo de mercancía y cumplimiento de metas de venta. Buena actitud de servicio y disponibilidad de horario.'
  },
  {
    nombre: 'Almacenista',
    descripcion: 'Recepción, acomodo y control de mercancía en el almacén, manejo de inventario y seguimiento de pedidos. Trabajo físico, orden y atención al detalle.'
  },
  {
    nombre: 'Bodeguero',
    descripcion: 'Manejo y custodia de la bodega: recepción, acomodo y entrega de mercancía, control de stock y limpieza del área. Trabajo físico, responsabilidad y orden.'
  },
  {
    nombre: 'Anaquelista',
    descripcion: 'Acomodo y reposición de producto en anaqueles, rotación de mercancía, verificación de precios y orden en piso de venta. Atención al detalle y rapidez.'
  }
];

/** Devuelve la descripción de un puesto (o cadena vacía si no está catalogado) */
export function getDescripcionPuesto(nombrePuesto: string): string {
  if (!nombrePuesto) return '';
  const p = PUESTOS.find(x => x.nombre.toLowerCase() === nombrePuesto.trim().toLowerCase());
  return p ? p.descripcion : '';
}

/**
 * Arma el mensaje de primer contacto por WhatsApp, incluyendo la descripción
 * del puesto cuando está catalogado. Usado por la vista de etapa, dashboard e historial.
 */
export function plantillaPrimerContacto(candidato: { puesto?: string }): string {
  const puesto = candidato.puesto || '[PUESTO]';
  const descripcion = getDescripcionPuesto(candidato.puesto || '');
  const bloqueDescripcion = descripcion ? `\n\nEn qué consiste el puesto:\n${descripcion}` : '';

  return `Hola, buen día. Te contacto de Capital Humano de Mega Dulces.

Recibimos tu solicitud para la vacante de ${puesto}.${bloqueDescripcion}

Antes de agendar entrevista, necesito confirmar algunos datos:

1. ¿Sigues interesado/a en la vacante?
2. ¿En qué colonia o ciudad vives?
3. ¿Cuánto tiempo te toma llegar a la sucursal donde solicitas la vacante y qué transporte usarías?
4. ¿Tienes disponibilidad para laborar en el horario?
5. ¿Tienes experiencia en el área?
6. ¿Cuál fue tu último empleo y motivo de salida?
7. ¿Cuál es tu expectativa salarial?
8. ¿Cuentas con tus documentos: INE, RFC, NSS y comprobante de domicilio?

Quedo atenta para revisar si tu perfil coincide con la vacante.`;
}

/**
 * Normaliza un teléfono mexicano a 10 dígitos sin código de país.
 * Acepta formatos como:
 *   - "3521234567"          → "3521234567"
 *   - "+52 352 123 4567"    → "3521234567"
 *   - "+52 1 352 123 4567"  → "3521234567"  (formato móvil viejo con "1")
 *   - "01 352 123 4567"     → "3521234567"
 * Devuelve cadena vacía si el resultado no es exactamente 10 dígitos.
 *
 * IMPORTANTE: corrige el bug donde teléfonos con prefijo 52 quedaban
 * doblemente prefijados (https://wa.me/52[52...]) y WhatsApp los abría
 * en un contacto distinto.
 */
export function normalizarTelefonoMX(telefono: string): string {
  let n = (telefono || '').replace(/\D/g, '');
  // +52 1 XXXXXXXXXX (formato móvil viejo con "1" después del 52)
  if (n.length === 13 && n.startsWith('521')) n = n.slice(3);
  // +52 XXXXXXXXXX
  else if (n.length === 12 && n.startsWith('52')) n = n.slice(2);
  // 01 XXXXXXXXXX (formato fijo viejo)
  else if (n.length === 12 && n.startsWith('01')) n = n.slice(2);
  // 1 XXXXXXXXXX
  else if (n.length === 11 && n.startsWith('1')) n = n.slice(1);
  // 0 XXXXXXXXXX
  else if (n.length === 11 && n.startsWith('0')) n = n.slice(1);
  return n.length === 10 ? n : '';
}

/**
 * Construye la URL de WhatsApp con el mensaje de primer contacto.
 * Si el teléfono del candidato no se puede normalizar a 10 dígitos
 * devuelve cadena vacía — el componente que lo invoque debe avisar
 * al usuario y NO abrir wa.me con un número inválido.
 */
export function urlWhatsApp(candidato: { telefono?: string; puesto?: string }): string {
  const numero = normalizarTelefonoMX(candidato.telefono || '');
  if (!numero) return '';
  return `https://wa.me/52${numero}?text=${encodeURIComponent(plantillaPrimerContacto(candidato))}`;
}
