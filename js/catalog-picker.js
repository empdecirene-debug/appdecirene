// (#6) Picker compartido del catálogo, con miniaturas.
//
// Antes: production.html usaba un <input list="catalog-dl"> (datalist) sin
// imágenes; intake.html tenía su propia implementación de modal con
// miniaturas que solo leía `imgs[0]` de IndexedDB (los productos
// enriquecidos por el scraper viven con `mainImage` / `colorImages` y NO
// tienen imgs locales → se veían sin imagen).
//
// Este módulo unifica ambos. Resuelve la miniatura por prioridad:
//   1. p.mainImage                                   (URL remota proveedor)
//   2. primera URL de p.colorImages                  (idem)
//   3. p.imgs[0] desde IndexedDB                     (local)
//
// API:
//   openCatalogPicker({ onPick, initialQuery, title })
//     onPick({ id, n, c, k, prod })  ← prod es el producto entero
//   closeCatalogPicker()
//
// Aporta su propio mount (#glnCatalogPickerMount) y se cierra solo al elegir
// o con la X / Escape / click fuera. No requiere que la página tenga ningún
// elemento previo.

import { loadCatalog } from './catalog-store.js?v=3';
import { getImage } from './image-store.js?v=3';

const STATE = {
  open: false,
  query: '',
  onPick: null,
  catalog: [],
};
let _root = null;
let _esc = (s) => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function _ensureMount() {
  let m = document.getElementById('glnCatalogPickerMount');
  if (!m) {
    m = document.createElement('div');
    m.id = 'glnCatalogPickerMount';
    document.body.appendChild(m);
  }
  return m;
}

function _thumbUrl(p) {
  if (p.mainImage) return p.mainImage;
  if (p.colorImages) {
    const first = Object.values(p.colorImages).flat().filter(Boolean)[0];
    if (first) return first;
  }
  return null;
}

export function closeCatalogPicker() {
  STATE.open = false;
  STATE.onPick = null;
  STATE.query = '';
  const m = _ensureMount();
  m.innerHTML = '';
  document.removeEventListener('keydown', _onKey);
}

function _onKey(e) {
  if (e.key === 'Escape' && STATE.open) closeCatalogPicker();
}

export function openCatalogPicker({ onPick, initialQuery = '', title = 'Elegí producto' } = {}) {
  if (typeof onPick !== 'function') throw new Error('openCatalogPicker: onPick callback es obligatorio');
  const cat = loadCatalog();
  STATE.catalog = (cat.productos || []).filter(p => p && p.n);
  STATE.onPick = onPick;
  STATE.query = initialQuery || '';
  STATE.open = true;

  _root = _ensureMount();
  _root.innerHTML = `
    <div id="glnCpBg" style="position:fixed;inset:0;background:rgba(0, 0, 0,.55);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px">
      <div id="glnCpBox" onclick="event.stopPropagation()" style="background:#fff;border-radius:14px;width:100%;max-width:980px;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0, 0, 0,.2);font-family:inherit;color:#14161A">
        <div style="display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid #E2E2E0">
          <h2 style="font-size:17px;margin:0;white-space:nowrap;font-family:inherit">${_esc(title)}</h2>
          <input id="glnCpSearch" placeholder="Buscar por nombre o categoría…" value="${_esc(STATE.query)}"
            style="flex:1;padding:8px 12px;border:1px solid #E2E2E0;border-radius:8px;font-family:inherit;font-size:13px;color:inherit" />
          <button id="glnCpClose" style="background:none;border:none;font-size:22px;cursor:pointer;color:#5A5F66;padding:2px 8px;line-height:1">✕</button>
        </div>
        <div id="glnCpGrid" style="padding:14px 18px;overflow-y:auto;flex:1;background:#FAFAFA"></div>
      </div>
    </div>
  `;
  document.getElementById('glnCpBg').onclick = (e) => { if (e.target === e.currentTarget) closeCatalogPicker(); };
  document.getElementById('glnCpClose').onclick = closeCatalogPicker;
  const search = document.getElementById('glnCpSearch');
  search.oninput = (e) => { STATE.query = e.target.value; _renderGrid(); };
  search.focus();
  document.addEventListener('keydown', _onKey);
  _renderGrid();
}

