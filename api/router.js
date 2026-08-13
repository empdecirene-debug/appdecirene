// Rutas de la API. Todo lo que antes hacía Supabase pasa por acá.
//
//   POST /api/auth/login    { email, password }  → cookie de sesión
//   POST /api/auth/logout
//   GET  /api/auth/me
//   POST /api/auth/password { actual, nueva }
//   POST /api/q             descriptor de consulta (ver api/query.js)
//   POST /api/upload        adjunto (multipart) → { url }
//   GET  /api/health        estado de la base

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { q, pool } from './db.js';
import { construir, ErrorConsulta } from './query.js';
import { puede, ES_ADMIN } from './registry.js';
import {
  hashPassword, verifyPassword, crearToken, leerToken,
  leerCookies, cookieSesion, cookieBorrar, COOKIE,
} from './session.js';

export const DIR_ADJUNTOS = process.env.ADJUNTOS_DIR || '/data/adjuntos';

const json = (res, status, obj, headers = {}) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
};

function leerCuerpo(req, maxBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const trozos = []; let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) { reject(new Error('Cuerpo demasiado grande')); req.destroy(); return; }
      trozos.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(trozos)));
    req.on('error', reject);
  });
}

// Sesión del request: { userId, email, rol } o null.
async function sesion(req) {
  const tok = leerToken(leerCookies(req)[COOKIE]);
  if (!tok?.uid) return null;
  const { rows } = await q(
    `select p.id, p.email, p.role, p.active, p.full_name
       from user_profiles p where p.id = $1`, [tok.uid]);
  const p = rows[0];
  if (!p || p.active === false) return null;
  return { userId: p.id, email: p.email, rol: p.role || 'comercial', nombre: p.full_name };
}

