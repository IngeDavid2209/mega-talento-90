// api/agente/origen-hr.js
//
// ══════════════════════════════════════════════════════════════════
// SINCRONIZADOR DESDE LA BASE DEL PROVEEDOR (servidor_245 · `hr`)
// ══════════════════════════════════════════════════════════════════
//
// En el corporativo ya hay un sistema que habla con los 10 relojes y guarda todo
// en Postgres (`hr.attendance_logs`, al día al segundo). Este agente NO vuelve a
// pelear por el puerto 4370: lee de ahí y empuja a la API.
//
// ══ POR QUÉ NO LEER LOS RELOJES DIRECTO ══
//
// Se midió: los 10 equipos contestan `CMD_ACK_UNAUTH` (commandId 2005) al
// saludo. Un ZKTeco acepta UNA SOLA sesión TCP, y ese sistema los está sondeando
// cada pocos minutos. Si le peleamos el socket, los dos leen a medias — y la
// lectura a medias es exactamente el error que este proyecto lleva meses
// tratando de sacarse de encima.
//
// ══ POR QUÉ NO LEER LA BASE `hr` DESDE RAILWAY ══
//
// 192.168.0.245 es una IP privada. La API no la alcanza, igual que no alcanza
// los relojes. Por eso esto corre en una PC de la LAN y empuja por HTTPS.
//
// ══ LA MARCA DE AGUA ══
//
// Se avanza sobre `punched_local` (la hora local del reloj), NO sobre
// `imported_at`. Medido el 17/08/2026: las 129,477 filas tenían `imported_at`
// de los últimos 3 minutos — ese sistema reescribe la marca de importación en
// cada resincronización. Usarla significaría releer la tabla completa cada vez.
//
// A cambio, `punched_local` tiene su propio riesgo: si el proveedor importa
// tarde una checada de ayer, entra con fecha vieja y una marca estricta se la
// saltaría PARA SIEMPRE. Por eso hay dos redes:
//   · traslape corto en cada vuelta (10 min hacia atrás), y
//   · una pasada amplia cada hora (7 días hacia atrás).
// Reenviar de más no cuesta nada: la API deduplica. Reenviar de menos es un
// hueco que nadie va a notar.

const { Pool } = require('pg');
const { ErrorEnvio } = require('./enviar');

const LIMITE_CONSULTA = 5000;

class SincronizadorHr {
  constructor(config, deps) {
    this.cfg = config;
    this.cola = deps.cola;
    this.enviador = deps.enviador;
    this.log = deps.log;
    this.pool = new Pool({
      connectionString: config.hrDbUrl,
      ssl: false,
      max: 4,
      connectionTimeoutMillis: 10000,
    });
    this.relojes = [];            // los del padrón de la API, por serie
    this.corriendo = false;
    this.timers = {};
    this.ultimoPadron = 0;
  }

  // ── Arranque ─────────────────────────────────────────────────────
  async arrancar(relojes) {
    // Solo se sincronizan los relojes que la API reconoce. Uno que esté en
    // `hr` pero no en nuestro padrón se reporta y se deja fuera: meter sus
    // checadas sin saber de qué plaza son las atribuiría a la sucursal
    // equivocada, y eso no se nota mirando la pantalla.
    this.relojes = relojes;
    this.corriendo = true;

    const { rows } = await this.pool.query(
      'SELECT serial_number, ip_address FROM hr.attendance_devices'
    );
    const enOrigen = new Map(rows.map((r) => [r.serial_number, r.ip_address]));
    for (const r of this.relojes) r.ipOrigen = enOrigen.get(r.serie) || r.ip;

    const huerfanos = rows.filter((r) => !this.relojes.some((x) => x.serie === r.serial_number));
    if (huerfanos.length) {
      this.log(`⚠ ${huerfanos.length} reloj(es) están en la base de origen pero no en el padrón de la API ` +
               `(o están en pausa): ${huerfanos.map((h) => `${h.serial_number}@${h.ip_address}`).join(', ')}`);
      this.log('  Sus checadas NO se suben. Dales de alta con tools/registrar-relojes-hr.js y quítales la pausa.');
    }

    const pollSeg = this.cfg.intervalos.pollSeg || 30;
    this.log(`Sincronizando cada ${pollSeg}s desde hr.attendance_logs · ${this.relojes.length} relojes`);

    await this.vuelta({ inicial: true });
    this.timers.poll = setInterval(
      () => this.vuelta({}).catch((e) => this.log(`⚠ vuelta: ${e.message}`)),
      pollSeg * 1000
    );
    // Pasada amplia: recupera lo que el proveedor haya importado tarde.
    this.timers.amplia = setInterval(
      () => this.vuelta({ amplia: true }).catch((e) => this.log(`⚠ pasada amplia: ${e.message}`)),
      (this.cfg.intervalos.reconciliarMin || 60) * 60000
    );
  }

