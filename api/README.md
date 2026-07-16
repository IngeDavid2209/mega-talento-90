# Mega Talento API

Backend intermediario entre el front Angular (Vercel) y Postgres (Railway).
El navegador **nunca** habla directo con Postgres: le pega a esta API por HTTPS,
y la API es la única que conoce las credenciales de la base.

Stack: **Node + Express + pg + TypeScript**. Auth con **JWT** (reemplaza Firebase Auth).

## Estructura
```
api/
├── db/schema.sql        # esquema completo de Postgres (idempotente)
├── src/
│   ├── index.ts         # servidor Express (health, /auth, y routers futuros)
│   ├── env.ts           # variables de entorno
│   ├── db.ts            # pool de Postgres
│   ├── auth.ts          # login JWT + middleware requireAuth
│   └── scripts/
│       ├── migrate.ts   # aplica db/schema.sql
│       └── seed-admin.ts# crea/actualiza el admin inicial
└── .env.example
```

## Desarrollo local
```bash
cd api
npm install
cp .env.example .env        # y llena DATABASE_URL (usa la Public URL de Railway) + JWT_SECRET
npm run migrate:dev         # crea las tablas
npm run seed:admin:dev      # crea el admin (usa ADMIN_EMAIL/ADMIN_PASSWORD del .env)
npm run dev                 # levanta la API en http://localhost:3000
```
Prueba: `GET http://localhost:3000/health` y `GET http://localhost:3000/health/db`.

## Deploy en Railway
1. En tu proyecto de Railway (donde ya vive Postgres) → **New → GitHub Repo** → elige este repositorio.
2. En el servicio nuevo → **Settings → Root Directory** = `api`.
3. **Build Command**: `npm install && npm run build`
   **Start Command**: `npm start`
4. **Variables** (Settings → Variables):
   - `DATABASE_URL` = `${{ Postgres.DATABASE_URL }}`  (referencia al Postgres del proyecto)
   - `PGSSL` = `false`  (si conectas por la red **interna** de Railway) o `true` (red pública)
   - `JWT_SECRET` = un secreto largo (`openssl rand -hex 32`)
   - `CORS_ORIGIN` = la URL del front en Vercel (p. ej. `https://mega-talento-90.vercel.app`)
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NOMBRE` (para el primer seed)
5. Primer arranque: corre una vez `npm run migrate` y `npm run seed:admin`
   (desde la pestaña de la consola/one-off de Railway, o localmente apuntando a la Public URL).

## Endpoints (Fase 0)
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Salud del servicio |
| GET | `/health/db` | Verifica conexión a Postgres |
| POST | `/auth/login` | `{ email, password }` → `{ token, usuario }` |
| GET | `/auth/me` | Datos del usuario (requiere `Authorization: Bearer <token>`) |

Los routers por dominio (candidatos, puestos, horarios/checadas) se agregan en las
siguientes fases de la migración.
