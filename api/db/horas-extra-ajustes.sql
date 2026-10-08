-- =====================================================================
-- AJUSTES AL BANCO DE HORAS EXTRA (08/10/2026)
--
-- El banco (api/src/agente-horarios/horas-extra.ts) no se guarda: sale del
-- cálculo de asistencia desde HORAS_EXTRA_DESDE. Quien ya traía horas extra de
-- antes de esa fecha —y las usó después— quedaba en negativo. Aquí RH captura
-- el SALDO INICIAL (o cualquier corrección) de una persona, en minutos con
-- signo: +330 = le suma 5 h 30 min; -60 = le resta 1 h.
--
-- No se borra: se ANULA con motivo, para que la auditoría vea qué se quitó.
-- Idempotente: se aplica con `npm run migrate`.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS horas_extra_ajustes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal_id      TEXT NOT NULL,
  empleado_codigo  TEXT NOT NULL,
  minutos          INTEGER NOT NULL,
  -- Desde qué día cuenta (para ver el saldo "al" de una fecha anterior).
  fecha            DATE NOT NULL DEFAULT CURRENT_DATE,
  motivo           TEXT NOT NULL,
  creado_por       TEXT,
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  anulado_por      TEXT,
  anulado_en       TIMESTAMPTZ,
  motivo_anulacion TEXT,
  CONSTRAINT horas_extra_ajuste_minutos_ok CHECK (minutos <> 0 AND abs(minutos) <= 100000)
);

CREATE INDEX IF NOT EXISTS idx_he_ajustes_persona
  ON horas_extra_ajustes (sucursal_id, empleado_codigo);
