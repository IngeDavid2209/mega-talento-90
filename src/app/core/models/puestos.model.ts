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
    nombre: 'Vendedor',
    descripcion: 'Atención y venta directa al cliente en piso, manejo de productos de dulcería, acomodo de mercancía y cumplimiento de metas de venta. Buena actitud de servicio y disponibilidad de horario.'
  },
  {
    nombre: 'Cajero',
    descripcion: 'Cobro en caja, manejo de efectivo y terminal, corte de caja al cierre y atención amable al cliente. Se requiere responsabilidad con el dinero y rapidez.'
  },
  {
    nombre: 'Auxiliar de Almacén',
    descripcion: 'Recepción, acomodo y control de mercancía, surtido de pedidos, orden y limpieza del almacén. Trabajo físico y seguimiento de inventarios.'
  },
  {
    nombre: 'Chofer Repartidor',
    descripcion: 'Reparto de mercancía a sucursales o clientes, carga y descarga, cuidado de la unidad y entrega documentada. Se requiere licencia vigente y conocimiento de rutas.'
  },
  {
    nombre: 'Gerente de Sucursal',
    descripcion: 'Responsable de la operación de la sucursal: equipo de trabajo, ventas, inventarios, cortes y atención al cliente. Liderazgo, toma de decisiones y orientación a resultados.'
  },
  {
    nombre: 'Personal Administrativo',
    descripcion: 'Apoyo en tareas administrativas: captura de datos, archivo, manejo de Excel, seguimiento de documentación y atención interna. Orden y organización.'
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

  return `Hola, buen día. Mi nombre es Lupita, de Recursos Humanos de Mega Dulces de Los Altos.

Recibimos tu solicitud para la vacante de ${puesto}.${bloqueDescripcion}

Antes de agendar entrevista, necesito confirmar algunos datos:

1. ¿Sigues interesado/a en la vacante?
2. ¿En qué colonia o ciudad vives?
3. ¿Tienes disponibilidad para laborar en el horario?
4. ¿Tienes experiencia en el área?
5. ¿Cuál fue tu último empleo y motivo de salida?
6. ¿Cuál es tu expectativa salarial?

Quedo atenta para revisar si tu perfil coincide con la vacante.`;
}

/** Construye la URL de WhatsApp con el mensaje de primer contacto */
export function urlWhatsApp(candidato: { telefono?: string; puesto?: string }): string {
  const numero = (candidato.telefono || '').replace(/\D/g, '');
  return `https://wa.me/52${numero}?text=${encodeURIComponent(plantillaPrimerContacto(candidato))}`;
}
