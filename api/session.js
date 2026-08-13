// Contraseñas y sesiones. Reemplaza a Supabase Auth.
//
// Sin dependencias a propósito: scrypt y HMAC vienen en node:crypto. Meter bcrypt
// obligaría a compilar binarios nativos en el build de Railway sin ganar nada.
//
//   contraseña → scrypt (N=16384) con salt por usuario
//   sesión     → token firmado con HMAC-SHA256 en cookie httpOnly (no lo lee el JS
//                del navegador, así un XSS no se lleva la sesión)

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const N = 16384, r = 8, p = 1, KEYLEN = 32;

// ── Contraseñas ──────────────────────────────────────────────────────────────
export async function hashPassword(plano) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(plano, salt, KEYLEN, { N, r, p });
  return ['scrypt', N, r, p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(plano, guardado) {
  try {
    const [alg, n, rr, pp, saltB64, hashB64] = String(guardado).split('$');
    if (alg !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const esperado = Buffer.from(hashB64, 'base64');
    const calculado = await scrypt(plano, salt, esperado.length, { N: +n, r: +rr, p: +pp });
    // Comparación en tiempo constante: no filtra cuánto coincide.
    return crypto.timingSafeEqual(esperado, calculado);
  } catch { return false; }
}

// ── Tokens de sesión ─────────────────────────────────────────────────────────
// El secreto sale de la env. Si no está, se genera uno al vuelo: la app anda, pero
// cada reinicio invalida las sesiones (y avisamos, porque en producción es un error).
let SECRET = process.env.SESSION_SECRET || '';
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[session] Falta SESSION_SECRET: uso uno efímero. Las sesiones se caen en cada reinicio.');
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const firmar = (txt) => crypto.createHmac('sha256', SECRET).update(txt).digest('base64url');

export const DIAS_VALIDEZ = 30;

export function crearToken(payload) {
  const cuerpo = b64u(JSON.stringify({ ...payload, exp: Date.now() + DIAS_VALIDEZ * 864e5 }));
  return cuerpo + '.' + firmar(cuerpo);
}

export function leerToken(token) {
  if (!token || typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  if (i < 1) return null;
  const cuerpo = token.slice(0, i), firma = token.slice(i + 1);
  const esperada = firmar(cuerpo);
  // timingSafeEqual exige mismo largo.
  if (firma.length !== esperada.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(firma), Buffer.from(esperada))) return null;
  try {
    const p = JSON.parse(Buffer.from(cuerpo, 'base64url').toString('utf8'));
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}

// ── Cookies ──────────────────────────────────────────────────────────────────
export const COOKIE = 'cirene_sesion';

export function leerCookies(req) {
  const out = {};
  for (const parte of String(req.headers.cookie || '').split(';')) {
    const i = parte.indexOf('=');
    if (i < 0) continue;
    out[parte.slice(0, i).trim()] = decodeURIComponent(parte.slice(i + 1).trim());
  }
  return out;
}

export function cookieSesion(token) {
  const attrs = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${DIAS_VALIDEZ * 86400}`,
  ];
  // Railway sirve por HTTPS; en local (http) Secure impediría guardar la cookie.
  if (process.env.NODE_ENV !== 'development') attrs.push('Secure');
  return attrs.join('; ');
}

export const cookieBorrar = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
