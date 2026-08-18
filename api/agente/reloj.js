// api/agente/reloj.js
//
// EL CICLO DE VIDA DE UN RELOJ: descubrir → stream en vivo → backfill.
//
// ══ POR QUÉ HACEN FALTA LOS DOS, STREAM Y BACKFILL ══
//
// El stream (`getRealTimeLogs`) es lo que da el "en vivo": el reloj queda
// registrado para eventos y EMPUJA cada checada en el momento. Pero no es una
// fuente confiable por sí solo — si el agente estuvo caído media hora, esos
// eventos no se guardaron en ningún lado y se perdieron para siempre.
//
// El backfill es la red de seguridad: una lectura VERIFICADA del log completo.
// El protocolo ZK no permite pedir "solo lo nuevo", siempre se baja todo, y en
// 8-Esquinas eso son ~50 mil registros (≈2 MB). Por eso corre cada hora y no
// cada 5 minutos: intentarlo cada 5 min no cierra de forma confiable y lo único
// que se logra es encimar corridas.
//
// ══ UN RELOJ = UNA SESIÓN ══
//
// Los ZKTeco aceptan UNA SOLA sesión TCP en el 4370. El stream ocupa el socket.
// Para el backfill hay que DETENER el stream, hacer la lectura, y volver a
// levantarlo. Nunca los dos a la vez: si se intenta, el reloj deja de contestar
// y se ve exactamente igual que si estuviera apagado.

const { fmt, conectar, cerrar, leerVerificado, normalizarChecadas, normalizarUsuarios, motivo, serieCoincide } =
  require('../tools/lectura-verificada');
const { descubrir } = require('./descubrir');
const { ErrorEnvio } = require('./enviar');

const TAM_LOTE = 500;

/**
 * Al reenviar en un backfill, se retrocede un poco antes de la marca de agua.
 * Dos razones concretas: los relojes se corren de hora (se han visto minutos de
 * diferencia contra el servidor) y un evento del stream pudo llegar con la hora
 * del reloj ya movida. Reenviar de más es gratis —la API deduplica— y reenviar
 * de menos es un hueco que nadie va a notar.
 */
const MARGEN_MS = 36 * 60 * 60 * 1000;   // 36 h

class RelojJob {
  constructor(reloj, deps) {
    this.reloj = { ...reloj };            // { serie, ip, puerto, commKey, sucursalId, alias }
    this.cola = deps.cola;
    this.enviador = deps.enviador;
    this.intervalos = deps.intervalos;
    this.log = (m) => deps.log(`[${this.etiqueta}] ${m}`);

    this.zk = null;
    this.corriendo = false;
    this.ocupado = false;                 // mutex: stream y backfill no conviven
    this.fallosKeepalive = 0;
    this.timers = {};
    this.ultimoError = null;
    this.infoReloj = null;
  }

  get etiqueta() { return this.reloj.alias || this.reloj.sucursalId || this.reloj.serie; }

  // ── Arranque / paro ──────────────────────────────────────────────
  async arrancar(retrasoBackfillMs = 0) {
    this.corriendo = true;
    await this.reconectar('arranque');
    // Los backfills se escalonan: si los 8 relojes bajan su log completo al
    // mismo tiempo, se saturan la red de la plaza y el enlace de salida.
    this.timers.backfill = setTimeout(() => {
      this.backfill().catch((e) => this.log(`backfill: ${motivo(e)}`));
      this.timers.backfillRepe = setInterval(
        () => this.backfill().catch((e) => this.log(`backfill: ${motivo(e)}`)),
        this.intervalos.backfillMin * 60000
      );
    }, retrasoBackfillMs);
  }

  async detener() {
    this.corriendo = false;
    for (const t of Object.values(this.timers)) { clearTimeout(t); clearInterval(t); }
    this.timers = {};
    await this.soltarSocket();
  }

  async soltarSocket() {
    const zk = this.zk;
    this.zk = null;
    if (zk) await cerrar(zk);
  }

