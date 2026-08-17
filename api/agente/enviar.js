// api/agente/enviar.js
//
// EL ÚNICO PUNTO POR EL QUE EL AGENTE HABLA CON LA NUBE.
//
// El agente NO tiene DATABASE_URL. Solo `apiUrl` + `token`. Sacar las
// credenciales de Postgres de las PCs de sucursal es parte del objetivo: hoy
// cada plaza tiene el string de conexión de producción en un archivo de texto.

const os = require('os');

const VERSION = require('./package.json').version;
// Backoff: 5 s → 15 s → 60 s → 5 min (tope). Un corte de internet de una hora
// se traduce en ~12 reintentos, no en 720.
const ESPERAS_MS = [5000, 15000, 60000, 300000];

class ErrorEnvio extends Error {
  constructor(mensaje, { status = 0, reintentable = true, cuerpo = null } = {}) {
    super(mensaje);
    this.status = status;
    this.reintentable = reintentable;
    this.cuerpo = cuerpo;
  }
}

class Enviador {
  constructor(config, log) {
    this.url = String(config.apiUrl || '').replace(/\/$/, '');
    this.token = config.token || '';
    this.log = log || console.log;
    this.host = os.hostname();
    this.espera = 0;      // índice del backoff actual
  }

  get cabeceras() {
    return { 'Content-Type': 'application/json', 'X-Agente-Token': this.token };
  }

  async pedir(ruta, opciones = {}, timeoutMs = 30000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.url}${ruta}`, {
        ...opciones, headers: { ...this.cabeceras, ...(opciones.headers || {}) }, signal: ctrl.signal,
      });
      const txt = await res.text();
      let json = null;
      try { json = txt ? JSON.parse(txt) : null; } catch { /* no era JSON */ }
      return { res, json, txt };
    } finally { clearTimeout(t); }
  }

  /** El padrón de relojes que le toca a este agente. La lista NO vive en su config. */
  async padron(sucursalId) {
    const q = sucursalId ? `?sucursalId=${encodeURIComponent(sucursalId)}` : '';
    const { res, json, txt } = await this.pedir(`/checador/ingesta/relojes${q}`, { method: 'GET' }, 15000);
    if (!res.ok) throw new Error(`la API contestó ${res.status} al pedir el padrón: ${txt.slice(0, 200)}`);
    return json || [];
  }

  /**
   * Manda un lote. Devuelve el resultado de la API.
   *
   * Los códigos que NO se reintentan, y por qué:
   *   · 409 serie desconocida → la API ya guardó el lote crudo en `ingesta_lotes`.
   *     El dato NO se perdió; falta que RH dé de alta el reloj. Reintentar solo
   *     duplicaría filas en esa tabla hasta llenarla.
   *   · 202 reloj en pausa → igual: aceptado, guardado, no aplicado a propósito.
   *   · 401 token inválido → reintentar no lo arregla; hay que corregir config.
   */
  async enviarLote(lote) {
    const cuerpo = { ...lote, agenteVersion: `agente ${VERSION}`, agenteHost: this.host };
    const { res, json, txt } = await this.pedir('/checador/ingesta', {
      method: 'POST', body: JSON.stringify(cuerpo),
    }, 120000);

    if (res.ok) { this.espera = 0; return { ...json, aplicado: true }; }
    if (res.status === 202) { this.espera = 0; return { ...json, aplicado: false, pausado: true }; }
    if (res.status === 409) {
      this.espera = 0;
      throw new ErrorEnvio(json?.mensaje || `serie ${lote.serie} sin registrar en el padrón`,
        { status: 409, reintentable: false, cuerpo: json });
    }
    if (res.status === 401 || res.status === 403) {
      throw new ErrorEnvio('token de agente rechazado por la API — revisa config.json',
        { status: res.status, reintentable: false });
    }
    throw new ErrorEnvio(`la API contestó ${res.status}: ${txt.slice(0, 200)}`, { status: res.status });
  }

  /** Señal de vida (con o sin error). Sin esto un agente caído es invisible. */
  async latido(serie, extra = {}) {
    try {
      await this.pedir('/checador/ingesta/latido', {
        method: 'POST',
        body: JSON.stringify({ serie, agenteVersion: `agente ${VERSION}`, agenteHost: this.host, ...extra }),
      }, 15000);
    } catch (e) {
      // Un latido perdido no se reintenta: el siguiente sale en minutos y
      // encolarlos solo taparía el problema real.
      this.log(`  latido de ${serie} no salió: ${e.message}`);
    }
  }

  /** Cuánto esperar antes del siguiente intento, subiendo por el backoff. */
  siguienteEspera() {
    const ms = ESPERAS_MS[Math.min(this.espera, ESPERAS_MS.length - 1)];
    this.espera++;
    return ms;
  }
  reiniciarEspera() { this.espera = 0; }
}

module.exports = { Enviador, ErrorEnvio, ESPERAS_MS, VERSION };
