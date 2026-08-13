// Servidor de Cirene en Railway: sirve la app Y expone la API de datos.
//
// Historia: la app era estática (Netlify) y hablaba directo con Supabase. El proyecto
// de Supabase fue eliminado, así que los datos pasaron a Postgres dentro del propio
// proyecto de Railway. Como un navegador no puede conectarse a Postgres, este proceso
// hace de intermediario:
//
//   /api/*      → API de datos y sesión (ver api/router.js)
//   /adjuntos/* → archivos subidos, desde el volumen persistente
//   el resto    → los archivos estáticos de siempre, con fallback a index.html
//
// Lo estático replica lo que hacían netlify.toml/_headers/_redirects: headers de
// seguridad, no-cache global (el cache-busting va por ?v=N) y fallback SPA.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrar } from './api/db.js';
import { manejar, DIR_ADJUNTOS } from './api/router.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
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

const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    return send(res, 400, { 'Content-Type': 'text/plain' }, 'URL inválida');
  }

  // La API y los adjuntos se manejan aparte (y sí aceptan POST).
  if (pathname.startsWith('/api/') || pathname.startsWith('/adjuntos/')) {
    try {
      const atendido = await manejar(req, res, pathname);
      if (atendido !== false) return;
    } catch (e) {
      console.error('[api]', pathname, e);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Error interno: ' + e.message }));
      }
      return;
    }
  }

  // De acá para abajo, solo archivos estáticos.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { 'Content-Type': 'text/plain' }, 'Method not allowed');
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

// Arranque: primero la base (esquema + seed + admin inicial), después escuchar.
// Si la migración falla igual levantamos el servidor: así la app muestra el login y
// /api/health explica el problema, en vez de dejar el servicio en crash-loop sin pistas.
(async () => {
  try {
    fs.mkdirSync(DIR_ADJUNTOS, { recursive: true });
  } catch (e) {
    console.warn('[adjuntos] no pude crear', DIR_ADJUNTOS, '—', e.message,
      '(¿falta montar el volumen en Railway?)');
  }
  try {
    await migrar();
  } catch (e) {
    console.error('[db] LA MIGRACIÓN FALLÓ:', e.message);
    console.error('[db] La app va a levantar igual, pero sin datos. Revisá DATABASE_URL.');
  }
  server.listen(PORT, () => {
    console.log(`De Cirene ERP sirviendo en puerto ${PORT}`);
  });
})();