export async function manejar(req, res, pathname) {
  // ── Adjuntos servidos desde el volumen ──
  if (pathname.startsWith('/adjuntos/') && req.method === 'GET') {
    const rel = decodeURIComponent(pathname.slice('/adjuntos/'.length));
    const dest = path.normalize(path.join(DIR_ADJUNTOS, rel));
    if (!dest.startsWith(path.normalize(DIR_ADJUNTOS))) return json(res, 403, { error: 'Prohibido' });
    if (!fs.existsSync(dest)) return json(res, 404, { error: 'No existe' });
    res.writeHead(200, { 'Cache-Control': 'public, max-age=31536000, immutable' });
    return fs.createReadStream(dest).pipe(res);
  }

  if (!pathname.startsWith('/api/')) return false;

  // ── Salud ──
  if (pathname === '/api/health') {
    try {
      const { rows } = await q('select 1 as ok');
      const { rows: t } = await q(
        `select count(*)::int as n from information_schema.tables where table_schema='public'`);
      return json(res, 200, { ok: rows[0].ok === 1, tablas: t[0].n });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // ── Login ──
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    let body;
    try { body = JSON.parse((await leerCuerpo(req, 8192)).toString('utf8')); }
    catch { return json(res, 400, { error: 'Cuerpo inválido' }); }
    const email = String(body.email || '').toLowerCase().trim();
    const password = String(body.password || '');
    if (!email || !password) return json(res, 400, { error: 'Falta email o contraseña' });

    const { rows } = await q(
      `select u.id, u.password_hash, u.must_change_pw, p.role, p.active, p.full_name
         from app_users u left join user_profiles p on p.id = u.id
        where lower(u.email) = $1`, [email]);
    const u = rows[0];
    // Mismo mensaje y mismo costo aunque el usuario no exista: no revelamos cuáles hay.
    const hashDummy = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    const ok = await verifyPassword(password, u?.password_hash || hashDummy);
    if (!u || !ok) return json(res, 401, { error: 'Email o contraseña incorrectos' });
    if (u.active === false) return json(res, 403, { error: 'Tu usuario está desactivado' });

    await q('update app_users set last_login_at = now() where id = $1', [u.id]);
    const token = crearToken({ uid: u.id });
    return json(res, 200, {
      user: { id: u.id, email, role: u.role || 'comercial', full_name: u.full_name, must_change_pw: u.must_change_pw },
    }, { 'Set-Cookie': cookieSesion(token) });
  }

  if (pathname === '/api/auth/logout') {
    return json(res, 200, { ok: true }, { 'Set-Cookie': cookieBorrar() });
  }

  const ses = await sesion(req);

  if (pathname === '/api/auth/me') {
    if (!ses) return json(res, 200, { user: null });
    return json(res, 200, { user: { id: ses.userId, email: ses.email, role: ses.rol, full_name: ses.nombre } });
  }

  // A partir de acá todo exige sesión.
  if (!ses) return json(res, 401, { error: 'Sin sesión' });

  // ── Cambio de contraseña ──
  if (pathname === '/api/auth/password' && req.method === 'POST') {
    let body;
    try { body = JSON.parse((await leerCuerpo(req, 8192)).toString('utf8')); }
    catch { return json(res, 400, { error: 'Cuerpo inválido' }); }
    const nueva = String(body.nueva || '');
    if (nueva.length < 8) return json(res, 400, { error: 'La contraseña nueva necesita al menos 8 caracteres' });
    const { rows } = await q('select password_hash from app_users where id = $1', [ses.userId]);
    if (!rows[0] || !(await verifyPassword(String(body.actual || ''), rows[0].password_hash))) {
      return json(res, 401, { error: 'La contraseña actual no coincide' });
    }
    await q('update app_users set password_hash = $1, must_change_pw = false where id = $2',
      [await hashPassword(nueva), ses.userId]);
    return json(res, 200, { ok: true });
  }

  // ── Alta de usuarios (solo admin) ──
  if (pathname === '/api/auth/usuarios' && req.method === 'POST') {
    if (!ES_ADMIN(ses.rol)) return json(res, 403, { error: 'Requiere permisos de administrador' });
    let body;
    try { body = JSON.parse((await leerCuerpo(req, 8192)).toString('utf8')); }
    catch { return json(res, 400, { error: 'Cuerpo inválido' }); }
    const email = String(body.email || '').toLowerCase().trim();
    const rol = ['admin', 'director', 'comercial', 'produccion'].includes(body.role) ? body.role : 'comercial';
    const pw = String(body.password || '') || ('cirene-' + Math.random().toString(36).slice(2, 10));
    if (!email) return json(res, 400, { error: 'Falta el email' });
    const cliente = await pool.connect();
    try {
      await cliente.query('begin');
      const { rows } = await cliente.query(
        `insert into app_users (email, password_hash, must_change_pw) values ($1,$2,true)
         on conflict (email) do nothing returning id`, [email, await hashPassword(pw)]);
      if (!rows[0]) { await cliente.query('rollback'); return json(res, 409, { error: 'Ese email ya existe' }); }
      await cliente.query(
        `insert into user_profiles (id, email, full_name, role, active) values ($1,$2,$3,$4,true)`,
        [rows[0].id, email, String(body.full_name || email.split('@')[0]), rol]);
      await cliente.query('commit');
      return json(res, 200, { ok: true, email, password: pw, role: rol });
    } catch (e) {
      await cliente.query('rollback');
      return json(res, 500, { error: e.message });
    } finally { cliente.release(); }
  }

  // ── Consulta genérica ──
  if (pathname === '/api/q' && req.method === 'POST') {
    let desc;
    try { desc = JSON.parse((await leerCuerpo(req, 4 * 1024 * 1024)).toString('utf8')); }
    catch { return json(res, 400, { error: 'Cuerpo inválido' }); }

    const accion = desc.accion === 'upsert' ? 'insert' : desc.accion;
    const motivo = puede(desc.tabla, accion, ses.rol);
    if (motivo) return json(res, 403, { error: motivo });

    try {
      const { sql, params } = construir(desc);
      const { rows } = await q(sql, params);
      if (desc.single) {
        if (rows.length !== 1) {
          return json(res, 200, {
            data: null,
            error: { message: rows.length ? 'Se esperaba una sola fila' : 'No se encontró la fila', code: 'PGRST116' },
          });
        }
        return json(res, 200, { data: rows[0], error: null });
      }
      if (desc.maybeSingle) return json(res, 200, { data: rows[0] ?? null, error: null });
      return json(res, 200, { data: rows, error: null });
    } catch (e) {
      const esDeConsulta = e instanceof ErrorConsulta;
      if (!esDeConsulta) console.error('[api/q]', desc.tabla, desc.accion, '→', e.message);
      return json(res, 200, {
        data: null,
        error: { message: e.message, code: e.code || 'DB_ERROR' },
      });
    }
  }

  // ── Subida de adjuntos ──
  if (pathname === '/api/upload' && req.method === 'POST') {
    const nombre = String(req.headers['x-nombre-archivo'] || 'archivo').replace(/[^\w.\-]+/g, '_').slice(0, 120);
    const carpeta = String(req.headers['x-card-id'] || 'varios').replace(/[^\w.\-]+/g, '_').slice(0, 80);
    let datos;
    try { datos = await leerCuerpo(req); }
    catch (e) { return json(res, 413, { error: e.message }); }
    if (!datos.length) return json(res, 400, { error: 'Archivo vacío' });
    const rel = path.join(carpeta, Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '-' + nombre);
    const dest = path.join(DIR_ADJUNTOS, rel);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, datos);
    } catch (e) {
      console.error('[upload]', e.message);
      return json(res, 500, { error: 'No se pudo guardar el archivo: ' + e.message });
    }
    return json(res, 200, { url: '/adjuntos/' + rel.split(path.sep).join('/'), path: rel.split(path.sep).join('/') });
  }

  if (pathname === '/api/upload/borrar' && req.method === 'POST') {
    let body;
    try { body = JSON.parse((await leerCuerpo(req, 8192)).toString('utf8')); }
    catch { return json(res, 400, { error: 'Cuerpo inválido' }); }
    const dest = path.normalize(path.join(DIR_ADJUNTOS, String(body.path || '')));
    if (!dest.startsWith(path.normalize(DIR_ADJUNTOS))) return json(res, 403, { error: 'Prohibido' });
    try { fs.unlinkSync(dest); } catch {}
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'Ruta de API desconocida' });
}
