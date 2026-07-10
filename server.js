// Servidor estático para Railway (sin dependencias, node:http puro).
//
// Por qué existe: Netlify sirve archivos estáticos directo del CDN, pero Railway
// corre procesos — necesita un server que sirva los archivos. Este replica lo
// que hacían netlify.toml/_headers/_redirects:
//   - headers de seguridad (X-Frame-Options, nosniff, etc.)
//   - Cache-Control: no-cache global (_headers) — el cache-busting es via ?v=N
//   - fallback a index.html para rutas desconocidas (_redirects: /* → /index.html 200)
//
// La función netlify/functions/img-proxy.js NO se porta: no hay ninguna
// referencia a ella en el frontend (herencia de Glide, código muerto acá).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const PORT = process.env.PORT || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function send(res, status, headers, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  };
  fs.createReadStream(filePath)
    .on('open', () => res.writeHead(200, { ...SECURITY_HEADERS, ...headers }))
    .on('error', () => send(res, 500, { 'Content-Type': 'text/plain' }, 'Error leyendo archivo'))
    .pipe(res);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { 'Content-Type': 'text/plain' }, 'Method not allowed');
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    return send(res, 400, { 'Content-Type': 'text/plain' }, 'URL inválida');
  }

  // Anti path-traversal: resolver dentro de ROOT o rechazar.
  const resolved = path.normalize(path.join(ROOT, pathname));
  if (!resolved.startsWith(ROOT + path.sep) && resolved !== ROOT) {
    return send(res, 403, { 'Content-Type': 'text/plain' }, 'Prohibido');
  }

  let filePath = resolved;
  const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
  if (stat && stat.isDirectory()) filePath = path.join(filePath, 'index.html');

  if (!fs.existsSync(filePath)) {
    // _redirects: /* → /index.html 200 (fallback, no 404, para rutas de la SPA)
    filePath = path.join(ROOT, 'index.html');
  }

  serveFile(res, filePath);
});

server.listen(PORT, () => {
  console.log(`De Cirene ERP sirviendo en puerto ${PORT}`);
});
