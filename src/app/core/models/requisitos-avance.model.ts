// =====================================================================
// REQUISITOS MÍNIMOS PARA AVANZAR DE FASE
// =====================================================================
//
// Lógica PURA: recibe el candidato y devuelve si cumple lo mínimo para pasar a
// la siguiente etapa, con los motivos en palabras. No toca red ni servicios.
//
// ── POR QUÉ EXISTE ──
//
// El 30/07/2026, auditando quién estaba en fases adelantadas, salieron 20
// candidatos que no debían estar ahí: gente sin CV, con el registro del bot a
// medias (le faltaba RFC, NSS o el tiempo de traslado), pidiendo un puesto que
// no está abierto, y una persona que declaró tener a su hermana trabajando en la
// empresa — un conflicto de interés que nadie revisó.
//
// La causa no era RH: era el AUTOAVANCE. Al terminar el cuestionario de
// liderazgo, si el candidato calificaba, el sistema lo movía solo a la 2ª fase.
// La única condición era el puntaje del cuestionario; nada más se revisaba.
//
// Contestar bien un cuestionario no sustituye tener expediente. Este archivo es
// el filtro que faltaba, y se usa en dos lados:
//   · el autoavance (portal/evaluacion-liderazgo): si no cumple, NO avanza solo.
//   · el avance manual (rh/expediente): avisa a RH con el motivo y deja decidir.
//
// OJO con la asimetría, que es deliberada: al sistema se le prohíbe avanzar solo,
// pero a RH solo se le advierte. Una persona puede tener razones que el sistema
// no conoce (trajo el CV impreso, el puesto se abre la semana que entra). Quien
// decide es quien puede explicar la decisión.

import { ID_ETAPAS } from './proceso.model';

export interface RevisionAvance {
  /** ¿Cumple lo mínimo para avanzar de fase? */
  ok: boolean;
  /** Qué le falta, en palabras que RH pueda leer. */
  motivos: string[];
}

/** ¿Tiene CV, en cualquiera de los dos lugares donde puede estar? */
export function tieneCV(c: any): boolean {
  if (!c) return false;
  if (String(c.cvUrl || '').trim()) return true;               // formulario web
  return (c.documentosBot || []).some((d: any) => d?.tipo === 'cv'); // WhatsApp
}

/**
 * Revisa los mínimos. `puestosAbiertos` es opcional: si se pasa la lista de
 * nombres de vacantes activas, también valida que el puesto exista.
 */
export function revisarAvance(c: any, puestosAbiertos?: string[]): RevisionAvance {
  const motivos: string[] = [];
  if (!c) return { ok: false, motivos: ['No hay datos del candidato.'] };

  // 1. Sin CV no hay nada que evaluar en las siguientes fases.
  if (!tieneCV(c)) motivos.push('No tiene CV en el expediente.');

  // 2. El bot dejó su registro a medias: falta un dato del filtro inicial.
  const estadoBot = String(c.estadoBot || '');
  if (estadoBot.startsWith('esperando_')) {
    const falta = estadoBot.replace('esperando_', '').replace(/_/g, ' ');
    motivos.push(`Su registro está incompleto: falta ${falta}.`);
  }

  // 3. Banderas graves del dictamen: son políticas de la empresa, no matices.
  //    (Un familiar en la empresa exige revisar conflicto de interés ANTES de
  //    seguirlo evaluando, no después.)
  const graves = ((c.dictamen?.reglas || []) as any[])
    .filter(r => r?.gravedad === 'alta' && r?.codigo !== 'sin_cv');
  for (const g of graves) motivos.push(g.texto || `Bandera grave: ${g.codigo}`);

  // 4. El puesto que pide, ¿sigue abierto? Solo si nos pasaron el catálogo.
  if (Array.isArray(puestosAbiertos) && puestosAbiertos.length && c.puesto) {
    const norm = (s: string) => String(s || '').toLowerCase().normalize('NFD')
      .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
    const pedido = norm(c.puesto);
    if (!puestosAbiertos.some(p => norm(p) === pedido)) {
      motivos.push(`El puesto "${c.puesto}" no está abierto hoy.`);
    }
  }

  return { ok: motivos.length === 0, motivos };
}

/**
 * ¿Se le permite al SISTEMA avanzar a este candidato por su cuenta?
 * Más estricto que `revisarAvance`: además exige que siga en la 1ª fase (no
 * retrocede a nadie ni toca a los ya resueltos).
 */
export function puedeAutoavanzar(c: any, puestosAbiertos?: string[]): RevisionAvance {
  const estado = c?.status;
  if (estado && estado !== ID_ETAPAS.FILTRO && estado !== ID_ETAPAS.NUEVO) {
    return { ok: false, motivos: ['Ya no está en Filtro Inicial.'] };
  }
  return revisarAvance(c, puestosAbiertos);
}
