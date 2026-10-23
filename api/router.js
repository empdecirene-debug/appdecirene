// Rutas de la API. Todo lo que antes hacía Supabase pasa por acá.
//
//   POST /api/auth/pin      { pin }              → cookie de sesión del dueño del PIN
//   POST /api/auth/login    { email, password }  → cookie de sesión
//   GET  /api/auth/usuarios/pines                (solo admin) quién tiene PIN
//   POST /api/auth/usuarios/pin { id, pin }      (solo admin) asignar / sacar PIN
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
import { puede, ES_ADMIN, cargarRoles, rolExiste } from './registry.js';
import { generarDemo, reiniciar } from './demo.js';
import { importarAsana } from './asana.js';
import { enviarPendientes, ticketsActivos } from './tickets.js';
import {
  operarioPorPin, estadoTaller,
  iniciar as iniciarTaller, terminar as terminarTaller,
} from './taller.js';
import {
  hashPassword, verifyPassword, crearToken, leerToken,
  leerCookies, cookieSesion, cookieBorrar, COOKIE,
  crearTokenTaller, leerTokenTaller, cookieTaller, cookieTallerBorrar, COOKIE_TALLER,
} from './session.js';

/* Freno de fuerza bruta del PIN del taller. Un PIN de 4 dígitos son 10.000
   combinaciones: sin esto, probarlas todas es cuestión de minutos. En memoria y
   por IP alcanza — es un taller, no un banco, y un reinicio del servicio que
   limpie el contador no regala nada (la ventana vuelve a empezar). */
const intentos = new Map();
const MAX_INTENTOS = 12, VENTANA_MS = 10 * 60 * 1000;

function intentoPermitido(ip) {
  const ahora = Date.now();
  const previos = (intentos.get(ip) || []).filter((t) => ahora - t < VENTANA_MS);
  if (previos.length >= MAX_INTENTOS) { intentos.set(ip, previos); return false; }
  previos.push(ahora);
  intentos.set(ip, previos);
  if (intentos.size > 500) for (const [k, v] of intentos) if (!v.some((t) => ahora - t < VENTANA_MS)) intentos.delete(k);
  return true;
}
const limpiarIntentos = (ip) => intentos.delete(ip);

const ipDe = (req) => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '?').split(',')[0].trim();

/* Freno de fuerza bruta del PIN de ENTRADA a la app. Es más duro que el del
   taller porque este PIN abre la app entera como administrador. Cada intento se
   cuenta ANTES de verificarlo (si no, mil pedidos en paralelo pasarían todos el
   control antes de que falle el primero) y se devuelve si el PIN era el bueno.
   Dos capas:
     · por IP: 5 intentos cada 15 minutos;
     · GLOBAL: 20 fallos por hora y 60 por día, sumando todas las IPs. Es la que
       importa: quien ataca puede cambiar de IP, el total no. A 60 por día,
       recorrer las 10.000 combinaciones lleva meses.
   Si la global se traba, el PIN deja de andar un rato para todos: para eso sigue
   la entrada con email y contraseña, que no pasa por este freno. */
const PIN_IP = { max: 5, ms: 15 * 60e3 };
const PIN_HORA = { max: 20, ms: 60 * 60e3 };
const PIN_DIA = { max: 60, ms: 24 * 60 * 60e3 };
const pinPorIp = new Map();
let pinGlobal = [];
let avisoFrenoGlobal = 0;

function frenoPin(ip) {
  const ahora = Date.now();
  pinGlobal = pinGlobal.filter((t) => ahora - t < PIN_DIA.ms);
  const enLaHora = pinGlobal.filter((t) => ahora - t < PIN_HORA.ms).length;
  if (pinGlobal.length >= PIN_DIA.max || enLaHora >= PIN_HORA.max) return { error: 'global' };
  const propios = (pinPorIp.get(ip) || []).filter((t) => ahora - t < PIN_IP.ms);
  if (propios.length >= PIN_IP.max) { pinPorIp.set(ip, propios); return { error: 'ip' }; }
  propios.push(ahora);
  pinPorIp.set(ip, propios);
  pinGlobal.push(ahora);
  if (pinPorIp.size > 500) for (const [k, v] of pinPorIp) if (!v.some((t) => ahora - t < PIN_IP.ms)) pinPorIp.delete(k);
  return { t: ahora };
}

