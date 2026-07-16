// =====================================================================
// PARSER DE CHECADAS · Mega Talento 90
// Lee el archivo que exporta el reloj checador ZKTeco. Formato estándar
// `attlog.dat`: separado por tabuladores, en orden
//   código_empleado | fecha-hora | id_reloj | tipo | ...
// También acepta:
//   - CSV con ',' o ';'
//   - fecha 'dd/MM/yyyy HH:mm:ss' (algunos reportes COMPAC/CONTPAQi)
//   - fecha y hora en columnas separadas
//   - filas de un Excel ya leído con xlsx (sheet_to_json header:1)
// Salta encabezados y renglones basura sin romperse.
// =====================================================================

/** Una fila de checada cruda, tal como se extrajo del archivo (aún sin mapear a empleado). */
export interface FilaChecadaCruda {
  empleadoCodigo: string;
  fechaHora: string;   // 'yyyy-MM-ddTHH:mm:ss' — hora local del reloj (sin corrimiento de zona)
  fecha: string;       // 'yyyy-MM-dd'
  hora: string;        // 'HH:mm:ss'
  deviceId?: string;
  tipo?: number;
  lineaOriginal: string;
}

export interface ResultadoParseo {
  filas: FilaChecadaCruda[];
  ignoradas: number;
  totalLineas: number;
}

// Primer token cuando la línea es un encabezado (no una checada).
const CABECERA = /^(no\.?|id|emp|empleado|nombre|usuario|user|name|fecha|date|hora|time|c[oó]digo|codigo|device|reloj|estado|status|#)$/i;

const RE_FULL_ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const RE_FULL_DMY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const RE_DATE_ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const RE_DATE_DMY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const RE_TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

interface Comp { fecha: string; hora: string; fechaHora: string; }

/** Valida rangos y arma los componentes de fecha/hora. Devuelve null si algo es inválido. */
function componentes(y: number, mo: number, d: number, h: number, mi: number, s: number): Comp | null {
  if (y < 2000 || y > 2100) return null;
  if (mo < 1 || mo > 12) return null;
  if (d < 1 || d > 31) return null;
  if (h < 0 || h > 23) return null;
  if (mi < 0 || mi > 59) return null;
  if (s < 0 || s > 59) return null;
  const fecha = `${y}-${pad(mo)}-${pad(d)}`;
  const hora = `${pad(h)}:${pad(mi)}:${pad(s)}`;
  return { fecha, hora, fechaHora: `${fecha}T${hora}` };
}

/** ¿La celda es una fecha-hora completa? */
function parseFull(cell: string): Comp | null {
  let m = RE_FULL_ISO.exec(cell);
  if (m) return componentes(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0));
  m = RE_FULL_DMY.exec(cell);
  if (m) return componentes(+m[3], +m[2], +m[1], +m[4], +m[5], +(m[6] || 0));
  return null;
}

/** ¿La celda es solo fecha? Devuelve {y,mo,d}. */
function parseFecha(cell: string): { y: number; mo: number; d: number } | null {
  let m = RE_DATE_ISO.exec(cell);
  if (m) return { y: +m[1], mo: +m[2], d: +m[3] };
  m = RE_DATE_DMY.exec(cell);
  if (m) return { y: +m[3], mo: +m[2], d: +m[1] };
  return null;
}

/** ¿La celda es solo hora? Devuelve {h,mi,s}. */
function parseHora(cell: string): { h: number; mi: number; s: number } | null {
  const m = RE_TIME.exec(cell);
  if (!m) return null;
  return { h: +m[1], mi: +m[2], s: +(m[3] || 0) };
}

