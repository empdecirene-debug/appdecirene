// js/stock.js — Acceso a stock_items (migraciones 015 + 023) desde la UI.
//
// 023 agregó stock por VARIANTE: marca, color, talle, catalog_product_id,
// unit_price; y la tabla stock_movements (bitácora de entradas/salidas/ajustes).
//
// qty_available es calculado: qty_on_hand - qty_reserved (no hay columna).

import { getSupa } from './supa.js';
import { getCurrentUser, isAdmin } from './auth.js';
import { logAudit } from './audit.js';

export async function listStockItems({ search = '', brand = '', limit = 2000 } = {}) {
  const supa = getSupa();
  let q = supa.from('stock_items').select('*').order('sku', { ascending: true });
  if (search) q = q.or(`sku.ilike.%${search}%,name.ilike.%${search}%,marca.ilike.%${search}%,color.ilike.%${search}%`);
  if (brand) q = q.eq('marca', brand);
  if (limit) q = q.limit(limit);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map(r => ({
    ...r,
    qty_available: Number(r.qty_on_hand || 0) - Number(r.qty_reserved || 0),
  }));
}

// Marcas conocidas (seed) ∪ las distintas ya presentes en stock_items.
// Permite agregar marcas nuevas (Optima, Linder, …) sin tabla aparte: la UI usa
// esta lista como datalist y guarda cualquier texto que escriba el usuario.
const SEED_BRANDS = ['FAMET', 'Disershop', 'Indiewears', 'Yazbek', 'Optima', 'Linder', 'Comodines', 'Otro'];
export async function listStockBrands() {
  const supa = getSupa();
  const { data } = await supa.from('stock_items').select('marca').not('marca', 'is', null);
  const distinct = (data || []).map(r => (r.marca || '').trim()).filter(Boolean);
  return [...new Set([...SEED_BRANDS, ...distinct])].sort((a, b) => a.localeCompare(b, 'es'));
}

