# Agente de Horarios

Capa **agéntica** encima del módulo de checadas (`checador.ts`, tablas `checadas`,
`empleados`, `horarios_sucursal`, `asistencia_revision`). Convierte la revisión de
asistencia de **manual** a **asistida por IA**: el agente analiza las checadas,
detecta inconsistencias solo y deja **borradores** listos para que RH apruebe.

> **Regla 80/20:** el agente SOLO deja `estado='sugerida_ia'`. NUNCA marca
> `aprobada`. RH tiene la última palabra. El punto exacto donde el agente para y
> entrega al humano está marcado en `notificador.ts` y en `router.ts` (`// HANDOFF`).

## Arquitectura

| Archivo | Rol |
|---|---|
| `tipos.ts` | Tipos del dominio (puros). |
| `config.ts` | Carga de umbrales: `CONFIG_DEFAULT` (código) → `__global__` → sucursal (tabla `asistencia_config`). |
| `reglas.ts` | **Lógica pura y testeable**: `analizarDia(entrada) → Inconsistencia[]`. Sin DB. |
| `detector.ts` | Orquesta: lee `checadas`/`empleados`/`horarios_sucursal`, agrupa por empleado-día, corre `reglas.ts`. |
| `persistencia.ts` | UPSERT idempotente en `asistencia_alertas` (no pisa lo que RH ya decidió) + listado + código/justificación del jefe. |
| `jefes.ts` | Jefe responsable por sucursal (tabla `jefes_sucursal`): a quién se le avisa. |
| `notificador.ts` | **Adaptador/handoff**: llama al BOT-RH para mandar el WhatsApp. |
| `router.ts` | Endpoints con JWT (`analizar`, `alertas`, `jefes`) + el router de callback del bot, **sin** JWT. |

## Reglas detectadas (todas configurables, nada hardcodeado)

1. **multiples_entradas** — 2+ entradas (`tipo=0`) separadas por > `saltoEntradasHoras`.
2. **checada_duplicada** — 2 marcas separadas por ≤ `duplicadaMinutos`.
3. **entrada_sin_salida / salida_sin_entrada** — marca sin par al cerrar el día.
4. **fuera_de_turno** — checada fuera de `[entrada − ventana, salida + ventana]`.
5. **retardo** — primera entrada > `entrada + tolerancia` (usa `horarios_sucursal.tolerancia_min`).
6. **falta** — día laborable (según el turno) sin ninguna checada.

Umbrales en la tabla **`asistencia_config`** (`sucursal_id='__global__'` = default; una
fila con el id de la sucursal la sobrescribe). Ejemplo del `config` (jsonb):

```jsonc
{
  "duplicadaMinutos": 5, "saltoEntradasHoras": 4, "ventanaFueraTurnoMin": 120,
  "usarToleranciaHorario": true, "toleranciaRetardoMin": null,
  "marcarFaltas": true, "soloDiasCerrados": true,
  "faltaSoloConActividadEnRango": true,   // no marca falta a quien no checó NADA en todo el rango
  "reglasActivas": { "retardo": true, "falta": true, "checada_duplicada": true,
    "multiples_entradas": true, "entrada_sin_salida": true, "fuera_de_turno": true }
}
```

### Turno del empleado (empleado↔turno)

`empleados.horario_id` (opcional) liga a un empleado con su turno de
`horarios_sucursal`. Si está puesto, el agente usa **ese** turno para
retardo/falta/fuera-de-turno; si es `NULL`, cae al turno **general** de la
sucursal por día de la semana (con `horarioAmbiguo:true` si hay varios). Se
asigna vía `POST/PUT /checador/empleados` con el campo `horarioId`.

## Instalación / migración

Las tablas nuevas (`asistencia_alertas`, `asistencia_config`) están en
`api/db/agente-horarios.sql` (aditivo, idempotente). Se aplican con:

```bash
cd api
npm run migrate:dev     # local (tsx)   — usa DATABASE_URL del .env
# o en Railway, tras build:
npm run build && npm run migrate
```

## Cómo probar con datos reales

Hay ~91k checadas en prod. **Usa un rango corto de una sola sucursal.**

