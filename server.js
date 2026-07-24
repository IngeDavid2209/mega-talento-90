// Servidor estático (sin dependencias) para servir el front Angular en Railway.
// Sirve dist/mega-talento-90/browser con fallback SPA a index.html.
// Railway inyecta PORT. Localmente: `node server.js`.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8080', 10);
const ROOT = path.join(__dirname, 'dist', 'mega-talento-90', 'browser');
const INDEX = path.join(ROOT, 'index.html');

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.gif': 'image/gif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json'
};

if (!fs.existsSync(INDEX)) {
  console.error('[front] No existe el build en', ROOT, '— corre `npm run build` primero.');
}

const server = http.createServer((req, res) => {
  try {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    let rel = path.normalize(url).replace(/^(\.\.[/\\])+/, '');
    let file = path.join(ROOT, rel);

    // Seguridad: no salir de ROOT.
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }

    fs.stat(file, (err, stat) => {
      if (!err && stat.isFile()) return enviar(res, file);
      // SPA fallback: rutas de Angular → index.html
      return enviar(res, INDEX);
    });
  } catch {
    res.writeHead(500); res.end('Error');
  }
});

function enviar(res, file) {
  const ext = path.extname(file).toLowerCase();
  const tipo = TIPOS[ext] || 'application/octet-stream';
  // index.html sin cache; assets con hash → cache largo.
  const cache = file === INDEX ? 'no-cache' : 'public, max-age=31536000, immutable';
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('No encontrado'); }
    res.writeHead(200, { 'Content-Type': tipo, 'Cache-Control': cache });
    res.end(data);
  });
}

server.listen(PORT, () => console.log(`[front] Sirviendo ${ROOT} en el puerto ${PORT}`));
