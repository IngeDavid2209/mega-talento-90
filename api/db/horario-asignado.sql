-- =====================================================================
-- EL HORARIO DE CADA PERSONA, ASIGNADO POR RH (06/10/2026)
-- =====================================================================
--
-- `horarios_confirmados` ya mandaba sobre el horario deducido, pero solo
-- guardaba la hora de ENTRADA (la escribe el bot). RH pidió poner el horario
-- completo por persona desde el portal: entrada, salida, comida y sábado.
-- Contra él se miden retardo, tolerancia, faltas, salida antes, comida y horas.
--
-- Mismas columnas que crea el bot (BOT-RH/db/schema.sql), por si esta base
-- todavía no la tiene; luego se agregan las nuevas. Una fila SIN `salida` es
-- una confirmación vieja del bot y se sigue tratando como antes.
CREATE TABLE IF NOT EXISTS horarios_confirmados (
  sucursal_id      text NOT NULL,
  empleado_codigo  text NOT NULL,
  turnos           text[] NOT NULL,
  nota             text,
  confirmado_por   text,
  creado_en        timestamptz NOT NULL DEFAULT now(),
  actualizado_en   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sucursal_id, empleado_codigo)
);
ALTER TABLE horarios_confirmados ADD COLUMN IF NOT EXISTS salida         text;
ALTER TABLE horarios_confirmados ADD COLUMN IF NOT EXISTS comida_min     integer;
ALTER TABLE horarios_confirmados ADD COLUMN IF NOT EXISTS sabado         boolean NOT NULL DEFAULT false;
ALTER TABLE horarios_confirmados ADD COLUMN IF NOT EXISTS sabado_entrada text;
ALTER TABLE horarios_confirmados ADD COLUMN IF NOT EXISTS sabado_salida  text;
