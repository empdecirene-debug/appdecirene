// Página standalone del catálogo. Reusa el mismo localStorage (`cirene_catalog_v3`) e
// IndexedDB (`cirene_db_v1`) que el cotizador, así ambos comparten datos en tiempo real.
//
// Vistas:
//   - Productos: grid + modal de edición con imagen + colores + guía de talles
//   - Tarifas: lista de técnicas con tiers por cantidad
//   - Sync Odoo: estado + push completo + zona peligrosa (wipe + push)

import { renderNavbar } from './navbar.js';
import { requireAuth } from './auth.js';
import { getImage, setImage, delImage, compressImage, dataUrlToBase64 } from './image-store.js';
import { loadCatalog, saveCatalog, flushCatalogToSupabase, hasPendingSync, bootstrapCatalogFromSupabase, migrateAllProducts, newProductId, newImageKey } from './catalog-store.js';
import { pushProductFull, archiveAllProducts, listAllProducts, upsertProductFromCatalog } from './odoo-client.js';

// saveCatalog empuja a Supabase con debounce (catalog-store.js).
// Los eventos cirene:catalog-sync-* actualizan el indicador de estado en el header.

const $ = id => document.getElementById(id);
const esc = s => (s || '').toString().replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const ODOO_MAP_KEY = 'cirene_odoo_product_map_v1';
const loadOdooMap = () => { try { return JSON.parse(localStorage.getItem(ODOO_MAP_KEY) || '{}'); } catch { return {}; } };
const saveOdooMap = (m) => { try { localStorage.setItem(ODOO_MAP_KEY, JSON.stringify(m)); } catch {} };

const state = {
  productos: [],
  tarifas: [],
  subtab: 'prods',
  search: '',
  editing: null,   // producto en edición (deep copy)
  editIdx: -1,     // -1 = nuevo
};

// ─── INIT ──────────────────────────────────────────────────
(async function init() {
  await requireAuth();
  renderNavbar('catalog');

  // Bootstrap: hidrata desde Supabase si es un dispositivo nuevo.
  await bootstrapCatalogFromSupabase();

  const cat = loadCatalog();
  state.productos = migrateAllProducts(cat.productos);
  state.tarifas = cat.tarifas || [];
  // NO persistimos la migración al cargar. Eso disparaba un push a Supabase
  // que pisaba enrichments hechos por el script offline (tools/enrich-catalog).
  // saveCatalog solo se llama después de cambios reales del usuario.

  bindUI();
  renderProductos();
  renderTarifas();
  updateSyncStats();
  _installSaveGuard();
})();

function _setSaveIndicator(state) {
  const el = document.getElementById('saveStatus');
  if (!el) return;
  if (window._saveStatusTimer) { clearTimeout(window._saveStatusTimer); window._saveStatusTimer = null; }
  if (state === 'pending') {
    el.innerHTML = '<span class="saving-pill">guardando…</span>';
  } else if (state === 'saved') {
    el.innerHTML = '<span class="saved-pill">guardado ✓</span>';
    window._saveStatusTimer = setTimeout(() => { el.innerHTML = ''; }, 2500);
  } else if (state === 'error') {
    el.innerHTML = '<span class="save-error-pill">⚠ error al guardar</span>';
  } else {
    el.innerHTML = '';
  }
}

function _installSaveGuard() {
  window.addEventListener('cirene:catalog-sync-pending', () => _setSaveIndicator('pending'));
  window.addEventListener('cirene:catalog-sync-done',    () => _setSaveIndicator('saved'));
  window.addEventListener('cirene:catalog-sync-error',   () => {
    _setSaveIndicator('error');
    // Toast si el navegador tiene la función (catalog.html tiene su propio toast)
    const t = document.getElementById('toast');
    if (t) { t.textContent = '⚠ No se pudo guardar en la nube. Revisá tu conexión.'; t.className = 'toast error show'; setTimeout(() => { t.className = 'toast'; }, 4000); }
  });
  window.addEventListener('beforeunload', (e) => {
    if (!hasPendingSync()) return;
    // Flush inmediato: cancela el debounce y empieza el push ahora
    flushCatalogToSupabase();
    e.preventDefault();
    e.returnValue = '';
  });
}

