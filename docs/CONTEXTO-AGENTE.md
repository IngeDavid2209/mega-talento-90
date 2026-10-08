# Contexto para agentes de Claude Code — MegaTalento 90 y BOT-RH

> **Cómo usar este documento.** Léelo completo antes de tocar código en este repo o en BOT-RH.
> Describe qué es el sistema, cómo fluye la información, las reglas de negocio que RH ya decidió
> (y que NO se deben deshacer), el código del back y del front, la UI, cómo se despliega y las
> trampas que ya costaron horas. Está escrito al 08/10/2026. Si algo de aquí contradice al código,
> **manda el código**: verifícalo y actualiza este archivo.

---

## 0. Reglas para trabajar con el usuario

- **Todo en español.** Respuestas, resúmenes, preguntas, mensajes de commit, comentarios de código y
  textos de la UI. El usuario es David (desarrollador de Mega Dulces); sus usuarios finales son de
  Capital Humano (RH), por ejemplo Tania. Escribe para gente no técnica en la UI.
- **Cambios grandes de pantalla: primero maqueta.** El usuario aprueba diseño con una maqueta HTML
  (Artifact) hecha **con el CSS real del portal** (no inventes estilos). Rechazó una maqueta con estilo
  propio ("está horrible") y otra saturada. Lo que funciona: el diseño existente, una sola pieza nueva,
  sin recuadros punteados ni etiquetas "Nuevo" en la entrega final.