  async detener() {
    this.corriendo = false;
    for (const t of Object.values(this.timers)) clearInterval(t);
    this.timers = {};
    await this.pool.end().catch(() => {});
  }

  // ── Una vuelta ───────────────────────────────────────────────────
  async vuelta({ inicial = false, amplia = false } = {}) {
    if (!this.corriendo && !inicial) return;

    // UNA VUELTA A LA VEZ. El reloj de 30 s no sabe cuánto tarda la anterior, y
    // la primera —cuando hay que recuperar el histórico— tarda minutos: 8
    // relojes × 5,000 filas cada uno. Sin este candado, `setInterval` lanzaría
    // una segunda vuelta encima de la primera, las dos leerían el mismo tramo
    // y se duplicaría el trabajo (que no el dato: la API deduplica, pero el
    // conteo de "nuevas" del log dejaría de significar algo).
    if (this.enVuelta) {
      this.saltadas = (this.saltadas || 0) + 1;
      // Se avisa solo la primera vez y luego cada 10, para no llenar el log
      // durante la recuperación inicial, que es cuando pasa y es normal.
      if (this.saltadas === 1 || this.saltadas % 10 === 0) {
        this.log(`vuelta anterior sigue corriendo, se salta este turno (${this.saltadas} en total). ` +
                 'Normal mientras se recupera el histórico.');
      }
      return;
    }
    this.enVuelta = true;
    try { await this.vueltaInterna({ amplia, inicial }); }
    finally { this.enVuelta = false; }
  }

  async vueltaInterna({ amplia = false, inicial = false } = {}) {
    // El padrón del reloj (códigos y nombres) se manda de vez en cuando, no en
    // cada vuelta: son ~450 upserts y no cambian cada 30 segundos.
    const tocaPadron = inicial || amplia;

    for (const reloj of this.relojes) {
      try {
        await this.sincronizarUno(reloj, { amplia, conPadron: tocaPadron });
      } catch (e) {
        this.log(`❌ ${reloj.alias || reloj.serie}: ${e.message}`);
        await this.enviador.latido(reloj.serie, { ip: reloj.ipOrigen, error: e.message });
      }
    }
  }

  /** Desde qué instante hay que pedir las checadas de este reloj. */
  ventana(serie, amplia) {
    const marca = this.cola.marca(serie);
    if (!marca?.ultima_fecha_hora) {
      // Primera vez: se trae todo. `desdeInicial` permite acotarlo si solo
      // interesa lo reciente (el histórico viejo ya está cargado en la base).
      return this.cfg.desdeInicial || '2000-01-01 00:00:00';
    }
    const traslapeMin = amplia
      ? (this.cfg.intervalos.reconciliarDias || 7) * 24 * 60
      : (this.cfg.intervalos.traslapeMin || 10);
    const t = new Date(marca.ultima_fecha_hora.replace('T', ' ')).getTime() - traslapeMin * 60000;
    return this.aTexto(new Date(t));
  }

