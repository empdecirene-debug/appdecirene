// Capa de datos del ERP De Cirene sobre Supabase.
// Materiales, tarifas de mano de obra, plantillas de producto (BOM) y cotizaciones.

import { getSupa } from './supa.js';

const db = () => getSupa();

/* ───────────── Materiales ───────────── */
export async function listMaterials({ search = '' } = {}) {
  let q = db().from('materials').select('*').eq('activo', true).order('tipo').order('nombre');
  const { data, error } = await q;
  if (error) throw error;
  let rows = data || [];
  if (search) {
    const s = search.toLowerCase();
    rows = rows.filter(m => (m.nombre + ' ' + (m.tipo || '') + ' ' + (m.proveedor || '')).toLowerCase().includes(s));
  }
  return rows;
}
export async function upsertMaterial(m) {
  const { data, error } = await db().from('materials').upsert(m).select().single();
  if (error) throw error;
  return data;
}
export async function deleteMaterial(id) {
  const { error } = await db().from('materials').delete().eq('id', id);
  if (error) throw error;
}

/* ───────────── Mano de obra ───────────── */
export async function listLaborRates() {
  const { data, error } = await db().from('labor_rates').select('*').order('display_order');
  if (error) throw error;
  return data || [];
}
export async function upsertLaborRate(r) {
  const { data, error } = await db().from('labor_rates').upsert(r).select().single();
  if (error) throw error;
  return data;
}

/* ───────────── Plantillas de producto (BOM) ───────────── */
export async function listTemplates() {
  const { data, error } = await db().from('product_templates').select('*').eq('activo', true).order('nombre');
  if (error) throw error;
  return data || [];
}
export async function getTemplate(id) {
  const sb = db();
  const [{ data: tpl }, { data: mat }, { data: lab }] = await Promise.all([
    sb.from('product_templates').select('*').eq('id', id).single(),
    sb.from('template_material_lines').select('*').eq('template_id', id).order('display_order'),
    sb.from('template_labor_lines').select('*').eq('template_id', id).order('display_order'),
  ]);
  return { tpl, materiales: mat || [], manoObra: lab || [] };
}
export async function saveTemplate(tpl, materiales, manoObra) {
  const sb = db();
  const { data: saved, error } = await sb.from('product_templates').upsert(tpl).select().single();
  if (error) throw error;
  const id = saved.id;
  await sb.from('template_material_lines').delete().eq('template_id', id);
  await sb.from('template_labor_lines').delete().eq('template_id', id);
  if (materiales?.length) {
    const rows = materiales.map((m, i) => ({
      template_id: id, material_id: m.material_id || null, descripcion: m.descripcion || null,
      dimension: m.dimension || null, costo_unit: m.costo_unit || 0, cantidad: m.cantidad || 0, display_order: i,
    }));
    const { error: e1 } = await sb.from('template_material_lines').insert(rows);
    if (e1) throw e1;
  }
  if (manoObra?.length) {
    const rows = manoObra.map((l, i) => ({
      template_id: id, labor_rate_id: l.labor_rate_id || null, rol: l.rol || null,
      costo_hora: l.costo_hora || 0, horas: l.horas || 0, display_order: i,
    }));
    const { error: e2 } = await sb.from('template_labor_lines').insert(rows);
    if (e2) throw e2;
  }
  return saved;
}
export async function deleteTemplate(id) {
  const { error } = await db().from('product_templates').update({ activo: false }).eq('id', id);
  if (error) throw error;
}

/* ───────────── Cotizaciones ───────────── */
export async function nextQuoteNumber() {
  const { data } = await db().from('quotes').select('numero').order('numero', { ascending: false }).limit(1);
  const max = (data && data[0] && data[0].numero) || 0;
  return max + 1;
}
export function quoteId(numero) { return 'COT-' + String(numero).padStart(4, '0'); }

export async function saveQuote(quote, lines) {
  const sb = db();
  const { data: saved, error } = await sb.from('quotes').upsert(quote).select().single();
  if (error) throw error;
  await sb.from('quote_lines').delete().eq('quote_id', saved.id);
  if (lines?.length) {
    const rows = lines.map((l, i) => ({
      quote_id: saved.id, template_id: l.template_id || null, producto: l.producto || 'Producto',
      es_estandar: !!l.es_estandar, pintado: !!l.pintado, tamano: l.tamano || null,
      cantidad: l.cantidad || 1, materiales: l.materiales || [], mano_obra: l.manoObra || [],
      especificaciones: l.especificaciones || null,
      costo_materiales: l.costoMateriales || 0, costo_mo: l.costoMO || 0, costo_directo: l.costoDirecto || 0,
      multiplicador: l.multiplicador || 1.5, precio_venta: l.precioVenta || 0, display_order: i,
    }));
    const { error: e1 } = await sb.from('quote_lines').insert(rows);
    if (e1) throw e1;
  }
  return saved;
}
export async function listQuotes() {
  const { data, error } = await db().from('quotes').select('*').order('created_at', { ascending: false }).limit(200);
  if (error) throw error;
  return data || [];
}
export async function getQuote(id) {
  const sb = db();
  const [{ data: q }, { data: lines }] = await Promise.all([
    sb.from('quotes').select('*').eq('id', id).single(),
    sb.from('quote_lines').select('*').eq('quote_id', id).order('display_order'),
  ]);
  return { quote: q, lines: lines || [] };
}

/* ───────────── Perfil actual (vendedor) ───────────── */
export async function currentVendorName() {
  const { data: { user } } = await db().auth.getUser();
  if (!user) return 'Visitante';
  const { data } = await db().from('user_profiles').select('full_name,vendor_name').eq('id', user.id).single();
  return (data && (data.vendor_name || data.full_name)) || user.email;
}