// Siguiente SKU numérico disponible (la planilla numera desde 1000). Sirve para
// agregar un talle nuevo sin pedirle el SKU al usuario.
export async function nextStockSku() {
  const supa = getSupa();
  const { data, error } = await supa.from('stock_items').select('sku');
  if (error) throw error;
  let max = 999;
  for (const r of (data || [])) {
    const n = parseInt(r.sku, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return String(max + 1);
}

export async function upsertStockItem(item) {
  if (!(await isAdmin())) throw new Error('Solo admin puede editar stock');
  const supa = getSupa();
  const user = await getCurrentUser();
  const payload = {
    sku:                item.sku,
    name:               item.name || null,
    marca:              item.marca || null,
    color:              item.color || null,
    talle:              item.talle || null,
    catalog_product_id: item.catalog_product_id || null,
    odoo_product_id:    item.odoo_product_id != null ? Number(item.odoo_product_id) : null,
    qty_on_hand:        Number(item.qty_on_hand) || 0,
    qty_reserved:       Number(item.qty_reserved) || 0,
    unit_price:         item.unit_price != null && item.unit_price !== '' ? Number(item.unit_price) : null,
    location:           item.location || null,
    notes:              item.notes || null,
    updated_at:         new Date().toISOString(),
    updated_by:         user?.id || null,
  };
  // ON CONFLICT por sku (índice unique idx_stock_items_sku)
  const { data, error } = await supa
    .from('stock_items')
    .upsert(payload, { onConflict: 'sku' })
    .select().single();
  if (error) throw error;
  await logAudit({ action: 'stock_upsert', entity_type: 'stock_item', entity_id: data.id, details: { sku: item.sku } });
  return data;
}

export async function deleteStockItem(id) {
  if (!(await isAdmin())) throw new Error('Solo admin puede eliminar stock');
  const supa = getSupa();
  const { error } = await supa.from('stock_items').delete().eq('id', id);
  if (error) throw error;
  await logAudit({ action: 'stock_delete', entity_type: 'stock_item', entity_id: id });
}

// ── (#OC) Sugerencia de descuento de stock al crear una Orden de Compra ────────
//
// Busca variantes de stock disponibles (qty_available > 0) para una línea de OC.
// La línea ya trae el id del producto de catálogo resuelto por quien llama
// (production.html tiene el catálogo en memoria). Devuelve las variantes que
// matchean, priorizando color+talle exactos.
export async function findStockForLine({ catalogProductId, color = '', talle = '' }) {
  if (!catalogProductId) return [];
  const supa = getSupa();
  const { data, error } = await supa
    .from('stock_items')
    .select('id, sku, name, marca, color, talle, qty_on_hand, qty_reserved')
    .eq('catalog_product_id', catalogProductId);
  if (error) { console.warn('[findStockForLine]', error.message); return []; }
  const norm = s => String(s || '').trim().toLowerCase();
  const c = norm(color), t = norm(talle);
  return (data || [])
    .map(r => ({ ...r, qty_available: Number(r.qty_on_hand || 0) - Number(r.qty_reserved || 0) }))
    .filter(r => r.qty_available > 0)
    .map(r => {
      let rank = 0;
      if (c && norm(r.color) === c) rank += 2;
      if (t && norm(r.talle) === t) rank += 1;
      return { ...r, rank };
    })
    .sort((a, b) => b.rank - a.rank || b.qty_available - a.qty_available);
}

// Aplica el descuento aceptado por el usuario: resta qty_on_hand y registra el
// movimiento (tipo 'salida') por cada ítem. items: [{ id, sku, cantidad }].
// NO se llama nunca automáticamente — solo cuando el usuario acepta la sugerencia.
export async function applyStockConsumption(items, { ocId = null, motivo = '' } = {}) {
  if (!(await isAdmin())) throw new Error('Solo admin puede mover stock');
  if (!items?.length) return { applied: 0 };
  const supa = getSupa();
  const user = await getCurrentUser();
  let applied = 0;
  for (const it of items) {
    const cant = Number(it.cantidad) || 0;
    if (cant <= 0) continue;
    // Releer la fila para no pisar otros campos y evitar negativos.
    const { data: row, error: e0 } = await supa
      .from('stock_items').select('id, sku, qty_on_hand').eq('id', it.id).single();
    if (e0 || !row) { console.warn('[applyStockConsumption] no row', it.id, e0?.message); continue; }
    const newQty = Math.max(0, Number(row.qty_on_hand || 0) - cant);
    const { error: e1 } = await supa.from('stock_items')
      .update({ qty_on_hand: newQty, updated_at: new Date().toISOString(), updated_by: user?.id || null })
      .eq('id', it.id);
    if (e1) { console.warn('[applyStockConsumption] update', e1.message); continue; }
    const { error: e2 } = await supa.from('stock_movements').insert({
      stock_item_id: it.id,
      sku:           row.sku || it.sku || null,
      tipo:          'salida',
      cantidad:      cant,
      motivo:        motivo || (ocId ? `OC ${ocId} · descuento de stock` : 'descuento de stock'),
      ref_oc_id:     ocId,
      actor_id:      user?.id || null,
    });
    if (e2) console.warn('[applyStockConsumption] movement', e2.message);
    await logAudit({ action: 'stock_consume', entity_type: 'stock_item', entity_id: it.id, details: { sku: row.sku, cantidad: cant, ocId } });
    applied++;
  }
  return { applied };
}

// Importar CSV de stock. Headers reconocidos (orden tolerante, sku requerido):
//   sku,name,marca,color,talle,qty_on_hand,qty_reserved,unit_price,location,notes
// Devuelve { ok, errors[] }.
export async function importStockCsv(csvText) {
  if (!(await isAdmin())) throw new Error('Solo admin puede importar stock');
  const lines = csvText.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { ok: 0, errors: ['CSV vacío'] };
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const idxOf = name => headers.indexOf(name);
  if (idxOf('sku') < 0) return { ok: 0, errors: ['Falta columna requerida: sku'] };
  const cell = (cells, name) => idxOf(name) >= 0 ? cells[idxOf(name)] : undefined;
  let ok = 0;
  const errors = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',').map(c => c.trim());
    const sku = cells[idxOf('sku')];
    if (!sku) { errors.push(`Línea ${i+1}: sku vacío`); continue; }
    try {
      await upsertStockItem({
        sku,
        name:         cell(cells, 'name') ?? null,
        marca:        cell(cells, 'marca') ?? null,
        color:        cell(cells, 'color') ?? null,
        talle:        cell(cells, 'talle') ?? null,
        qty_on_hand:  cell(cells, 'qty_on_hand') != null ? Number(cell(cells, 'qty_on_hand')) : 0,
        qty_reserved: cell(cells, 'qty_reserved') != null ? Number(cell(cells, 'qty_reserved')) : 0,
        unit_price:   cell(cells, 'unit_price'),
        location:     cell(cells, 'location') ?? null,
        notes:        cell(cells, 'notes') ?? null,
      });
      ok++;
    } catch (e) { errors.push(`Línea ${i+1}: ${e.message}`); }
  }
  return { ok, errors };
}
