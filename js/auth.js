// Auth wrapper sobre Supabase Auth. Manejo de login/logout, sesión actual y rol.
//
// Uso:
//   import { getCurrentUser, requireAuth, signIn, signOut, isAdmin } from './auth.js?v=8';
//   const user = await requireAuth();   // redirige a /login.html si no hay sesión
//   if (await isAdmin()) { ... }

import { getSupa } from './supa.js?v=8';

const LOGIN_URL = '/login.html';

let _profileCache = null;
// Va acá arriba, junto al otro cache, porque signOut() la limpia y signOut()
// está escrita más arriba que isAdmin(), que es donde se llena.
let _perfilCache = null;

export async function signIn(email, password) {
  const supa = getSupa();
  const { data, error } = await supa.auth.signInWithPassword({ email, password });
  if (error) throw error;
  _profileCache = null;
  return data;
}

// Entrada con el PIN de la app (4 números). Abre la sesión del administrador.
export async function signInWithPin(pin) {
  const { data, error } = await getSupa().auth.signInWithPin({ pin });
  if (error) throw error;
  _profileCache = null;
  _perfilCache = null;
  return data;
}

export async function signOut() {
  const supa = getSupa();
  await supa.auth.signOut();
  _profileCache = null;
  _perfilCache = null;
}

export async function getCurrentUser() {
  const supa = getSupa();
  const { data: { user } } = await supa.auth.getUser();
  return user || null;
}

export async function requireAuth(opts = {}) {
  const user = await getCurrentUser();
  if (!user) {
    if (opts.silent) return null;
    const next = encodeURIComponent(location.pathname + location.search);
    location.href = `${LOGIN_URL}?next=${next}`;
    return null;
  }
  return user;
}

export async function getProfile() {
  if (_profileCache) return _profileCache;
  const user = await getCurrentUser();
  if (!user) return null;
  const supa = getSupa();
  const { data, error } = await supa.from('user_profiles').select('*').eq('id', user.id).single();
  if (error) {
    console.warn('No se pudo leer user_profile:', error.message);
    return null;
  }
  _profileCache = data;
  return data;
}

// ¿Es administrador? Ya no alcanza con mirar si el rol se llama 'admin' o
// 'director': los roles se crean desde Administración y cada uno declara un
// PERFIL BASE (ver `app_roles` y api/registry.js). Un rol "Encargado general"
// con perfil base admin tiene que pasar por acá, o el cliente le esconde
// pantallas que el servidor sí le permite.
//
// El servidor decide igual, siempre: esto es solo para no mostrar de menos.
const PERFILES_ADMIN = ['admin', 'director'];

export async function isAdmin() {
  const p = await getProfile();
  if (!p) return false;
  if (PERFILES_ADMIN.includes(p.role)) return true;
  if (_perfilCache && _perfilCache.role === p.role) return _perfilCache.esAdmin;
  let esAdmin = false;
  try {
    const { data } = await getSupa().from('app_roles').select('perfil_base').eq('key', p.role).limit(1);
    esAdmin = !!(data && data[0] && data[0].perfil_base === 'admin');
  } catch (e) { console.warn('[auth] no pude leer el perfil del rol:', e.message); }
  _perfilCache = { role: p.role, esAdmin };
  return esAdmin;
}

export async function isCanMoveCards() {
  return isAdmin();
}

// Helper: si la página requiere admin, redirige a / si el usuario no lo es.
export async function requireAdmin() {
  await requireAuth();
  if (!(await isAdmin())) {
    alert('Esta sección requiere permisos de administrador.');
    location.href = '/';
    return false;
  }
  return true;
}
