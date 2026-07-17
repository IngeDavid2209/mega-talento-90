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
