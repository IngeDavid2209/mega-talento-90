// server.js — SIRVE EL PORTAL YA COMPILADO (Railway)
// ══════════════════════════════════════════════════════════════════
//
// El 05/08/2026 Vercel PAUSÓ el portal: plan gratis, sin tarjeta, se topó un
// límite y en lugar de cobrar lo apagó (HTTP 402). Estuvo cinco días caído y a 11
// candidatos les llegó su encuesta a una pantalla rota. Se mueve a Railway, donde
// ya viven el bot y el API y donde el pago ya está resuelto.
//
// ── POR QUÉ SIN DEPENDENCIAS ──
//
// Podría ser cuatro líneas de Express, pero esto va en el repo de un front de
// Angular: meterle Express a ese package.json le agrega una dependencia de
// servidor a algo que solo compila estáticos. Con `node:http` son 100 líneas y
// cero instalaciones nuevas.
//
// ── LO QUE NO PUEDE FALLAR ──
//
// 1. RESPALDO AL index.html. El portal es una SPA de Angular: /evaluacion/abc123
//    no es un archivo, es una ruta del navegador. Si el servidor contesta 404 ahí,
//    todas las ligas que manda el bot se rompen — que es justo lo que veníamos a
//    arreglar. Eso lo hacía `vercel.json` con su rewrite y aquí lo hace `servirSpa`.
// 2. El index.html NO se cachea y los bundles con hash SÍ, para siempre. Al revés,
//    la gente se queda con una versión vieja del portal y "no le aparece" lo que
//    acabamos de desplegar.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const PUERTO = process.env.PORT || 8080;
// Salida del builder `application` de Angular: dist/<proyecto>/browser
const RAIZ = path.join(__dirname, 'dist', 'mega-talento-90', 'browser');
const INDEX = path.join(RAIZ, 'index.html');

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject',
  '.txt': 'text/plain; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const COMPRIMIBLE = /^(text\/|application\/(javascript|json|xml)|image\/svg)/;

// Los bundles de Angular traen hash en el nombre, así que se pueden cachear para
// siempre. El index.html jamás: es el que apunta a los bundles nuevos.
function cacheDe(archivo) {
  if (archivo.endsWith('index.html')) return 'no-cache, must-revalidate';
  if (/-[A-Z0-9]{8,}\.(js|css|woff2?)$/i.test(archivo)) return 'public, max-age=31536000, immutable';
  return 'public, max-age=3600';
}

function servir(res, archivo, req, status = 200) {
  const tipo = TIPOS[path.extname(archivo).toLowerCase()] || 'application/octet-stream';
  let cuerpo;
  try {
    cuerpo = fs.readFileSync(archivo);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('No encontrado');
  }
  const cabeceras = {
    'Content-Type': tipo,
    'Cache-Control': cacheDe(archivo),
    'X-Content-Type-Options': 'nosniff',
  };
  const aceptaGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (aceptaGzip && COMPRIMIBLE.test(tipo) && cuerpo.length > 1024) {
    cuerpo = zlib.gzipSync(cuerpo);
    cabeceras['Content-Encoding'] = 'gzip';
    cabeceras.Vary = 'Accept-Encoding';
  }
  cabeceras['Content-Length'] = cuerpo.length;
  res.writeHead(status, cabeceras);
  res.end(cuerpo);
}

// Respaldo de la SPA: cualquier ruta que no sea un archivo devuelve el index con
// código 200. Con 404 el navegador no monta la app y la liga del bot se rompe.
function servirSpa(res, req) {
  servir(res, INDEX, req, 200);
}

const servidor = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let ruta = decodeURIComponent(url.pathname);

  // Para el vigilante y para el candado de despliegue.
  if (ruta === '/health' || ruta === '/salud') {
    const listo = fs.existsSync(INDEX);
    res.writeHead(listo ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: listo, servicio: 'mega-talento-front', build: listo ? 'presente' : 'FALTA' }));
  }

  if (ruta.endsWith('/')) ruta += 'index.html';
  // Se resuelve DENTRO de la carpeta del build: sin esto, un "/../.." leería
  // archivos del servidor.
  const archivo = path.normalize(path.join(RAIZ, ruta));
  if (!archivo.startsWith(RAIZ)) return servirSpa(res, req);

  if (fs.existsSync(archivo) && fs.statSync(archivo).isFile()) return servir(res, archivo, req);
  return servirSpa(res, req);
});

if (!fs.existsSync(INDEX)) {
  // Mejor gritarlo en el arranque que servir 404 en silencio.
  console.error(`[front] NO existe el build en ${RAIZ}. ¿Corrió "ng build"?`);
}

servidor.listen(PUERTO, () => {
  console.log(`[front] portal servido en :${PUERTO} desde ${RAIZ}`);
});
