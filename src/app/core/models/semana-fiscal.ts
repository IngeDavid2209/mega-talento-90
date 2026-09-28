/**
 * SEMANA FISCAL (28/09/2026).
 *
 * RH cuenta el año en semanas: "vamos en la 39 de 52". Aquí la semana es la de
 * NÓMINA —la misma con la que se acumulan la tolerancia y las horas extra—, que
 * abre en jueves (`diaInicio` = 4; lo manda la API como `diaInicioSemana`).
 *
 * La regla: la SEMANA 1 es la semana de nómina que contiene el 1 de enero. Una
 * semana pertenece al año en que TERMINA, así que la que cruza de diciembre a
 * enero ya cuenta como la 1 del año nuevo.
 *
 * El año casi siempre trae 52 semanas; cada cinco o seis años trae 53 (cuando
 * el 1 de enero cae justo en el día de corte). Se calcula, no se da por hecho:
 * decir "52 de 52" cuando falta una semana manda a cerrar el año antes.
 *
 * En 2026 el 1 de enero fue jueves: la semana 1 es jue 01 ene → mié 07 ene.
 */

const DIA_MS = 86400000;

function aIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Inicio (a mediodía, para no pelear con horarios de verano) de la semana que contiene a `d`. */
function inicioDeSemana(d: Date, diaInicio: number): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);
  x.setDate(x.getDate() - ((x.getDay() - diaInicio + 7) % 7));
  return x;
}

function inicioSemana1(anio: number, diaInicio: number): Date {
  return inicioDeSemana(new Date(anio, 0, 1, 12), diaInicio);
}

export interface SemanaFiscal {
  numero: number;
  anio: number;
  /** Cuántas semanas trae ese año (52, a veces 53). */
  total: number;
  /** 'yyyy-MM-dd' del primer y último día de la semana. */
  inicio: string;
  fin: string;
}

export function semanaFiscal(fechaIso: string, diaInicio = 4): SemanaFiscal {
  const f = new Date(fechaIso + 'T12:00:00');
  const ini = inicioDeSemana(f, diaInicio);
  const fin = new Date(ini); fin.setDate(ini.getDate() + 6);
  const anio = fin.getFullYear();
  const s1 = inicioSemana1(anio, diaInicio);
  const s1Sig = inicioSemana1(anio + 1, diaInicio);
  return {
    numero: Math.round((ini.getTime() - s1.getTime()) / (7 * DIA_MS)) + 1,
    anio,
    total: Math.round((s1Sig.getTime() - s1.getTime()) / (7 * DIA_MS)),
    inicio: aIso(ini),
    fin: aIso(fin),
  };
}