function _renderGrid() {
  const grid = document.getElementById('glnCpGrid');
  if (!grid) return;
  const q = (STATE.query || '').trim().toLowerCase();
  let products = STATE.catalog;
  if (q) {
    products = products.filter(p =>
      (p.n || '').toLowerCase().includes(q) ||
      (p.k || '').toLowerCase().includes(q) ||
      (p.id || '').toLowerCase().includes(q)
    );
  }
  products = products.slice(0, 120);

  if (!STATE.catalog.length) {
    grid.innerHTML = `<div style="padding:40px 20px;text-align:center;color:#5A5F66">
      El catálogo está vacío en este navegador. Abrí <a href="/catalog.html" style="color:#0A0A0A;font-weight:600">Catálogo</a> y sincronizá.
    </div>`;
    return;
  }
  if (!products.length) {
    grid.innerHTML = `<div style="padding:40px 20px;text-align:center;color:#5A5F66">Sin productos que coincidan con "${_esc(q)}".</div>`;
    return;
  }

  grid.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px">
      ${products.map(p => {
        const price = Number(p.c) || Number(p.precio) || 0;
        const remote = _thumbUrl(p);
        const localKey = (p.imgs && p.imgs[0]) || '';
        return `
          <div data-cp-pid="${_esc(p.id || '')}"
            style="border:1px solid #E2E2E0;border-radius:10px;padding:8px;cursor:pointer;background:#fff;transition:all .15s;display:flex;flex-direction:column;gap:6px"
            onmouseover="this.style.borderColor='#0A0A0A';this.style.boxShadow='0 4px 12px rgba(0, 0, 0,.10)';this.style.transform='translateY(-1px)'"
            onmouseout="this.style.borderColor='#E2E2E0';this.style.boxShadow='none';this.style.transform='none'">
            <div data-cp-thumb="${_esc(p.id || '')}" data-cp-localkey="${_esc(localKey)}"
              style="aspect-ratio:1;background:#FAFAFA ${remote ? `url('${_esc(remote)}')` : ''} center/contain no-repeat;border-radius:6px;display:flex;align-items:center;justify-content:center;overflow:hidden;color:#9AA0A6;font-size:24px">
              ${remote ? '' : (localKey ? '<div style="font-size:11px">…</div>' : '<div>⊟</div>')}
            </div>
            <div style="font-size:12px;font-weight:600;line-height:1.3;color:#14161A;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;min-height:31px">${_esc(p.n)}</div>
            <div style="display:flex;justify-content:space-between;align-items:center;font-size:11px">
              <span style="color:#9AA0A6">${_esc(p.k || '—')}</span>
              <span style="color:#0A0A0A;font-weight:700">$${price.toLocaleString('es-UY')}</span>
            </div>
          </div>`;
      }).join('')}
    </div>
  `;

  grid.querySelectorAll('[data-cp-pid]').forEach(card => {
    card.onclick = () => {
      const pid = card.dataset.cpPid;
      const prod = STATE.catalog.find(p => p.id === pid);
      if (!prod) return;
      const cb = STATE.onPick;
      const payload = {
        id: prod.id, n: prod.n, k: prod.k,
        c: Number(prod.c) || Number(prod.precio) || 0,
        prod,
      };
      closeCatalogPicker();
      try { cb && cb(payload); } catch (e) { console.error('[catalog-picker] onPick falló:', e); }
    };
  });

  // Cargar miniaturas locales (IndexedDB) si no hay remota.
  grid.querySelectorAll('[data-cp-thumb][data-cp-localkey]').forEach(async el => {
    if (el.style.backgroundImage) return;
    const k = el.dataset.cpLocalkey;
    if (!k) return;
    try {
      const dataUrl = await getImage(k);
      if (dataUrl) {
        el.style.backgroundImage = `url("${dataUrl}")`;
        el.style.backgroundPosition = 'center';
        el.style.backgroundSize = 'contain';
        el.style.backgroundRepeat = 'no-repeat';
        el.innerHTML = '';
      }
    } catch {}
  });
}