function bindUI() {
  // Subtabs
  document.querySelectorAll('#subtabs button').forEach(b => {
    b.onclick = () => {
      state.subtab = b.dataset.subtab;
      document.querySelectorAll('#subtabs button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      $('paneProds').style.display = state.subtab === 'prods' ? '' : 'none';
      $('paneTarifas').style.display = state.subtab === 'tarifas' ? '' : 'none';
      $('paneSync').style.display = state.subtab === 'sync' ? '' : 'none';
      if (state.subtab === 'sync') updateSyncStats();
    };
  });

  $('search').oninput = (e) => {
    state.search = e.target.value.toLowerCase().trim();
    renderProductos();
  };

  $('btnNew').onclick = () => openEditor(-1);
  $('btnAddTarifa').onclick = addTarifa;

  $('btnPushAll').onclick = onPushAll;
  $('btnRefreshOdoo').onclick = updateSyncStats;
  $('btnImportOdoo').onclick = onImportOdoo;
  $('btnWipePush').onclick = onWipeAndPush;
}

// ─── PRODUCTOS ─────────────────────────────────────────────
async function renderProductos() {
  const grid = $('prodGrid');
  const q = state.search;
  const list = q
    ? state.productos.filter(p =>
        (p.n || '').toLowerCase().includes(q) ||
        (p.k || '').toLowerCase().includes(q))
    : state.productos;

  if (!list.length) {
    grid.innerHTML = `<div class="cirene-alert info">No hay productos${q ? ' que matcheen "' + esc(q) + '"' : ''}. Crea uno con <b>+ Nuevo producto</b>.</div>`;
    return;
  }

  const map = loadOdooMap();
  grid.innerHTML = list.map((p, _idx) => {
    const realIdx = state.productos.indexOf(p);
    const thumbKey = (p.imgs && p.imgs[0]) || p.views?.front || null;
    // Imagen remota de fallback (proveedor): mainImage o primera de colorImages.
    const remoteThumb = !thumbKey
      ? (p.mainImage || (p.colorImages && Object.values(p.colorImages).flat()[0]) || '')
      : '';
    const inOdoo = !!map[p.id];
    return `
      <div class="prod-card" data-idx="${realIdx}">
        <div class="prod-thumb" data-thumb-key="${esc(thumbKey || '')}">
          ${thumbKey
            ? '<div class="prod-thumb-placeholder">…</div>'
            : (remoteThumb
                ? `<img src="${esc(remoteThumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'">`
                : '<div class="prod-thumb-placeholder">⊟</div>')}
        </div>
        <div class="prod-name">${esc(p.n || 'Sin nombre')}</div>
        <div class="prod-meta">
          <span>${esc(p.k || '—')}</span>
          <span class="prod-price">$${Number(p.precio || 0).toLocaleString('es-UY')}</span>
        </div>
        ${inOdoo ? '<div class="prod-odoo-badge">✓ en Odoo</div>' : ''}
      </div>
    `;
  }).join('');

  // Click → editor
  grid.querySelectorAll('.prod-card').forEach(card => {
    card.onclick = () => openEditor(parseInt(card.dataset.idx));
  });

  // Cargar thumbs async desde IndexedDB
  grid.querySelectorAll('.prod-thumb[data-thumb-key]').forEach(async (el) => {
    const k = el.dataset.thumbKey;
    if (!k) return;
    try {
      const dataUrl = await getImage(k);
      if (dataUrl) el.innerHTML = `<img src="${dataUrl}" alt="">`;
    } catch (e) { /* sin imagen, queda el placeholder */ }
  });
}

// ─── MODAL EDITOR ──────────────────────────────────────────
function openEditor(idx) {
  state.editIdx = idx;
  if (idx === -1) {
    state.editing = {
      id: '', n: '', k: '', precio: 0, c: 0, notes: '', imgs: [], colors: [], pros: [], sizeGuideKey: '',
      colorImages: {}, sizeGuideText: '', mainImage: '', datasheetUrl: '', sizeGuide: null, sizeGuideImage: '',
    };
  } else {
    // deep copy para poder cancelar
    state.editing = JSON.parse(JSON.stringify(state.productos[idx]));
    if (!state.editing.colorImages || typeof state.editing.colorImages !== 'object') state.editing.colorImages = {};
    if (typeof state.editing.sizeGuideText !== 'string') state.editing.sizeGuideText = '';
    if (typeof state.editing.mainImage !== 'string') state.editing.mainImage = '';
    if (typeof state.editing.sizeGuideImage !== 'string') state.editing.sizeGuideImage = '';
    if (typeof state.editing.datasheetUrl !== 'string') state.editing.datasheetUrl = '';
    if (state.editing.sizeGuide && typeof state.editing.sizeGuide !== 'object') state.editing.sizeGuide = null;
  }
  renderEditor();
}

function closeEditor() {
  state.editing = null;
  $('modalMount').innerHTML = '';
}

function renderEditor() {
  const p = state.editing;
  if (!p) { $('modalMount').innerHTML = ''; return; }

  $('modalMount').innerHTML = `
    <div class="modal-bg" id="modalBg">
      <div class="modal" id="modal">
        <div class="modal-hdr">
          <h2>${state.editIdx === -1 ? 'Nuevo producto' : 'Editar producto'}</h2>
          <button class="cirene-btn cirene-btn-ghost cirene-btn-sm" id="btnClose">✕</button>
        </div>

        <div class="modal-body">
          <div class="cirene-row2">
            <div class="cirene-fg">
              <label class="cirene-label">Nombre</label>
              <input class="cirene-input" id="f_n" value="${esc(p.n)}" placeholder="Ej: Chomba piqué"/>
            </div>
            <div class="cirene-row2" style="display:grid">
              <div class="cirene-fg">
                <label class="cirene-label">Categoría</label>
                <input class="cirene-input" id="f_k" value="${esc(p.k)}" placeholder="Ej: Chombas"/>
              </div>
              <div class="cirene-fg">
                <label class="cirene-label">Precio (UYU)</label>
                <input class="cirene-input" id="f_precio" type="number" value="${Number(p.precio) || 0}"/>
              </div>
            </div>
          </div>

          <div class="cirene-fg">
            <label class="cirene-label">Imágenes del producto</label>
            <div class="img-row" id="imgRow"></div>
            <input type="file" id="imgInput" accept="image/*" multiple style="display:none"/>
            <div class="cirene-hint">Hacé click en el cuadrado punteado para agregar imágenes. La primera se usa como principal en Odoo.</div>
          </div>

          <div class="cirene-fg">
            <label class="cirene-label">Guía de talles</label>
            <div id="sizeGuideRow"></div>
            <input type="file" id="sizeGuideInput" accept="image/*" style="display:none"/>
          </div>

          <div class="cirene-fg">
            <label class="cirene-label">Colores disponibles</label>
            <div id="colorList"></div>
            <div style="display:flex; gap:6px; align-items:center; margin-top:6px;">
              <input class="cirene-input" id="newColorName" placeholder="Nombre (ej: Rojo)" style="flex:1"/>
              <input type="color" id="newColorHex" value="#0A0A0A" style="width:36px; height:36px; border:1px solid var(--border); border-radius:var(--r); cursor:pointer"/>
              <button class="cirene-btn cirene-btn-sm" id="btnAddColor">+ Agregar</button>
            </div>
          </div>

          <div class="cirene-fg">
            <label class="cirene-label">Características</label>
            <div class="tag-list" id="prosList"></div>
            <div style="display:flex; gap:6px; margin-top:6px;">
              <input class="cirene-input" id="newPro" placeholder="Ej: 100% algodón" style="flex:1"/>
              <button class="cirene-btn cirene-btn-sm" id="btnAddPro">+ Agregar</button>
            </div>
          </div>

          <div class="cirene-fg">
            <label class="cirene-label">Notas / Descripción larga</label>
            <textarea class="cirene-textarea" id="f_notes" rows="5" placeholder="Detalles, certificaciones, etc.">${esc(p.notes)}</textarea>
          </div>
        </div>

        <div class="modal-ftr">
          ${state.editIdx !== -1 ? '<button class="cirene-btn cirene-btn-danger" id="btnDelete">Eliminar producto</button>' : ''}
          <div class="cirene-spacer"></div>
          <button class="cirene-btn cirene-btn-ghost" id="btnCancel">Cancelar</button>
          <button class="cirene-btn cirene-btn-primary" id="btnSave">Guardar</button>
        </div>
      </div>
    </div>
  `;

  $('btnClose').onclick = closeEditor;
  $('btnCancel').onclick = closeEditor;
  $('modalBg').onclick = (e) => { if (e.target.id === 'modalBg') closeEditor(); };
  $('btnSave').onclick = saveEditor;
  if ($('btnDelete')) $('btnDelete').onclick = deleteEditor;

  renderImages();
  renderSizeGuide();
  renderColors();
  renderPros();

  $('btnAddColor').onclick = () => {
    const name = $('newColorName').value.trim();
    if (!name) return;
    const hex = $('newColorHex').value;
    state.editing.colors.push({ name, hex });
    $('newColorName').value = '';
    renderColors();
  };
  $('btnAddPro').onclick = () => {
    const v = $('newPro').value.trim();
    if (!v) return;
    state.editing.pros.push(v);
    $('newPro').value = '';
    renderPros();
  };

  $('imgInput').onchange = async (e) => {
    const files = Array.from(e.target.files || []);
    for (const f of files) {
      try {
        const dataUrl = await compressImage(f, 1200, 0.85);
        const key = newImageKey(state.editing.id || 'tmp', 'img');
        await setImage(key, dataUrl);
        state.editing.imgs.push(key);
      } catch (err) { console.error('img:', err); }
    }
    renderImages();
  };

  $('sizeGuideInput').onchange = async (e) => {
    const f = (e.target.files || [])[0];
    if (!f) return;
    try {
      const dataUrl = await compressImage(f, 1600, 0.9);
      const key = newImageKey(state.editing.id || 'tmp', 'sizeguide');
      await setImage(key, dataUrl);
      // borrar anterior si existía
      if (state.editing.sizeGuideKey) { try { await delImage(state.editing.sizeGuideKey); } catch {} }
      state.editing.sizeGuideKey = key;
      renderSizeGuide();
    } catch (err) { console.error('sizeGuide:', err); }
  };
}

async function renderImages() {
  const row = $('imgRow'); if (!row) return;
  const keys = state.editing.imgs || [];
  let html = '';
  for (const k of keys) {
    const dataUrl = await getImage(k).catch(() => null);
    html += `<div class="img-thumb">
      ${dataUrl ? `<img src="${dataUrl}" alt="">` : '<div class="prod-thumb-placeholder">⊟</div>'}
      <button class="img-thumb-del" data-imgkey="${esc(k)}">×</button>
    </div>`;
  }
  // Si no hay imágenes locales, mostrar SOLO la imagen principal del proveedor
  // (1 sola). Las imágenes por color van organizadas abajo en "Colores".
  if (!keys.length) {
    const ci = state.editing.colorImages || {};
    const main = state.editing.mainImage || Object.values(ci).flat()[0] || '';
    if (main) {
      html += `<div class="img-thumb">
        <img src="${esc(main)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.opacity=0.25">
      </div>`;
    }
  }
  html += `<div class="img-thumb-add" id="imgAdd">+</div>`;
  row.innerHTML = html;
  row.querySelectorAll('.img-thumb-del').forEach(b => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const k = b.dataset.imgkey;
      state.editing.imgs = state.editing.imgs.filter(x => x !== k);
      try { await delImage(k); } catch {}
      renderImages();
    };
  });
  $('imgAdd').onclick = () => $('imgInput').click();
}