  // ── Conexión + stream en vivo ────────────────────────────────────
  async reconectar(porque) {
    if (!this.corriendo) return;
    if (this.ocupado) return;
    this.ocupado = true;
    try {
      await this.soltarSocket();
      clearInterval(this.timers.keepalive);

      // Descubrimiento por serie: si la IP cambió, aquí se reencuentra.
      let ubicacion;
      try {
        ubicacion = await descubrir(this.reloj, (m) => this.log(m.trim()));
      } catch (e) {
        this.ultimoError = motivo(e);
        this.log(`❌ ${this.ultimoError}`);
        await this.enviador.latido(this.reloj.serie, { ip: this.reloj.ip, error: this.ultimoError });
        this.programarReintento();
        return;
      }
      if (ubicacion.cambio) this.reloj.ip = ubicacion.ip;

      this.zk = await conectar(this.reloj.ip, {
        puerto: this.reloj.puerto, commKey: this.reloj.commKey, timeoutMs: 20000,
      });

      try {
        this.infoReloj = await this.zk.getInfo();
        // Punto de partida del detector: lo que el reloj tiene AHORA se da por
        // "visto". A partir de aquí, cada checada nueva hace crecer este número
        // y eso es lo que dispara la lectura. Lo que haya cambiado mientras el
        // agente estuvo caído lo recupera el backfill inicial.
        if (this.infoReloj && Number.isFinite(this.infoReloj.logCounts)) {
          this.conteoVisto = this.infoReloj.logCounts;
        }
      } catch { this.infoReloj = null; }

      this.fallosKeepalive = 0;
      this.ultimoError = null;
      this.log(`🟢 vigilando ${this.reloj.ip} (${porque})`);
      await this.enviador.latido(this.reloj.serie, {
        ip: this.reloj.ip,
        infoReloj: this.infoReloj ? { logCounts: this.infoReloj.logCounts, userCounts: this.infoReloj.userCounts } : undefined,
      });

      // EL VIGÍA: consulta el conteo del reloj cada pollSeg. Barato (getInfo es
      // un comando chico). Cuando el número sube, alguien marcó → se baja el log
      // y se empuja lo nuevo. Reemplaza al stream (getRealTimeLogs), que no se
      // pudo comprobar en estos equipos; getInfo sí es de fiar.
      this.timers.keepalive = setInterval(
        () => this.vigilar(), (this.intervalos.pollSeg || 30) * 1000
      );
    } catch (e) {
      this.ultimoError = motivo(e);
      this.log(`❌ no se pudo abrir la sesión: ${this.ultimoError}`);
      await this.enviador.latido(this.reloj.serie, { ip: this.reloj.ip, error: this.ultimoError });
      this.programarReintento();
    } finally {
      this.ocupado = false;
    }
  }

  programarReintento() {
    clearTimeout(this.timers.reintento);
    const ms = this.enviador.siguienteEspera();
    this.timers.reintento = setTimeout(() => this.reconectar('reintento'), ms);
  }

  /**
   * EL VIGÍA — detecta el movimiento nuevo y de paso mantiene viva la sesión.
   *
   * Cada pollSeg consulta `getInfo()`. Hace dos cosas con una sola llamada:
   *   1. Keepalive: los ZK cierran la sesión inactiva sin avisar; este comando
   *      la mantiene. Dos fallos seguidos y se reconecta desde cero.
   *   2. Detección: si el reloj declara MÁS checadas que la última vez, alguien
   *      marcó → se baja el log y se empuja lo nuevo. Si el número no cambió, no
   *      se lee nada: el reloj no se toca de más y la red de la plaza queda
   *      libre. Ésta es la parte que hace que la asistencia entre sola.
   *
   * El resultado de getInfo se VALIDA antes de creerle: un logCounts absurdo se
   * trata como fallo de sesión, no como dato, para no disparar una lectura ni
   * publicar "el reloj tiene 3 mil millones de checadas" en el semáforo.
   */
  async vigilar() {
    if (!this.zk || this.ocupado) return;
    let info;
    try {
      info = await this.zk.getInfo();
      const sano = info && Number.isFinite(info.logCounts) &&
                   info.logCounts >= 0 && info.logCounts < 10_000_000 &&
                   Number.isFinite(info.userCounts) && info.userCounts < 100_000;
      if (!sano) throw new Error('getInfo devolvió números incoherentes');
      this.infoReloj = info;
      this.fallosKeepalive = 0;
    } catch (e) {
      this.fallosKeepalive++;
      this.log(`vigía ${this.fallosKeepalive}/2: ${motivo(e)}`);
      if (this.fallosKeepalive >= 2) await this.reconectar('sesión perdida');
      return;
    }

    if (this.conteoVisto != null && info.logCounts > this.conteoVisto) {
      this.log(`+${info.logCounts - this.conteoVisto} checada(s) nueva(s) — bajando…`);
      await this.backfill('movimiento nuevo');
    }
  }

