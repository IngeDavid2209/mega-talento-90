# Agente de Horarios — Fase 1

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
| `persistencia.ts` | UPSERT idempotente en `asistencia_alertas` (no pisa lo que RH ya decidió) + listado. |
| `notificador.ts` | **Adaptador/handoff**. No-op en Fase 1 (no manda WhatsApp). |
| `router.ts` | `POST /checador/agente/analizar`, `GET /checador/agente/alertas` (JWT). |

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

## Handoff / fuera de alcance de la Fase 1

- **No** notifica por WhatsApp (BOT-RH es otro repo). `notificador.ts` es la
  interfaz con el `TODO` de dónde se conectará.
- **No** existe aún la relación empleado↔área↔jefe (ni teléfonos de jefes); se
  modelará en la fase de notificación. Hoy el turno se resuelve por
  **sucursal + día de la semana** (si hay varios turnos ese día, usa el general
  `area_id NULL` y marca `horarioAmbiguo:true` en la evidencia).
- **No** hay orquestador ni otros agentes todavía.
