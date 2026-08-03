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

const app = express();

app.use(cors({
  origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',').map(s => s.trim())
}));
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
app.use('/checador', checadorRouter);
app.use('/checador/agente', agenteHorariosRouter); // Agente de Horarios (Fase 1)
app.use('/candidatos', candidatosRouter);
app.use('/puestos', puestosRouter);
app.use('/usuarios', usuariosRouter);
app.use('/kpi', kpiRouter); // Concentrado de candidatos: bitácora de eventos + tablero
app.use('/requisiciones', requisicionesRouter); // Peticiones de personal de las sucursales
app.use('/permanencia', permanenciaRouter);     // ¿El contratado sigue a los 30/60/90 días?

app.listen(env.PORT, () => {
  console.log(`[api] Mega Talento API escuchando en el puerto ${env.PORT}`);
  // El Agente de Horarios revisa las sucursales por su cuenta, DENTRO de este
  // proceso. Antes solo analizaba si alguien entraba a la pantalla y apretaba un
  // botón; si nadie entraba, la asistencia se quedaba sin revisar. Se apaga con
  // AGENTE_AUTO=off. Ver src/agente-horarios/corredor.ts.
  arrancarCorredor();
});