  /** Date → 'YYYY-MM-DD HH:MM:SS' en hora local, sin pasar por UTC. */
  aTexto(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
           `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  async sincronizarUno(reloj, { amplia, conPadron }) {
    const desde = this.ventana(reloj.serie, amplia);

    // ⚠️ La hora sale de la base como TEXTO, formateada por Postgres.
    // `punched_local` es `timestamp without time zone` (la hora de pared del
    // reloj) y node-pg lo convertiría a un Date usando la zona de ESTA máquina.
    // Si la PC que corre el agente estuviera en otra zona —o cambiara el
    // horario de verano— todas las checadas se recorrerían en silencio.
    // Pidiendo el texto ya armado, no hay conversión que se pueda equivocar.
    const { rows } = await this.pool.query(
      `SELECT l.device_user_id AS codigo,
              to_char(l.punched_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS fecha_hora,
              l.punch_type AS tipo
         FROM hr.attendance_logs l
         JOIN hr.attendance_devices d ON d.id = l.device_id
        WHERE d.serial_number = $1
          AND l.punched_local >= $2::timestamp
        ORDER BY l.punched_local
        LIMIT $3`,
      [reloj.serie, desde, LIMITE_CONSULTA]
    );

    const info = await this.infoReloj(reloj.serie);

    if (rows.length) {
      const nuevas = this.cola.encolar(
        reloj.serie,
        rows.map((r) => ({ codigo: String(r.codigo), fechaHora: r.fecha_hora, tipo: r.tipo })),
        amplia ? 'hr-amplia' : 'hr'
      );
      if (nuevas) this.log(`${reloj.alias || reloj.serie}: ${nuevas} nuevas de ${rows.length} leídas`);
    }

    const usuarios = conPadron ? await this.padronDelReloj(reloj.serie) : undefined;
    await this.empujar(reloj, info, usuarios, rows.length === LIMITE_CONSULTA);
  }

  /**
   * Lo que el origen sabe del equipo. `horaReloj` se reconstruye a partir de la
   * deriva que el propio origen midió, para que el semáforo pueda mostrar el
   * desfase sin que nosotros le hablemos al reloj.
   */
  async infoReloj(serie) {
    const { rows } = await this.pool.query(
      `SELECT record_count, user_count, clock_drift_seconds, last_seen_at, last_error
         FROM hr.attendance_devices WHERE serial_number = $1`, [serie]
    );
    const d = rows[0];
    if (!d) return undefined;
    return {
      logCounts: d.record_count ?? undefined,
      userCounts: d.user_count ?? undefined,
      horaReloj: d.clock_drift_seconds != null
        ? new Date(Date.now() + d.clock_drift_seconds * 1000).toISOString()
        : undefined,
      _ultimoError: d.last_error || null,
    };
  }

  /** Códigos y nombres del reloj. El nombre solo RELLENA: la API no pisa lo que RH editó. */
  async padronDelReloj(serie) {
    const { rows } = await this.pool.query(
      `SELECT en.device_user_id AS codigo,
              COALESCE(NULLIF(btrim(e.full_name), ''), en.device_name) AS nombre
         FROM hr.device_enrollments en
         JOIN hr.attendance_devices d ON d.id = en.device_id
         LEFT JOIN hr.employees e ON e.id = en.employee_id
        WHERE d.serial_number = $1 AND en.is_present`, [serie]
    );
    return rows.filter((r) => r.codigo).map((r) => ({ codigo: String(r.codigo), nombre: r.nombre || '' }));
  }

  /**
   * Manda lo pendiente de este reloj. Solo se confirma lo que la API aceptó: si
   * el envío falla, las filas siguen en la cola local y salen en la vuelta
   * siguiente. Eso es lo que hace que un corte de internet no cueste checadas.
   */
  async empujar(reloj, info, usuarios, hayMas) {
    let mandadas = 0;
    for (;;) {
      const filas = this.cola.pendientes(reloj.serie, 500);
      if (!filas.length) break;
      const ultima = filas[filas.length - 1];
      try {
        const r = await this.enviador.enviarLote({
          serie: reloj.serie,
          ip: reloj.ipOrigen,
          origen: 'agente',
          infoReloj: info,
          usuarios: mandadas === 0 ? usuarios : undefined,
          checadas: filas.map((f) => ({ codigo: f.codigo, fechaHora: f.fechaHora, tipo: f.tipo })),
          // `completa` significa "esta lectura abarca todo el log del reloj",
          // y solo es cierto cuando la consulta NO se topó con el límite.
          completa: !hayMas && filas.length < 500,
        });
        this.cola.confirmar(filas.map((f) => f.id));
        this.cola.subirMarca(reloj.serie, ultima.fechaHora, true);
        mandadas += filas.length;
        this.enviador.reiniciarEspera();
        if (r.pausado) {
          this.log(`⏸ ${reloj.alias || reloj.serie}: el padrón lo tiene EN PAUSA. ` +
                   'La API guardó el lote sin aplicarlo.');
          break;
        }
      } catch (e) {
        if (e instanceof ErrorEnvio && !e.reintentable) {
          // La API ya archivó el lote crudo en `ingesta_lotes`. Reintentarlo
          // solo llenaría esa tabla de copias del mismo dato.
          this.cola.confirmar(filas.map((f) => f.id));
          this.cola.subirMarca(reloj.serie, ultima.fechaHora, true);
          this.log(`⚠ ${reloj.alias || reloj.serie}: ${e.message}`);
          continue;
        }
        this.log(`⚠ ${reloj.alias || reloj.serie}: ${e.message} — quedan en la cola, se reintenta en la vuelta siguiente`);
        return mandadas;
      }
    }

    // Latido aunque no haya habido movimiento: un reloj sin checadas a las 3 de
    // la tarde puede ser "nadie ha checado" o "lleva 6 horas muerto", y la
    // pantalla tiene que poder distinguirlos.
    if (!mandadas) {
      await this.enviador.latido(reloj.serie, {
        ip: reloj.ipOrigen,
        infoReloj: info,
        error: info?._ultimoError || undefined,
      });
    }
    return mandadas;
  }
}

module.exports = { SincronizadorHr };
