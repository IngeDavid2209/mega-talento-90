import express from 'express';
import cors from 'cors';
import { env } from './env';
import { pool } from './db';
import { authRouter } from './auth';
import { checadorRouter } from './checador';
import { agenteHorariosRouter } from './agente-horarios';
import { candidatosRouter } from './candidatos';
import { puestosRouter } from './puestos';
import { usuariosRouter } from './usuarios';

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
app.use('/checador', checadorRouter);
app.use('/checador/agente', agenteHorariosRouter); // Agente de Horarios (Fase 1)
app.use('/candidatos', candidatosRouter);
app.use('/puestos', puestosRouter);
app.use('/usuarios', usuariosRouter);

app.listen(env.PORT, () => {
  console.log(`[api] Mega Talento API escuchando en el puerto ${env.PORT}`);
});
