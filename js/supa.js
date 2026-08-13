// Cliente de datos de Cirene.
//
// ANTES: envoltorio de supabase-js contra el proyecto bxlnsbkglxtxqceagsyr.
// AHORA: ese proyecto fue eliminado y los datos viven en Postgres, dentro del propio
// proyecto de Railway. Un navegador no puede hablar con Postgres, así que las consultas
// van a la API de esta misma app (api/) por HTTP.
//
// Mantiene la MISMA interfaz encadenable que supabase-js a propósito: así las ~60
// llamadas repartidas por cirene-data.js y las páginas siguen funcionando sin tocarlas.
//
//   supa.from('quotes').select('*').eq('id', x).single()   → { data, error }
//   supa.auth.signInWithPassword({ email, password })
//   supa.storage.from('adjuntos').upload(path, file)
//
// Lo NO soportado (y por qué no importa): los embeds de PostgREST
// —select('*, workshops(name)')— solo los usan módulos heredados de Glide que
// ninguna página de Cirene importa. Si llega uno, la API devuelve todas las columnas.

const API = '/api';

async function pedir(ruta, opciones = {}) {
  const r = await fetch(API + ruta, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(opciones.headers || {}) },
    ...opciones,
  });
  let j = null;
  try { j = await r.json(); } catch {}
  if (!r.ok && !j) return { data: null, error: { message: `HTTP ${r.status}`, status: r.status } };
  return { httpOk: r.ok, status: r.status, ...(j || {}) };
}

// La API devuelve el error como texto plano en los 401/403 y como objeto en los
// errores de consulta. La app siempre lee `error.message`, así que unificamos acá:
// si no, un "sin sesión" o un "tu rol no puede…" llegaba como `undefined` a la pantalla.
function normalizarError(err) {
  if (!err) return null;
  if (typeof err === 'string') return { message: err };
  return err.message ? err : { message: String(err.message ?? err) };
}

// ── Constructor de consultas ────────────────────────────────────────────────
class Consulta {
  constructor(tabla) {
    this.d = { tabla, accion: 'select', columnas: '*', filtros: [], orden: [] };
  }
  // — acciones —
  select(columnas = '*') {
    // .insert(...).select() no cambia la acción: solo pide las filas de vuelta.
    if (this.d.accion === 'select') this.d.columnas = columnas;
    return this;
  }
  insert(valores)  { this.d.accion = 'insert'; this.d.valores = valores; return this; }
  update(valores)  { this.d.accion = 'update'; this.d.valores = valores; return this; }
  delete()         { this.d.accion = 'delete'; return this; }
  upsert(valores, opts = {}) {
    this.d.accion = 'upsert'; this.d.valores = valores;
    if (opts.onConflict) this.d.onConflict = opts.onConflict;
    return this;
  }
  // — filtros —
  eq(col, val)   { this.d.filtros.push({ op: 'eq', col, val }); return this; }
  neq(col, val)  { this.d.filtros.push({ op: 'neq', col, val }); return this; }
  gt(col, val)   { this.d.filtros.push({ op: 'gt', col, val }); return this; }
  gte(col, val)  { this.d.filtros.push({ op: 'gte', col, val }); return this; }
  lt(col, val)   { this.d.filtros.push({ op: 'lt', col, val }); return this; }
  lte(col, val)  { this.d.filtros.push({ op: 'lte', col, val }); return this; }
  like(col, val) { this.d.filtros.push({ op: 'like', col, val }); return this; }
  ilike(col, val){ this.d.filtros.push({ op: 'ilike', col, val }); return this; }
  is(col, val)   { this.d.filtros.push({ op: 'is', col, val }); return this; }
  in(col, val)   { this.d.filtros.push({ op: 'in', col, val }); return this; }
  contains(col, val) { this.d.filtros.push({ op: 'contains', col, val }); return this; }
  not(col, subOp, val) { this.d.filtros.push({ op: 'not', col, subOp, val }); return this; }
  or(expr)       { this.d.filtros.push({ op: 'or', val: expr }); return this; }
  match(obj)     { for (const [c, v] of Object.entries(obj || {})) this.eq(c, v); return this; }
  // .filter(col, 'eq', v) — forma larga de PostgREST
  filter(col, op, val) {
    if (op === 'in' && typeof val === 'string') {
      val = val.replace(/^\(|\)$/g, '').split(',').map(s => s.trim().replace(/^"|"$/g, ''));
    }
    this.d.filtros.push({ op, col, val });
    return this;
  }
  // — forma del resultado —
  order(col, opts = {}) { this.d.orden.push({ col, ascending: opts.ascending !== false, nullsFirst: opts.nullsFirst }); return this; }
  limit(n)        { this.d.limite = n; return this; }
  range(desde, hasta) { this.d.offset = desde; this.d.limite = hasta - desde + 1; return this; }
  single()        { this.d.single = true; return this; }
  maybeSingle()   { this.d.maybeSingle = true; return this; }

