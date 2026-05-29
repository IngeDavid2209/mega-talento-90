// =====================================================================
// SOLICITUD ELECTRÓNICA DE EMPLEO · Formato estándar mexicano
// Estructura que reemplaza al CV para candidatos que no lo envían.
// Se guarda dentro del documento del candidato en `solicitudElectronica`.
// =====================================================================

export interface DatosPersonales {
  nombre: string;
  fechaNacimiento: string;       // ISO date
  sexo: 'masculino' | 'femenino' | 'otro' | '';
  estadoCivil: 'soltero' | 'casado' | 'union_libre' | 'divorciado' | 'viudo' | '';
  nacionalidad: string;
  lugarNacimiento: string;       // ciudad, estado
}

export interface Identificacion {
  curp: string;
  rfc: string;
  nss: string;                   // Número de seguridad social
  ineFolio: string;              // Clave del INE
}

export interface Domicilio {
  calle: string;
  numero: string;
  colonia: string;
  ciudad: string;
  estado: string;
  codigoPostal: string;
}

export interface Contacto {
  telefono: string;
  telefonoEmergencia: string;
  contactoEmergencia: string;
  parentescoEmergencia: string;
  correo: string;
}

export interface Escolaridad {
  nivelMaximo: 'primaria' | 'secundaria' | 'bachillerato' | 'tecnico' | 'licenciatura' | 'posgrado' | '';
  institucion: string;
  carreraEspecialidad: string;
  anioTermino: string;
  certificado: boolean;
}

export interface EmpleoAnterior {
  empresa: string;
  puesto: string;
  fechaInicio: string;           // YYYY-MM
  fechaFin: string;              // YYYY-MM (o "actual")
  jefeDirecto: string;
  telefonoJefe: string;
  sueldoMensual: string;
  motivoSalida: string;
}

export interface Referencia {
  nombre: string;
  telefono: string;
  parentesco: string;            // "Vecino", "Amigo", "Conocido", etc.
  aniosConocer: string;
}

export interface PuestoDeseado {
  puesto: string;
  sueldoEsperado: string;
  fechaDisponibilidad: string;
  turnoPreferido: 'matutino' | 'vespertino' | 'mixto' | 'cualquiera' | '';
  motivoInteres: string;
}

export interface SolicitudElectronica {
  // Sección 1
  datosPersonales: DatosPersonales;
  // Sección 2
  identificacion: Identificacion;
  // Sección 3
  domicilio: Domicilio;
  // Sección 4
  contacto: Contacto;
  // Sección 5
  escolaridad: Escolaridad;
  // Sección 6 (hasta 3 empleos)
  experiencia: EmpleoAnterior[];
  // Sección 7 (2 referencias)
  referencias: Referencia[];
  // Sección 8
  puestoDeseado: PuestoDeseado;
  // Sección 9 — Aceptación legal
  aceptaAvisoPrivacidad: boolean;
  aceptaVeracidad: boolean;

  // Metadatos
  enviadaAt?: any;               // Timestamp
  ipPublica?: string;            // opcional, si se quiere registrar
}

/** Solicitud vacía inicial para inicializar el wizard */
export function solicitudVacia(): SolicitudElectronica {
  return {
    datosPersonales: {
      nombre: '', fechaNacimiento: '', sexo: '', estadoCivil: '',
      nacionalidad: 'Mexicana', lugarNacimiento: ''
    },
    identificacion: { curp: '', rfc: '', nss: '', ineFolio: '' },
    domicilio: {
      calle: '', numero: '', colonia: '', ciudad: '', estado: '', codigoPostal: ''
    },
    contacto: {
      telefono: '', telefonoEmergencia: '', contactoEmergencia: '',
      parentescoEmergencia: '', correo: ''
    },
    escolaridad: {
      nivelMaximo: '', institucion: '', carreraEspecialidad: '',
      anioTermino: '', certificado: false
    },
    experiencia: [
      { empresa: '', puesto: '', fechaInicio: '', fechaFin: '', jefeDirecto: '', telefonoJefe: '', sueldoMensual: '', motivoSalida: '' }
    ],
    referencias: [
      { nombre: '', telefono: '', parentesco: '', aniosConocer: '' },
      { nombre: '', telefono: '', parentesco: '', aniosConocer: '' }
    ],
    puestoDeseado: {
      puesto: '', sueldoEsperado: '', fechaDisponibilidad: '',
      turnoPreferido: '', motivoInteres: ''
    },
    aceptaAvisoPrivacidad: false,
    aceptaVeracidad: false
  };
}

/** Estados civiles para selects */
export const ESTADOS_CIVILES = [
  { id: 'soltero',     label: 'Soltero/a' },
  { id: 'casado',      label: 'Casado/a' },
  { id: 'union_libre', label: 'Unión libre' },
  { id: 'divorciado',  label: 'Divorciado/a' },
  { id: 'viudo',       label: 'Viudo/a' }
] as const;

export const NIVELES_ESCOLARIDAD = [
  { id: 'primaria',     label: 'Primaria' },
  { id: 'secundaria',   label: 'Secundaria' },
  { id: 'bachillerato', label: 'Bachillerato / Preparatoria' },
  { id: 'tecnico',      label: 'Carrera técnica' },
  { id: 'licenciatura', label: 'Licenciatura' },
  { id: 'posgrado',     label: 'Posgrado' }
] as const;

export const TURNOS = [
  { id: 'matutino',   label: 'Matutino' },
  { id: 'vespertino', label: 'Vespertino' },
  { id: 'mixto',      label: 'Mixto' },
  { id: 'cualquiera', label: 'Cualquier turno' }
] as const;