/** Convierte una celda de Excel (Date, número o texto) en texto uniforme. */
function celdaATexto(v: any): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date && !isNaN(v.getTime())) {
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())} ` +
      `${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}`;
  }
  return String(v).trim();
}

/** Elige el separador de una línea de texto. */
function separar(linea: string): string[] {
  if (linea.includes('\t')) return linea.split('\t');
  if (linea.includes(';')) return linea.split(';');
  if (linea.includes(',')) return linea.split(',');
  // Sin separador explícito: attlog delimitado por espacios (la fecha y la hora
  // quedan en celdas separadas, que el parser vuelve a combinar).
  return linea.trim().split(/\s+/);
}

/**
 * Núcleo del parser: toma las celdas de UNA fila y devuelve la checada, o null
 * si es un encabezado / basura (sin código o sin fecha-hora válida).
 */
function procesarCeldas(celdasRaw: string[], lineaOriginal: string): FilaChecadaCruda | null {
  const celdas = celdasRaw.map(c => (c || '').trim());

  const idxCodigo = celdas.findIndex(c => c !== '');
  if (idxCodigo === -1) return null;

  const empleadoCodigo = celdas[idxCodigo];
  if (CABECERA.test(empleadoCodigo)) return null;

  // Buscar la fecha-hora a partir de la celda siguiente al código.
  let comp: Comp | null = null;
  let dtEnd = -1;
  for (let k = idxCodigo + 1; k < celdas.length; k++) {
    const c = celdas[k];
    if (!c) continue;

    const full = parseFull(c);
    if (full) { comp = full; dtEnd = k; break; }

    const fpart = parseFecha(c);
    if (fpart) {
      // ¿La siguiente celda no vacía es una hora? Combínalas.
      let j = k + 1;
      while (j < celdas.length && celdas[j] === '') j++;
      const tpart = j < celdas.length ? parseHora(celdas[j]) : null;
      if (tpart) {
        comp = componentes(fpart.y, fpart.mo, fpart.d, tpart.h, tpart.mi, tpart.s);
        dtEnd = j;
      } else {
        // Fecha sin hora: asumimos medianoche para no perder la marca.
        comp = componentes(fpart.y, fpart.mo, fpart.d, 0, 0, 0);
        dtEnd = k;
      }
      if (comp) break;
    }
  }
  if (!comp) return null;

  // Lo que sigue a la fecha-hora: id_reloj y tipo (según formato attlog).
  const resto: string[] = [];
  for (let k = dtEnd + 1; k < celdas.length; k++) {
    if (celdas[k] !== '') resto.push(celdas[k]);
  }

  let deviceId: string | undefined;
  let tipo: number | undefined;
  if (resto.length) {
    if (/^\d+$/.test(resto[0])) deviceId = resto[0];
    const candTipo = deviceId !== undefined ? resto[1] : resto[0];
    if (candTipo !== undefined && /^\d+$/.test(candTipo)) {
      const n = parseInt(candTipo, 10);
      if (n >= 0 && n <= 15) tipo = n;
    }
  }

  return {
    empleadoCodigo,
    fechaHora: comp.fechaHora,
    fecha: comp.fecha,
    hora: comp.hora,
    deviceId,
    tipo,
    lineaOriginal
  };
}

/** Parser de texto plano (attlog.dat / .txt / .csv). */
export function parsearTextoChecadas(texto: string): ResultadoParseo {
  const lineas = (texto || '').split(/\r?\n/).filter(l => l.trim() !== '');
  const filas: FilaChecadaCruda[] = [];
  let ignoradas = 0;
  for (const linea of lineas) {
    const fila = procesarCeldas(separar(linea), linea);
    if (fila) filas.push(fila);
    else ignoradas++;
  }
  return { filas, ignoradas, totalLineas: lineas.length };
}

/** Parser de una matriz de celdas leída con xlsx (`sheet_to_json` con `header:1`). */
export function parsearFilasExcel(matriz: any[][]): ResultadoParseo {
  const filas: FilaChecadaCruda[] = [];
  let ignoradas = 0;
  let totalLineas = 0;
  for (const row of (matriz || [])) {
    if (!Array.isArray(row)) continue;
    const celdas = row.map(celdaATexto);
    if (celdas.every(c => c === '')) continue; // fila totalmente vacía: no cuenta
    totalLineas++;
    const lineaOriginal = celdas.join(' ');
    const fila = procesarCeldas(celdas, lineaOriginal);
    if (fila) filas.push(fila);
    else ignoradas++;
  }
  return { filas, ignoradas, totalLineas };
}
