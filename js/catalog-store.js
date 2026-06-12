// Acceso compartido al catálogo persistido en localStorage (`cirene_catalog_v3`).
// Mismo formato que el cotizador (index.html), así ambas páginas comparten datos.
//
// Shape:
//   {
//     productos: [{ id, n, k, precio, notes, imgs[], colors[], views{}, sizeGuideKey, pros[], ... }],
//     tarifas:   [{ tecnica, tiers: [{min, max, precio, setup}] }]
//   }

const CATALOG_KEY = 'cirene_catalog_v3';
const CATALOG_TS_KEY = 'cirene_catalog_v3_at';

// Normaliza tarifas legacy ({t,u,c}) al shape moderno ({tecnica, tiers:[...]}).
// El cotizador antiguo (index.html) guardaba filas planas; el editor moderno
// espera grupos por técnica con tiers. Sin esta migración, abrir catalog.html
// después de un reset/import legacy no muestra las técnicas. Idempotente.
function migrateTarifasShape(arr) {
  if (!Array.isArray(arr) || !arr.length) return [];
  const hasLegacy = arr.some(r => r && r.t !== undefined && r.tecnica === undefined);
  if (!hasLegacy) return arr;
  const byTec = new Map();
  arr.forEach(r => {
    if (!r) return;
    if (r.tecnica !== undefined && Array.isArray(r.tiers)) {
      if (!byTec.has(r.tecnica)) byTec.set(r.tecnica, { tecnica: r.tecnica, tiers: [] });
      r.tiers.forEach(t => byTec.get(r.tecnica).tiers.push({ ...t }));
      return;
    }
    if (r.t !== undefined) {
      const key = String(r.t || '');
      if (!byTec.has(key)) byTec.set(key, { tecnica: key, tiers: [] });
      byTec.get(key).tiers.push({
        min: Number(r.min) || 0,
        max: Number(r.max) || 0,
        precio: Number(r.c) || 0,
        setup: Number(r.setup) || 0,
        ubicacion: r.u || '',
      });
    }
  });
  return [...byTec.values()];
}

export function loadCatalog() {
  const stored = localStorage.getItem(CATALOG_KEY);
  if (stored) {
    try {
      const p = JSON.parse(stored);
      return {
        productos: Array.isArray(p.productos) ? p.productos : [],
        tarifas:   migrateTarifasShape(Array.isArray(p.tarifas) ? p.tarifas : []),
      };
    } catch (e) {
      console.warn('[catalog-store] JSON inválido en localStorage:', e.message);
    }
  }
  return { productos: [], tarifas: [] };
}

// Debounce del push a Supabase. Sin esto, mover múltiples campos seguidos
// dispararía N requests. 1.5s alcanza para agrupar rachas típicas de edición.
let _supaPushTimer = null;
let _pendingSync = false;  // true desde saveCatalog() hasta que Supabase confirma

export function hasPendingSync() { return _pendingSync; }

function _scheduleSupabasePush(productos, tarifas) {
  _pendingSync = true;
  window.dispatchEvent(new CustomEvent('cirene:catalog-sync-pending'));
  if (_supaPushTimer) clearTimeout(_supaPushTimer);
  _supaPushTimer = setTimeout(async () => {
    _supaPushTimer = null;
    const ok = await syncCatalogToSupabase(productos, tarifas);
    _pendingSync = false;
    window.dispatchEvent(new CustomEvent(ok ? 'cirene:catalog-sync-done' : 'cirene:catalog-sync-error'));
  }, 1500);
}

export function saveCatalog(productos, tarifas) {
  try {
    localStorage.setItem(CATALOG_KEY, JSON.stringify({ productos, tarifas }));
    localStorage.setItem(CATALOG_TS_KEY, new Date().toISOString());
    window.dispatchEvent(new CustomEvent('cirene:catalog-saved', {
      detail: { productos, tarifas },
    }));
    _scheduleSupabasePush(productos, tarifas);
    return true;
  } catch (e) {
    console.error('[catalog-store] save falló:', e.message);
    return false;
  }
}

// Cancela el debounce y escribe a Supabase de inmediato.
// Usado por el beforeunload para no perder el último cambio si el usuario sale.
export async function flushCatalogToSupabase() {
  if (_supaPushTimer) { clearTimeout(_supaPushTimer); _supaPushTimer = null; }
  if (!_pendingSync) return true;
  const stored = localStorage.getItem(CATALOG_KEY);
  if (!stored) return false;
  try {
    const { productos, tarifas } = JSON.parse(stored);
    return await syncCatalogToSupabase(productos, tarifas);
  } catch { return false; }
}

// Sube el catálogo entero a Supabase (tabla catalog_v1, id='main').
// Falla silenciosa: si Supabase no está disponible, queda solo en localStorage.
export async function syncCatalogToSupabase(productos, tarifas) {
  try {
    const { getSupa } = await import('./supa.js?v=2');
    const supa = getSupa();
    const payload = {
      id: 'main',
      data: { productos, tarifas },
      updated_at: new Date().toISOString(),
    };
    const { error } = await supa.from('catalog_v1').upsert(payload, { onConflict: 'id' });
    if (error) throw error;
    localStorage.setItem(CATALOG_TS_KEY, payload.updated_at);
    return true;
  } catch (e) {
    console.warn('[catalog-store] sync a Supabase falló:', e.message);
    return false;
  }
}

