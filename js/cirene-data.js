// Capa de datos del ERP De Cirene sobre Supabase.
// Materiales, tarifas de mano de obra, plantillas de producto (BOM) y cotizaciones.

import { getSupa } from './supa.js?v=3';

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

/* ───────────── Clientes (portal por vendedor) ───────────── */
export async function listClients({ search = '' } = {}) {
  const { data, error } = await db().from('clients').select('*').order('nombre');
  if (error) throw error;
  let rows = data || [];
  if (search) { const s = search.toLowerCase(); rows = rows.filter(c => (c.nombre + ' ' + (c.empresa || '') + ' ' + (c.telefono || '') + ' ' + (c.email || '')).toLowerCase().includes(s)); }
  return rows;
}
export async function getClient(id) {
  const { data } = await db().from('clients').select('*').eq('id', id).single();
  return data || null;
}
export async function upsertClient(c) {
  const sb = db();
  let row = { ...c };
  if (!row.id) {
    const { data: { user } } = await sb.auth.getUser();
    row.vendedor_user_id = user?.id || null;
    if (!row.vendedor) row.vendedor = await currentVendorName();
  }
  const { data, error } = await sb.from('clients').upsert(row).select().single();
  if (error) throw error;
  return data;
}
export async function deleteClient(id) {
  const { error } = await db().from('clients').delete().eq('id', id);
  if (error) throw error;
}

/* ───────────── Etapas (kanban) ───────────── */
export async function listStages(category) {
  let q = db().from('kanban_stages').select('*').eq('active', true).order('display_order');
  if (category) q = q.eq('category', category);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

/* ───────────── CRM (intake / leads) ───────────── */
export function newId(prefix) { return prefix + '-' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36); }

export async function listIntakeCards() {
  const { data, error } = await db().from('intake_cards').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}
export async function createIntakeCard(card) {
  const { data: { user } } = await db().auth.getUser();
  const row = { id: newId('in'), stage_key: 'mensaje_entrante', status: 'abierta', vendor: card.vendor || 'Comercial', vendor_user_id: user?.id || null, ...card };
  const { data, error } = await db().from('intake_cards').insert(row).select().single();
  if (error) throw error;
  return data;
}
export async function saveIntakeCard(card) {
  const { data, error } = await db().from('intake_cards').update(card).eq('id', card.id).select().single();
  if (error) throw error;
  return data;
}
export async function getIntakeCard(id) {
  const { data } = await db().from('intake_cards').select('*').eq('id', id).single();
  return data || null;
}
export async function getQuoteByIntake(intakeId) {
  const { data } = await db().from('quotes').select('*').eq('intake_card_id', intakeId).order('created_at', { ascending: false }).limit(1);
  return (data && data[0]) || null;
}

/* ───────────── Producción ───────────── */
export async function listProductionCards() {
  const { data, error } = await db().from('production_cards').select('*').is('archived_at', null).order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}
export async function saveProductionCard(card) {
  const { data, error } = await db().from('production_cards').update(card).eq('id', card.id).select().single();
  if (error) throw error;
  return data;
}
export async function moveProductionStage(id, stage_key) {
  const patch = { stage_key };
  if (stage_key === 'entregado') patch.completed_at = new Date().toISOString();
  return saveProductionCard({ id, ...patch });
}

/* ───────────── Comentarios / historial de tarjeta ───────────── */
export async function listComments(cardId) {
  const { data } = await db().from('card_stories').select('*').eq('card_id', cardId).eq('type', 'comment').order('occurred_at', { ascending: false });
  return data || [];
}
export async function addComment(cardId, notes) {
  const sb = db();
  const { data: { user } } = await sb.auth.getUser();
  let label = user?.email || 'Usuario';
  try { const { data: p } = await sb.from('user_profiles').select('full_name,vendor_name').eq('id', user.id).single(); if (p) label = p.vendor_name || p.full_name || label; } catch {}
  const { data, error } = await sb.from('card_stories').insert({ card_id: cardId, user_id: user?.id || null, user_label: label, type: 'comment', notes }).select().single();
  if (error) throw error;
  return data;
}
export async function countCommentsByCard() {
  const { data } = await db().from('card_stories').select('card_id').eq('type', 'comment');
  const map = {};
  (data || []).forEach(r => { map[r.card_id] = (map[r.card_id] || 0) + 1; });
  return map;
}

