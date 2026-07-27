-- =====================================================================
-- ESQUEMA POSTGRES · AGENTE DE HORARIOS (Fase 1 — capa agéntica)
-- =====================================================================
-- Aditivo e idempotente. NO toca las tablas del módulo de checadas
-- (checadas, empleados, horarios_sucursal, asistencia_revision) ni las del
-- bot. Solo agrega lo que necesita el agente:
--   · asistencia_alertas → borradores de inconsistencias detectadas por la IA.
--   · asistencia_config  → umbrales de las reglas (NO hardcodeados).
--
-- Se aplica con `npm run migrate` (src/scripts/migrate.ts ya lo incluye).
--
-- POR QUÉ UNA TABLA NUEVA Y NO `asistencia_revision`:
--   asistencia_revision es 1 fila por (sucursal, empleado, día) y es la que RH
--   edita a mano desde el front (PUT /checador/revision). El agente necesita:
--     (a) VARIAS inconsistencias por día (un día puede tener retardo Y entrada
--         sin salida) → aquí es 1 fila por (día, regla);
--     (b) EVIDENCIA estructurada (qué checadas, minutos, turno esperado) en jsonb;
--     (c) NO pisar el trabajo manual de RH → tabla separada, estado propio.
--   El agente SOLO escribe estado='sugerida_ia'. RH la mueve a aprobada/rechazada.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Borrador de una inconsistencia detectada por el agente para un empleado-día.
CREATE TABLE IF NOT EXISTS asistencia_alertas (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal_id            TEXT NOT NULL,
  empleado_codigo        TEXT NOT NULL,
  empleado_nombre        TEXT,
  fecha                  TEXT NOT NULL,                        -- 'yyyy-MM-dd'
  regla                  TEXT NOT NULL,                        -- retardo|falta|checada_duplicada|multiples_entradas|entrada_sin_salida|salida_sin_entrada|fuera_de_turno
  severidad              TEXT NOT NULL DEFAULT 'media',        -- baja|media|alta
  detalle                TEXT,                                 -- descripción legible para RH
  evidencia              JSONB NOT NULL DEFAULT '{}'::jsonb,   -- { checadas, minutosRetardo, horarioEsperado, inferido, ... }
  justificacion_sugerida TEXT,                                 -- borrador que el agente propone (RH lo edita/aprueba)
  estado                 TEXT NOT NULL DEFAULT 'sugerida_ia',  -- sugerida_ia → (RH) aprobada|rechazada|descartada
  origen                 TEXT NOT NULL DEFAULT 'agente_ia',
  decidido_por           TEXT,                                 -- quién (RH) la resolvió
  decidido_en            TIMESTAMPTZ,
  analizado_en           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Una alerta por (sucursal, empleado, día, regla): re-analizar hace UPSERT,
  -- no duplica. El UPSERT solo refresca las que siguen en 'sugerida_ia'.
  UNIQUE (sucursal_id, empleado_codigo, fecha, regla)
);
CREATE INDEX IF NOT EXISTS idx_alertas_suc_fecha ON asistencia_alertas (sucursal_id, fecha);
CREATE INDEX IF NOT EXISTS idx_alertas_estado    ON asistencia_alertas (estado);
CREATE INDEX IF NOT EXISTS idx_alertas_suc_emp   ON asistencia_alertas (sucursal_id, empleado_codigo);

-- Configuración de reglas por sucursal. La fila '__global__' es el default para
-- todas; una fila con el id de una sucursal la sobrescribe (merge parcial en código).
CREATE TABLE IF NOT EXISTS asistencia_config (
  sucursal_id     TEXT PRIMARY KEY,                 -- '__global__' = default global
  config          JSONB NOT NULL DEFAULT '{}'::jsonb,
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Semilla del default global (no pisa si ya existe). Los mismos valores viven
-- como respaldo en código (config.ts::CONFIG_DEFAULT) por si la tabla está vacía.
INSERT INTO asistencia_config (sucursal_id, config) VALUES (
  '__global__',
  '{
    "duplicadaMinutos": 5,
    "saltoEntradasHoras": 4,
    "ventanaFueraTurnoMin": 120,
    "usarToleranciaHorario": true,
    "toleranciaRetardoMin": null,
    "marcarFaltas": true,
    "soloDiasCerrados": true,
    "faltaSoloConActividadEnRango": true,
    "reglasActivas": {
      "retardo": true,
      "falta": true,
      "checada_duplicada": true,
      "multiples_entradas": true,
      "entrada_sin_salida": true,
      "fuera_de_turno": true
    }
  }'::jsonb
)
ON CONFLICT (sucursal_id) DO NOTHING;

-- Si el default global ya existía sin la llave nueva, la agrega (idempotente).
UPDATE asistencia_config
   SET config = jsonb_set(config, '{faltaSoloConActividadEnRango}', 'true'::jsonb, true)
 WHERE sucursal_id = '__global__' AND NOT (config ? 'faltaSoloConActividadEnRango');

-- Liga (opcional) de un empleado a su TURNO asignado. Si está puesta, el agente
-- usa ESE horario para retardo/falta/fuera-de-turno; si es NULL, cae al horario
-- general de la sucursal por día de la semana. Aditiva: no rompe checadas ni el
-- CRUD de empleados existente.
ALTER TABLE empleados ADD COLUMN IF NOT EXISTS horario_id UUID;

-- JEFE responsable por SUCURSAL (a quién se le avisa por WhatsApp cuando RH
-- aprueba una alerta). Modelo simple 1 jefe por sucursal (los empleados ya
-- tienen sucursal_id). El teléfono lo captura RH; sin él no se puede notificar.
CREATE TABLE IF NOT EXISTS jefes_sucursal (
  sucursal_id     TEXT PRIMARY KEY,
  nombre          TEXT,
  telefono        TEXT,
  activo          BOOLEAN NOT NULL DEFAULT TRUE,
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fase 2b: respuesta/justificación del jefe capturada por WhatsApp. Al avisar
-- (RH aprueba) se genera un `codigo` corto; el jefe responde "JUSTIFICAR <codigo>
-- <texto>" al bot y esa justificación queda pegada a la alerta.
ALTER TABLE asistencia_alertas ADD COLUMN IF NOT EXISTS codigo             TEXT;
ALTER TABLE asistencia_alertas ADD COLUMN IF NOT EXISTS justificacion_jefe TEXT;
ALTER TABLE asistencia_alertas ADD COLUMN IF NOT EXISTS respondido_por     TEXT;
ALTER TABLE asistencia_alertas ADD COLUMN IF NOT EXISTS respondido_en      TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_alertas_codigo ON asistencia_alertas (codigo);
