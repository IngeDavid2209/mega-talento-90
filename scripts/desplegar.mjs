#!/usr/bin/env node
/**
 * ============================================================
 * DESPLIEGUE DEL PORTAL, EN ORDEN Y CON CANDADOS
 *   npm run desplegar            API y luego front (el orden correcto)
 *   npm run desplegar -- api     solo el API
 *   npm run desplegar -- front   solo el front
 *   npm run desplegar -- --dry   solo revisa, no sube
 *   npm run desplegar -- --sucio sube aunque haya cambios sin commitear
 * ============================================================
 *
 * ── EL ORDEN IMPORTA, Y ESTE ES EL ORDEN ──
 *
 *   1. BASE (migraciones)  ->  npm run migrate
 *   2. API                 ->  railway up --service mega-talento-api
 *   3. FRONT               ->  railway up --service mega-talento-front
 *
 * Siempre el que SIRVE el dato antes que el que lo CONSUME. Si el front sube
 * primero y llama a un endpoint que todavía no existe, el usuario ve errores en
 * una pantalla que "ya está desplegada"; al revés no pasa nada, porque un
 * endpoint nuevo que nadie llama es inofensivo. Por eso `npm run desplegar` sin
 * argumentos hace API y luego front, y si el API falla NO sube el front.
 *
 * ── POR QUÉ HAY CANDADOS ──
 *
 * `railway up` sube LA CARPETA, no lo que revisaste: si un
 * archivo está a medio guardar, se va a producción. El 30/07/2026 un template a
 * la mitad (`agente-horarios.html`) tumbó un build mientras dos personas
 * trabajaban en el repo. El candado que lo atrapa es el build ANTES de subir:
 * `ng build` no perdona un tag sin cerrar y `tsc --noEmit` no perdona un tipo mal.
 *
 * Y avisa de los archivos sin commitear, porque en un repo compartido eso suele
 * significar "alguien está a medio editar": mejor preguntar que pisar su trabajo.
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = path.join(RAIZ, 'api');
const SERVICIO_API = 'mega-talento-api';
const SALUD_API = 'https://mega-talento-api-production.up.railway.app/health';
// El front se mudo a Railway el 05/08/2026: Vercel bloqueo la cuenta por "fair
// use" y dejo de servir el sitio (HTTP 402), no solo de aceptar deploys. El
// servidor estatico ya estaba listo en server.js desde el 24/07.
const URL_FRONT = 'https://mega-talento-front-production.up.railway.app';
const SERVICIO_FRONT = 'mega-talento-front';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const SUCIO = args.includes('--sucio');
const soloApi = args.includes('api');
const soloFront = args.includes('front');
const haceApi = soloApi || !soloFront;
const haceFront = soloFront || !soloApi;

const c = { ok: '\x1b[32m', mal: '\x1b[31m', warn: '\x1b[33m', dim: '\x1b[90m', fin: '\x1b[0m' };
const titulo = (t) => console.log(`\n${c.dim}══${c.fin} ${t}`);
const bien = (t) => console.log(`   ${c.ok}✔${c.fin} ${t}`);
const aviso = (t) => console.log(`   ${c.warn}⚠${c.fin}  ${t}`);
const morir = (t, extra) => {
  console.log(`   ${c.mal}✘ ${t}${c.fin}`);
  if (extra) console.log(`\n${extra}`);
  console.log(`\n${c.mal}NO SE DESPLEGÓ.${c.fin}\n`);
  process.exit(1);
};
const sh = (cmd, cwd = RAIZ, mostrar = false) =>
  execSync(cmd, { cwd, encoding: 'utf8', stdio: mostrar ? 'inherit' : ['ignore', 'pipe', 'pipe'] });

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
async function pide(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    return { ok: r.ok, status: r.status, texto: await r.text() };
  } catch { return { ok: false, status: 0, texto: '' }; }
}

console.log(`\n🌐 Portal MegaTalento${DRY ? c.dim + ' (simulación)' + c.fin : ''}` +
  `  ${c.dim}${haceApi ? 'API' : ''}${haceApi && haceFront ? ' → ' : ''}${haceFront ? 'FRONT' : ''}${c.fin}`);

// ── Candado 0: trabajo sin commitear ────────────────────────────────
titulo('Cambios sin commitear');
let sucios = [];
try {
  sucios = sh('git status --porcelain').split('\n').map((s) => s.trim()).filter(Boolean);
} catch { aviso('no se pudo leer git; se continúa.'); }
if (sucios.length) {
  aviso(`${sucios.length} archivo(s) sin commitear — ¿alguien más está editando?`);
  for (const s of sucios.slice(0, 12)) console.log(`      ${c.dim}${s}${c.fin}`);
  if (sucios.length > 12) console.log(`      ${c.dim}… y ${sucios.length - 12} más${c.fin}`);
  if (!SUCIO && !DRY) {
    morir('Hay cambios sin commitear.',
      `   ${c.dim}Si son tuyos y ya quedaron:${c.fin} git add -A && git commit -m "..."\n` +
      `   ${c.dim}Si estás seguro:${c.fin} npm run desplegar -- --sucio`);
  }
} else {
  bien('el árbol está limpio');
}

// ── 1. API ──────────────────────────────────────────────────────────
if (haceApi) {
  titulo('API · revisión');
  if (!existsSync(API_DIR)) morir('no encuentro la carpeta api/');
  try {
    sh('npx tsc --noEmit', API_DIR);
    bien('TypeScript compila');
  } catch (e) {
    morir('el API no compila', String(e.stdout || e.stderr || '').split('\n').slice(0, 20).join('\n'));
  }

  let estado = '';
  try { estado = sh('railway status', API_DIR); } catch { morir('railway status falló (¿railway login?)'); }
  if (!new RegExp(`\\b${SERVICIO_API}\\b`).test(estado)) {
    morir(`el servicio enlazado en api/ NO es ${SERVICIO_API}`, `${c.dim}${estado.trim()}${c.fin}`);
  }
  bien(`enlazado a ${SERVICIO_API}`);

  if (!DRY) {
    titulo('API · subiendo');
    try {
      sh(`railway up --service ${SERVICIO_API} --detach`, API_DIR, true);
    } catch { morir('railway up falló'); }

    process.stdout.write(`   ${c.dim}esperando a que responda…${c.fin} `);
    let arriba = false;
    for (let i = 0; i < 40; i++) {
      await esperar(15000);
      const r = await pide(SALUD_API);
      if (r.ok) { arriba = true; break; }
      process.stdout.write('.');
    }
    console.log('');
    if (!arriba) {
      morir('el API no respondió /health después de subirlo',
        `   ${c.warn}VOLVER ATRÁS:${c.fin} cd api && railway rollback`);
    }
    bien('/health responde');
  }
}

// ── 2. FRONT ────────────────────────────────────────────────────────
if (haceFront) {
  titulo('Front · build (aquí se atrapan los archivos a medio guardar)');
  try {
    sh('npx ng build', RAIZ);
    bien('Angular compila');
  } catch (e) {
    const salida = String(e.stdout || e.stderr || '');
    const errores = salida.split('\n').filter((l) => /ERROR|NG\d|error TS/.test(l)).slice(0, 12);
    morir('el front no compila', errores.join('\n') || salida.split('\n').slice(-15).join('\n'));
  }

  if (!DRY) {
    titulo('Front · subiendo');
    try {
      sh(`railway up --service ${SERVICIO_FRONT} --detach`, RAIZ, true);
    } catch { morir('el deploy del front falló'); }

    // ── ¿DE VERDAD ESTÁ ARRIBA LO QUE ACABO DE SUBIR? ──
    //
    // Antes esto solo pedía /health y cantaba victoria. El 18/08/2026 el script
    // dijo "✅ Listo" mientras producción seguía sirviendo el bundle ANTERIOR:
    // tardó 45 segundos más en salir, y en ese rato uno abre el portal, no ve
    // su cambio y empieza a buscar el error en el código equivocado.
    //
    // "Responde" y "responde con lo que subí" no son lo mismo. Angular pone un
    // hash en el nombre del bundle (main-XXXX.js) en cada build, así que basta
    // comparar el del dist local contra el que anuncia el index de producción.
    let hashLocal = null;
    try {
      const idx = readFileSync(path.join(RAIZ, 'dist/mega-talento-90/browser/index.html'), 'utf8');
      hashLocal = (idx.match(/main-[A-Za-z0-9]+\.js/) || [])[0] || null;
    } catch { /* sin dist legible se cae al chequeo de antes */ }

    let listo = false;
    for (let i = 0; i < 20 && !listo; i++) {
      const r = await pide(`${URL_FRONT}/`);
      if (r.ok) {
        if (!hashLocal) { listo = true; break; }          // sin hash: como antes
        const servido = (r.texto.match(/main-[A-Za-z0-9]+\.js/) || [])[0] || '';
        if (servido === hashLocal) { listo = true; break; }
      }
      if (i === 0) console.log(`   ${c.dim}esperando a que salga el bundle nuevo…${c.fin}`);
      process.stdout.write('.');
      await esperar(15000);
    }
    if (!listo) {
      console.log('');
      morir(`producción sigue sin servir ${hashLocal}`,
        `   ${c.dim}El build subió, pero el edge todavía entrega el bundle anterior.${c.fin}\n` +
        `   ${c.dim}Revisa el deploy en Railway o vuelve a correrlo en un minuto.${c.fin}\n` +
        `   ${c.warn}VOLVER ATRÁS:${c.fin} railway rollback --service ${SERVICIO_FRONT}`);
    }
    if (hashLocal) console.log('');
    bien(`el portal responde${hashLocal ? ` con ${hashLocal}` : ''}`);
    console.log(`   ${c.dim}Recuerda el refresh forzado (Ctrl+Shift+R): Angular cachea el bundle.${c.fin}`);
  }
}

console.log(`\n${DRY ? c.warn + 'Simulación: todo pasó, no se subió nada.' : c.ok + '✅ Listo.'}${c.fin}\n`);
