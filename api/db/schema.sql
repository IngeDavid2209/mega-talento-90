-- =====================================================================
-- ESQUEMA POSTGRES · Mega Talento 90 — MÓDULO HORARIOS Y CHECADAS
-- =====================================================================
-- La base ya existe (la del bot de WhatsApp) con `usuarios`, `candidatos`,
-- `productos`, etc. Este script crea SOLO lo que falta y NO toca nada del bot.
--   · usuarios   → se REUSA la tabla del bot (auth lo mapea, no se recrea).
--   · candidatos → migración con diseño aparte (extender la tabla del bot).
-- Idempotente: CREATE ... IF NOT EXISTS, se puede correr varias veces.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- para gen_random_uuid()

-- Un área con checador dentro de una sucursal.
CREATE TABLE IF NOT EXISTS areas_checador (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal_id  TEXT NOT NULL,
  nombre       TEXT NOT NULL,
  ip_checador  TEXT,
  device_id    TEXT,
  activo       BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_areas_sucursal ON areas_checador (sucursal_id);

-- Turno/horario general de la sucursal (area_id NULL) o de un área.
CREATE TABLE IF NOT EXISTS horarios_sucursal (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal_id    TEXT NOT NULL,
  area_id        UUID,
  nombre         TEXT NOT NULL,
  dias           INTEGER[] NOT NULL DEFAULT '{}',   -- 0=domingo .. 6=sábado
  entrada        TEXT NOT NULL,                     -- 'HH:mm'
  inicio_comida  TEXT,
  fin_comida     TEXT,
  salida         TEXT NOT NULL,
  tolerancia_min INTEGER NOT NULL DEFAULT 0,
  activo         BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_horarios_sucursal ON horarios_sucursal (sucursal_id);

-- Empleado fijo por sucursal: mapea el código del reloj a un nombre.
CREATE TABLE IF NOT EXISTS empleados (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal_id     TEXT NOT NULL,
  codigo_checador TEXT NOT NULL,
  nombre          TEXT NOT NULL,
  puesto          TEXT,
  foto_url        TEXT,
  activo          BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sucursal_id, codigo_checador)
);
ALTER TABLE empleados ADD COLUMN IF NOT EXISTS foto_url TEXT;

-- DEPARTAMENTO y NOMBRE COMPLETO (18/08/2026).
--
-- El reporte semanal de RH (ReporteSemMD.rpt) NO lista a la gente por sucursal a
-- secas: la agrupa por DEPARTAMENTO (Compras, Contabilidad, Finanzas, RH,
-- Sistemas, Promotoras, Staff…), y usa el nombre COMPLETO, no el apodo del reloj.
-- Esa estructura vive en CONTPAQi/Crystal, no en el reloj; se recuperó de los
-- propios PDFs (api/tools/parsear-reportes.py) y se siembra aquí.
--
-- `nombre_completo` va APARTE de `nombre` a propósito: `nombre` puede traer una
-- corrección que hizo RH en el portal, y la regla del proyecto es no pisarla. La
-- pantalla usa `nombre_completo` cuando existe y cae a `nombre` si no.
ALTER TABLE empleados ADD COLUMN IF NOT EXISTS departamento TEXT;
ALTER TABLE empleados ADD COLUMN IF NOT EXISTS nombre_completo TEXT;
CREATE INDEX IF NOT EXISTS idx_empleados_departamento ON empleados (sucursal_id, departamento);

-- EL PUENTE ENTRE EL PROCESO Y LA NÓMINA (2026-08-03).
--
-- Hasta aquí `candidatos` y `empleados` eran dos mundos sin una sola línea que
-- los uniera: el portal sabía a quién se contrató y el reloj sabía quién llega a
-- trabajar, pero nadie podía responder "¿el que contratamos en mayo sigue?".
-- Esa pregunta es literalmente el KPI de permanencia a 90 días.
--
-- Se guarda en `empleados` y no en `candidatos` porque el padrón del reloj ya
-- existía con gente de años atrás que nunca pasó por el portal: la mayoría de
-- las filas se quedan en NULL, y eso está bien. La liga la confirma RH; el
-- sistema solo la sugiere por nombre (ver api/src/permanencia.ts).
ALTER TABLE empleados ADD COLUMN IF NOT EXISTS candidato_id UUID;
CREATE INDEX IF NOT EXISTS idx_empleados_candidato ON empleados (candidato_id);

-- PROMOTORAS (04/08/2026).
--
-- No son personal de piso: andan en calle o en punto de venta y no checan en el
-- reloj de la sucursal. Medidas con la misma vara que los de planta salían con
-- falta todos los días, y ese ruido diario es lo que hace que se deje de mirar
-- el tablero de asistencia.
--
-- Se marcan aquí y no en `puesto` porque el puesto es texto libre que cada
-- sucursal escribe a su manera: filtrar por él sería adivinar.
ALTER TABLE empleados ADD COLUMN IF NOT EXISTS es_promotora BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_empleados_promotora ON empleados (sucursal_id, es_promotora);

-- Una marca de asistencia ya importada del reloj.
CREATE TABLE IF NOT EXISTS checadas (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal_id      TEXT NOT NULL,
  area_id          UUID,
  device_id        TEXT,
  empleado_codigo  TEXT NOT NULL,
  empleado_nombre  TEXT,
  fecha_hora       TEXT NOT NULL,     -- 'yyyy-MM-ddTHH:mm:ss' (hora local del reloj)
  fecha            TEXT NOT NULL,     -- 'yyyy-MM-dd'
  hora             TEXT NOT NULL,     -- 'HH:mm:ss'
  tipo             INTEGER,
  dedup_key        TEXT NOT NULL UNIQUE,   -- evita duplicados al reimportar
  importado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_checadas_sucursal_fecha ON checadas (sucursal_id, fecha);

-- Revisión de RH sobre un día de asistencia: justificación del retardo/falta y
-- estado de verificación (pendiente/verificada/aprobada/rechazada). Una fila por
-- (sucursal, empleado, día); se hace upsert al capturar/cambiar.
CREATE TABLE IF NOT EXISTS asistencia_revision (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal_id      TEXT NOT NULL,
  empleado_codigo  TEXT NOT NULL,
  fecha            TEXT NOT NULL,     -- 'yyyy-MM-dd'
  justificacion    TEXT,
  estado           TEXT NOT NULL DEFAULT 'pendiente',
  actualizado_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sucursal_id, empleado_codigo, fecha)
);
CREATE INDEX IF NOT EXISTS idx_revision_suc_emp ON asistencia_revision (sucursal_id, empleado_codigo);