```bash
# 1) Login para obtener el JWT
curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"<usuario>","password":"<pass>"}' | jq -r .token
# 2) Analizar (crea borradores)
curl -s -X POST "$API/checador/agente/analizar" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"sucursalId":"morelia-abastos","desde":"2026-07-14","hasta":"2026-07-20"}' | jq
# 3) Ver los borradores que dejó para RH
curl -s "$API/checador/agente/alertas?sucursalId=morelia-abastos&desde=2026-07-14&hasta=2026-07-20" \
  -H "Authorization: Bearer $TOKEN" | jq
```

`analizar` devuelve `{ resumen, borradores:{creadas,actualizadas,sinCambio} }`.
Re-correr el mismo rango NO duplica (UPSERT) y NO pisa lo que RH ya movió a
aprobada/rechazada.

## Fase 2 — aviso al jefe por WhatsApp

Cuando **RH aprueba** una alerta, se le avisa al jefe de esa sucursal. La API no
tiene credenciales de WhatsApp; el **BOT-RH** (repo aparte) sí. Así que el aviso
se manda llamando a `POST /api/aviso-asistencia` del bot, que envía el mensaje.

El jefe se registra en `jefes_sucursal` (uno por sucursal) desde la pantalla del
agente en el front (`GET`/`PUT /checador/agente/jefes`). **Sin jefe activo con
teléfono no se envía nada** y la alerta se aprueba igual: la notificación nunca
rompe la decisión de RH. La UI avisa antes de que eso pase.

Env de la API:

| Variable | Para qué |
|---|---|
| `BOT_RH_URL` | Base del bot. **Vacía = no-op** (solo deja rastro en log). |
| `AVISO_ASISTENCIA_SECRET` | Secreto compartido con el bot (header `x-aviso-secret`), en **las dos** direcciones. |

## Fase 2b — la justificación del jefe regresa sola

El aviso incluye un **código corto** de 4 caracteres (alfabeto sin `O/0/I/1`).
El jefe contesta en el chat del bot:

```
JUSTIFICAR A7K2 andaba en una cita medica, yo lo autorice
```

El bot parsea eso y lo regresa a la API, que pega el texto a esa alerta. RH lo
ve en la tarjeta con un botón para adoptarlo como justificación oficial.

```
agente detecta ─▶ borrador (sugerida_ia) ─▶ RH aprueba ─┬─▶ asegurarCodigo()
                                                        └─▶ BOT-RH ─▶ WhatsApp al jefe
jefe responde "JUSTIFICAR <codigo> ..." ─▶ BOT-RH ─▶ callback ─▶ justificarPorCodigo()
```

El callback vive en `agenteCallbackRouter` y se monta en
`/checador/agente/callback` **antes** del router de `checador`: ese router tiene
`requireAuth` global y, como `/checador` es prefijo de la ruta del callback, lo
bloquearía con JWT. El bot no tiene sesión, así que se autentica con el **secreto
compartido**, no con JWT. Si `AVISO_ASISTENCIA_SECRET` está vacío en la API, el
callback queda **abierto** — defínelo siempre en producción.

Columnas que agrega la Fase 2b a `asistencia_alertas` (aditivas): `codigo`,
`justificacion_jefe`, `respondido_por`, `respondido_en`.

Del lado del bot hace falta `MEGA_TALENTO_API_URL` + el mismo
`AVISO_ASISTENCIA_SECRET`, y `PLANTILLA_ASISTENCIA_LISTA=on` **solo** cuando la
plantilla `aviso_inconsistencia` (5 variables: empleado, sucursal, fecha, motivo,
código) ya esté aprobada en Meta. Sin la plantilla se manda texto libre, que solo
llega si el jefe le escribió al bot en las últimas 24 h.

## Fuera de alcance todavía

- La relación es **empleado↔sucursal↔jefe**, no empleado↔área↔jefe: hay un solo
  jefe por sucursal, no por área. El turno se resuelve por **sucursal + día de la
  semana** cuando el empleado no tiene `horario_id` (si hay varios turnos ese
  día, usa el general `area_id NULL` y marca `horarioAmbiguo:true`).
- **No** hay orquestador ni otros agentes todavía.
- El agente no reabre ni escala una alerta si el jefe nunca contesta.