  // Thenable: `await consulta` dispara el fetch, igual que supabase-js.
  then(resolve, reject) {
    return pedir('/q', { method: 'POST', body: JSON.stringify(this.d) })
      .then(r => resolve({ data: r.data ?? null, error: normalizarError(r.error) }))
      .catch(e => resolve({ data: null, error: { message: e.message || String(e) } }));
  }
  catch(fn) { return this.then(x => x).catch(fn); }
}

// ── Auth ────────────────────────────────────────────────────────────────────
let _usuarioCache;

const auth = {
  async signInWithPassword({ email, password }) {
    const r = await pedir('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    if (r.error || !r.user) { _usuarioCache = null; return { data: null, error: { message: r.error || 'No se pudo iniciar sesión' } }; }
    _usuarioCache = r.user;
    return { data: { user: r.user, session: { user: r.user } }, error: null };
  },
  async signOut() {
    _usuarioCache = null;
    await pedir('/auth/logout', { method: 'POST' });
    return { error: null };
  },
  async getUser() {
    if (_usuarioCache !== undefined) return { data: { user: _usuarioCache }, error: null };
    const r = await pedir('/auth/me');
    _usuarioCache = r.user ?? null;
    return { data: { user: _usuarioCache }, error: null };
  },
  async getSession() {
    const { data } = await auth.getUser();
    return { data: { session: data.user ? { user: data.user } : null }, error: null };
  },
  async updateUser({ password }) {
    const r = await pedir('/auth/password', { method: 'POST', body: JSON.stringify({ actual: arguments[0]?.actual || '', nueva: password }) });
    return r.error ? { data: null, error: { message: r.error } } : { data: { ok: true }, error: null };
  },
  onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
};

// ── Storage ─────────────────────────────────────────────────────────────────
// Antes: bucket público `adjuntos` de Supabase. Ahora: volumen del servicio en
// Railway, servido en /adjuntos/<ruta>.
function storageBucket() {
  return {
    async upload(ruta, archivo) {
      const r = await fetch(API + '/upload', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': archivo?.type || 'application/octet-stream',
          'X-Nombre-Archivo': encodeURIComponent(archivo?.name || ruta.split('/').pop() || 'archivo').replace(/%/g, '_'),
          'X-Card-Id': String(ruta).split('/')[0] || 'varios',
        },
        body: archivo,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) return { data: null, error: { message: j.error || `HTTP ${r.status}` } };
      _ultimaSubida.set(ruta, j.url);
      return { data: { path: j.path }, error: null };
    },
    getPublicUrl(ruta) {
      return { data: { publicUrl: _ultimaSubida.get(ruta) || ('/adjuntos/' + String(ruta).replace(/^\/+/, '')) } };
    },
    async remove(rutas) {
      for (const p of (Array.isArray(rutas) ? rutas : [rutas])) {
        await pedir('/upload/borrar', { method: 'POST', body: JSON.stringify({ path: p }) });
      }
      return { data: null, error: null };
    },
  };
}
// `upload` devuelve la ruta y después el código pide `getPublicUrl(path)`; guardamos
// la URL real que resolvió el servidor para no tener que recalcularla.
const _ultimaSubida = new Map();

// ── Cliente ─────────────────────────────────────────────────────────────────
const cliente = {
  from: (tabla) => new Consulta(tabla),
  auth,
  storage: { from: storageBucket },
};

export function getSupa() { return cliente; }
export function supaConfigured() { return true; }
export const api = { pedir };
