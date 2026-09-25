-- =====================================================================
-- INCIDENCIAS DE PERSONAL (25/09/2026)
--
-- Vacaciones, permisos, incapacidades, faltas injustificadas, amonestaciones…
-- capturadas por RH desde el tablero de Horarios, por un día o por un periodo.
--
-- POR QUÉ UNA TABLA NUEVA Y NO `asistencia_revision`:
--   asistencia_revision es 1 fila por (sucursal, empleado, DÍA) con un solo
--   texto libre. Una incidencia es otra cosa:
--     (a) cubre un PERIODO (unas vacaciones son una decisión, no ocho filas);
--     (b) tiene un TIPO de catálogo, no texto libre: el cálculo decide por el
--         tipo si el día deja de contar como falta, y "vacasiones" escrito a
--         mano no debe cambiar la nómina;
--     (c) un día puede traer DOS (una amonestación el mismo día de un permiso).
--   Las justificaciones viejas de asistencia_revision se siguen respetando.
--
-- Idempotente: se aplica con `npm run migrate`.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS asistencia_incidencias (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal_id      TEXT NOT NULL,
  empleado_codigo  TEXT NOT NULL,
  -- vacaciones | permiso_sin_goce | permiso_con_goce | falta_injustificada |
  -- incapacidad | paternidad | maternidad | riesgo_trabajo | amonestacion |
  -- semana_reducida | otros   (el catálogo vive en api/src/incidencias.ts)
  tipo             TEXT NOT NULL,
  desde            DATE NOT NULL,
  hasta            DATE NOT NULL,
  nota             TEXT,
  creado_por       TEXT,
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT incidencia_rango_ok CHECK (hasta >= desde)
);

CREATE INDEX IF NOT EXISTS idx_incidencias_suc_fechas
  ON asistencia_incidencias (sucursal_id, desde, hasta);
CREATE INDEX IF NOT EXISTS idx_incidencias_emp
  ON asistencia_incidencias (sucursal_id, empleado_codigo);
