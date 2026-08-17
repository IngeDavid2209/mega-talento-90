# Mantener la asistencia AL DÍA (en vivo)

La pantalla se refresca sola cada minuto, pero **solo muestra lo que hay en la
base**. Para que haya datos de hoy, algo tiene que meterlos. Aquí está cómo
queda automático — y cómo darse cuenta cuando se rompe.

> ⚠️ Esto corre en una **PC de la red del corporativo**. Tanto los relojes como
> el servidor de asistencia (`192.168.0.245`) tienen IPs privadas: desde Railway
> **no hay ruta**, y no existe VPN entre plazas.

---

## Cómo entra el dato hoy

```
  ┌─ CORPORATIVO (LAN) ──────────────────┐      ┌─ NUBE (Railway) ──────────┐
  │  10 relojes ZKTeco                   │      │                           │
  │        │ TCP 4370                    │      │                           │
  │        ▼                             │      │                           │
  │  Sistema del proveedor               │      │                           │
  │  (Postgres `hr` @ 192.168.0.245)     │      │                           │
  │        │ SELECT cada 30 s            │      │                           │
  │        ▼                             │HTTPS │                           │
  │  api/agente  ──────────────────────────────►│  POST /checador/ingesta   │
  │  (servicio Windows + cola SQLite)    │token │        │                  │
  └──────────────────────────────────────┘      │        ▼                  │
                                                │    Postgres (checadas)    │
                                                │        │                  │
                                                │        ▼                  │
                                                │  GET /checador/relojes/   │
                                                │      estado  → semáforo   │
                                                └───────────────────────────┘
```

**Por qué no le hablamos a los relojes directo.** Se probó
(`node tools/diagnostico-red.js`) y los 10 equipos contestan `CMD_ACK_UNAUTH`
(commandId 2005) al saludo. Un ZKTeco acepta **una sola sesión TCP** en el 4370,
y el sistema del proveedor los está sondeando cada pocos minutos. Pelearle el
socket haría que los dos leyeran a medias — que es exactamente el problema que
este módulo lleva meses quitándose de encima.

Así que el agente lee de la base del proveedor, que ya tiene el dato al segundo,
y lo empuja a la API. **La PC ya no necesita el `DATABASE_URL` de producción**:
solo `apiUrl` + `token`.

---

## Instalación (una sola vez, en esa PC)

