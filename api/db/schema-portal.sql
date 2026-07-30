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
  candidato_id    UUID NOT NULL,
  etapa_origen    TEXT,
  etapa_destino   TEXT NOT NULL,
  horas_en_origen NUMERIC,
  cambiado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- MIGRACIÓN (2026-07-29). La tabla nació con `candidato_id TEXT` y eso rompía en
-- silencio TODO el registro de transiciones: la consulta que inserta compara el
-- mismo parámetro contra esta columna (text) y contra candidatos.id (uuid), y
-- Postgres aborta con «operator does not exist: uuid = text». El error caía en un
-- catch con console.warn, así que la tabla llevaba 5 días en cero sin que nadie
-- lo notara — y sin historial no hay KPI de tiempo por etapa ni de cobertura.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'candidatos_transiciones'
       AND column_name = 'candidato_id'
       AND data_type = 'text'
  ) THEN
    ALTER TABLE candidatos_transiciones
      ALTER COLUMN candidato_id TYPE uuid USING candidato_id::uuid;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_transiciones_candidato ON candidatos_transiciones (candidato_id);
CREATE INDEX IF NOT EXISTS idx_transiciones_origen    ON candidatos_transiciones (etapa_origen);

-- =====================================================================
-- BITÁCORA DE EVENTOS DEL PROCESO (KPI "Concentrado de candidatos")
--
-- Por qué hace falta una tabla y no otra bandera en portal_data: el KPI que pide
-- RH necesita saber CUÁNDO pasó cada cosa y CUÁNTAS veces, no solo si pasó. Un
-- campo booleano responde "¿ya se le llamó?"; esto responde "¿a cuántas personas
-- se contactó el martes?", que es la pregunta real.
--
-- Al 29/07/2026 no existía forma de medir: (1) los contactos que RH hace por
-- teléfono o WhatsApp personal (solo se veían los del bot, en la tabla mensajes),
-- (2) las entrevistas realizadas (no había evento con fecha), (3) las
-- contrataciones (la etapa existe y nadie la usaba).
--
--   tipo  = contacto | entrevista | contratacion | nota
--   canal = llamada | whatsapp | presencial | bot | portal   (nulo si no aplica)
--   por   = usuario de RH que lo registró (o 'bot')
-- =====================================================================
CREATE TABLE IF NOT EXISTS candidatos_eventos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidato_id  UUID NOT NULL,
  tipo          TEXT NOT NULL,
  canal         TEXT,
  nota          TEXT,
  por           TEXT,
  ocurrido_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_eventos_candidato ON candidatos_eventos (candidato_id);
CREATE INDEX IF NOT EXISTS idx_eventos_tipo_fecha ON candidatos_eventos (tipo, ocurrido_en);

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

-- =====================================================================
-- REQUISICIONES DE PERSONAL
--
-- La petición formal de una sucursal: "necesito a alguien para este puesto".
-- Hasta ahora esto viajaba por WhatsApp y por eso no había forma de saber
-- cuántas están esperando, desde cuándo, ni cuáles ya se cubrieron.
--
-- Tres decisiones que explican la forma de la tabla:
--
-- 1. `puesto` ES TEXTO LIBRE Y `puesto_id` ES OPCIONAL. Se pide personal para
--    puestos que todavía NO existen como vacante publicada — de hecho ese es el
--    caso normal: primero se pide, después se abre la vacante. Obligar a elegir
--    de un catálogo haría que la requisición no se pudiera capturar cuando más
--    urge.
--
-- 2. LA URGENCIA SE GUARDA COMO FECHA, NO COMO BANDERA. "Urgente" envejece:
--    lo que era para hoy, mañana ya está vencido y nadie lo nota. Con
--    `fecha_requerida` la pantalla puede decir "vencida hace 3 días" en vez de
--    un chip rojo permanente que se vuelve paisaje.
--
-- 3. `cubierta_por` APUNTA AL CANDIDATO. Es el puente que faltaba entre pedir
--    gente y contratarla: sin él no se puede responder "esta vacante, ¿con
--    quién se cubrió y en cuántos días?".
--
--   estado = pendiente | autorizada | rechazada | cubierta | cancelada
-- =====================================================================
CREATE TABLE IF NOT EXISTS requisiciones (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  folio           SERIAL,
  puesto          TEXT NOT NULL,
  puesto_id       UUID REFERENCES puestos(id) ON DELETE SET NULL,
  sucursal_id     TEXT,
  area            TEXT,
  vacantes        INTEGER NOT NULL DEFAULT 1,
  motivo          TEXT,               -- nuevo | reemplazo | temporal | otro
  reemplaza_a     TEXT,               -- a quién sustituye, si es reemplazo
  fecha_requerida DATE,               -- para cuándo se necesita (hoy = urgente)
  justificacion   TEXT,
  archivo_url     TEXT,               -- el formato escaneado/firmado, si lo hay
  archivo_nombre  TEXT,
  solicita        TEXT,               -- quién la pide (jefe de la sucursal)
  estado          TEXT NOT NULL DEFAULT 'pendiente',
  resuelta_por    TEXT,
  resuelta_en     TIMESTAMPTZ,
  nota_resolucion TEXT,
  cubierta_por    UUID REFERENCES candidatos(id) ON DELETE SET NULL,
  cubierta_en     TIMESTAMPTZ,
  creado_por      TEXT,
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_requis_estado   ON requisiciones (estado);
CREATE INDEX IF NOT EXISTS idx_requis_fecha    ON requisiciones (fecha_requerida);
CREATE INDEX IF NOT EXISTS idx_requis_sucursal ON requisiciones (sucursal_id);