  /**
   * Se agrupa unos segundos antes de mandar. En el cambio de turno entran 40
   * checadas en dos minutos; mandarlas una por una son 40 peticiones HTTPS
   * desde el enlace de una plaza. Con 5 s de espera siguen llegando muy por
   * debajo de los 90 s que se prometieron, y salen en uno o dos envíos.
   */
  programarEnvio() {
    if (this.timers.envio) return;
    this.timers.envio = setTimeout(() => {
      this.timers.envio = null;
      this.vaciarCola().catch((e) => this.log(`envío: ${motivo(e)}`));
    }, (this.intervalos.agrupaSeg || 5) * 1000);
  }

  // ── Envío ────────────────────────────────────────────────────────
  /**
   * Manda lo que haya pendiente de este reloj. Solo se marca como enviado lo
   * que la API confirmó: si el envío falla a medias, esas filas siguen en la
   * cola y salen en el siguiente intento.
   */
  async vaciarCola(extra = {}) {
    // Un solo vaciado a la vez por reloj. Sin esto, el temporizador del stream
    // y el vaciado del backfill pueden leer LAS MISMAS filas de la cola y
    // mandarlas dos veces: la API las deduplica, pero el conteo de "aceptadas"
    // que se reporta dejaría de significar algo.
    if (this.enviando) { this.reenviarAlTerminar = true; return 0; }
    this.enviando = true;
    let total = 0;
    try {
      total = await this.vaciarColaInterno(extra);
    } finally {
      this.enviando = false;
      if (this.reenviarAlTerminar) {
        this.reenviarAlTerminar = false;
        this.programarEnvio();
      }
    }
    return total;
  }

  async vaciarColaInterno(extra = {}) {
    let total = 0;
    for (;;) {
      const filas = this.cola.pendientes(this.reloj.serie, TAM_LOTE);
      if (!filas.length) break;
      const ultima = filas[filas.length - 1];
      const esUltimo = filas.length < TAM_LOTE;
      try {
        const r = await this.enviador.enviarLote({
          serie: this.reloj.serie,
          ip: this.reloj.ip,
          origen: 'agente',
          infoReloj: this.infoReloj ? {
            logCounts: this.infoReloj.logCounts,
            userCounts: this.infoReloj.userCounts,
            horaReloj: this.horaReloj ? this.horaReloj.toISOString() : undefined,
          } : undefined,
          usuarios: extra.usuarios && total === 0 ? extra.usuarios : undefined,
          checadas: filas.map((f) => ({ codigo: f.codigo, fechaHora: f.fechaHora, tipo: f.tipo })),
          completa: !!extra.completa && esUltimo,
        });
        this.cola.confirmar(filas.map((f) => f.id));
        this.cola.subirMarca(this.reloj.serie, ultima.fechaHora, !!extra.completa);
        total += filas.length;
        this.enviador.reiniciarEspera();
        if (r.pausado) {
          this.log(`⏸ el padrón tiene este reloj EN PAUSA: la API guardó el lote pero no lo aplicó.`);
          break;
        }
      } catch (e) {
        if (e instanceof ErrorEnvio && !e.reintentable) {
          // La API ya archivó el lote crudo; reintentar solo llenaría
          // `ingesta_lotes` de copias. Se confirma para que la cola avance y se
          // deja el aviso, que es lo que hay que resolver a mano.
          this.cola.confirmar(filas.map((f) => f.id));
          this.log(`⚠ ${e.message}`);
          this.log('  El dato NO se perdió: quedó guardado en la API sin aplicar. ' +
                   'Se aplica solo cuando el reloj esté dado de alta (reprocesar lotes).');
          continue;
        }
        // Reintentable: se deja en la cola y se vuelve más tarde. Esto es lo
        // que hace que un corte de internet de una hora no cueste checadas.
        const ms = this.enviador.siguienteEspera();
        this.log(`⚠ ${motivo(e)} — quedan ${filas.length}+ en la cola, reintento en ${Math.round(ms / 1000)}s`);
        clearTimeout(this.timers.envio);
        this.timers.envio = setTimeout(() => {
          this.timers.envio = null;
          this.vaciarCola().catch(() => {});
        }, ms);
        return total;
      }
    }
    return total;
  }

