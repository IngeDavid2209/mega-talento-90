-- =====================================================================
-- PAPELERA DE EMPLEADOS (29/09/2026)
--
-- RH quitó el botón de borrar: a nadie se le borra, se le da de BAJA, y la
-- baja se va a la Papelera de empleados, de donde se le puede regresar.
-- Para que la papelera diga cuándo y quién la dio de baja, esas dos cosas se
-- guardan aquí (antes `activo = false` no dejaba rastro de ninguna de las dos).
--
-- Idempotente: se aplica con `npm run migrate`.
-- =====================================================================

ALTER TABLE empleados ADD COLUMN IF NOT EXISTS baja_en  TIMESTAMPTZ;
ALTER TABLE empleados ADD COLUMN IF NOT EXISTS baja_por TEXT;
