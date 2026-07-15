// js/production-metrics.js — (#13) Cálculo de demoras de producción.
//
// Reads production_cards + production_card_transitions (migración 017) y
// calcula para cada tarjeta:
//
//   compraDays    = primera transición que saca estado_stock de "Registrar/Chequear"
//                   o "Comprar" — días desde created_at
//   insumoDays    = primera transición de estado_insumo a algo distinto de
//                   "No esta editado" — días desde created_at
//   dtfDays       = primera transición a estado_insumo='Falta que llegue el DTF' o
//                   'Esta el DTF' — días desde created_at
//   entregaDays   = primera transición a stage_key='entregado' — días desde created_at
//
// Devuelve por tarjeta un objeto rico (con vendor, supplier, totales) y un
// resumen agregado (avg, mediana, p95).

import { getSupa } from './supa.js?v=3';

function diffDays(a, b) {
  if (!a || !b) return null;
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return ms > 0 ? +(ms / 86400000).toFixed(2) : null;
}

function inferSupplierFromLines(lines) {
  if (!Array.isArray(lines)) return null;
  for (const l of lines) {
    const p = (l?.producto || '').toUpperCase();
    if (p.startsWith('AE')) return 'Famet';
    if (p.startsWith('YK') || p.startsWith('LR')) return 'Indiewears';
    if (p.startsWith('SW')) return 'Disershop';
  }
  return null;
}

function quantile(arr, q) {
  if (!arr.length) return null;
  const sorted = [...arr].filter(x => x != null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function avg(arr) {
  const xs = arr.filter(x => x != null);
  return xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : null;
}

// Filtros: { dateFrom: 'YYYY-MM-DD'|null, dateTo, vendor, supplier }
export async function loadMetrics({ dateFrom = null, dateTo = null, vendor = null, supplier = null } = {}) {
  const supa = getSupa();
  // 1) Trae tarjetas que entran en el rango (created_at).
  // Excluye archivadas: una tarjeta archivada no cuenta en las métricas
  // (se restaura al desarchivar).
  let q = supa.from('production_cards')
    .select('id, created_at, vendor, stage_key, completed_at, product_lines, client_name')
    .is('archived_at', null)
    .order('created_at', { ascending: true });
  if (dateFrom) q = q.gte('created_at', dateFrom);
  if (dateTo)   q = q.lte('created_at', dateTo + 'T23:59:59');
  if (vendor)   q = q.eq('vendor', vendor);
  const { data: cards, error: ec } = await q;
  if (ec) throw ec;
  if (!cards || !cards.length) return { rows: [], summary: emptySummary() };

  // 2) Trae las transiciones de esas tarjetas
  const cardIds = cards.map(c => c.id);
  const { data: trans, error: et } = await supa
    .from('production_card_transitions')
    .select('card_id, field_changed, from_value, to_value, occurred_at')
    .in('card_id', cardIds)
    .order('occurred_at', { ascending: true });
  if (et) throw et;
  const byCard = {};
  for (const t of (trans || [])) (byCard[t.card_id] ||= []).push(t);

  // 3) Filtro opcional por proveedor (post-load, requiere product_lines)
  let filtered = cards;
  if (supplier) {
    filtered = cards.filter(c => inferSupplierFromLines(c.product_lines) === supplier);
  }

  // 4) Para cada tarjeta, calcular las 4 demoras
  const rows = filtered.map(c => {
    const ts = byCard[c.id] || [];
    const compraT = ts.find(t => t.field_changed === 'estado_stock'
                              && /^(Registrar|Comprar)/i.test(t.from_value || ''));
    const insumoT = ts.find(t => t.field_changed === 'estado_insumo'
                              && t.to_value && t.to_value !== 'No esta editado');
    const dtfT    = ts.find(t => t.field_changed === 'estado_insumo'
                              && /DTF/.test(t.to_value || ''));
    const entregaT = ts.find(t => t.field_changed === 'stage_key' && t.to_value === 'entregado');

    return {
      id: c.id,
      cliente: c.client_name,
      vendor: c.vendor,
      created_at: c.created_at,
      stage_key: c.stage_key,
      supplier: inferSupplierFromLines(c.product_lines),
      compraDays:  compraT  ? diffDays(c.created_at, compraT.occurred_at)  : null,
      insumoDays:  insumoT  ? diffDays(c.created_at, insumoT.occurred_at)  : null,
      dtfDays:     dtfT     ? diffDays(c.created_at, dtfT.occurred_at)     : null,
      entregaDays: entregaT ? diffDays(c.created_at, entregaT.occurred_at) :
                              c.completed_at ? diffDays(c.created_at, c.completed_at) : null,
    };
  });

  const summary = {
    compra:  { avg: avg(rows.map(r => r.compraDays)),  p50: quantile(rows.map(r => r.compraDays), 0.5),  p95: quantile(rows.map(r => r.compraDays), 0.95) },
    insumo:  { avg: avg(rows.map(r => r.insumoDays)),  p50: quantile(rows.map(r => r.insumoDays), 0.5),  p95: quantile(rows.map(r => r.insumoDays), 0.95) },
    dtf:     { avg: avg(rows.map(r => r.dtfDays)),     p50: quantile(rows.map(r => r.dtfDays), 0.5),     p95: quantile(rows.map(r => r.dtfDays), 0.95) },
    entrega: { avg: avg(rows.map(r => r.entregaDays)), p50: quantile(rows.map(r => r.entregaDays), 0.5), p95: quantile(rows.map(r => r.entregaDays), 0.95) },
    n: rows.length,
  };
  return { rows, summary };
}

function emptySummary() {
  return {
    compra:  { avg: null, p50: null, p95: null },
    insumo:  { avg: null, p50: null, p95: null },
    dtf:     { avg: null, p50: null, p95: null },
    entrega: { avg: null, p50: null, p95: null },
    n: 0,
  };
}

export function rowsToCsv(rows) {
  const headers = ['id','cliente','vendor','created_at','stage_key','supplier','compraDays','insumoDays','dtfDays','entregaDays'];
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(headers.map(h => {
      const v = r[h];
      if (v == null) return '';
      const s = String(v).replace(/"/g, '""');
      return s.includes(',') || s.includes('\n') ? `"${s}"` : s;
    }).join(','));
  }
  return lines.join('\n');
}