// Parser liviano cliente (espejo de tools/enrich-catalog/lib/sizeguide.mjs).
// Asume texto ya formateado en filas "Etiqueta: v1 v2 …". No reconcilia
// números pegados (eso lo hizo el scraper; si se edita a mano, separar bien).
function parseSizeGuideClient(text) {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const parsed = lines.map(l => {
    const ci = l.indexOf(':');
    const label = (ci >= 0 ? l.slice(0, ci) : l).trim();
    const vals = (ci >= 0 ? l.slice(ci + 1) : '').trim().split(/\s+/).filter(Boolean);
    return { label, vals };
  });
  const hi = parsed.findIndex(p => /^talles?$/i.test(p.label));
  if (hi < 0) return null;
  const headers = parsed[hi].vals;
  if (headers.length < 2) return null;
  const rows = parsed.filter((p, i) => i !== hi && p.vals.length)
    .map(p => ({ label: p.label, values: p.vals }));
  if (!rows.length) return null;
  return { headers, rows, ok: rows.every(r => r.values.length === headers.length) };
}

function sizeGuideTableHtml(sg) {
  if (!sg || !(sg.headers || []).length || !(sg.rows || []).length) return '';
  const th = sg.headers.map(h => `<th style="border:1px solid #cce5f0;padding:3px 6px;background:#01b3da;color:#fff;font-size:11px">${esc(h)}</th>`).join('');
  const trs = sg.rows.map(r => {
    const tds = (r.values || []).map(v => `<td style="border:1px solid #cce5f0;padding:3px 6px;text-align:center;font-size:11px">${esc(v)}</td>`).join('');
    return `<tr><td style="border:1px solid #cce5f0;padding:3px 6px;font-weight:600;font-size:11px">${esc(r.label)}</td>${tds}</tr>`;
  }).join('');
  return `<div style="overflow-x:auto;margin-bottom:8px"><table style="border-collapse:collapse;width:100%">
    <tr><th style="border:1px solid #cce5f0;padding:3px 6px;background:#01b3da;color:#fff;font-size:11px">Talle</th>${th}</tr>
    ${trs}</table></div>`;
}