/* ───────────── Adjuntos (Supabase Storage, bucket 'adjuntos') ───────────── */
export async function uploadAttachment(file, cardId) {
  const sb = db();
  const safe = (file.name || 'archivo').replace(/[^\w.\-]+/g, '_');
  const path = `${cardId}/${Date.now()}_${safe}`;
  const { error } = await sb.storage.from('adjuntos').upload(path, file, { upsert: false, contentType: file.type || undefined });
  if (error) throw error;
  const { data } = sb.storage.from('adjuntos').getPublicUrl(path);
  return { name: file.name, url: data.publicUrl, type: file.type || '', path, size: file.size };
}
export async function deleteAttachment(path) {
  if (!path) return;
  try { await db().storage.from('adjuntos').remove([path]); } catch {}
}
// Crea una tarjeta de producción a partir de un lead aceptado (con su cotización si hay).
export async function createProductionFromIntake(intake, quote) {
  const sb = db();
  const { data: { user } } = await sb.auth.getUser();
  const lines = [];
  if (quote) {
    const { data: ql } = await sb.from('quote_lines').select('*').eq('quote_id', quote.id);
    (ql || []).forEach(l => lines.push({ producto: l.producto, cantidad: n(l.cantidad) || 1, precio: n(l.precio_venta) }));
  }
  const card = {
    id: newId('pr'), source: 'quote_approved', stage_key: 'procesar',
    vendor: intake.vendor, vendor_user_id: user?.id || null,
    intake_card_id: intake.id, quote_id: quote?.id || null,
    client_name: intake.client_query, client_phone_e164: intake.client_phone_e164 || (quote?.cliente_telefono || null),
    direccion: quote?.cliente_direccion || null, description: intake.description,
    product_lines: lines, total_venta: quote?.precio_venta || 0, estado_pago: 'NO',
    due_date: intake.target_date || null, billing_month: new Date().toISOString().slice(0, 7),
  };
  const { data: pc, error } = await sb.from('production_cards').insert(card).select().single();
  if (error) throw error;
  await sb.from('intake_cards').update({ status: 'aceptada', stage_key: 'aceptado', resulting_production_card_id: pc.id }).eq('id', intake.id);
  if (quote) await sb.from('quotes').update({ estado: 'aceptado', production_card_id: pc.id }).eq('id', quote.id);
  return pc;
}
function n(x) { const v = parseFloat(x); return Number.isFinite(v) ? v : 0; }

/* ───────────── Contabilidad / Caja ───────────── */
const today = () => new Date().toISOString().slice(0, 10);

export async function getOpenSession() {
  const { data } = await db().from('cash_sessions').select('*').eq('estado', 'abierta').order('fecha', { ascending: false }).limit(1);
  return (data && data[0]) || null;
}
export async function openCashSession(saldoInicial = 0, fecha = today()) {
  const { data: { user } } = await db().auth.getUser();
  const { data, error } = await db().from('cash_sessions').insert({ fecha, estado: 'abierta', saldo_inicial: saldoInicial, abierta_por: user?.id || null }).select().single();
  if (error) throw error;
  return data;
}
export async function closeCashSession(id) {
  const sb = db();
  const { data: { user } } = await sb.auth.getUser();
  const { data: ses } = await sb.from('cash_sessions').select('*').eq('id', id).single();
  const { data: movs } = await sb.from('cash_movements').select('tipo,monto').eq('cash_session_id', id);
  let ing = 0, egr = 0;
  (movs || []).forEach(m => m.tipo === 'ingreso' ? ing += n(m.monto) : egr += n(m.monto));
  const saldo_final = n(ses.saldo_inicial) + ing - egr;
  const { data, error } = await sb.from('cash_sessions').update({ estado: 'cerrada', total_ingresos: ing, total_egresos: egr, saldo_final, cerrada_por: user?.id || null, cerrada_at: new Date().toISOString() }).eq('id', id).select().single();
  if (error) throw error;
  return data;
}
export async function listCashSessions() {
  const { data } = await db().from('cash_sessions').select('*').order('fecha', { ascending: false }).limit(60);
  return data || [];
}
export async function listCashMovements({ from, to, sessionId } = {}) {
  let q = db().from('cash_movements').select('*').order('fecha', { ascending: false }).order('created_at', { ascending: false });
  if (sessionId) q = q.eq('cash_session_id', sessionId);
  if (from) q = q.gte('fecha', from);
  if (to) q = q.lte('fecha', to);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}