function devolverIntentoPin(ip, t) {
  const i = pinGlobal.lastIndexOf(t);
  if (i >= 0) pinGlobal.splice(i, 1);
  pinPorIp.delete(ip);
}

/* PIN por usuario. Cada uno tiene el suyo (app_users.pin_hash, scrypt con su
   salt), así que para saber de quién es un PIN hay que probarlo contra todos.
   Son pocos usuarios y scrypt corre en el pool de hilos: en paralelo tarda lo
   que tarda uno o dos.

   La cookie de quien entró con PIN lleva una HUELLA del hash de su PIN: si
   administración se lo cambia o se lo saca, esa sesión se cae (si no, quien
   supiera el PIN viejo seguiría adentro 30 días). */
// Dominio de los usuarios creados sin email (ver el alta de usuarios).
const SIN_EMAIL = '@sin-email.decirene';
const clave = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

const huellaPin = (hash) => crypto.createHash('sha256').update(String(hash)).digest('base64url').slice(0, 16);

async function usuarioPorPin(pin, salvoId = null) {
  const { rows } = await q(
    `select u.id, u.email, u.pin_hash, p.role, p.full_name, p.active
       from app_users u left join user_profiles p on p.id = u.id
      where u.pin_hash is not null and u.id is distinct from $1`, [salvoId]);
  const ok = await Promise.all(rows.map((u) => verifyPassword(pin, u.pin_hash)));
  return rows.find((_, i) => ok[i]) || null;
}

