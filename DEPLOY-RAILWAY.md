# Desplegar TODO en un proyecto de Railway

Un proyecto Railway con varios **servicios**, todos apuntando a la **misma base**.
El repo ya trae la config; lo que sigue se hace en el **panel de Railway**.

Base compartida (ya migrada):
```
DATABASE_URL = postgresql://postgres:…@reseau.proxy.rlwy.net:10993/railway
PGSSL = true
```
> 🔒 Rota esta contraseña cuando puedas (se compartió en texto) y actualiza la variable en cada servicio + el `api/.env` local.

---

## Servicio 1 — API (backend)

- **New Service → GitHub Repo** → este repo.
- **Settings → Root Directory:** `api`
- Build y start salen de `api/railway.json` (`npm run build` → `npm run migrate && npm start`).
  - El `migrate` crea/actualiza solo las tablas (idempotente) en cada deploy.
- **Variables:**
  - `DATABASE_URL` (la de arriba)
  - `PGSSL=true`
  - `JWT_SECRET` = el mismo secreto que ya usa tu API en producción
  - `CORS_ORIGIN=https://mega-talento-90.vercel.app` (y tu dominio si tienes)
- Deploy. En logs: `[migrate] … ✔`. Copia la URL pública `...up.railway.app`.

## Servicio 2 — Front (Angular)

- **New Service → GitHub Repo** → este repo (otro servicio).
- **Settings → Root Directory:** `/` (raíz)
- Build y start salen de `railway.json` (raíz): `npm run build` → `node server.js`
  - `server.js` sirve `dist/mega-talento-90/browser` con fallback SPA (sin dependencias).
- No necesita variables (el `API_URL` está en `src/app/core/services/api-config.ts`).
  - ⚠️ Si la URL de la API cambió, actualiza `API_URL` ahí y vuelve a desplegar.

## Servicio 3 — Base Postgres

- Ya existe (`reseau…`). Si vive en otro proyecto y la quieres dentro de este,
  Railway permite mover/compartir; o simplemente usa su `DATABASE_URL` desde cada servicio.

## Servicio 4 — Bot de WhatsApp (otro repo)

- Deséstalo desde su propio repo como un servicio más y ponle el **mismo `DATABASE_URL`**
  para que comparta datos (candidatos, checadas, etc.).

---

## Después de desplegar
1. Verifica que la API responde: `https://TU-API.up.railway.app/health` → `{ ok: true }`.
2. Si la URL de la API es nueva, avísame para actualizar `API_URL` del front y redeployar.
3. Haz login y prueba: Justificación/Verificación (Horarios) y KPI de fases (Dashboard).
