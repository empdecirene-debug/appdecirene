// Auth wrapper sobre Supabase Auth. Manejo de login/logout, sesión actual y rol.
//
// Uso:
//   import { getCurrentUser, requireAuth, signIn, signOut, isAdmin } from './auth.js?v=2';
//   const user = await requireAuth();   // redirige a /login.html si no hay sesión
//   if (await isAdmin()) { ... }

import { getSupa } from './supa.js?v=2';

const LOGIN_URL = '/login.html';

let _profileCache = null;

export async function signIn(email, password) {
  const supa = getSupa();
  const { data, error } = await supa.auth.signInWithPassword({ email, password });
  if (error) throw error;
  _profileCache = null;
  return data;
}

export async function signOut() {
  const supa = getSupa();
  await supa.auth.signOut();
  _profileCache = null;
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

export async function isAdmin() {
  const p = await getProfile();
  return !!p && ['admin','director'].includes(p.role);
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
