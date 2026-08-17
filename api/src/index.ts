import express from 'express';
import cors from 'cors';
import { env } from './env';
import { pool } from './db';
import { authRouter } from './auth';
import { checadorRouter } from './checador';
import { agenteHorariosRouter, agenteCallbackRouter, arrancarCorredor } from './agente-horarios';
import { candidatosRouter } from './candidatos';
import { puestosRouter } from './puestos';
import { usuariosRouter } from './usuarios';
import { kpiRouter } from './kpi';
import { requisicionesRouter } from './requisiciones';
import { permanenciaRouter } from './permanencia';
import { encuestasRouter, arrancarEncuestas } from './encuestas-onboarding';
import { ingestaRouter, relojesRouter } from './ingesta';
import { iclockRouter, ICLOCK_CONTENT_TYPES } from './iclock';

const app = express();

app.use(cors({
  origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',').map(s => s.trim())
}));

// ── Rutas con su PROPIO lector de cuerpo, montadas antes del express.json
// global. Ese está en 2 mb y aquí llegan lotes más grandes; si el parser global
// corriera primero, devolvería 413 antes de que estas rutas vieran nada.
//
// El agente parte en lotes de 500, así que 8 mb sobra con holgura; el margen es
// para el primer backfill de 8-Esquinas (~50 mil checadas).
app.use('/checador/ingesta', express.json({ limit: '8mb' }), ingestaRouter);
// Los relojes en modo ADMS mandan TEXTO PLANO (ATTLOG separado por tabuladores),
// y el content-type varía entre firmwares: por eso se acepta cualquiera.
app.use('/iclock', express.text({ type: ICLOCK_CONTENT_TYPES, limit: '8mb' }), iclockRouter);

app.use(express.json({ limit: '2mb' }));

/** Salud del servicio (no toca la base). */
app.get('/health', (_req, res) => {
  res.json({ ok: true, servicio: 'mega-talento-api', hora: new Date().toISOString() });
});

/** Salud de la base: confirma que el pool conecta a Postgres. */
app.get('/health/db', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT now() AS ahora');
    res.json({ ok: true, postgres: rows[0].ahora });
  } catch (e: any) {
    console.error('[health/db] error:', e);
    res.status(500).json({ ok: false, error: 'No se pudo conectar a Postgres.' });
  }
});

app.use('/auth', authRouter);
// El callback va ANTES de /checador: ese router tiene requireAuth global y, como
// /checador es prefijo de /checador/agente/callback, lo bloquearía con JWT. El
// callback se autentica con secreto compartido, no con JWT.
app.use('/checador/agente/callback', agenteCallbackRouter); // Fase 2b: justificación del jefe (secreto compartido)
// Mismo motivo que el callback: /checador es prefijo de /checador/relojes, y
// checadorRouter tiene requireAuth global. Este router lleva su propio JWT.
app.use('/checador/relojes', relojesRouter);   // semáforo de relojes + padrón por SERIE
app.use('/checador', checadorRouter);
app.use('/checador/agente', agenteHorariosRouter); // Agente de Horarios (Fase 1)
app.use('/candidatos', candidatosRouter);
app.use('/puestos', puestosRouter);
app.use('/usuarios', usuariosRouter);
app.use('/kpi', kpiRouter); // Concentrado de candidatos: bitácora de eventos + tablero
app.use('/requisiciones', requisicionesRouter); // Peticiones de personal de las sucursales
app.use('/permanencia', permanenciaRouter);     // ¿El contratado sigue a los 30/60/90 días?
app.use('/encuestas', encuestasRouter);         // Encuestas de onboarding (día 3/7/15/30/90)

app.listen(env.PORT, () => {
  console.log(`[api] Mega Talento API escuchando en el puerto ${env.PORT}`);
  // El Agente de Horarios revisa las sucursales por su cuenta, DENTRO de este
  // proceso. Antes solo analizaba si alguien entraba a la pantalla y apretaba un
  // botón; si nadie entraba, la asistencia se quedaba sin revisar. Se apaga con
  // AGENTE_AUTO=off. Ver src/agente-horarios/corredor.ts.
  arrancarCorredor();
  // Las encuestas de onboarding se mandan solas: si dependieran de que alguien
  // entre a una pantalla, las del fin de semana no saldrían nunca.
  arrancarEncuestas();
});