// Hidrata localStorage desde Supabase si el remoto es más reciente que la
// versión local (o si localStorage está vacío). Devuelve true si trajo algo.
// Soluciona dos casos:
//   - Dispositivo nuevo: localStorage vacío → trae todo.
//   - Catálogo enriquecido offline (script tools/enrich-catalog) que tocó Supabase:
//     trae los cambios sin pisar localStorage solo porque "ya tenía timestamp".
export async function bootstrapCatalogFromSupabase({ timeoutMs = 4000 } = {}) {
  try {
    const { getSupa } = await import('./supa.js?v=2');
    const supa = getSupa();
    const fetchPromise = supa.from('catalog_v1').select('data, updated_at').eq('id', 'main').maybeSingle();
    const { data, error } = await Promise.race([
      fetchPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
    if (error) throw error;
    if (!data || !data.data) return false;
    const productos = Array.isArray(data.data.productos) ? data.data.productos : [];
    let tarifas = Array.isArray(data.data.tarifas) ? data.data.tarifas : [];
    if (!productos.length && !tarifas.length) return false;
    // Comparar timestamps: si el local es igual o más nuevo, no tocamos.
    const localTs = localStorage.getItem(CATALOG_TS_KEY);
    const remoteTs = data.updated_at;
    if (localTs && remoteTs && new Date(localTs) >= new Date(remoteTs)) return false;
    // Si el remoto no trae técnicas pero localmente SÍ hay, conservamos las
    // locales (el remoto pudo haber sido pisado por un import/script).
    if (!tarifas.length) {
      try {
        const prev = JSON.parse(localStorage.getItem(CATALOG_KEY) || '{}');
        if (Array.isArray(prev.tarifas) && prev.tarifas.length) tarifas = prev.tarifas;
      } catch {}
    }
    localStorage.setItem(CATALOG_KEY, JSON.stringify({ productos, tarifas }));
    localStorage.setItem(CATALOG_TS_KEY, remoteTs || new Date().toISOString());
    return true;
  } catch (e) {
    console.warn('[catalog-store] bootstrap desde Supabase falló:', e.message);
    return false;
  }
}

// Asegurar que cada producto tenga los campos del modelo actual (idempotente).
//
// IMPORTANTE: el cotizador (index.html) lee el costo de `p.c`, pero el editor
// del catálogo (catalog.html) usa `p.precio`. Acá los mantenemos en sync —
// el que tenga valor > 0 manda; si los dos existen, gana `c` (legacy del cotizador
// que tiene 518 productos pre-cargados con costos reales).
export function migrateProduct(p, i = 0) {
  if (!p.id) p.id = 'p_' + i + '_' + (p.n || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
  if (!Array.isArray(p.imgs)) p.imgs = [];
  if (!Array.isArray(p.colors)) p.colors = [];
  if (!Array.isArray(p.pros)) p.pros = [];
  if (typeof p.notes !== 'string') p.notes = '';
  if (typeof p.k !== 'string') p.k = p.categoria || '';
  if (typeof p.n !== 'string') p.n = '';
  // Campos enriquecidos (tools/enrich-catalog). Defaults para que la UI no rompa.
  if (typeof p.sizeGuideText !== 'string') p.sizeGuideText = '';
  if (!p.colorImages || typeof p.colorImages !== 'object') p.colorImages = {};
  if (typeof p.mainImage !== 'string') p.mainImage = '';
  if (typeof p.sizeGuideImage !== 'string') p.sizeGuideImage = '';
  if (p.sizeGuide && typeof p.sizeGuide !== 'object') p.sizeGuide = null;
  if (p.sizeGuide === undefined) p.sizeGuide = null;

  // Sincronizar precio ↔ c (ambos son "costo"). Sin esto, productos importados
  // desde Odoo (que solo tienen `precio`) muestran NaN en el cotizador que lee `c`.
  const fromC = Number(p.c);
  const fromPrecio = Number(p.precio);
  const validC = !isNaN(fromC) && fromC > 0;
  const validPrecio = !isNaN(fromPrecio) && fromPrecio > 0;
  if (validC && !validPrecio)        p.precio = fromC;
  else if (validPrecio && !validC)   p.c = fromPrecio;
  else if (validC && validPrecio) {
    // ambos > 0: prefiero `c` (catálogo legacy) y sincronizo precio
    p.precio = fromC;
  } else {
    // ninguno válido: ambos en 0
    p.c = 0;
    p.precio = 0;
  }
  return p;
}

export function migrateAllProducts(productos) {
  return productos.map((p, i) => migrateProduct(p, i));
}

export function newProductId(name) {
  const slug = (name || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20).toLowerCase() || 'item';
  return `p_${Date.now()}_${slug}`;
}

export function newImageKey(productId, kind = 'img') {
  return `${productId}_${kind}_${Date.now().toString(36)}`;
}

// (#T4) Busca un producto del catálogo por nombre (case-insensitive, trim).
// Devuelve null si no encuentra. No carga el catálogo si ya está cacheado en
// localStorage (loadCatalog es síncrono).
export function findProductByName(name) {
  if (!name) return null;
  const target = String(name).toLowerCase().trim();
  if (!target) return null;
  const cat = loadCatalog();
  return cat.productos.find(p => String(p.n || '').toLowerCase().trim() === target) || null;
}

// (#T4) Resuelve la URL de la miniatura de un producto del catálogo.
// Prioridad: colorImages[color][0] → mainImage → primera de colorImages → null.
// Útil para mostrar thumb en líneas de producción y otros listados.
export function productThumb(name, color) {
  const p = findProductByName(name);
  if (!p) return null;
  if (color && p.colorImages && Array.isArray(p.colorImages[color]) && p.colorImages[color][0]) {
    return p.colorImages[color][0];
  }
  if (p.mainImage) return p.mainImage;
  if (p.colorImages) {
    const first = Object.values(p.colorImages).flat().filter(Boolean)[0];
    if (first) return first;
  }
  return null;
}
