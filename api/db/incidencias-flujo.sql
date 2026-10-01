-- =====================================================================
-- FLUJO DE LAS INCIDENCIAS: estados, bitácora y cierre de semana (01/10/2026)
--
-- Antes, guardar una incidencia ERA aprobarla, y borrarla no dejaba rastro.
-- Eso dejaba a tres puestos sin su paso:
--   · el encargado no podía ENTREGAR una justificación para que otro la viera;
--   · servicios al personal no tenía dónde CALIFICAR lo que le entregan;
--   · contabilidad no podía AUDITAR ni reproducir el número que se pagó.
--
-- El camino de una incidencia:
--
--   capturada ──calificar──▶ calificada ──cierre de semana──▶ cerrada ──auditar──▶ auditada
--       └──rechazar──▶ rechazada           (cualquiera, sin cerrar) ──anular──▶ anulada
--
-- Solo calificada / cerrada / auditada cambian el cálculo de asistencia.
--
-- Idempotente: se aplica con `npm run migrate`.
-- =====================================================================

ALTER TABLE asistencia_incidencias ADD COLUMN IF NOT EXISTS estado TEXT NOT NULL DEFAULT 'calificada';
ALTER TABLE asistencia_incidencias ADD COLUMN IF NOT EXISTS calificado_por TEXT;
ALTER TABLE asistencia_incidencias ADD COLUMN IF NOT EXISTS calificado_en TIMESTAMPTZ;
ALTER TABLE asistencia_incidencias ADD COLUMN IF NOT EXISTS motivo_rechazo TEXT;
ALTER TABLE asistencia_incidencias ADD COLUMN IF NOT EXISTS auditado_por TEXT;
ALTER TABLE asistencia_incidencias ADD COLUMN IF NOT EXISTS auditado_en TIMESTAMPTZ;
ALTER TABLE asistencia_incidencias ADD COLUMN IF NOT EXISTS nota_auditoria TEXT;
ALTER TABLE asistencia_incidencias ADD COLUMN IF NOT EXISTS anulado_por TEXT;
ALTER TABLE asistencia_incidencias ADD COLUMN IF NOT EXISTS anulado_en TIMESTAMPTZ;
ALTER TABLE asistencia_incidencias ADD COLUMN IF NOT EXISTS motivo_anulacion TEXT;
-- Quién lo autorizó (el jefe que pidió el cambio de horario, quien dio el permiso).
ALTER TABLE asistencia_incidencias ADD COLUMN IF NOT EXISTS autorizo TEXT;
-- Solo "Horario distinto": su entrada de siempre (minuto del día), para medir
-- cuánto se corrió la hora sin tener que leerlo de la nota.
ALTER TABLE asistencia_incidencias ADD COLUMN IF NOT EXISTS horario_base_min INTEGER;

DO $$ BEGIN
  ALTER TABLE asistencia_incidencias ADD CONSTRAINT incidencia_estado_ok
    CHECK (estado IN ('capturada', 'calificada', 'rechazada', 'cerrada', 'auditada', 'anulada'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Lo que ya existía se guardó cuando guardar era aprobar: quedó CALIFICADO por
-- quien lo capturó. Se dice así, sin inventar un segundo revisor.
UPDATE asistencia_incidencias
   SET calificado_por = creado_por, calificado_en = creado_en
 WHERE estado = 'calificada' AND calificado_por IS NULL;

-- La hora de siempre de los "Horario distinto" viejos venía solo en la nota
-- ("... (su horario: 08:30)").
UPDATE asistencia_incidencias
   SET horario_base_min = split_part(substring(nota from 'su horario: (\d{1,2}:\d{2})'), ':', 1)::int * 60
                        + split_part(substring(nota from 'su horario: (\d{1,2}:\d{2})'), ':', 2)::int
 WHERE tipo = 'horario_distinto' AND horario_base_min IS NULL
   AND nota ~ 'su horario: \d{1,2}:\d{2}';

CREATE INDEX IF NOT EXISTS idx_incidencias_estado ON asistencia_incidencias (sucursal_id, estado);

-- ── BITÁCORA: cada paso, con quién, cuándo y cómo quedó la fila ──
-- Nunca se borra ni se edita: es lo que contabilidad lee para auditar.
CREATE TABLE IF NOT EXISTS asistencia_incidencias_bitacora (
  id              BIGSERIAL PRIMARY KEY,
  incidencia_id   UUID NOT NULL,
  -- creada | calificada | rechazada | anulada | cerrada | reabierta | auditada
  accion          TEXT NOT NULL,
  estado_antes    TEXT,
  estado_despues  TEXT,
  quien           TEXT,
  cuando          TIMESTAMPTZ NOT NULL DEFAULT now(),
  detalle         TEXT,
  -- La fila completa DESPUÉS del paso: lo que había, aunque luego cambie.
  fila            JSONB
);
CREATE INDEX IF NOT EXISTS idx_bitacora_incidencia ON asistencia_incidencias_bitacora (incidencia_id, cuando);

-- Las que ya existían entran a la bitácora con su alta original.
INSERT INTO asistencia_incidencias_bitacora (incidencia_id, accion, estado_antes, estado_despues, quien, cuando, detalle, fila)
SELECT i.id, 'creada', NULL, i.estado, i.creado_por, i.creado_en,
       'Capturada antes del flujo de calificación: guardar era aprobar.', to_jsonb(i)
  FROM asistencia_incidencias i
 WHERE NOT EXISTS (SELECT 1 FROM asistencia_incidencias_bitacora b WHERE b.incidencia_id = i.id);

-- ── CIERRE DE SEMANA: la foto de lo que se mandó a prenómina ──
-- El número de asistencia se recalcula cada vez (el horario sale del historial,
-- y llegan checadas tarde). Sin foto, la semana que se pagó no se puede volver a
-- ver tal cual. Al cerrar se guarda el cálculo completo y la semana se bloquea.
-- Reabrir no borra la foto: deja el renglón con quién, cuándo y por qué.
CREATE TABLE IF NOT EXISTS asistencia_cierres (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal_id        TEXT NOT NULL,
  desde              DATE NOT NULL,
  hasta              DATE NOT NULL,
  cerrado_por        TEXT,
  cerrado_en         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Resumen corto para la lista (personas, faltas, retardo, incidencias).
  resumen            JSONB,
  -- El resultado completo de asistenciaPersonas() de esa semana.
  foto               JSONB NOT NULL,
  reabierto_por      TEXT,
  reabierto_en       TIMESTAMPTZ,
  motivo_reapertura  TEXT,
  CONSTRAINT cierre_rango_ok CHECK (hasta >= desde)
);
-- Una sola semana CERRADA (vigente) por plaza.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cierre_vigente
  ON asistencia_cierres (sucursal_id, desde) WHERE reabierto_en IS NULL;
