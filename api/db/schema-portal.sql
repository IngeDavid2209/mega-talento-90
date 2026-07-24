-- =====================================================================
-- MIGRACIÓN ADITIVA · Campos del portal sobre la base del bot
-- =====================================================================
-- Extiende la tabla `candidatos` del bot con los campos que hoy viven en
-- Firestore (portal), SIN romper al bot: todas las columnas son nullable y
-- el bot simplemente las ignora. Mapeo de campos compartidos que hace la API:
--   portal.nombre  → candidatos.nombre_completo
--   portal.ciudad  → candidatos.ciudad_sucursal
--   portal.puesto  → candidatos.puesto_interes
-- El estado/etapa del portal va aparte (portal_status) para no pisar el
-- `estado` del flujo de WhatsApp del bot.
-- Idempotente.
-- =====================================================================

ALTER TABLE candidatos ADD COLUMN IF NOT EXISTS portal_status         TEXT;
ALTER TABLE candidatos ADD COLUMN IF NOT EXISTS fuente                TEXT;
ALTER TABLE candidatos ADD COLUMN IF NOT EXISTS cv_url                TEXT;
ALTER TABLE candidatos ADD COLUMN IF NOT EXISTS cv_url_reverso        TEXT;
ALTER TABLE candidatos ADD COLUMN IF NOT EXISTS cv_formato            TEXT;
ALTER TABLE candidatos ADD COLUMN IF NOT EXISTS licencia_url          TEXT;
ALTER TABLE candidatos ADD COLUMN IF NOT EXISTS solicitud_electronica JSONB;
ALTER TABLE candidatos ADD COLUMN IF NOT EXISTS rubrica_aptitudes     JSONB;
ALTER TABLE candidatos ADD COLUMN IF NOT EXISTS aptitudes_eval        JSONB;
ALTER TABLE candidatos ADD COLUMN IF NOT EXISTS portal_data           JSONB DEFAULT '{}'::jsonb;
ALTER TABLE candidatos ADD COLUMN IF NOT EXISTS origen                TEXT;
ALTER TABLE candidatos ADD COLUMN IF NOT EXISTS ultima_actividad      TIMESTAMPTZ;
ALTER TABLE candidatos ADD COLUMN IF NOT EXISTS deleted_at            TIMESTAMPTZ;

-- Estado activo para los usuarios de RH (la tabla del bot no lo tenía).
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS activo BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS desactivado_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_candidatos_portal_id  ON candidatos (portal_candidate_id);
CREATE INDEX IF NOT EXISTS idx_candidatos_deleted_at ON candidatos (deleted_at);
CREATE INDEX IF NOT EXISTS idx_candidatos_portal_status ON candidatos (portal_status);

-- Historial de cambios de fase/etapa de cada candidato (para KPI de tiempo por
-- fase). Se inserta una fila cada vez que cambia portal_status. horas_en_origen =
-- tiempo que estuvo en la etapa que deja (desde la transición anterior o el alta).
CREATE TABLE IF NOT EXISTS candidatos_transiciones (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidato_id    TEXT NOT NULL,
  etapa_origen    TEXT,
  etapa_destino   TEXT NOT NULL,
  horas_en_origen NUMERIC,
  cambiado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_transiciones_candidato ON candidatos_transiciones (candidato_id);
CREATE INDEX IF NOT EXISTS idx_transiciones_origen    ON candidatos_transiciones (etapa_origen);

-- Vacantes del portal (no existía; el bot solo tiene `productos`, que es otra cosa).
CREATE TABLE IF NOT EXISTS puestos (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre            TEXT NOT NULL,
  descripcion       TEXT,
  sucursal_ids      TEXT[],
  sucursales        TEXT,
  sueldo            TEXT,
  horario           TEXT,
  requisitos        TEXT,
  imagen_url        TEXT,
  area              TEXT,
  activo            BOOLEAN NOT NULL DEFAULT TRUE,
  orden             INTEGER DEFAULT 999,
  hoja_competencias TEXT,
  extra             JSONB NOT NULL DEFAULT '{}'::jsonb,
  creado_en         TIMESTAMPTZ NOT NULL DEFAULT now()
);
