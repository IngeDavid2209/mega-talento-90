-- =====================================================================
-- CAMBIOS EN LOS RELOJES CHECADORES (27/09/2026)
--
-- Hasta hoy el sistema solo LEÍA los relojes. RH pidió poder, desde la ficha
-- de una persona, cambiarle el nombre y eliminarla "del sistema y de los
-- checadores". El portal no habla con los relojes: están en la red de cada
-- plaza y solo el agente local los alcanza. Así que el portal deja aquí un
-- COMANDO por reloj, y el agente lo toma, lo ejecuta dentro de su sesión y
-- reporta cómo le fue.
--
-- Cada comando guarda su RESPALDO (el registro de 72 bytes del usuario, tal
-- como estaba en el equipo) antes de tocar nada, y el resultado de volver a
-- leer el reloj después: "hecho" quiere decir VERIFICADO, no "se mandó".
--
-- Idempotente: se aplica con `npm run migrate`.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS reloj_comandos (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  serie            TEXT NOT NULL,                 -- a qué reloj va
  sucursal_id      TEXT NOT NULL,
  empleado_codigo  TEXT NOT NULL,
  tipo             TEXT NOT NULL,                 -- borrar_usuario | renombrar_usuario
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,   -- { nombre } al renombrar
  -- pendiente → (el agente lo toma) → hecho | error | cancelado
  estado           TEXT NOT NULL DEFAULT 'pendiente',
  intentos         INTEGER NOT NULL DEFAULT 0,
  detalle          TEXT,                          -- lo último que dijo el agente
  respaldo         JSONB,                         -- el usuario como estaba en el reloj
  creado_por       TEXT,
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reloj_comandos_serie_estado ON reloj_comandos (serie, estado);
CREATE INDEX IF NOT EXISTS idx_reloj_comandos_emp ON reloj_comandos (sucursal_id, empleado_codigo);

-- ELIMINADO ≠ DADO DE BAJA. La baja se revierte; lo eliminado ya no aparece en
-- ningún lado (ni en "Ver dadas de baja"). La fila se CONSERVA a propósito,
-- inactiva: si se borrara, la ingesta la volvería a crear activa en el
-- siguiente lote mientras el reloj siga trayendo a la persona, y sus checadas
-- históricas (nómina ya pagada) se quedarían sin a quién colgarse.
ALTER TABLE empleados ADD COLUMN IF NOT EXISTS eliminado_en TIMESTAMPTZ;
ALTER TABLE empleados ADD COLUMN IF NOT EXISTS eliminado_por TEXT;
