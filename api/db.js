// Conexión a Postgres y migración al arrancar.
//
// El esquema viaja con el código (db/schema.sql) y se aplica solo al levantar el
// servicio: es idempotente (create ... if not exists), así que correrlo en cada
// deploy no rompe nada y garantiza que la base nunca quede atrás del código.
//
// La base NO está expuesta a internet: vive en la red privada de Railway
// (postgres.railway.internal) y solo la alcanza este servicio.

import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from './session.js';
import { cargarColumnas } from './registry.js';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Railway inyecta DATABASE_URL al referenciar el servicio Postgres.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('[db] FALTA DATABASE_URL. En Railway: Variables → Add reference → Postgres.DATABASE_URL');
}

export const pool = new pg.Pool({
  connectionString,
  max: 8,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  // La red interna de Railway ya es privada; el certificado del contenedor es self-signed.
  ssl: /railway\.internal/.test(connectionString || '') ? false : { rejectUnauthorized: false },
});

pool.on('error', (e) => console.error('[db] error en cliente inactivo:', e.message));

export const q = (sql, params) => pool.query(sql, params);

async function existeTabla(nombre) {
  const { rows } = await q(`select to_regclass($1) as t`, ['public.' + nombre]);
  return !!rows[0].t;
}

async function contar(tabla) {
  try { const { rows } = await q(`select count(*)::int as n from "${tabla}"`); return rows[0].n; }
  catch { return -1; }
}

// ── Recuperar el acceso de administración ────────────────────────────────────
// La contraseña se guarda con scrypt: no se puede leer ni recuperar. Si se perdió,
// la única salida era tener acceso a la base. Con esto alcanza una variable:
//
//   1. Railway → servicio appdecirene → Variables → ADMIN_RESET_PASSWORD = <la nueva>
//      (guardar la variable ya dispara un deploy, no hace falta nada más)
//   2. Entrar con ADMIN_EMAIL (o admin@decirene.uy) y esa contraseña
//   3. BORRAR la variable  ← importante: mientras exista, cada reinicio la vuelve a poner
//
// Si el usuario no existe, se crea. Si existe pero perdió el perfil o quedó
// inactivo, se repara. Corre ANTES del esquema a propósito: si un cambio de
// schema.sql falla, igual tenés forma de entrar y arreglarlo.
async function resetearAdmin() {
  const nueva = process.env.ADMIN_RESET_PASSWORD;
  if (!nueva) return;
  const email = (process.env.ADMIN_EMAIL || 'admin@decirene.uy').toLowerCase().trim();

  if (String(nueva).length < 8) {
    console.error('[db] ADMIN_RESET_PASSWORD tiene menos de 8 caracteres: no la aplico.');
    return;
  }
  if (!(await existeTabla('app_users'))) {
    console.error('[db] todavía no existe app_users: el reset se aplica en el próximo arranque.');
    return;
  }

  const hash = await hashPassword(String(nueva));
  const { rows } = await q(
    `update app_users set password_hash = $1, must_change_pw = true
      where lower(email) = $2 returning id`, [hash, email]);

  let uid = rows[0]?.id;
  if (!uid) {
    const { rows: nuevo } = await q(
      `insert into app_users (email, password_hash, must_change_pw) values ($1,$2,true) returning id`,
      [email, hash]);
    uid = nuevo[0].id;
    console.log('[db] el usuario', email, 'no existía: lo creé.');
  }

  // El perfil tiene que tener el MISMO id que el usuario: la sesión resuelve el rol
  // buscando user_profiles por ese id. Si quedó uno viejo con ese email, se realinea.
  await q(`update user_profiles set id = $1 where lower(email) = $2 and id <> $1`, [uid, email]);
  await q(
    `insert into user_profiles (id, email, full_name, role, active)
     values ($1,$2,'Administrador','admin',true)
     on conflict (id) do update set role = 'admin', active = true, email = excluded.email`,
    [uid, email]);

  console.log('┌──────────────────────────────────────────────');
  console.log('│ CONTRASEÑA DE ADMIN RESTABLECIDA');
  console.log('│   email :', email);
  console.log('│   rol   : admin');
  console.log('│ Entrá y después BORRÁ la variable ADMIN_RESET_PASSWORD:');
  console.log('│ mientras exista, cada reinicio vuelve a poner esa contraseña.');
  console.log('└──────────────────────────────────────────────');
}

export async function migrar() {
  if (!connectionString) throw new Error('Sin DATABASE_URL no puedo migrar');

  // Va primero: recuperar el acceso no puede depender de que el esquema aplique bien.
  try { await resetearAdmin(); }
  catch (e) { console.error('[db] no se pudo restablecer el admin:', e.message); }

  const esquema = fs.readFileSync(path.join(RAIZ, 'db', 'schema.sql'), 'utf8');
  console.log('[db] aplicando esquema…');
  await q(esquema);

  // Las plantillas van aparte: su script borra y recrea, así que solo corre si no hay.
  if (await contar('product_templates') === 0) {
    const seed = path.join(RAIZ, 'db', 'seed_templates.sql');
    if (fs.existsSync(seed)) {
      console.log('[db] sembrando plantillas de producto…');
      await q(fs.readFileSync(seed, 'utf8'));
    }
  }

  // Usuario admin inicial. La contraseña sale de la env; si no está, se genera una
  // y se imprime UNA vez en los logs del deploy para poder entrar y cambiarla.
  if (await existeTabla('app_users')) {
    const { rows } = await q('select count(*)::int as n from app_users');
    if (rows[0].n === 0) {
      const email = (process.env.ADMIN_EMAIL || 'admin@decirene.uy').toLowerCase().trim();
      let pw = process.env.ADMIN_PASSWORD;
      let generada = false;
      if (!pw) { pw = 'cirene-' + Math.random().toString(36).slice(2, 10); generada = true; }
      const hash = await hashPassword(pw);
      const { rows: u } = await q(
        `insert into app_users (email, password_hash, must_change_pw) values ($1,$2,$3) returning id`,
        [email, hash, generada]
      );
      await q(
        `insert into user_profiles (id, email, full_name, role, active)
         values ($1,$2,$3,'admin',true)
         on conflict (id) do update set role='admin', active=true`,
        [u[0].id, email, 'Administrador']
      );
      console.log('┌──────────────────────────────────────────────');
      console.log('│ USUARIO ADMIN CREADO');
      console.log('│   email      :', email);
      console.log('│   contraseña :', generada ? pw + '   ← generada, cambiala al entrar' : '(la de ADMIN_PASSWORD)');
      console.log('└──────────────────────────────────────────────');
    }
  }

  const n = await cargarColumnas(pool);
  const resumen = {};
  for (const t of ['materials', 'labor_rates', 'product_templates', 'kanban_stages', 'app_users', 'user_profiles']) {
    resumen[t] = await contar(t);
  }
  console.log('[db] listo ·', n, 'tablas ·', JSON.stringify(resumen));
  return resumen;
}
