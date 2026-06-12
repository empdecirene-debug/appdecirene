// Proxy de imágenes server-side.
//
// Por qué existe: el cotizador genera el PDF en el browser con jsPDF, que necesita
// los bytes de la imagen. Las imágenes del catálogo enriquecido son URLs remotas
// de los proveedores (Disershop/Famet/Indiewears), que NO mandan headers CORS, así
// que el browser no puede bajarlas ni meterlas en un canvas/PDF. Un servidor sí
// puede: esta función las baja y las devuelve con CORS abierto + cache.
//
// Uso: GET /.netlify/functions/img-proxy?u=<url-encodeada>
// Devuelve la imagen (binaria) con Access-Control-Allow-Origin:* y cache largo.
//
// Seguridad: whitelist de hosts (evita que el proxy sea un open-relay/SSRF).

const ALLOWED_HOSTS = [
  'disershop.com.uy', 'www.disershop.com.uy',
  'famet.uy', 'www.famet.uy',
  'indiewears.uy', 'www.indiewears.uy',
  'f.fcdn.app',   // CDN de Jumpseller que sirve todas las imágenes de Indiewears
];

// Referer a enviar según el host de destino. f.fcdn.app sirve imágenes de
// varios stores — le enviamos el origen de Indiewears para que sepa de dónde
// viene la solicitud (igual que lo haría un browser en indiewears.uy).
const REFERER_BY_HOST = {
  'f.fcdn.app': 'https://www.indiewears.uy/',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: 'Method not allowed' };
  }

  const raw = (event.queryStringParameters && event.queryStringParameters.u) || '';
  if (!raw) return { statusCode: 400, headers: CORS, body: 'Falta parámetro u' };

  let target;
  try { target = new URL(raw); } catch { return { statusCode: 400, headers: CORS, body: 'URL inválida' }; }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return { statusCode: 400, headers: CORS, body: 'Protocolo no permitido' };
  }
  if (!ALLOWED_HOSTS.includes(target.hostname)) {
    return { statusCode: 403, headers: CORS, body: 'Host no permitido' };
  }

  try {
    const resp = await fetch(target.href, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CireneImgProxy/1.0; +https://cirene.uy)',
        'Accept': 'image/*',
        'Referer': REFERER_BY_HOST[target.hostname] || (target.origin + '/'),
      },
    });
    if (!resp.ok) {
      return { statusCode: 502, headers: CORS, body: `Origen respondió ${resp.status}` };
    }
    const ct = resp.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//i.test(ct)) {
      return { statusCode: 415, headers: CORS, body: 'El recurso no es una imagen' };
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    // Límite defensivo: 8 MB por imagen.
    if (buf.length > 8 * 1024 * 1024) {
      return { statusCode: 413, headers: CORS, body: 'Imagen demasiado grande' };
    }
    return {
      statusCode: 200,
      headers: {
        ...CORS,
        'Content-Type': ct,
        // Cache agresivo: las imágenes de catálogo no cambian. Netlify CDN
        // sirve la 2da vez sin re-pegarle al proveedor.
        'Cache-Control': 'public, max-age=604800, immutable',
      },
      body: buf.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (e) {
    return { statusCode: 502, headers: CORS, body: `Error bajando imagen: ${e.message}` };
  }
};