export async function registerCashMovement(m) {
  const sb = db();
  const { data: { user } } = await sb.auth.getUser();
  const ses = await getOpenSession();
  const row = { tipo: m.tipo, categoria: m.categoria || 'otro', monto: m.monto, metodo: m.metodo || null, descripcion: m.descripcion || null, fecha: m.fecha || today(), cash_session_id: ses?.id || null, registrado_por: user?.id || null };
  const { data, error } = await sb.from('cash_movements').insert(row).select().single();
  if (error) throw error;
  return data;
}
export async function listJobPayments(cardId) {
  const { data } = await db().from('job_payments').select('*').eq('production_card_id', cardId).order('fecha');
  return data || [];
}
export async function paymentsByCard() {
  const { data } = await db().from('job_payments').select('production_card_id,monto');
  const map = {};
  (data || []).forEach(p => { map[p.production_card_id] = (map[p.production_card_id] || 0) + n(p.monto); });
  return map;
}
export async function jobBalance(card) {
  const pays = await listJobPayments(card.id);
  const pagado = pays.reduce((s, p) => s + n(p.monto), 0);
  const total = n(card.total_venta);
  const saldo = total - pagado;
  const estado = (total > 0 && saldo <= 0.01) ? 'SI' : (pagado > 0 ? 'SEÑA' : 'NO');
  return { total, pagado, saldo, estado, pays };
}
export async function registerJobPayment({ card, tipo, monto, metodo, fecha }) {
  const sb = db();
  const { data: { user } } = await sb.auth.getUser();
  const ses = await getOpenSession();
  const { data: pay, error } = await sb.from('job_payments').insert({ production_card_id: card.id, tipo, monto, metodo: metodo || null, fecha: fecha || today(), cash_session_id: ses?.id || null, registrado_por: user?.id || null }).select().single();
  if (error) throw error;
  await sb.from('cash_movements').insert({ tipo: 'ingreso', categoria: 'venta', monto, metodo: metodo || null, fecha: fecha || today(), production_card_id: card.id, job_payment_id: pay.id, cash_session_id: ses?.id || null, descripcion: 'Cobro ' + (card.client_name || card.id), registrado_por: user?.id || null });
  const bal = await jobBalance(card);
  await sb.from('production_cards').update({ estado_pago: bal.estado, contabilidad: 'Agregado' }).eq('id', card.id);
  return { pay, bal };
}
export async function listPayments({ from, to } = {}) {
  let q = db().from('job_payments').select('monto,fecha,production_card_id').order('fecha', { ascending: false });
  if (from) q = q.gte('fecha', from);
  if (to) q = q.lte('fecha', to);
  const { data } = await q;
  return data || [];
}
export async function cashReport({ from, to } = {}) {
  const movs = await listCashMovements({ from, to });
  let ingresos = 0, egresos = 0; const porCat = {};
  movs.forEach(m => { const v = n(m.monto); if (m.tipo === 'ingreso') ingresos += v; else egresos += v; const k = (m.tipo === 'ingreso' ? '+ ' : '− ') + (m.categoria || 'otro'); porCat[k] = (porCat[k] || 0) + v; });
  return { ingresos, egresos, neto: ingresos - egresos, porCat, count: movs.length };
}