async function renderSizeGuide() {
  const row = $('sizeGuideRow'); if (!row) return;
  const key = state.editing.sizeGuideKey;
  const sg = state.editing.sizeGuide;
  const txt = state.editing.sizeGuideText || '';
  const sgImg = state.editing.sizeGuideImage || '';

  // Estado + preview de la tabla estructurada (lo que verá el cliente en el PDF).
  let statusBlock = '';
  // Guía de talles como IMAGEN (Famet): preview + se muestra al cliente en el PDF.
  if (sgImg) {
    statusBlock += `<div class="cirene-alert" style="background:#e8f7ee;border:1px solid #aadcbb;color:#1a7a3a;padding:8px 10px;border-radius:6px;margin-bottom:8px;font-size:12px">
      ✓ Guía de talles (imagen del proveedor) — se muestra al cliente en el PDF.
    </div>
    <img src="${esc(sgImg)}" alt="guía de talles" loading="lazy" referrerpolicy="no-referrer"
      style="max-width:100%;border:1px solid var(--border);border-radius:6px;margin-bottom:10px"
      onerror="this.style.opacity=0.25">`;
  }
  if (sg && (sg.headers || []).length) {
    if (sg.needsReview) {
      statusBlock = `<div class="cirene-alert" style="background:#fff8e1;border:1px solid #f0d48a;color:#7a5b00;padding:8px 10px;border-radius:6px;margin-bottom:8px;font-size:12px">
        ⚠ Guía extraída por OCR / no cuadró — <b>NO se muestra al cliente</b> hasta que la apruebes.
        Revisá los valores abajo, corregí si hace falta y dale <b>Aprobar guía</b>.
        <button class="cirene-btn cirene-btn-sm" id="btnSGApprove" style="margin-left:8px">✓ Aprobar guía</button>
      </div>`;
    } else {
      statusBlock = `<div class="cirene-alert" style="background:#e8f7ee;border:1px solid #aadcbb;color:#1a7a3a;padding:8px 10px;border-radius:6px;margin-bottom:8px;font-size:12px">
        ✓ Guía lista — se muestra al cliente en el PDF cuando se tilda "Guía de talles".
      </div>`;
    }
    statusBlock += sizeGuideTableHtml(sg);
  }

  // Textarea editable + botón para regenerar la tabla desde el texto.
  const nrows = (txt.match(/\n/g) || []).length + 1;
  const textBlock = statusBlock + `
    <textarea class="cirene-textarea" id="f_sizeGuideText" rows="${Math.min(Math.max(nrows + 1, 4), 12)}"
      placeholder="Tabla de talles (Talle: XS S M L … / Pecho: 100 104 … / Largo: …)"
      style="font-family:monospace; font-size:12px; white-space:pre; overflow-x:auto; margin-bottom:6px">${esc(txt)}</textarea>
    <button class="cirene-btn cirene-btn-ghost cirene-btn-sm" id="btnSGRebuild" style="margin-bottom:8px">↻ Reconstruir tabla desde el texto</button>`;
  if (key) {
    const dataUrl = await getImage(key).catch(() => null);
    row.innerHTML = textBlock + `<div style="display:flex; gap:10px; align-items:center;">
      <div class="img-thumb" style="width:90px;height:90px">
        ${dataUrl ? `<img src="${dataUrl}" alt="guía">` : '…'}
      </div>
      <button class="cirene-btn cirene-btn-sm" id="btnSGChange">Cambiar imagen</button>
      <button class="cirene-btn cirene-btn-ghost cirene-btn-sm" id="btnSGRemove">Quitar imagen</button>
    </div>`;
    $('btnSGChange').onclick = () => $('sizeGuideInput').click();
    $('btnSGRemove').onclick = async () => {
      try { await delImage(key); } catch {}
      state.editing.sizeGuideKey = '';
      renderSizeGuide();
    };
  } else {
    row.innerHTML = textBlock + `<button class="cirene-btn cirene-btn-sm" id="btnSGAdd">+ Subir guía de talles (imagen)</button>`;
    $('btnSGAdd').onclick = () => $('sizeGuideInput').click();
  }

  // Handlers de los botones de la tabla estructurada.
  const bApprove = $('btnSGApprove');
  if (bApprove) bApprove.onclick = () => {
    if (state.editing.sizeGuide) state.editing.sizeGuide.needsReview = false;
    renderSizeGuide();
  };
  const bRebuild = $('btnSGRebuild');
  if (bRebuild) bRebuild.onclick = () => {
    const ta = $('f_sizeGuideText');
    state.editing.sizeGuideText = ta ? ta.value : '';
    const parsed = parseSizeGuideClient(state.editing.sizeGuideText);
    if (!parsed) {
      alert('No pude reconstruir la tabla. Formato esperado: una línea por medida, ej:\nTalle: XS S M L\nPecho: 100 104 108');
      return;
    }
    const prevSource = state.editing.sizeGuide && state.editing.sizeGuide.source;
    state.editing.sizeGuide = {
      headers: parsed.headers,
      rows: parsed.rows,
      source: 'manual',
      // editado a mano: si cuadra queda OK; si no, sigue en revisión
      needsReview: !parsed.ok,
    };
    renderSizeGuide();
  };
}

