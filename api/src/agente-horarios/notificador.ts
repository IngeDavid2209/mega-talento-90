import { JefeSucursal } from './jefes';

/**
 * ADAPTADOR DE NOTIFICACIÓN — Fase 2.
 * La API de MegaTalento NO tiene credenciales de WhatsApp; el BOT-RH (repo
 * aparte) sí. Así que el aviso al jefe se manda llamando a un endpoint del
 * BOT-RH (`POST /api/aviso-asistencia`), que envía la plantilla aprobada.
 *
 * Config (env de la API):
 *   BOT_RH_URL               base del bot (ej. https://bot-rh-production.up.railway.app)
 *   AVISO_ASISTENCIA_SECRET  secreto compartido con el bot (header x-aviso-secret)
 *
 * Si BOT_RH_URL no está configurada, es no-op (deja rastro en log) — así el flujo
 * de aprobación de RH nunca se rompe por la notificación.
 */

export interface DatosAviso {
  empleadoNombre: string;
  sucursalId: string;
  fecha: string;
  regla: string;
  detalle: string;
  codigo: string; // para que el jefe responda "JUSTIFICAR <codigo> ..."
}

export async function notificarJefe(
  aviso: DatosAviso, jefe: JefeSucursal
): Promise<{ enviado: boolean; motivo?: string }> {
  const base = process.env.BOT_RH_URL;
  const secret = process.env.AVISO_ASISTENCIA_SECRET || '';
  if (!base) {
    console.log(`[agente-horarios][aviso] BOT_RH_URL no configurada; no se notifica a ${jefe.nombre || jefe.sucursalId}.`);
    return { enviado: false, motivo: 'sin BOT_RH_URL' };
  }
  if (!jefe.telefono) return { enviado: false, motivo: 'el jefe de la sucursal no tiene teléfono registrado' };
  try {
    const r = await fetch(`${base.replace(/\/$/, '')}/api/aviso-asistencia`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-aviso-secret': secret },
      body: JSON.stringify({
        telefono: jefe.telefono,
        jefe: jefe.nombre,
        empleado: aviso.empleadoNombre,
        sucursal: aviso.sucursalId,
        fecha: aviso.fecha,
        motivo: aviso.regla,
        detalle: aviso.detalle,
        codigo: aviso.codigo,
      }),
    });
    const data: any = await r.json().catch(() => ({}));
    if (!r.ok || data?.enviado === false) {
      return { enviado: false, motivo: data?.error || `el bot respondió HTTP ${r.status}` };
    }
    return { enviado: true };
  } catch (e: any) {
    return { enviado: false, motivo: e?.message || 'error de red al contactar al bot' };
  }
}