1. Instalar **Node.js 20 o superior** (https://nodejs.org).
2. Copiar el proyecto a la PC.
3. Instalar dependencias en las **dos** carpetas:
   ```
   cd api            && npm install
   cd api\agente     && npm install
   ```
4. Crear `api\agente\config.json` a partir de `config.ejemplo.json`:
   ```json
   {
     "apiUrl": "https://mega-talento-api.up.railway.app",
     "token":  "<el INGESTA_TOKEN del .env de la API>",
     "origen": "hr",
     "hrDbUrl": "postgresql://postgres:<contraseña>@192.168.0.245:5432/hr",
     "intervalos": { "pollSeg": 30 }
   }
   ```
   > `config.json` **no se versiona** (lleva token y contraseña). Ya está en
   > `.gitignore`.
5. Probar antes de instalar el servicio:
   ```
   node index.js --una-vez
   ```
   Debe listar los relojes a cargo y decir cuántas checadas nuevas subió.

6. Instalar el servicio de Windows, **en una consola de administrador**:
   ```
   cd api\agente
   node instalar-servicio.js instalar
   ```

7. **Comprobar que de verdad quedó corriendo.** Que la consola diga
   "Servicio arrancado" NO basta: node-windows solo lanza el comando de
   arranque, no revisa si el servicio se quedó de pie.
   ```
   powershell "Get-Service megatalentoagentedechecadas.exe | Select Name,Status"
   ```
   Tiene que decir **Running**. Si dice `Stopped`:
   ```
   node instalar-servicio.js revisar
   ```
   revisa el XML de winsw y dice qué está mal.

Listo. Arranca solo con la PC, **sobrevive al cierre de sesión**, y si el proceso
muere Windows lo levanta otra vez.

> **Si el servicio queda "Detenido" con arranque automático y sin ningún log**,
> casi siempre es la cuenta. `node-windows` escribe en el XML de winsw el nombre
> de la PC como dominio (`DAVID-CISNEROS\LocalSystem`), una cuenta que no
> existe; el inicio de sesión falla antes de que winsw alcance a crear su log.
> Ya está corregido en `instalar-servicio.js` (se fuerza
> `NT AUTHORITY\LocalSystem`), pero si alguien instaló el servicio con una
> versión vieja del script hay que **quitarlo y volverlo a instalar**:
> ```
> node instalar-servicio.js quitar
> node instalar-servicio.js instalar
> ```

> El `.bat` viejo (`jalar-en-vivo.bat`) dependía de que alguien dejara una
> ventana abierta, y la tarea programada se moría al cerrar sesión. Así se
> perdieron doce días de asistencia (del 05/08 al 17/08) sin que saliera un solo
> error.

---

## Cómo saber que está funcionando

**En el portal.** Arriba de la asistencia hay una franja de relojes:

| | Qué significa | Qué hacer |
|---|---|---|
| 🟢 al día | reportó hace menos de 10 min | nada |
| 🟡 con retraso | reportó hace menos de 2 h | vigilarlo |
| 🔴 sin señal | 2 h o más sin reportar | revisar el agente y el equipo |
| ⏸ en pausa | reloj sin identificar o sin traducir su numeración | trabajo de RH (abajo) |

Si el reloj de la sucursal que estás viendo está mudo, la franja lo dice con
todas sus letras: **lo que se ve abajo es la última asistencia que llegó, no la
de hoy**. Un día sin dato no es una falta.

**En la PC.** El log rotativo está en `api\agente\logs\`.

---

## Cuando algo falla

| Síntoma | Causa más probable | Cómo se revisa |
|---|---|---|
| Todos los relojes en rojo a la vez | el agente no está corriendo | `services.msc` → *Mega Talento · Agente de checadas* |
| Todos en rojo y el servicio sí corre | no hay internet, o el token cambió | `api\agente\logs\` |
| Un solo reloj en rojo | ese equipo está apagado o sin red | el sistema del proveedor también lo dirá |
| Sale "hora corrida" | el reloj tiene la hora mal | **se corrige en el equipo**, no en el sistema |
| Todo verde pero faltan checadas | el proveedor no las ha bajado | revisar su sistema en `192.168.0.245` |

**"Hora corrida" no es cosmético.** Si un reloj va 3 minutos atrasado, la
tolerancia del horario se aplica sobre una hora que no es, y RH ve retardos que
no existen. Al 17/08/2026, 8-Esquinas iba **−221 s** (≈3.7 min).

---

## Lo que NO hay que hacer

- **No** borrar el log del reloj ("clear attendance"). Es irreversible y el
  equipo es la única copia si la base se pierde.
- **No** bajar `pollSeg` a 5 segundos. No hace el dato más fresco: lo que manda
  es cada cuánto el proveedor sondea sus relojes.
- **No** sacar de pausa un reloj sin terminar su traducción de códigos: sus
  marcas se le atribuirían a la persona equivocada, y eso no se nota mirando la
  pantalla.
- **No** poner el `DATABASE_URL` de producción en esta PC. Ya no hace falta, y
  quitarlo fue parte del punto.

---

## Trabajo pendiente de RH (2 relojes en pausa)

### `192.168.0.81` — Oficinas, desayuno y comida
Es la misma gente de corporativo con **otra numeración**. La traducción ya está
propuesta y verificada por dos caminos independientes:

```
node tools/mapear-codigos.js --proponer --ip 192.168.0.81 --contra 192.168.0.80
```

35 de sus 48 códigos ligan a la misma persona del reloj de entrada/salida, y los
35 cumplen exactamente `código_oficial = código_comida + 100`. Faltan **13 por
revisar** (gente que no aparece en el otro reloj): Jorge RL, Eufrosina, Claudia
Mata, Ariz González, Andrea, Viviana, Memo, Montse, Dayan, Danna, Víctor,
Jazmín, Nery.

Se revisa el CSV con RH, se aplica con `--aplicar`, y hasta que no falte ninguno
se le quita la pausa. Lo que llegó mientras estuvo pausado **no se perdió**:
está en `ingesta_lotes` y se aplica con
`POST /checador/relojes/lotes/<serie>/reprocesar`.

### `192.168.0.196` — sin identificar
12 personas checando a diario (Joaquín, Ángel, Víctor, Mariano, Victorino, Tere,
Elena…) y **no se sabe de qué plaza es**. Ni los nombres ni el tamaño alcanzan
para decidirlo: se parece a varias. Hay que preguntarle a RH de quién es ese
reloj. Mientras tanto sigue en pausa — meter sus checadas bajo una plaza
adivinada sería peor que no tenerlas.

---

## Herramientas

```
node tools/diagnostico-red.js                 los 6 pasos, por reloj, con el motivo exacto
node tools/diagnostico-red.js --json          evidencia para guardar
node tools/comparar-hr.js                     ¿el origen está más al día que nosotros?
node tools/registrar-relojes-hr.js            da de alta/actualiza el padrón de relojes
node tools/mapear-codigos.js --estado --serie <serie>
node agente/index.js --una-vez                una pasada de sincronización y salir
npm run jalar -- --dry-run                    lectura verificada directa a un reloj (si algún día se libera el 4370)
```