  // ── Backfill ─────────────────────────────────────────────────────
  /**
   * Lectura VERIFICADA del log completo. Si no se puede verificar contra
   * `info.logCounts`, `leerVerificado` lanza y no se encola nada: nunca se
   * carga una lectura parcial.
   */
  async backfill(porque = 'programado') {
    if (!this.corriendo || this.ocupado) return;
    this.ocupado = true;
    const t0 = Date.now();
    try {
      // La sesión del vigía ocupa el socket. Se suelta ANTES de leer: los ZK
      // aceptan UNA sola sesión a la vez.
      clearInterval(this.timers.keepalive);
      await this.soltarSocket();

      this.log(`backfill (${porque}): leyendo el log completo…`);
      const lectura = await leerVerificado(this.reloj.ip, {
        puerto: this.reloj.puerto, commKey: this.reloj.commKey,
        log: (m) => this.log(m.trim()),
      });

      if (lectura.serie && !serieCoincide(this.reloj.serie, lectura.serie)) {
        throw new Error(`ESTA IP YA NO ES ESTE RELOJ: esperaba ${this.reloj.serie} y contesta ` +
          `${lectura.serie}. No se encola nada para no atribuir las marcas a otra plaza.`);
      }
      this.infoReloj = lectura.info;
      this.horaReloj = lectura.horaReloj;
      // Ya está subido lo que el reloj tiene hasta este conteo: el vigía no debe
      // volver a dispararse hasta que el número CREZCA otra vez.
      if (Number.isFinite(lectura.info?.logCounts)) this.conteoVisto = lectura.info.logCounts;

      const todas = normalizarChecadas(lectura.logs);
      // Filtrado incremental: sin esto se reenviarían las ~50 mil checadas del
      // reloj cada hora. La API las descartaría igual, pero serían 2 MB de
      // subida por reloj por hora desde el enlace de la plaza.
      const marca = this.cola.marca(this.reloj.serie);
      let nuevas = todas;
      if (marca?.ultima_fecha_hora) {
        const corte = new Date(new Date(marca.ultima_fecha_hora).getTime() - MARGEN_MS);
        const corteTxt = fmt(corte).fechaHora;
        nuevas = todas.filter((c) => c.fechaHora >= corteTxt);
      }

      const encoladas = this.cola.encolar(this.reloj.serie, nuevas, 'backfill');
      this.log(`backfill: ${todas.length} en el reloj · ${nuevas.length} desde la marca · ` +
               `${encoladas} nuevas a la cola (${Math.round((Date.now() - t0) / 1000)}s)`);

      const usuarios = normalizarUsuarios(lectura.users);
      await this.vaciarCola({ completa: true, usuarios });

      if (lectura.horaReloj) {
        const desfase = Math.round((lectura.horaReloj.getTime() - Date.now()) / 1000);
        if (Math.abs(desfase) > 120) {
          this.log(`⚠ el reloj va ${desfase > 0 ? 'adelantado' : 'atrasado'} ${Math.abs(desfase)}s. ` +
            'La tolerancia se está aplicando sobre una hora falsa: se corrige en el equipo.');
        }
      }
    } catch (e) {
      this.ultimoError = motivo(e);
      this.log(`❌ backfill: ${this.ultimoError}`);
      await this.enviador.latido(this.reloj.serie, { ip: this.reloj.ip, error: this.ultimoError });
    } finally {
      this.ocupado = false;
      // Vuelve el stream. Si esto falla, `reconectar` deja programado su propio
      // reintento — el reloj no se queda sin nadie que lo vigile.
      if (this.corriendo) await this.reconectar('después del backfill');
    }
  }
}

module.exports = { RelojJob, TAM_LOTE, MARGEN_MS };
