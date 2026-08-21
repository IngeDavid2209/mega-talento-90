-- =====================================================================
-- CHECADAS EN VIVO · padrón de relojes, latido e ingesta
-- =====================================================================
-- Extiende el módulo de horarios y checadas (db/schema.sql) para que el dato
-- lo EMPUJE algo que sí está en la LAN de los relojes, en vez de que una PC
-- con el DATABASE_URL de producción los jale cada 5 minutos.
--
-- Idempotente: CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ---------------------------------------------------------------------
-- PADRÓN DE RELOJES — reemplaza a tools/targets.json.
--
-- LA IDENTIDAD DEL RELOJ ES SU NÚMERO DE SERIE, NO SU IP.
--
-- El importador viejo identificaba cada equipo por IP. Morelia Madero
-- (192.168.32.215) tiene DHCP ENCENDIDO: en cuanto se reinicia, esa plaza deja
-- de bajar y nadie se entera —no sale ningún error, simplemente dejan de llegar
-- checadas—. Peor todavía, si otro equipo toma esa IP, las marcas de una plaza
-- entran bajo el nombre de otra, y eso NO se nota mirando la pantalla.
--
-- Con la serie como llave, el agente reencuentra el reloj aunque le cambien la
-- dirección, y `ip` queda como dato informativo (la última donde se le vio).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS relojes (
  serie            TEXT PRIMARY KEY,        -- serial del equipo (~SerialNumber)
  sucursal_id      TEXT NOT NULL,
  alias            TEXT,                    -- 'Oficinas entrada/salida'
  ip               TEXT,                    -- ÚLTIMA ip conocida, informativa
  puerto           INTEGER NOT NULL DEFAULT 4370,
  modo             TEXT NOT NULL DEFAULT 'agente',   -- agente | push | manual
  comm_key         INTEGER,                 -- contraseña de comunicación, si tiene
  activo           BOOLEAN NOT NULL DEFAULT TRUE,
  pendiente        BOOLEAN NOT NULL DEFAULT FALSE,   -- NO aplicar (sin identificar)
  nota             TEXT,
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_relojes_sucursal ON relojes (sucursal_id);

-- ---------------------------------------------------------------------
-- LATIDO — sin esto, un reloj muerto es INVISIBLE.
--
-- Hoy la pantalla se ve igual con un reloj al día que con uno apagado desde
-- hace tres semanas: en los dos casos sale la última asistencia que hay en la
-- base. Esta tabla es lo que permite decir "esta plaza lleva 2 h sin señal" en
-- vez de dejar que RH suponga que todos faltaron.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS relojes_estado (
  serie              TEXT PRIMARY KEY REFERENCES relojes(serie) ON DELETE CASCADE,
  ultima_senal       TIMESTAMPTZ,       -- último lote recibido del agente (aunque venga vacío)
  ultima_checada     TIMESTAMPTZ,       -- fecha_hora más reciente recibida
  ultimo_backfill    TIMESTAMPTZ,       -- última lectura VERIFICADA completa
  ip_vista           TEXT,              -- IP donde se le encontró (puede != relojes.ip)
  logs_en_reloj      INTEGER,           -- info.logCounts declarado por el equipo
  logs_en_base       INTEGER,           -- lo que tenemos nosotros de esa serie
  desfase_reloj_seg  INTEGER,           -- hora del reloj − hora del servidor
  ultimo_error       TEXT,
  agente_version     TEXT,
  agente_host        TEXT
);

-- CUÁNDO LO LEYÓ QUIEN NOS DA EL DATO (17/08/2026).
--
-- El latido de arriba dice que NUESTRO agente está vivo. No dice que el dato
-- esté fresco, y no es lo mismo: el agente lee de la base del proveedor, y si
-- ESE sistema deja de sondear sus relojes, nosotros seguimos copiando
-- fielmente una base congelada. Con el semáforo mirando solo `ultima_senal`,
-- las diez plazas se ven en verde mientras la asistencia lleva horas parada.
--
-- Pasó el mismo 17/08: el proveedor hizo una carga a las 15:08 y no volvió a
-- correr; a las 17:36 seguíamos "al día" contra un origen de 2.5 horas atrás.
--
-- Esta columna guarda el `last_seen_at` que el propio origen reporta por
-- equipo. El semáforo se queda con LO PEOR de las dos señales.
ALTER TABLE relojes_estado ADD COLUMN IF NOT EXISTS origen_visto TIMESTAMPTZ;

-- ---------------------------------------------------------------------
-- TRADUCCIÓN DE CÓDIGOS — relojes con numeración propia.
--
-- Caso real documentado el 05/08/2026: 192.168.0.81 ("Oficinas desayuno y
-- comida") es LA MISMA GENTE de corporativo con OTRA numeración —#11 es Alfonso,
-- que en el padrón es #111; #21 Ivonne (#121); #6 Perla (#106); #23 Carmen
-- (#123)—. De sus 47 usuarios, 34 tienen nombre idéntico en el padrón y solo 1
-- código coincide con el reloj de entrada/salida.
--
-- Jalarlo por código le atribuiría las marcas a la PERSONA EQUIVOCADA. Por eso
-- ese reloj está en `pendiente` hasta que su traducción esté completa aquí.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reloj_codigo_map (
  serie            TEXT NOT NULL REFERENCES relojes(serie) ON DELETE CASCADE,
  codigo_reloj     TEXT NOT NULL,
  codigo_empleado  TEXT NOT NULL,
  nota             TEXT,
  PRIMARY KEY (serie, codigo_reloj)
);

-- ---------------------------------------------------------------------
-- COLA DE INGESTA CRUDA — el lote tal como llegó, ANTES de procesarlo.
--
-- Sirve para tres cosas que hoy no se pueden hacer:
--   · Reprocesar sin volver a bajar el reloj (bajar 50 mil registros de
--     8-Esquinas son ~2 MB y varios minutos).
--   · No perder el dato de un reloj cuya serie todavía no está dada de alta:
--     se guarda con error='serie desconocida' y se aplica cuando RH lo registre.
--   · Guardar lo que manda un reloj `pendiente` sin dejar que entre a `checadas`.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingesta_lotes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  serie         TEXT,
  origen        TEXT NOT NULL,        -- agente | push | manual
  recibido_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
  registros     INTEGER NOT NULL,
  aceptados     INTEGER,
  crudo         JSONB,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_lotes_serie ON ingesta_lotes (serie, recibido_en DESC);
-- Los que hay que resolver a mano: series sin registrar y relojes en pausa.
CREATE INDEX IF NOT EXISTS idx_lotes_error ON ingesta_lotes (recibido_en DESC) WHERE error IS NOT NULL;

-- ---------------------------------------------------------------------
-- CHECADAS — de qué equipo vino y por dónde entró.
-- ---------------------------------------------------------------------
ALTER TABLE checadas ADD COLUMN IF NOT EXISTS serie_reloj TEXT;
ALTER TABLE checadas ADD COLUMN IF NOT EXISTS origen TEXT;         -- agente|push|manual|directo
ALTER TABLE checadas ADD COLUMN IF NOT EXISTS recibido_en TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_checadas_recibido ON checadas (recibido_en DESC);
CREATE INDEX IF NOT EXISTS idx_checadas_serie ON checadas (serie_reloj, fecha);

-- =====================================================================
-- EL ARREGLO DEL dedup_key  (bug latente, encontrado el 17/08/2026)
-- =====================================================================
-- La clave anterior era:
--
--     sucursal_id__codigo__fechaHora
--
-- Corporativo tiene DOS relojes: 192.168.0.80 (entrada y salida) y
-- 192.168.0.81 (desayuno y comida). Los dos son `sucursal_id='corporativo'`.
-- Con la misma sucursal, el mismo código y el mismo segundo, la checada del
-- SEGUNDO reloj se descartaba como duplicado y se perdía en silencio. El
-- registro nunca llegaba a existir, así que no hay manera de auditarlo después.
--
-- La clave nueva es:
--
--     serie__codigoEmpleado__fechaHora
--
-- ⚠️ CONVIVEN DOS FORMATOS A PROPÓSITO. El histórico ya cargado tiene claves sin
-- serie y NO se reescribe: renombrar millones de dedup_key para "emparejar" es
-- una operación destructiva que arriesga el único registro que tenemos de años
-- de asistencia, y no compra nada —lo viejo ya está insertado, y la clave solo
-- sirve para no insertar dos veces—.
--
-- El efecto de convivir: una checada YA cargada con la clave vieja podría
-- volver a entrar UNA vez con la clave nueva, porque la llave es distinta. Eso
-- se ataja en la ingesta, no con una restricción: al insertar se descarta la
-- fila si ya existe una con el mismo (sucursal, código, fecha_hora) y sin serie
-- —el histórico— o con ESTA misma serie. Ver `aplicarLote()` en
-- api/src/ingesta.ts.
--
-- NO se pone un UNIQUE de contenido a propósito. Serviría para lo mismo, pero
-- la restricción tendría que incluir la serie para que .80 y .81 puedan
-- convivir, y entonces no atraparía justo el caso que aquí importa: histórico
-- sin serie contra dato nuevo con serie. Además, un índice único sobre una
-- tabla de millones de filas ya cargadas falla al crearse si hay un solo
-- duplicado viejo, y dejaría la migración a medias.
--
-- Este índice es solo para que ese descarte sea rápido:
CREATE INDEX IF NOT EXISTS idx_checadas_dedup_contenido
  ON checadas (sucursal_id, empleado_codigo, fecha_hora);

-- ---------------------------------------------------------------------
-- PADRÓN DEPURADO — la lápida que evita que una ficha revida.
--
-- El 21/08/2026 se depuraron 503 fichas del padrón (gente sin checadas en tres
-- meses y que no aparece en el reporte semanal de RH). Diez minutos después, las
-- 10 de Zamora Catedral estaban de vuelta con `creado_en` de esa misma tarde.
--
-- No fue un error del barrido: el upsert de la ingesta las repone. Si la ficha
-- existe, cada lote solo le repasa el nombre; si NO existe porque se borró, entra
-- por el INSERT con `activo = true`. Y vuelve porque la persona sigue ENROLADA EN
-- EL RELOJ, que manda su padrón completo en cada lote. Borrar de la base sin dar
-- de baja en el equipo es discutir con el reloj, y el reloj tiene la última
-- palabra.
--
-- Esta tabla es la respuesta: la ingesta puede seguir reponiendo la ficha —de
-- hecho conviene, para que sus checadas tengan a quién colgarse— pero la repone
-- INACTIVA. La lápida no bloquea el dato; le quita el estatus de activo.
--
-- Para revivir a alguien (recontratación, o una depuración equivocada) se borra
-- su renglón de aquí y se pone activo=TRUE en su ficha. Las dos cosas, porque
-- mientras la lápida esté puesta el siguiente lote la volvería a apagar.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS padron_depurado (
  sucursal_id      TEXT NOT NULL,
  codigo_checador  TEXT NOT NULL,
  nombre           TEXT,                -- como se llamaba al depurarla, para auditar
  motivo           TEXT,
  depurado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (sucursal_id, codigo_checador)
);
