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

-- ---------------------------------------------------------------------
-- DESAYUNO EXCEDIDO (27/08/2026). Política de RH: 25 min en corporativo,
-- 30 en las demás plazas. El global lleva 30 y corporativo su propia fila.
--
-- `desayunoAlertaMin` es el mínimo de EXCESO para generar alerta; el exceso
-- SIEMPRE se ve en la pantalla de asistencia, alerte o no. Con umbral 1 serían
-- ~284 alertas por semana; con 10, ~149 (medido sobre 857 desayunos reales del
-- 10 al 23/08/2026). Este módulo ya se ahogó una vez en alertas y la lección
-- está escrita en corredor.ts: una alerta con ruido se ignora.
-- ---------------------------------------------------------------------
UPDATE asistencia_config SET config = config
     || '{"desayunoTopeMin": 30, "desayunoAlertaMin": 10, "desayunoHastaHora": "13:00", "desayunoMaxPlausibleMin": 120}'::jsonb
 WHERE sucursal_id = '__global__' AND NOT (config ? 'desayunoTopeMin');

UPDATE asistencia_config
   SET config = jsonb_set(config, '{reglasActivas,desayuno_excedido}', 'true'::jsonb, true)
 WHERE sucursal_id = '__global__' AND NOT (config -> 'reglasActivas' ? 'desayuno_excedido');

INSERT INTO asistencia_config (sucursal_id, config)
VALUES ('corporativo', '{"desayunoTopeMin": 25}'::jsonb)
ON CONFLICT (sucursal_id) DO UPDATE
   SET config = asistencia_config.config || '{"desayunoTopeMin": 25}'::jsonb;

-- HORAS NETAS (25/09/2026). En corporativo el desayuno se PAGA: las horas netas
-- descuentan solo la comida. Las demás plazas tienen una sola pausa (su comida)
-- y esa sí se descuenta. El código ya trae esta política como respaldo
-- (config.ts::POLITICA_POR_SUCURSAL); aquí queda escrita en la tabla.
UPDATE asistencia_config
   SET config = config || '{"desayunoCuentaComoJornada": true}'::jsonb
 WHERE sucursal_id = 'corporativo' AND NOT (config ? 'desayunoCuentaComoJornada');

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

-- =====================================================================
-- FASE 3 · EL AGENTE CORRE SOLO (corredor interno)
-- =====================================================================
-- Antes, la deteccion solo ocurria si alguien entraba a la pantalla y apretaba
-- un boton. Si nadie entraba, no pasaba nada: un agente que hay que despertar a
-- mano no es un agente. Ahora un corredor dentro del propio proceso de la API
-- revisa todas las sucursales cada N minutos.
--
-- Esta tabla es la BITACORA del corredor: una fila por sucursal con el resultado
-- de su ultima revision. Sirve para tres cosas concretas:
--   (a) que la pantalla pueda decir "revisado solo, hace 12 min" en vez de
--       mostrar un boton que el usuario cree obligatorio;
--   (b) que el corredor SALTE una sucursal cuyos datos no cambiaron (la huella),
--       en vez de re-analizar ocho sucursales cada media hora sin motivo;
--   (c) que un fallo quede registrado con su mensaje REAL y visible, en vez de
--       morir en silencio en los logs.
CREATE TABLE IF NOT EXISTS agente_corridas (
  sucursal_id        TEXT PRIMARY KEY,
  desde              TEXT,           -- ventana analizada, 'yyyy-MM-dd'
  hasta              TEXT,
  ultimo_dato        TEXT,           -- max(checadas.fecha) de ESTA sucursal
  primer_dato        TEXT,           -- min(checadas.fecha): revela historia no cubierta
  huella             TEXT,           -- 'ultimo_dato|numero de checadas en la ventana'
  empleados          INTEGER,
  omitidos_ex        INTEGER,        -- ex-trabajadores excluidos de la ventana
  creadas            INTEGER,
  actualizadas       INTEGER,
  eliminadas         INTEGER,
  pendientes         INTEGER,        -- alertas en 'sugerida_ia' que esperan a RH
  duracion_ms        INTEGER,
  error              TEXT,           -- mensaje REAL del fallo; NULL si salio bien
  saltada            BOOLEAN NOT NULL DEFAULT FALSE,  -- no cambio nada desde la corrida anterior
  corrida_en         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Arranque prudente del corredor: retardo/falta/fuera_de_turno APAGADAS ──
--
-- No es timidez, es aritmetica. Con la ventana de 45 dias al 28/07/2026 el agente
-- detecta 8,724 inconsistencias, y 6,257 de ellas (72%) salen de comparar las
-- checadas contra un horario que NO es el que la gente trabaja:
--
--   · 8-Esquinas esta configurada a las 07:30. Su entrada real va de 07:56 (p25)
--     a 12:32 (p75) -> 81% de "retardo". No llegan tarde: tienen varios turnos y
--     la sucursal tiene UNO configurado.
--   · Zamora Canindo esta configurada a las 09:00 y su p25 de entrada es 06:13
--     -> 1,018 "faltas" y 508 "fuera de turno" de gente que llego TRES HORAS
--     ANTES de su horario.
--
-- Si RH abre la pantalla y encuentra 8,724 tarjetas de las que 7 de cada 10 son
-- falsas, deja de creerle al agente y ya no lo vuelve a abrir. Una alerta falsa
-- cuesta mas que una alerta que no existe.
--
-- Quedan activas las tres reglas que son aritmetica pura sobre las marcas y no
-- necesitan que el horario este bien: checada duplicada, multiples entradas y
-- entrada sin salida. Son 2,467 y todas son hallazgos reales de integridad
-- (el 20% de los dias-persona tiene una marca faltante).
--
-- COMO SE REACTIVAN: cuando Capital Humano confirme los turnos reales de una
-- sucursal, se cargan en horarios_sucursal y se prende regla por regla, por
-- sucursal (una fila propia en asistencia_config pisa a la global). El marcador
-- `ajusteInicialAplicado` hace que este UPDATE no vuelva a correr, asi que una
-- migracion posterior NO reapaga lo que ya hayan encendido.
UPDATE asistencia_config
   SET config = config || '{
         "ajusteInicialAplicado": true,
         "reglasActivas": {
           "retardo": false,
           "falta": false,
           "fuera_de_turno": false,
           "checada_duplicada": true,
           "multiples_entradas": true,
           "entrada_sin_salida": true,
           "salida_sin_entrada": true
         }
       }'::jsonb,
       actualizado_en = now()
 WHERE sucursal_id = '__global__'
   AND NOT (config ? 'ajusteInicialAplicado');