- **Producción solo con autorización explícita** ("súbelo a producción", "desarróllalo y mándalo a
  producción"). Si dice "no lo subas hasta que yo te diga", no lo subas.
- **Cambios de datos en producción**: solo los que el usuario pide; antes de escribir, lista a quién
  afecta; escribe en transacción; verifica después.
- **Reporta con honestidad**: qué se probó con datos reales, qué no (por ejemplo, "no lo probé con un
  usuario con sesión").

---

## 1. Qué es el sistema

Mega Dulces es una cadena de dulcerías en Michoacán/Guanajuato. Este sistema tiene dos mitades:

1. **Reclutamiento**: candidatos llegan por el formulario público `/unete` y por un **bot de WhatsApp**
   (BOT-RH). RH los mueve por etapas (filtro → entrevista conductual → aptitudes → psicométricas →
   contratado).
2. **Asistencia (checadores)**: relojes ZKTeco en cada plaza registran checadas; el sistema calcula
   horario de cada persona, retardos, tolerancia, faltas, horas, desayuno/comida, incidencias, y cierra
   la semana para **prenómina**.

### Plazas (sucursales) y relojes

| `sucursal_id` | Nombre | Reloj (IP LAN) |
|---|---|---|
| `corporativo` | Oficinas | 192.168.0.80 (entrada/salida) y 192.168.0.81 (desayuno/comida, misma gente, otra numeración, fundido) |
| `cedis` | CEDIS | 192.168.0.153 |
| `morelia-vicente-guerrero` | Morelia **Madero** | 192.168.32.215 (DHCP encendido: la IP puede cambiar) |
| `morelia-abastos` | Morelia Abastos | 192.168.30.253 |
| `8-esquinas` | 8 Esquinas (La Piedad) | 192.168.40.12 |
| `la-piedad-abastos` | La Piedad Abastos ("LP Abastos") | 192.168.42.37 |
| `yurecuaro-centro` | Yurécuaro | 192.168.44.12 |
| `zamora-canindo` | Zamora Canindo | 192.168.50.12 |
| `zamora-catedral` | Zamora Centro / "Dámaso" | 192.168.54.10 |
| `sucursal-ph` | Padre Hidalgo ("PH", Santa Ana Pacueco) | 192.168.10.2 |
| `reloj-196` | "RD", sin identificar | 192.168.0.196 |

El padrón vivo de relojes lo da la API; el agente lo cachea en `api/agente/padron.json`.

---

## 2. Repos, servicios y URLs

| Pieza | Dónde | Tecnología |
|---|---|---|
| Portal (front) | `C:\Users\Administrator\Documents\mega-talento-90` (raíz) | Angular **20** standalone, control flow `@if/@for`, sin NgModules |
| API | mismo repo, carpeta `api/` | Node + Express 4 + TypeScript, `pg` (Postgres), `tsx` para scripts |
| Agente de checadas | `api/agente/` — corre en **esta PC de la LAN** del corporativo | Node; lee relojes o la base del proveedor y empuja a la API por HTTPS |
| Bot de reclutamiento | **Otro repo**: `C:\Users\Administrator\Documents\mudanza\BOT-RH` (git, `IngeDavid2209/bot-rh`) | Node (CommonJS), Express, Meta WhatsApp Cloud API, Claude (Anthropic) |
| Base de datos | Postgres en Railway, **compartida** por API y bot | — |

> ⚠️ `C:\Users\Administrator\Documents\BOT-RH` es una **copia vieja sin git** del bot. No la uses.

**Railway** (workspace de Edgar Dayan Cortes Garcia, proyecto `mega-dulces-compras`, entorno `production`):
- `mega-talento-api` → https://mega-talento-api-production.up.railway.app (`/health`)
- `mega-talento-front` → https://mega-talento-front-production.up.railway.app
- `bot-rh` → https://bot-rh-production.up.railway.app (`/salud` devuelve `version.commit`)
- Postgres compartido. Otros servicios del proyecto no son de este sistema.

**GitHub**: `IngeDavid2209/mega-talento-90`. La rama que corre en producción es
**`horarios-incidencias`**; `main` se mantiene igual a ella (fast-forward). Bot: `IngeDavid2209/bot-rh`, rama `main`.

---

## 3. Flujo de los datos de asistencia

```
Reloj ZKTeco (LAN de cada plaza)
   │  (o la base del proveedor `hr` en 192.168.0.245, que sondea los relojes)
   ▼
Agente local  api/agente/index.js   (config.json: origen "relojes"|"hr")
   │  POST /checador/ingesta  (token compartido, lotes con checadas + padrón del reloj)
   ▼
API  src/ingesta.ts
   ├─ inserta en `checadas` (dedup por dedupKey)
   └─ AUTO-ALTA en `empleados`: todo código del reloj obtiene ficha con su apodo del reloj
      (`nombre`). La ingesta solo RELLENA `nombre` si está vacío; nunca pisa lo que RH editó.
   ▼
Cálculo  src/agente-horarios/asistencia-personas.ts  (asistenciaPersonas)
   ▼
GET /checador/agente/asistencia?sucursalId&desde&hasta[&soloPromotoras=1]
   ▼
Front  rh/asistencia-resumen (reporte de Checadas, Tolerancia, Faltas)
```

Además:
- **Agente de alertas** (`src/agente-horarios/corredor.ts`): cada **30 min**, ventana de **45 días**,
  corre `detector.ts` → `reglas.ts` sobre cada plaza y guarda **borradores** en `asistencia_alertas`
  (`estado='sugerida_ia'`). Reconcilia: borra borradores que ya no se detectan. **Nunca** toca alertas
  que RH aprobó/rechazó/descartó. Salta una plaza si su "huella" (último dato + nº checadas) no cambió;
  para forzar: `correrUnaVez({ forzar: true, sucursalId })`.
- **Cierre de semana** (`src/cierres.ts`): guarda una FOTO de `asistenciaPersonas` y bloquea la semana.
  Las semanas cerradas no cambian aunque cambie el cálculo.
- **Cola de comandos al reloj** (`src/reloj-comandos.ts` + `api/agente/escritura.js`): renombrar o
  restaurar usuarios en los relojes vía el agente.

La base del proveedor `hr` (192.168.0.245) **no sirve como fuente de nombres**: sus 592 "empleados" son
copia del apodo del reloj, sin apellidos, departamento ni bajas. **La única fuente del nombre completo
es RH en el portal.**

---

## 4. Modelo de datos (tablas clave)

Migraciones idempotentes en `api/db/*.sql`, aplicadas en orden por `api/src/scripts/migrate.ts`
(se ejecuta en cada arranque: `startCommand = npm run migrate && npm start`). Para agregar columnas:
nuevo `.sql` con `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` y agrégalo a la lista de `migrate.ts`.

- **`empleados`** — una ficha por (`sucursal_id`, `codigo_checador`). Campos clave:
  `nombre` (apodo del reloj), `nombre_completo` (el de RH, el que sale en reportes), `departamento`
  (SECCIÓN del reporte, en MAYÚSCULAS), `puesto`, `activo`, `es_promotora`, `eliminado_en`
  (papelera), `baja_en/baja_por`, `creado_en`, `foto_url`.
- **`checadas`** — `sucursal_id`, `empleado_codigo`, `fecha` (**TEXT** `'yyyy-MM-dd'`), `hora`
  (`'HH:mm:ss'`), `fecha_hora`, `tipo`, `dedup_key`.
- **`horarios_confirmados`** — PK (`sucursal_id`, `empleado_codigo`). `turnos text[]` (entrada; un
  rotativo tiene varias), y desde 06/10/2026: `salida`, `comida_min`, `sabado`, `sabado_entrada`,
  `sabado_salida`, `confirmado_por`, `nota`. **Con `salida` = horario completo asignado por RH (manda
  sobre todo)**; sin `salida` = confirmación vieja del bot (solo entrada). La escriben el portal y el bot.
- **`asistencia_incidencias`** — vacaciones, permisos, incapacidades, horario distinto, horas extra…
  con estados `capturada → calificada → cerrada → auditada` (o `rechazada/anulada`). Solo calificada,
  cerrada y auditada cuentan en el cálculo.
- **`asistencia_cierres`** — cierre por plaza y semana (jueves→miércoles), con `resumen` y `foto` JSONB.
- **`asistencia_alertas`** — borradores del agente y decisiones de RH. `regla` (retardo, falta,
  desayuno_excedido…), `evidencia` JSONB, `estado`.
- **`agente_corridas`** — bitácora del corredor por plaza.
- **`relojes`**, **`relojes_estado`**, **`reloj_codigo_map`**, **`ingesta_lotes`**, **`padron_depurado`**
  ("lápida": códigos depurados; la ingesta no los reactiva hasta que vuelven a checar),
  **`reloj_comandos`**.
- **`candidatos`** — compartida con el bot. Incluye columnas del bot (`telefono`, `estado`,
  `puesto_interes`, `ciudad_sucursal`, `documentos` JSONB, `portal_data` JSONB…) y del portal
  (`portal_status` = etapa, `cv_url`…). Desde 06/10/2026: `spam`, `spam_motivo`, `spam_por`, `spam_en`.
- **`mensajes`** — historial bot↔candidato.

---

## 5. Backend (API) — `api/src`

**Convenciones**: routers Express por dominio; `requireAuth` (JWT, `req.usuario` = `{sub, email, rol}`);
helper `fallo(res, e, msg)`; mapeo snake_case → camelCase (`mapEmpleado`, `mapCandidato`…);
errores en español, dirigidos a RH. Rutas montadas en `src/index.ts`.

### 5.1 Cálculo de asistencia — `agente-horarios/asistencia-personas.ts`

`asistenciaPersonas({ sucursalId, desde, hasta, soloPromotoras })`. Reglas (en orden):

1. **El horario sale de las checadas de CADA persona**, no del horario de la sucursal. Se deduce de una
   ventana ancha (`VENTANA_HORARIO_DIAS`, 28 días) y el retardo se mide **solo en el rango pedido**.
   La deducción vive en `horario-deducido.ts` (puro, sin base): entrada redondeada a :00/:30, fijo o
   rotativo, días laborales, `DUPLICADA_MIN = 5` para colapsar lecturas repetidas.
2. **Tolerancia**: bolsa de `BOLSA_SEMANAL_MIN = 15` min por semana de nómina (jueves→miércoles,
   `DIA_INICIO_SEMANA = 4`); solo cuenta el excedente (`retardoRealMin`). `atrasoBrutoMin` = minutos
   crudos tarde.
3. **Un día con una sola marca no genera retardo** (no se sabe si es entrada o salida).
4. **Falta** = día laboral de esa persona sin marcas, solo entre su primera checada y (si lleva 21 días
   sin aparecer) su última.
5. **Lo confirmado/asignado por RH manda** sobre la deducción (ver 5.2). "Horario distinto" (incidencia
   de un día) manda sobre todo ese día.
6. **Promotoras** (`tipos.ts::esPromotora`) se excluyen de la vista de planta y son las únicas en
   `soloPromotoras`. Inactivos no se miden.
7. **`detalleDia(marcas)`**: pausas emparejadas entre la primera y última marca; `comida` es el texto de
   tramos (`"10:58 – 11:14 · 14:02 – 14:58"`); **el desayuno solo existe si el día tiene DOS pausas**
   (la primera que empieza antes de `desayunoHastaHora`, 13:00); con una sola pausa, es la comida
   (decisión 08/10/2026; antes salían comidas como "desayuno"). En corporativo el desayuno no se
   descuenta de las horas si hay comida aparte (`desayunoPagado`). Devuelve `desayunoMin`,
   `desayunoExcesoMin`, `comidaMin`, `netasMin`, `entradaMin`, `salidaMin`.
8. Cada persona trae `marcas` (por qué su número puede no servir) y `usable`/`bloqueadoPor`.

Salida por persona (`PersonaAsistencia`): `codigo, nombreCompleto, departamento, horario, salida,
diasLaborales, retardoRealMin, atrasoBrutoMin, faltas, minutosTrabajados, semanas[].dias[]` (cada día:
`estado, entrada, salida, comida, desayunoMin, comidaMin, atrasoMin, netasMin, incidencias,
comidaExcesoMin, salidaAntesMin, esperadoMin`), `horarioAsignado`, `minutosEsperados`, `marcas`.

### 5.2 Horario por persona (06/10/2026)

- `confirmados()` lee `horarios_confirmados`; si la fila tiene `salida` y un solo turno →
  `HorarioAsignado { entrada, salida, comidaMin, sabado, sabadoEntrada, sabadoSalida, asignadoPor }`.
- Con horario asignado: entrada = la suya (aunque no haya historia), días laborales = L–V (+ sábado si
  aplica), el sábado puede tener otra entrada (se inyecta como "horario del día"), no se marcan
  `sin_datos/sin_patron/rotativo`, y por día se calcula `esperadoMin`, `salidaAntesMin`,
  `comidaExcesoMin`; por persona `minutosEsperados`.
- **Sin horario asignado el cálculo es idéntico al anterior** (verificado comparando la salida completa
  antes/después en 3 plazas). Mantén esa propiedad.
- Endpoints (`agente-horarios/router.ts`): `PUT /checador/agente/horario-asignado`
  `{ sucursalId, codigos[], entrada, salida, comidaMin, sabado, sabadoEntrada?, sabadoSalida? }`
  (valida HH:MM, salida > entrada, comida 0–180, ≥1 h de trabajo) y
  `POST /checador/agente/horario-asignado/quitar` `{ sucursalId, codigos[] }` (borra la fila: vuelve
  al deducido).

### 5.2b Horas extra, ajustes de pausa y cambio de descanso (08/10/2026)

- **Horas extra ganadas** (por día, `extraMin`): lo que se queda después de su salida esperada
  (`salidaEsperada` = referencia de entrada del día + jornada), **menos** lo que debía ese día (minutos
  tarde + exceso de desayuno + exceso de comida), en **bloques completos de 30 min**
  (`EXTRA_BLOQUE_MIN`), tope `EXTRA_MAX_DIA_MIN` = 6 h. Jornada: la del horario asignado (el sábado la
  suya); sin asignado, la deducida **solo si es fija y de más de 5 h 20** (medio tiempo y rotativos no
  generan: su horario cambia por día). Por persona: `horasExtraGanadasMin`, `horasExtraUsadasMin`,
  `horasExtraSegun` ('asignado' | 'deducido' | null).
- **Banco** (`agente-horarios/horas-extra.ts`, `GET /checador/agente/horas-extra?sucursalId[&hasta][&codigo]`):
  saldo = ganadas − usadas desde `HORAS_EXTRA_DESDE` (env, por omisión `2026-09-24`). Las usadas salen
  de las incidencias `horas_extra` (minutos × días). No se guarda: se recalcula. Lo único guardado son
  los **ajustes** de RH (`horas_extra_ajustes`, db/horas-extra-ajustes.sql): saldo inicial o corrección
  con signo, solo admin (`POST /checador/agente/horas-extra/ajuste`, `.../ajuste/:id/anular` con motivo;
  no se borran). Saldo = ganadas − usadas + ajustes. Pestaña **Horas extra**
  en Horarios (`rh/horas-extra`); saldo en la ficha y en el formulario de "Uso de horas extra".
- **`desayuno_distinto` / `comida_distinta`** (DD/CD): de un día, `minutos` = lo autorizado; el exceso
  de ese día se mide contra eso (y la comida de `esperadoMin`). Exigen motivo y quién autorizó. Se
  capturan desde el botón "Horario distinto" de la ficha (selector Entrada / Desayuno / Comida); no van en
  los menús (`SOLO_DESDE_FICHA` en el front).
- **`cambio_descanso`** (DES): de un día. Ese día es descanso (`laboralPorFecha` → false) y el primer
  descanso habitual de esa semana pasa a laborable (→ true; si no viene, es falta). Se leen las
  incidencias de las semanas COMPLETAS que toca el periodo. Días marcados `descansoCambio`.
- `TIPOS_DE_AJUSTE` (incidencias.ts) / `AJUSTES` (front): HD, DD, CD, DES **no justifican** el día.
- Un día con incidencia se mide aunque la persona no haya checado en el periodo (antes, mirando un solo
  día, el "Uso de horas extra" de un día completo no aparecía).

### 5.3 Reglas de alertas — `agente-horarios/reglas.ts`

`analizarDia()` aplica: falta, retardo, checada duplicada, múltiples entradas, entrada sin salida, fuera
de turno, **desayuno excedido**. `reglaDesayunoExcedido` **debe coincidir con `detalleDia`**: colapsa
duplicadas (< `DUPLICADA_MIN`) y exige dos pausas. Si cambias una, cambia la otra.

### 5.4 Empleados — `checador.ts`

- `GET /checador/empleados?sucursalId` — fichas.
- `POST /checador/empleados` — alta (UPSERT por sucursal+código: dar de alta un código existente lo
  reemplaza/regresa a propósito). Si el departamento es de promotoría, marca `es_promotora`.
- `PUT|PATCH /checador/empleados/:id` — `actualizarEmpleado`. `nombre_completo` no se pisa si llega
  vacío; `departamento` solo se toca si viene en el cuerpo. **`conciliarPromotora()`** pone de acuerdo
  casilla y departamento (ver §7). Al reactivar borra la lápida de `padron_depurado`.
- `GET /checador/empleados/numero?sucursalId[&codigo]` — **siguiente número libre** de la plaza (mayor
  código numérico en fichas, incluida papelera, y en checadas, + 1) y de quién es `codigo`.
- `GET /checador/empleados/por-identificar?dias=30` — quien checó en N días y le falta nombre completo
  o departamento, o está dado de baja / en papelera y sigue checando; más altas de 14 días.
- `GET /checador/empleados/nuevos`, `/papelera`; `GET /checador/checadas?sucursalId&desde&hasta[&codigo]`.

### 5.5 Cierres — `cierres.ts`

`POST /checador/cierres { sucursalId, desde(jueves), forzar?, motivo? }` (solo admin). Rechaza 409 si:
la semana no terminó, ya está cerrada, hay incidencias `capturada`, o **alguien checó esa semana sin
estar identificado** (`sinIdentificar()`: sin nombre completo o sin departamento, excluye promotoras y
"Admin"). En ese caso la respuesta trae `sinIdentificar[]`; con `forzar: true` + `motivo` (≥5 car.)
cierra y anota `sinIdentificar` y `motivoSinIdentificar` en el `resumen`.

### 5.6 Candidatos — `candidatos.ts`

- `ES_POSTULACION` (SQL): es postulación si tiene CV (portal o documento `slot='cv'` del bot) o etapa.
- `NO_ES_SPAM`: lo marcado spam no sale en `GET /candidatos` ni en conteos de `kpi.ts`.
- `POST /candidatos` (público `/unete`): exige CV y **ciudad y puesto** salvo que lo mande el bot
  (`x-bot-secret`).
- `POST /candidatos/:id/spam {marcar, motivo}`, `GET /candidatos/lista/spam`.
- Script `src/scripts/spam-sin-ciudad-puesto.ts` (lista; `--aplicar` marca).

---

## 6. Frontend (portal) — `src/app`

Angular 20 standalone. Servicios en `core/services` (`api.service.ts` = HttpClient con JWT y
`API_URL`; `checador.service.ts`; `candidate.ts`; `toast.service.ts` con `confirmar()` y `pedirTexto()`).
Rutas en `app.routes.ts`; menú en `rh/layout/layout.html`.

### 6.1 Horarios y checadas — `rh/horarios`

Página con selector de sucursal (`app-sucursal-select`, chips) y pestañas: **Checadas, Tolerancia,
Faltas** (las tres son el MISMO componente `app-asistencia-resumen` con otra `vista`, no se desmonta al
cambiar de pestaña), Incidencias (`rh/incidencias-bandeja`), Cruces, **Empleados**, Papelera de
empleados. Cuando se guarda algo en Empleados se incrementa `recargaAsistencia` →
`[recargarToken]` recarga Checadas al instante.

**Pestaña Empleados**:
- Recuadro **"Por identificar en los relojes"** (`getPorIdentificar(30)`), arranca en la plaza en
  pantalla; botones Completar / Reactivar / Ver en la papelera.
- **"+ Nuevo empleado"**: propone el siguiente número libre (`numeroReloj`), exige nombre completo y
  departamento, avisa si el número ya es de alguien. Mensaje: "Enrola su huella con el número N". **El
  alta empieza en el portal, antes que en el reloj.**

### 6.2 Reporte de asistencia — `rh/asistencia-resumen` (archivo grande, ~2700 líneas)

- Barra `ar-bar`: Periodo, **Personas**, Buscar en todas las plazas, Atajos, Semana fiscal, Exportar.
- **Campo Personas** (`personasSel: Set<codigo>`, `personasSuc`): lista con casillas por departamento y
  buscador. Nada = toda la plaza; departamento; varias personas; una persona (`personaUnica`).
  `porDepartamento` filtra la VISTA y de ahí salen totales, PDF y Excel ("lo que se ve es lo que sale").
  Reemplazó a los chips "Secciones".
- **Tabla semanal ("reporte calcado")**: columnas Clv, Nombre, Horario (asignado o "Deducido · 8:00 am"),
  un día por columna (jornada / tramos de pausa / **D** minutos de desayuno · **C** minutos de comida,
  ámbar si se pasó), Horas, Min. retardo, vs. horario (si alguien tiene asignado), ⋯. Clic en un renglón
  abre la **ficha** (modal donde se justifica); "Ver solo a esta persona" está en el menú ⋯.
- **Una persona**: tabla día por renglón (Día, Entrada, Desayuno, Comida, Salida, Horas, Min. retardo,
  vs. horario) con `+N min` (tarde, rojo), `−N min` (salió antes, ámbar), `+N min` en comida (ámbar).
  Tira "Horario de X asignado por RH" o "no tiene horario asignado".
- **Botón Horario** (`horarioAbierto`, `horarioForm`, `destinoHorario`): una persona o todos los
  visibles; Guardar / Quitar (volver al deducido).
- **PDF**: jsPDF + autotable con `import()` dinámico. Plaza: horizontal, por departamento. Una persona
  (`exportarPdfPersona`): vertical, con su horario, totales y líneas de firma.
- Desayuno/comida por día: `pausasDe(d)` / `resumenDia` (desayuno = el tramo que dura `desayunoMin`).

### 6.3 Otros

- `rh/incidencias-bandeja`: calificar, **cerrar semana** (maneja el 409 `sinIdentificar` con
  `pedirTexto` → "Cerrar de todos modos"), reabrir.
- `rh/promotoras`: planta ↔ promotoría (`marcar`).
- `rh/spam`: apartado de Spam (sacar de spam).
- `rh/papelera-empleados`: regresar a alguien (restaura en el reloj con respaldo; la huella se vuelve a
  registrar).

### 6.4 Sistema visual (UI)

- Tokens en `src/styles.css`: fondo `--bg #F4F6FA`, `--surface #fff`, tinta `--ink #1A2F4E`, dorado
  `--gold #E5A300`, semánticos `--red/--amber/--green/--blue` con sus `-bg`. Fuente **DM Sans**, números
  **DM Mono**. Tema claro.
- Prefijos de clases: `ar-*` (barra/paneles de asistencia), `rep-*` (tabla del reporte; `rep-clv` y
  `rep-nom` son sticky a la izquierda), `fic-*` (ficha), `hz-*` (página Horarios), `per-*` (campo
  Personas), `hor-*` (horario asignado), `ib-*` (bandeja de incidencias).
- **Cuidado**: `.ar-field label` y `.ar-field input` tienen estilos (mayúsculas, `min-width:140px`) que
  se filtran a popovers dentro de la barra; sobrescribe con `.ar-field .tu-clase`.
- Presupuesto de CSS por componente: 30 kB (warning). `asistencia-resumen.css + .extra.css` va justo; si
  agregas, quita CSS muerto.

---

## 7. Reglas de negocio que RH ya decidió (no las deshagas)

1. **No se borra a nadie del reloj al dar de baja** (RH lo quitó el 29/09/2026: al borrar se pierde la
   huella). La baja manda a la Papelera. Quien sigue checando dado de baja aparece en "Por identificar".
2. **Promotora**: una sola regla, `esDeptoDePromotoria(depto)` = contiene "promotor" y NO "mega dulces".
   `esPromotora(ficha)` = casilla o departamento de promotoría. `conciliarPromotora()` en el guardado:
   si cambia el departamento (y no la casilla) → la casilla sigue al departamento; si se pasa a planta y
   el departamento es de promotoría → se le quita el departamento. "PROMOTORIA MEGA DULCES" = las paga
   Mega Dulces = personal de piso.
3. **Desayuno** solo con dos pausas (§5.1-7). Con una, es comida.
4. **Semana de nómina jueves→miércoles**; tolerancia 15 min/semana, solo cuenta el excedente.
5. **El horario asignado por RH manda**; "horario distinto" de un día manda sobre todo.
6. **Nadie a prenómina sin identificar** (cierre con motivo si no).
7. **Alta primero en el portal** con número asignado.
8. **Reportes parciales dicen que lo son** ("· solo SISTEMAS", "· 3 personas") en pantalla y en PDF.
9. **Spam**: postulaciones sin ciudad y sin puesto se marcan spam (no se borran).
10. **Departamentos que son otra plaza** ("PH" en 8 Esquinas, "STAFF LA PIEDAD"…): hoy salen en el
    reporte del reloj donde checan. **Pendiente de decisión del usuario** si deben salir en su plaza.

---

## 8. Bot de reclutamiento (BOT-RH)

Repo `C:\Users\Administrator\Documents\mudanza\BOT-RH`. `src/server.js` (webhook de WhatsApp, envío,
descarga de medios, cierre de postulación), `src/conversacion.js` (máquina de estados PURA: recibe
texto, devuelve `{ respuesta, notificar, ...banderas }`), `src/ia.js` (Claude: interpretar mensajes,
`validarCV`, clasificar documentos), `src/solicitud.js` (las ~130 preguntas para armar CV), `cierre.js`.

Estados principales: `nuevo → esperando_<campo>` (puesto_interes, nombre_completo, correo,
ciudad_sucursal, tiempo_traslado, disponibilidad, empresa_anterior, salario_deseado, rfc, nss,
familiar_en_empresa, reingreso) → `confirmando` → `esperando_cv` → `completado` → etapas de decisión;
ramas `orientando_puesto`, `armando_solicitud`, `revisando_cv`, `editando_<campo>`, `pidiendo_documentos`.

Decisiones recientes:
- **Comandos informativos** (`comandoInformativo`): menú/vacantes/sucursales solo si el mensaje ES el
  comando (quitando relleno). Antes cualquier mensaje con "sucursal"/"puesto" ciclaba al candidato.
- **CV en Word** se acepta y se marca para revisión (la visión solo lee imagen/PDF).
- **Ciudad y puesto obligatorios** (`CAMPOS_CLAVE`, `esDatoClaro`, `falta`, `exigirClave`): "cualquiera",
  "no sé", "donde sea" no cuentan; nadie pasa del resumen ni entrega CV sin ellos; si ya mandó CV, se
  guarda y al aclarar el dato cierra sin pedirlo otra vez.

Despliegue: `npm run desplegar` (candados: sin cambios sin commitear, `node --check`, pruebas puras
`scripts/probar-*.js`, servicio enlazado, verificación de `/salud`). Requiere `railway link` al
servicio `bot-rh` en esa carpeta (ya enlazado).

---

## 9. Operación

### Verificar antes de entregar
- API: `cd api && npx tsc --noEmit -p .`
- Front: `npx ng build` (raíz). Los warnings de presupuesto de `expediente.css` ya existían.
- Para cambios de cálculo: compara la salida completa de `asistenciaPersonas` antes/después
  (`git stash push <archivo>`, correr, `git stash pop`) en varias plazas; sin la nueva condición, debe
  salir idéntico.
- Pruebas con datos reales: scripts temporales en `api/src/scripts/_algo.ts` con `npx tsx` (usan el
  `DATABASE_URL` del entorno de la API → **es producción**). Solo lectura salvo pedido; escrituras en
  transacción; **borra el script al terminar**. Para probar SQL de escritura: `BEGIN … ROLLBACK`.
- La base del proveedor (`hr`) solo se alcanza desde esta PC (`api/agente/config.json`, `hrDbUrl`).

### Desplegar
- Portal: `npm run desplegar` (raíz; hace build, API y luego front) o, servicio por servicio:
  `cd api && railway up --service mega-talento-api --ci` y luego (raíz)
  `railway up --service mega-talento-front --ci`. **Orden: base/API antes que front.** La migración
  corre sola al arrancar la API.
- Antes de subir, mira `railway deployment list --service <s>`: si el último despliegue no es tuyo,
  alguien más subió; no lo pises sin revisar.
- Después: `/health`, rutas nuevas responden 401 sin sesión, y busca un texto nuevo en el bundle
  (`main-*.js`/`chunk-*.js`) para confirmar que el front nuevo está servido.
- GitHub: `git push origin horarios-incidencias` y `git push origin horarios-incidencias:main`.
- Commits en español, con la atribución que indique el sistema.

---

## 10. Trampas conocidas (ya costaron tiempo)

- **Escapes en SQL dentro de template strings de TS**: `'^\s*admin'` dentro de `` `...` `` pierde la
  diagonal. Escribe `'^\\s*admin'`. Lo mismo para `\s` en regex de Postgres.
- **`checadas.fecha` es TEXT**: compara con `(current_date - 30)::text`, no con un `date`.
- **Heredocs largos en Bash fallan** en esta máquina ("unexpected EOF"). Para ediciones grandes escribe
  un `.py` en el scratchpad con `Write` y ejecútalo.
- **Railway mantiene la instancia vieja unos minutos** durante un despliegue: el corredor puede correr
  con código viejo. Verifica `agente_corridas` y, si hace falta, `correrUnaVez({forzar})`.
- **El corredor salta plazas sin datos nuevos**: una corrección de reglas no limpia borradores de esas
  plazas hasta la siguiente checada (o forzando).
- **CRLF**: Git avisa "LF will be replaced by CRLF"; es normal en este repo.
- **El POST de empleados es UPSERT**: dar de alta un código existente reemplaza la ficha (por eso el
  portal avisa con `/empleados/numero`).
- **La ingesta crea fichas solas**: "no está en el sistema" casi nunca es falta de ficha; suele ser
  ficha con solo el apodo, sin nombre ni departamento, o dada de baja.
- **`esPromotora` también mira el departamento**: cualquier cambio de departamento puede sacar a alguien
  de Checadas. Usa `esDeptoDePromotoria` y `conciliarPromotora`, no regex sueltas.
- En el front, `celda()` se llama muchas veces por render: no metas trabajo pesado ahí.
- `toast.confirmar/pedirTexto` son los diálogos del portal; no uses `confirm()`/`prompt()` nativos.

---

## 11. Pendientes y preguntas abiertas (al 08/10/2026)

- **Departamentos que son otra plaza** (§7-10): ¿deben salir en la plaza a la que pertenecen, en las dos
  o solo donde checan? Sin decidir.
- **Ignacio** (LP Abastos #62, "Donnacho") sin nombre completo; **Betty #57 y Cecilia #95**
  (8 Esquinas) sin departamento: el cierre de semana los va a pedir.
- El bot puede reescribir la entrada de `horarios_confirmados` de alguien con horario asignado desde el
  portal (salida/comida/sábado se conservan); "Quitar" en el portal borra la fila completa, incluida la
  confirmación del bot.
- Cualquier usuario con sesión puede asignar horarios (no solo admin).
- La vista de "tarjetas" del reporte no respeta el campo Personas; el PDF de plaza no muestra D/C.