function renderColors() {
  const wrap = $('colorList'); if (!wrap) return;
  const ci = state.editing.colorImages || {};
  wrap.innerHTML = (state.editing.colors || []).map((c, i) => {
    const urls = Array.isArray(ci[c.name]) ? ci[c.name] : [];
    const thumbs = urls.length ? `
      <div style="display:flex; gap:5px; flex-wrap:wrap; margin:6px 0 2px 22px">
        ${urls.slice(0, 6).map(u => `<img src="${esc(u)}" alt="${esc(c.name)}" title="${esc(c.name)}" style="width:50px; height:50px; object-fit:cover; border:1px solid var(--border); border-radius:6px" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.opacity=0.25"/>`).join('')}
        ${urls.length > 6 ? `<span style="font-size:11px; color:var(--tinta-3); align-self:center">+${urls.length - 6}</span>` : ''}
      </div>` : '';
    return `
    <div class="color-block" style="border-bottom:1px solid var(--border); padding:6px 0">
      <div class="color-row">
        <span class="color-swatch" style="background:${esc(c.hex || '#999')}"></span>
        <span style="flex:1; font-size:13px">${esc(c.name)}${urls.length ? ` <span style="color:var(--tinta-3); font-size:11px">(${urls.length} img)</span>` : ''}</span>
        <button class="cirene-btn cirene-btn-ghost cirene-btn-xs" data-rmcolor="${i}">×</button>
      </div>
      ${thumbs}
    </div>`;
  }).join('');
  wrap.querySelectorAll('[data-rmcolor]').forEach(b => {
    b.onclick = () => {
      state.editing.colors.splice(parseInt(b.dataset.rmcolor), 1);
      renderColors();
    };
  });
}

function renderPros() {
  const wrap = $('prosList'); if (!wrap) return;
  wrap.innerHTML = (state.editing.pros || []).map((s, i) => `
    <span class="tag-pill">${esc(s)} <button data-rmpro="${i}">×</button></span>
  `).join('');
  wrap.querySelectorAll('[data-rmpro]').forEach(b => {
    b.onclick = () => {
      state.editing.pros.splice(parseInt(b.dataset.rmpro), 1);
      renderPros();
    };
  });
}

function saveEditor() {
  const p = state.editing;
  p.n = $('f_n').value.trim();
  p.k = $('f_k').value.trim();
  p.precio = parseFloat($('f_precio').value) || 0;
  p.c = p.precio;  // sync con el campo que usa el cotizador (evita NaN en líneas)
  p.notes = $('f_notes').value.trim();
  if ($('f_sizeGuideText')) p.sizeGuideText = $('f_sizeGuideText').value.trim();
  if (!p.n) { alert('El nombre es obligatorio'); return; }
  if (!p.id) p.id = newProductId(p.n);
  if (state.editIdx === -1) state.productos.push(p);
  else state.productos[state.editIdx] = p;
  saveCatalog(state.productos, state.tarifas);
  closeEditor();
  renderProductos();
}

async function deleteEditor() {
  if (state.editIdx === -1) { closeEditor(); return; }
  const p = state.productos[state.editIdx];
  if (!confirm(`¿Eliminar "${p.n}" del catálogo?\n\nNota: si el producto está en Odoo, queda allá; solo se borra del catálogo local.`)) return;
  // borrar imágenes asociadas
  for (const k of (p.imgs || [])) { try { await delImage(k); } catch {} }
  if (p.sizeGuideKey) { try { await delImage(p.sizeGuideKey); } catch {} }
  state.productos.splice(state.editIdx, 1);
  saveCatalog(state.productos, state.tarifas);
  closeEditor();
  renderProductos();
}

// ─── TARIFAS ───────────────────────────────────────────────
function renderTarifas() {
  const wrap = $('tarifaList'); if (!wrap) return;
  if (!state.tarifas.length) {
    wrap.innerHTML = '<div class="cirene-alert info">Sin técnicas. Agregá una con el botón de abajo.</div>';
    return;
  }
  wrap.innerHTML = state.tarifas.map((t, i) => `
    <div class="tarifa-card">
      <div class="tarifa-hdr">
        <input class="cirene-input" style="max-width:240px; font-weight:600" value="${esc(t.tecnica || '')}" data-tname="${i}"/>
        <button class="cirene-btn cirene-btn-ghost cirene-btn-xs" data-rmtarifa="${i}">Eliminar</button>
      </div>
      <div style="font-size:11px; color: var(--tinta-2); margin-bottom:6px">Tiers por cantidad — desde / hasta / precio unit. / setup</div>
      ${(t.tiers || []).map((tier, j) => `
        <div class="tier-row">
          <input class="cirene-input" type="number" value="${tier.min || 0}" data-tier="${i}-${j}-min" placeholder="Desde"/>
          <input class="cirene-input" type="number" value="${tier.max || 0}" data-tier="${i}-${j}-max" placeholder="Hasta"/>
          <input class="cirene-input" type="number" value="${tier.precio || 0}" data-tier="${i}-${j}-precio" placeholder="Precio"/>
          <input class="cirene-input" type="number" value="${tier.setup || 0}" data-tier="${i}-${j}-setup" placeholder="Setup"/>
          <button class="cirene-btn cirene-btn-ghost cirene-btn-xs" data-rmtier="${i}-${j}">×</button>
        </div>
      `).join('')}
      <button class="cirene-btn cirene-btn-ghost cirene-btn-xs" data-addtier="${i}" style="margin-top:6px">+ Tier</button>
    </div>
  `).join('');

  wrap.querySelectorAll('[data-tname]').forEach(el => {
    el.onchange = () => { state.tarifas[parseInt(el.dataset.tname)].tecnica = el.value.trim(); saveCatalog(state.productos, state.tarifas); };
  });
  wrap.querySelectorAll('[data-tier]').forEach(el => {
    el.onchange = () => {
      const [ti, ji, f] = el.dataset.tier.split('-');
      state.tarifas[+ti].tiers[+ji][f] = parseFloat(el.value) || 0;
      saveCatalog(state.productos, state.tarifas);
    };
  });
  wrap.querySelectorAll('[data-rmtarifa]').forEach(b => {
    b.onclick = () => {
      if (!confirm('¿Eliminar esta técnica y todos sus tiers?')) return;
      state.tarifas.splice(parseInt(b.dataset.rmtarifa), 1);
      saveCatalog(state.productos, state.tarifas);
      renderTarifas();
    };
  });
  wrap.querySelectorAll('[data-rmtier]').forEach(b => {
    b.onclick = () => {
      const [ti, ji] = b.dataset.rmtier.split('-');
      state.tarifas[+ti].tiers.splice(+ji, 1);
      saveCatalog(state.productos, state.tarifas);
      renderTarifas();
    };
  });
  wrap.querySelectorAll('[data-addtier]').forEach(b => {
    b.onclick = () => {
      const i = parseInt(b.dataset.addtier);
      if (!state.tarifas[i].tiers) state.tarifas[i].tiers = [];
      state.tarifas[i].tiers.push({ min: 0, max: 0, precio: 0, setup: 0 });
      saveCatalog(state.productos, state.tarifas);
      renderTarifas();
    };
  });
}

function addTarifa() {
  const name = prompt('Nombre de la técnica (ej: Bordado, DTF, Serigrafía):');
  if (!name || !name.trim()) return;
  state.tarifas.push({ tecnica: name.trim(), tiers: [] });
  saveCatalog(state.productos, state.tarifas);
  renderTarifas();
}

// ─── SYNC ODOO ─────────────────────────────────────────────
async function updateSyncStats() {
  $('statLocal').textContent = state.productos.length;
  const map = loadOdooMap();
  $('statMapped').textContent = Object.keys(map).length;
  $('statOdoo').textContent = '…';
  try {
    const list = await listAllProducts({ limit: 5000 });
    $('statOdoo').textContent = list.length;
  } catch (e) {
    $('statOdoo').textContent = '?';
    logSync('err', 'No se pudo consultar Odoo: ' + e.message);
  }
}

function showProg(pct) {
  $('syncProg').style.display = pct == null ? 'none' : '';
  $('syncProgFill').style.width = (pct || 0) + '%';
}

function logSync(kind, msg) {
  const el = $('syncLog');
  el.style.display = '';
  const line = document.createElement('div');
  line.className = kind || '';
  line.textContent = `[${new Date().toLocaleTimeString('es-UY')}] ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

async function loadImgBase64(key) {
  if (!key) return null;
  const dataUrl = await getImage(key).catch(() => null);
  return dataUrl ? dataUrlToBase64(dataUrl) : null;
}

async function buildOdooPayload(p) {
  // Imagen principal: primera del array `imgs` o `views.front` si existe.
  const imgKey = (p.imgs && p.imgs[0]) || (p.views && p.views.front) || null;
  const imageBase64 = await loadImgBase64(imgKey);
  const sizeGuideBase64 = await loadImgBase64(p.sizeGuideKey);
  return {
    id: p.id,
    n: p.n,
    k: p.k,
    precio: p.precio,
    notes: p.notes,
    pros: p.pros || [],
    colors: p.colors || [],
    imageBase64,
    sizeGuideBase64,
    sizeGuideName: 'guia_de_talles.png',
  };
}

async function onPushAll() {
  const list = state.productos;
  if (!list.length) { alert('El catálogo está vacío.'); return; }
  if (!confirm(`Vas a subir/actualizar ${list.length} productos a Odoo con todos sus datos (imágenes incluidas). Puede tardar varios minutos. ¿Seguir?`)) return;

  $('btnPushAll').disabled = true;
  $('syncLog').innerHTML = '';
  logSync('info', `Iniciando push de ${list.length} productos…`);
  showProg(0);
  const map = loadOdooMap();
  let ok = 0, err = 0;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    try {
      const payload = await buildOdooPayload(p);
      const r = await pushProductFull(payload);
      map[p.id] = { templateId: r.templateId, syncedAt: new Date().toISOString(),
                    image: r.image, sizeGuide: r.sizeGuide };
      ok++;
      logSync('ok', `✓ ${p.n} → template ${r.templateId}${r.alreadyExisted ? ' (existía)' : ' (nuevo)'}${r.image ? ' +img' : ''}${r.sizeGuide ? ' +guía' : ''}`);
    } catch (e) {
      err++;
      logSync('err', `✗ ${p.n}: ${e.message}`);
    }
    showProg(Math.round((i + 1) / list.length * 100));
  }
  saveOdooMap(map);
  logSync('info', `Listo. ${ok} ok, ${err} con error.`);
  showProg(null);
  $('btnPushAll').disabled = false;
  updateSyncStats();
}

async function onWipeAndPush() {
  const list = state.productos;
  if (!list.length) { alert('El catálogo está vacío. Cargá productos antes.'); return; }
  if (!confirm(`PASO 1: archivar TODOS los productos activos en Odoo (reversible).\nPASO 2: subir los ${list.length} productos del catálogo desde cero.\n\n¿Seguir?`)) return;
  if (!confirm('Última confirmación: vas a archivar el catálogo de Odoo. ¿Estás SEGURO?')) return;

  $('btnWipePush').disabled = true;
  $('syncLog').innerHTML = '';
  try {
    logSync('info', 'Archivando productos activos en Odoo…');
    const archived = await archiveAllProducts();
    logSync('ok', `✓ ${archived} producto(s) archivado(s) en Odoo`);
  } catch (e) {
    logSync('err', 'Falló el archivado: ' + e.message);
    $('btnWipePush').disabled = false;
    return;
  }
  // Limpiar el mapeo local — ya no apuntan a nada útil
  saveOdooMap({});
  $('btnWipePush').disabled = false;
  // Ahora push completo
  await onPushAll();
}

// Importa productos de Odoo. Trae standard_price (COSTO) como `precio` del catálogo,
// porque el cotizador usa ese campo como base para calcular el precio de venta
// sumando margen/tarifa por técnica. Si standard_price es 0, cae a list_price.
//
// Hace TRES cosas:
//   1) Agrega productos nuevos (no existían localmente).
//   2) Actualiza el costo de productos existentes si su `precio` local es 0/falta
//      y Odoo tiene un costo positivo.
//   3) Refresca el mapeo Odoo (template_id) por si el producto fue creado desde
//      Odoo y nunca pasó por nuestro sync.
async function onImportOdoo() {
  if (!confirm('Voy a traer productos y COSTOS desde Odoo.\n\n• Productos nuevos: se agregan al catálogo.\n• Productos que ya existen acá (matcheados por nombre): les actualizo el precio si está en 0.\n\n¿Seguir?')) return;
  $('btnImportOdoo').disabled = true;
  $('syncLog').innerHTML = '';
  try {
    logSync('info', 'Leyendo product.template de Odoo…');
    const list = await listAllProducts({ limit: 5000 });
    logSync('info', `${list.length} productos en Odoo. Cruzando con catálogo local…`);

    const localByName = new Map();
    state.productos.forEach((p, i) => {
      const k = (p.n || '').trim().toLowerCase();
      if (k) localByName.set(k, i);
    });

    const map = loadOdooMap();
    let added = 0, updated = 0, skipped = 0;

    for (const op of list) {
      const name = (op.name || '').trim();
      if (!name) { skipped++; continue; }

      // Costo (standard_price) tiene prioridad sobre precio de venta (list_price),
      // porque el cotizador trabaja sobre costos para armar la propuesta.
      const cost = parseFloat(op.standard_price) || 0;
      const sale = parseFloat(op.list_price) || 0;
      const priceToUse = cost > 0 ? cost : sale;

      const idx = localByName.get(name.toLowerCase());
      if (idx !== undefined) {
        // Ya existe — actualizo precio solo si está vacío/0 acá Y Odoo tiene algo.
        const existing = state.productos[idx];
        const hasLocalPrice = (parseFloat(existing.precio) > 0) || (parseFloat(existing.c) > 0);
        let didUpdate = false;
        if (!hasLocalPrice && priceToUse > 0) {
          existing.precio = priceToUse;
          existing.c = priceToUse;  // sync con campo que usa el cotizador
          didUpdate = true;
        }
        // Aprovecho y refresco el mapeo a Odoo aunque ya exista.
        if (!map[existing.id] || map[existing.id].templateId !== op.id) {
          map[existing.id] = { templateId: op.id, syncedAt: new Date().toISOString(), importedFromOdoo: true };
          didUpdate = true;
        }
        if (didUpdate) {
          updated++;
          logSync('ok', `↻ ${name}: costo ${priceToUse} (era ${existing.precio === priceToUse ? '0' : existing.precio})`);
        }
        continue;
      }

      // Producto nuevo — lo creo en el catálogo.
      // Seteo `c` y `precio` con el mismo valor: el cotizador lee `c`, el editor lee `precio`.
      const newP = {
        id: op.default_code || newProductId(name),
        n: name,
        k: op.description_sale || '',
        c: priceToUse,
        precio: priceToUse,
        notes: '',
        imgs: [],
        colors: [],
        pros: [],
        sizeGuideKey: '',
      };
      state.productos.push(newP);
      map[newP.id] = { templateId: op.id, syncedAt: new Date().toISOString(), importedFromOdoo: true };
      added++;
      logSync('ok', `+ ${name}: costo ${priceToUse}`);
    }

    saveOdooMap(map);
    saveCatalog(state.productos, state.tarifas);
    logSync('info', `Listo. ${added} nuevo(s), ${updated} actualizado(s).`);
    renderProductos();
  } catch (e) {
    logSync('err', 'Falló import: ' + e.message);
  }
  $('btnImportOdoo').disabled = false;
  updateSyncStats();
}
