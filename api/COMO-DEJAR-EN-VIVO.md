# Mantener la asistencia AL DÍA (en vivo)

La pantalla ya se refresca sola cada minuto, pero **solo muestra lo que hay en la
base**. Para que haya datos de hoy, alguien tiene que **jalar los relojes**. Aquí
está cómo dejarlo automático.

> ⚠️ Esto debe correr en una **PC que esté en la misma red (LAN) que los relojes
> checadores**. Las IPs de `tools/targets.json` son locales; desde internet /
> Railway / Vercel **no** se alcanzan.

## Requisitos (una sola vez, en esa PC)
1. Instalar **Node.js** (https://nodejs.org).
2. Copiar el proyecto a la PC.
3. Abrir una terminal dentro de la carpeta `api` y correr: `npm install`
4. Crear el archivo `api/.env` con la línea:
   ```
   DATABASE_URL=postgres://...   (el mismo de Railway)
   PGSSL=true
   ```

## Opción A — La más fácil (ventana abierta)
Doble clic a **`api\jalar-en-vivo.bat`**.
- Jala los 4 relojes **cada 5 minutos** y deja el registro en pantalla.
- Mientras esa ventana esté abierta, la base se mantiene al día.
- Si la cierras, se detiene. (Sirve para dejarla en una PC que no se apaga.)

## Opción B — Automático de fondo (recomendado)
Con el **Programador de tareas de Windows**, corriendo `jalar-una-vez.bat` cada 5 min:

1. Abre **Programador de tareas** (busca "Task Scheduler" en Inicio).
2. **Crear tarea…** (no "tarea básica").
3. Pestaña **General**: nombre `Jalar relojes Mega Talento`. Marca
   **"Ejecutar aunque el usuario no haya iniciado sesión"** y
   **"Ejecutar con los privilegios más altos"**.
4. Pestaña **Desencadenadores** → **Nuevo**:
   - Iniciar la tarea: **Según una programación** → Diariamente.
   - Marca **"Repetir cada: 5 minutos"** durante **"Indefinidamente"** (o "1 día").
5. Pestaña **Acciones** → **Nuevo**:
   - Acción: **Iniciar un programa**.
   - Programa/script: la ruta completa a **`jalar-una-vez.bat`**
     (ej. `C:\Users\...\mega-talento-90\api\jalar-una-vez.bat`).
6. Pestaña **Condiciones**: desmarca "Iniciar solo si el equipo está con CA" si es
   una laptop y quieres que corra siempre.
7. Aceptar. (Si pide contraseña de Windows, es la de esa cuenta.)

Listo: cada 5 minutos jala los relojes y la pantalla (que se auto-refresca) mostrará
las checadas de hoy.

## Verificar
Para ver qué relojes tienen datos y hasta qué fecha:
```
npm run estado
```

## Cambiar el intervalo
- Opción A: `set LOOP_MIN=10` antes de correr, o edita el `.bat`.
- Opción B: cambia el "Repetir cada" del desencadenador.