// Un PIN identifica a la persona: no puede repetirse entre usuarios. Tampoco
// puede ser el número de taller de un operario, porque equivocarse de pantalla
// lo dejaría entrar a la app con la cuenta de otro.
async function motivoPinOcupado(pin, salvoId = null) {
  if (await usuarioPorPin(pin, salvoId)) return 'Ese PIN ya lo tiene otra persona. Elegí otro.';
  const { rows } = await q(`select 1 from operators where pin = $1 and activo limit 1`, [pin]);
  if (rows.length) return 'Ese número ya lo usa un operario en el taller. Elegí otro.';
  return null;
}

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
    `select p.id, p.email, p.role, p.active, p.full_name, u.pin_hash
       from user_profiles p left join app_users u on u.id = p.id where p.id = $1`, [tok.uid]);
  const p = rows[0];
  if (!p || p.active === false) return null;
  if (tok.pin && (!p.pin_hash || tok.pin !== huellaPin(p.pin_hash))) return null;
  return { userId: p.id, email: p.email, rol: p.role || 'comercial', nombre: p.full_name, porPin: !!tok.pin };
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

  // ── Entrada con PIN ──
  // Cada usuario tiene su PIN: el que coincide abre SU sesión, con los permisos
  // de su rol. El email y la contraseña siguen funcionando aparte.
  if (pathname === '/api/auth/pin' && req.method === 'POST') {
    let body;
    try { body = JSON.parse((await leerCuerpo(req, 4096)).toString('utf8')); }
    catch { return json(res, 400, { error: 'Cuerpo inválido' }); }
    const ip = ipDe(req);
    const freno = frenoPin(ip);
    if (freno.error === 'global') {
      // Un aviso cada 10 minutos alcanza: bajo ataque, uno por pedido tapa los logs.
      if (Date.now() - avisoFrenoGlobal > 10 * 60e3) {
        avisoFrenoGlobal = Date.now();
        console.warn('[auth] entrada con PIN frenada para todos: demasiados intentos fallidos');
      }
      return json(res, 429, { error: 'Hubo demasiados intentos con un PIN equivocado y la entrada con PIN quedó frenada por un rato. Entrá con email y contraseña.' });
    }
    if (freno.error) return json(res, 429, { error: 'Demasiados intentos. Esperá 15 minutos y volvé a probar.' });

    const pin = String(body.pin ?? '').replace(/\D+/g, '');
    const u = /^\d{4}$/.test(pin) ? await usuarioPorPin(pin) : null;
    if (!u) {
      console.warn('[auth] PIN de entrada incorrecto desde', ip);
      return json(res, 401, { error: 'PIN incorrecto' });
    }
    devolverIntentoPin(ip, freno.t);
    if (u.active === false) return json(res, 403, { error: 'Tu usuario está desactivado. Hablá con administración.' });

    await q('update app_users set last_login_at = now() where id = $1', [u.id]);
    const token = crearToken({ uid: u.id, pin: huellaPin(u.pin_hash) });
    return json(res, 200, {
      user: { id: u.id, email: u.email, role: u.role || 'comercial', full_name: u.full_name },
    }, { 'Set-Cookie': cookieSesion(token) });
  }

  if (pathname === '/api/auth/logout') {
    return json(res, 200, { ok: true }, { 'Set-Cookie': cookieBorrar() });
  }

  // ── TALLER: fichadas de los operarios ──────────────────────────────────────
  // Credencial propia (PIN → cookie de taller) y respuesta recortada: ver
  // api/taller.js. No pasa por la sesión de la app a propósito, porque el
  // operario no tiene usuario.
  if (pathname.startsWith('/api/taller/')) {
    if (pathname === '/api/taller/login' && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await leerCuerpo(req, 4096)).toString('utf8')); }
      catch { return json(res, 400, { error: 'Cuerpo inválido' }); }
      const ip = ipDe(req);
      if (!intentoPermitido(ip)) {
        return json(res, 429, { error: 'Demasiados intentos. Esperá unos minutos y volvé a probar.' });
      }
      const op = await operarioPorPin(body.pin);
      if (!op) return json(res, 401, { error: 'Ese número no es correcto. Pedile tu número al encargado.' });
      limpiarIntentos(ip);
      return json(res, 200, { operario: op }, { 'Set-Cookie': cookieTaller(crearTokenTaller(op.id)) });
    }

    if (pathname === '/api/taller/logout') {
      return json(res, 200, { ok: true }, { 'Set-Cookie': cookieTallerBorrar() });
    }

    const tok = leerTokenTaller(leerCookies(req)[COOKIE_TALLER]);
    if (!tok) return json(res, 401, { error: 'Escribí tu número para entrar.' });

    if (pathname === '/api/taller/estado') {
      const estado = await estadoTaller(tok.op);
      // El operario pudo quedar inactivo mientras la cookie seguía viva.
      if (!estado) return json(res, 401, { error: 'Tu usuario de taller ya no está activo.' }, { 'Set-Cookie': cookieTallerBorrar() });
      return json(res, 200, estado);
    }

    if (pathname === '/api/taller/inicio' && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await leerCuerpo(req, 8192)).toString('utf8')); }
      catch { return json(res, 400, { error: 'Cuerpo inválido' }); }
      try { return json(res, 200, await iniciarTaller(tok.op, body)); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }

    if (pathname === '/api/taller/fin' && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse((await leerCuerpo(req, 8192)).toString('utf8')); } catch {}
      try { return json(res, 200, await terminarTaller(tok.op, body)); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }

    return json(res, 404, { error: 'Ruta de taller desconocida' });
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

  // ── PIN de cada usuario (solo admin) ──
  // GET: quién tiene PIN (nunca el PIN: se guarda como hash y no se puede leer).
  if (pathname === '/api/auth/usuarios/pines' && req.method === 'GET') {
    if (!ES_ADMIN(ses.rol)) return json(res, 403, { error: 'Requiere permisos de administrador' });
    const { rows } = await q(`select id, (pin_hash is not null) as tiene_pin, email from app_users`);
    return json(res, 200, { usuarios: rows.map(r => ({ id: r.id, tiene_pin: r.tiene_pin, sin_email: r.email.endsWith(SIN_EMAIL) })) });
  }
  // POST { id, pin }: asigna o cambia el PIN; pin vacío se lo saca.
  if (pathname === '/api/auth/usuarios/pin' && req.method === 'POST') {
    if (!ES_ADMIN(ses.rol)) return json(res, 403, { error: 'Requiere permisos de administrador' });
    let body;
    try { body = JSON.parse((await leerCuerpo(req, 4096)).toString('utf8')); }
    catch { return json(res, 400, { error: 'Cuerpo inválido' }); }
    const id = String(body.id || '');
    const pin = String(body.pin ?? '').trim();
    const { rows: existe } = await q(`select id from app_users where id::text = $1`, [id]);
    if (!existe.length) return json(res, 404, { error: 'No existe ese usuario' });
    if (pin && !/^\d{4}$/.test(pin)) return json(res, 400, { error: 'El PIN tiene que ser de 4 números' });
    if (pin) {
      const motivo = await motivoPinOcupado(pin, id);
      if (motivo) return json(res, 409, { error: motivo });
    }
    const hash = pin ? await hashPassword(pin) : null;
    await q(`update app_users set pin_hash = $1 where id = $2`, [hash, id]);
    // Las sesiones abiertas con el PIN viejo se caen solas (ver huellaPin). La de
    // quien se lo cambió a sí mismo no: si entró con PIN, se le renueva.
    const headers = id === ses.userId && ses.porPin && hash
      ? { 'Set-Cookie': cookieSesion(crearToken({ uid: ses.userId, pin: huellaPin(hash) })) } : {};
    return json(res, 200, { ok: true, tiene_pin: !!hash }, headers);
  }

  // ── Alta de usuarios (solo admin) ──
  if (pathname === '/api/auth/usuarios' && req.method === 'POST') {
    if (!ES_ADMIN(ses.rol)) return json(res, 403, { error: 'Requiere permisos de administrador' });
    let body;
    try { body = JSON.parse((await leerCuerpo(req, 8192)).toString('utf8')); }
    catch { return json(res, 400, { error: 'Cuerpo inválido' }); }
    const nombre = String(body.full_name || '').trim();
    // Con PIN, el email es opcional: mucha gente del taller no usa uno. La base
    // igual necesita uno único, así que se arma un identificador que no es un
    // mail de verdad (SIN_EMAIL) y no sirve para entrar con contraseña.
    const conEmail = !!String(body.email || '').trim();
    const slug = clave(nombre).replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '') || 'usuario';
    const email = conEmail ? String(body.email).toLowerCase().trim()
      : `${slug}.${crypto.randomBytes(3).toString('hex')}${SIN_EMAIL}`;
    // Los roles ya no son cuatro constantes: se crean desde Administración, así
    // que la validación va contra `app_roles` (ver api/registry.js).
    const rol = rolExiste(body.role) ? body.role : 'comercial';
    const pw = String(body.password || '') || ('cirene-' + Math.random().toString(36).slice(2, 10));
    if (!conEmail && !nombre) return json(res, 400, { error: 'Falta el nombre' });
    const pin = String(body.pin ?? '').trim();
    if (pin && !/^\d{4}$/.test(pin)) return json(res, 400, { error: 'El PIN tiene que ser de 4 números' });
    if (pin) {
      const motivo = await motivoPinOcupado(pin);
      if (motivo) return json(res, 409, { error: motivo });
    }
    const cliente = await pool.connect();
    try {
      await cliente.query('begin');
      const { rows } = await cliente.query(
        `insert into app_users (email, password_hash, must_change_pw, pin_hash) values ($1,$2,true,$3)
         on conflict (email) do nothing returning id`, [email, await hashPassword(pw), pin ? await hashPassword(pin) : null]);
      if (!rows[0]) { await cliente.query('rollback'); return json(res, 409, { error: 'Ese email ya existe' }); }
      await cliente.query(
        `insert into user_profiles (id, email, full_name, role, active) values ($1,$2,$3,$4,true)`,
        [rows[0].id, email, nombre || email.split('@')[0], rol]);
      await cliente.query('commit');
      return json(res, 200, { ok: true, email: conEmail ? email : null, password: conEmail ? pw : null, role: rol, pin: !!pin });
    } catch (e) {
      await cliente.query('rollback');
      return json(res, 500, { error: e.message });
    } finally { cliente.release(); }
  }

  // ── Datos de prueba y reinicio (solo admin) ──
  //
  // Van del lado del servidor y no en el navegador porque las dos cosas tocan
  // muchas tablas encadenadas: acá corren en UNA transacción, así que o queda
  // todo o no queda nada. Desde el cliente, media docena de llamadas sueltas
  // podían dejar la base a medio camino.
  if (pathname === '/api/admin/demo' && req.method === 'POST') {
    if (!ES_ADMIN(ses.rol)) return json(res, 403, { error: 'Requiere permisos de administrador' });
    try {
      const r = await generarDemo();
      if (r.ya) return json(res, 409, { error: r.mensaje });
      return json(res, 200, { ok: true, cuenta: r.cuenta });
    } catch (e) {
      console.error('[demo] generar:', e);
      return json(res, 500, { error: 'No se pudieron generar los datos: ' + e.message });
    }
  }

  if (pathname === '/api/admin/reset' && req.method === 'POST') {
    if (!ES_ADMIN(ses.rol)) return json(res, 403, { error: 'Requiere permisos de administrador' });
    let body;
    try { body = JSON.parse((await leerCuerpo(req, 8192)).toString('utf8')); }
    catch { return json(res, 400, { error: 'Cuerpo inválido' }); }
    const modo = body.modo === 'operativo' ? 'operativo' : 'demo';
    // El borrado total pide confirmación escrita: es irreversible.
    if (modo === 'operativo' && String(body.confirmacion || '').trim().toUpperCase() !== 'REINICIAR') {
      return json(res, 400, { error: 'Para reiniciar todo hay que escribir REINICIAR' });
    }
    try {
      const r = await reiniciar(modo);
      return json(res, 200, { ok: true, ...r });
    } catch (e) {
      console.error('[demo] reiniciar:', e);
      return json(res, 500, { error: 'No se pudo reiniciar: ' + e.message });
    }
  }

  // ── Importar desde Asana (solo admin) ──
  // Reemplaza todo el movimiento por lo de los dos CSV, con respaldo previo.
  // `soloVer` corre todo y deshace: es la vista previa. Ver api/asana.js.
  if (pathname === '/api/admin/importar-asana' && req.method === 'POST') {
    if (!ES_ADMIN(ses.rol)) return json(res, 403, { error: 'Requiere permisos de administrador' });
    let body;
    try { body = JSON.parse((await leerCuerpo(req, 20 * 1024 * 1024)).toString('utf8')); }
    catch { return json(res, 400, { error: 'Cuerpo inválido' }); }
    const soloVer = body.soloVer === true;
    if (!soloVer && String(body.confirmacion || '').trim().toUpperCase() !== 'REINICIAR') {
      return json(res, 400, { error: 'Para borrar y cargar hay que escribir REINICIAR' });
    }
    try {
      const r = await importarAsana(
        { presupuestos: String(body.presupuestos || ''), operativa: String(body.operativa || '') },
        { soloVer, uid: ses.userId });
      if (!soloVer) console.log('[asana] importado por', ses.email, JSON.stringify(r.carga), 'respaldo', r.respaldo);
      return json(res, 200, { ok: true, ...r });
    } catch (e) {
      console.error('[asana]', e);
      return json(res, 500, { error: 'No se pudo importar: ' + e.message });
    }
  }

  // ── Sugerencias → tickets de customERP (solo admin) ──
  // GET: si el envío está configurado. POST: reintenta ya lo que quedó pendiente.
  if (pathname === '/api/admin/tickets') {
    if (!ES_ADMIN(ses.rol)) return json(res, 403, { error: 'Requiere permisos de administrador' });
    if (req.method === 'POST') return json(res, 200, await enviarPendientes({ forzar: true }));
    return json(res, 200, { activo: ticketsActivos() });
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
      // Los permisos de tabla se resuelven por el `perfil_base` del rol, que vive
      // en `app_roles`. Si acaban de tocar esa tabla, el mapa en memoria quedó
      // viejo: recargarlo acá evita tener que redesplegar para que el rol nuevo
      // funcione.
      if (desc.tabla === 'app_roles' && accion !== 'select') await cargarRoles(pool);
      // Una sugerencia nueva sale enseguida para customERP, sin hacer esperar a quien la mandó.
      if (desc.tabla === 'suggestions' && accion === 'insert') setImmediate(() => enviarPendientes());
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
