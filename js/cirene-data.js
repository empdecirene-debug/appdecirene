// Capa de datos del ERP De Cirene sobre Supabase.
// Materiales, terminaciones, tarifas de mano de obra, plantillas de producto (BOM)
// y cotizaciones. TODA página de datos pasa por acá.

import { getSupa } from './supa.js?v=5';
import { normalizePhoneUY } from './phone-normalizer.js?v=5';

const db = () => getSupa();

// Número seguro (0 si no lo es) y número-o-NULL (para columnas opcionales:
// una dimensión vacía tiene que guardarse como NULL, no como 0).
const num = (x) => { const v = parseFloat(x); return Number.isFinite(v) ? v : 0; };
const numOrNull = (x) => {
  if (x === null || x === undefined || x === '') return null;
  const v = parseFloat(x);
  return Number.isFinite(v) ? v : null;
};

// Id del usuario logueado (para las columnas `updated_by`). Nunca tira.
async function currentUserId() {
  try { const { data } = await db().auth.getUser(); return data?.user?.id || null; }
  catch { return null; }
}

/* ───────────── Auditoría ─────────────
   Deja constancia de las operaciones importantes: quién, cuándo, qué y sobre
   qué registro. Nunca tira: una auditoría que falla no puede voltear la
   operación que la disparó. */
export async function auditar(action, { entity_type, entity_id, details } = {}) {
  try {
    const sb = db();
    const { data } = await sb.auth.getUser();
    const user = data?.user || null;
    await sb.from('audit_log').insert({
      user_id: user?.id || null, user_label: user?.full_name || user?.email || 'sistema',
      action, entity_type: entity_type || null, entity_id: entity_id ? String(entity_id) : null,
      details: details || null, status: 'ok',
    });
  } catch (e) { console.warn('[auditoría]', action, e.message); }
}

/* ───────────── Materiales ─────────────
   FUENTE ÚNICA. El Catálogo y el Cotizador escriben sobre esta misma tabla: crear
   un material desde una cotización actualiza el catálogo, no hace una copia. */
export async function listMaterials({ search = '', incluirInactivos = false } = {}) {
  let q = db().from('materials').select('*').order('tipo').order('nombre');
  if (!incluirInactivos) q = q.eq('activo', true);
  const { data, error } = await q;
  if (error) throw error;
  let rows = data || [];
  if (search) {
    const s = search.toLowerCase();
    rows = rows.filter(m => (m.nombre + ' ' + (m.tipo || '') + ' ' + (m.proveedor || '')).toLowerCase().includes(s));
  }
  return rows;
}
// Guarda un material. Sin `id` inserta; con `id` actualiza. Sella `updated_by`
// (la fecha la pone el trigger `trg_materials_updated`).
export async function upsertMaterial(m) {
  const sb = db();
  const row = { ...m, updated_by: await currentUserId() };
  if (row.id) {
    // Se guarda el costo anterior para que el cambio de precio quede auditado.
    const antes = (await sb.from('materials').select('nombre,precio_unit').eq('id', row.id).single()).data;
    const { id, ...patch } = row;
    const { data, error } = await sb.from('materials').update(patch).eq('id', id).select().single();
    if (error) throw error;
    if (antes && num(antes.precio_unit) !== num(data.precio_unit)) {
      auditar('material_costo_cambio', {
        entity_type: 'material', entity_id: id,
        details: { nombre: data.nombre, antes: num(antes.precio_unit), ahora: num(data.precio_unit) },
      });
    }
    return data;
  }
  delete row.id;
  const { data, error } = await sb.from('materials').insert(row).select().single();
  if (error) throw error;
  auditar('material_alta', { entity_type: 'material', entity_id: data.id, details: { nombre: data.nombre, precio_unit: num(data.precio_unit) } });
  return data;
}
export async function deleteMaterial(id) {
  const { error } = await db().from('materials').delete().eq('id', id);
  if (error) throw error;
}

/* ───────────── Terminaciones / pintado ─────────────
   Reemplaza al viejo sí/no de "pintado". Se administran desde Catálogo y el
   cotizador solo las elige; el costo entra al costo del producto. */
export async function listFinishes({ incluirInactivas = false } = {}) {
  let q = db().from('finishes').select('*').order('display_order').order('nombre');
  if (!incluirInactivas) q = q.eq('activo', true);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}
export async function upsertFinish(f) {
  const sb = db();
  const row = { ...f, updated_by: await currentUserId() };
  if (row.id) {
    const antes = (await sb.from('finishes').select('nombre,costo').eq('id', row.id).single()).data;
    const { id, ...patch } = row;
    const { data, error } = await sb.from('finishes').update(patch).eq('id', id).select().single();
    if (error) throw error;
    if (antes && num(antes.costo) !== num(data.costo)) {
      auditar('terminacion_costo_cambio', {
        entity_type: 'finish', entity_id: id,
        details: { nombre: data.nombre, antes: num(antes.costo), ahora: num(data.costo) },
      });
    }
    return data;
  }
  delete row.id;
  const { data, error } = await sb.from('finishes').insert(row).select().single();
  if (error) throw error;
  return data;
}
// Baja lógica: una cotización vieja tiene que seguir mostrando su terminación.
export async function deleteFinish(id) {
  const { error } = await db().from('finishes').update({ activo: false }).eq('id', id);
  if (error) throw error;
}

/* ───────────── Mano de obra ───────────── */
export async function listLaborRates({ incluirInactivos = false } = {}) {
  let q = db().from('labor_rates').select('*').order('display_order');
  if (!incluirInactivos) q = q.eq('activo', true);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}
export async function upsertLaborRate(r) {
  const sb = db();
  const row = { ...r, updated_by: await currentUserId() };
  if (row.id) {
    const antes = (await sb.from('labor_rates').select('rol,costo_hora').eq('id', row.id).single()).data;
    const { id, ...patch } = row;
    const { data, error } = await sb.from('labor_rates').update(patch).eq('id', id).select().single();
    if (error) throw error;
    if (antes && num(antes.costo_hora) !== num(data.costo_hora)) {
      auditar('mano_obra_costo_cambio', {
        entity_type: 'labor_rate', entity_id: id,
        details: { rol: data.rol, antes: num(antes.costo_hora), ahora: num(data.costo_hora) },
      });
    }
    return data;
  }
  delete row.id;
  const { data, error } = await sb.from('labor_rates').insert(row).select().single();
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

/* ───────────── Cotizaciones ─────────────
   Guardar es IDEMPOTENTE: la primera vez inserta (Postgres asigna `numero` desde
   la secuencia `quotes_numero_seq` y el trigger arma el id COT-XXXX); a partir de
   ahí SIEMPRE actualiza la misma fila. Apretar Guardar dos veces, recargar o
   volver a abrir la cotización nunca crea una cotización nueva. */

// Convierte una línea del estado del cotizador a fila de `quote_lines`.
function lineaARow(l, quoteId, i) {
  return {
    quote_id: quoteId,
    template_id: l.templateId || l.template_id || null,
    producto: l.producto || 'Producto',
    es_estandar: !!l.es_estandar,
    tamano: l.tamano || null,
    cantidad: num(l.cantidad) || 1,

    // Dimensiones de fabricación (no afectan el precio; viajan a Producción).
    ancho: numOrNull(l.ancho), ancho_unidad: l.anchoUnidad || 'cm',
    alto: numOrNull(l.alto), alto_unidad: l.altoUnidad || 'cm',
    largo: numOrNull(l.largo), largo_unidad: l.largoUnidad || 'cm',
    diametro: numOrNull(l.diametro), diametro_unidad: l.diametroUnidad || 'cm',
    comentarios_produccion: l.comentariosProduccion || null,

    // Terminación: id + snapshot de nombre y costo al momento de presupuestar.
    terminacion_id: l.terminacionId || null,
    terminacion_nombre: l.terminacionNombre || null,
    terminacion_costo: num(l.terminacionCosto),
    costo_terminacion: num(l.costoTerminacion),
    // Compatibilidad con datos históricos: se sigue marcando si hay terminación.
    pintado: !!l.terminacionId,

    materiales: l.materiales || [],
    mano_obra: l.manoObra || [],
    especificaciones: l.especificaciones || null,

    costo_materiales: num(l.costoMateriales), costo_mo: num(l.costoMO),
    costo_directo: num(l.costoDirecto), multiplicador: num(l.multiplicador) || 1.5,
    precio_venta: num(l.precioVenta), display_order: i,
  };
}

// Fila de `quote_lines` → objeto del estado del cotizador (el viaje de vuelta).
export function rowALinea(l) {
  return {
    id: l.id,
    producto: l.producto, templateId: l.template_id, es_estandar: l.es_estandar,
    tamano: l.tamano || '', cantidad: num(l.cantidad) || 1,
    ancho: l.ancho ?? '', anchoUnidad: l.ancho_unidad || 'cm',
    alto: l.alto ?? '', altoUnidad: l.alto_unidad || 'cm',
    largo: l.largo ?? '', largoUnidad: l.largo_unidad || 'cm',
    diametro: l.diametro ?? '', diametroUnidad: l.diametro_unidad || 'cm',
    comentariosProduccion: l.comentarios_produccion || '',
    terminacionId: l.terminacion_id || null,
    terminacionNombre: l.terminacion_nombre || '',
    terminacionCosto: num(l.terminacion_costo),
    materiales: l.materiales || [], manoObra: l.mano_obra || [],
    especificaciones: l.especificaciones || '',
    multiplicador: num(l.multiplicador) || 1.5,
  };
}

export async function saveQuote(quote, lines) {
  const sb = db();
  const uid = await currentUserId();
  let saved;

  if (quote.id) {
    // Ya existe: actualizar SIEMPRE la misma fila.
    const { id, numero, created_at, ...patch } = quote;
    patch.updated_by = uid;
    const { data, error } = await sb.from('quotes').update(patch).eq('id', id).select().single();
    if (error) throw new Error('No se pudo guardar la cotización ' + id + ': ' + error.message);
    saved = data;
  } else {
    // Nueva: id y número los asigna Postgres (secuencia + trigger). Sin carreras.
    const { id, numero, created_at, ...row } = quote;
    row.updated_by = uid;
    // El vendedor queda sellado al crear: editarla después no cambia a quién se le imputa.
    if (!row.vendedor_user_id) row.vendedor_user_id = uid;
    const { data, error } = await sb.from('quotes').insert(row).select().single();
    if (error) throw new Error('No se pudo crear la cotización: ' + error.message);
    saved = data;
  }
  if (!saved?.id) throw new Error('La base no devolvió la cotización guardada');

  // Las líneas se reescriben completas (son hijas de la cotización).
  const { error: eDel } = await sb.from('quote_lines').delete().eq('quote_id', saved.id);
  if (eDel && !/no se encontr/i.test(eDel.message || '')) throw eDel;
  if (lines?.length) {
    const { error: eIns } = await sb.from('quote_lines').insert(lines.map((l, i) => lineaARow(l, saved.id, i)));
    if (eIns) throw new Error('La cotización se guardó pero fallaron los ítems: ' + eIns.message);
  }
  auditar(quote.id ? 'cotizacion_editada' : 'cotizacion_creada', {
    entity_type: 'quote', entity_id: saved.id,
    details: { cliente: saved.cliente_nombre, total: num(saved.precio_venta), estado: saved.estado, items: lines?.length || 0 },
  });
  return saved;
}

export async function listQuotes() {
  const { data, error } = await db().from('quotes').select('*').order('created_at', { ascending: false }).limit(200);
  if (error) throw error;
  return data || [];
}
export async function getQuote(id) {
  const sb = db();
  const [{ data: q, error: e1 }, { data: lines, error: e2 }] = await Promise.all([
    sb.from('quotes').select('*').eq('id', id).single(),
    sb.from('quote_lines').select('*').eq('quote_id', id).order('display_order'),
  ]);
  if (e1) throw new Error('No se pudo abrir la cotización ' + id + ': ' + e1.message);
  if (e2) throw new Error('No se pudieron leer los ítems de ' + id + ': ' + e2.message);
  if (!q) throw new Error('La cotización ' + id + ' no existe');
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
// Guarda un cliente. El teléfono se normaliza SIEMPRE a E.164: es el
// identificador que evita fichas duplicadas del mismo cliente.
export async function upsertClient(c) {
  const sb = db();
  let row = { ...c };
  if (row.telefono !== undefined || row.telefono_e164 !== undefined) {
    row.telefono_e164 = normalizePhoneUY(row.telefono_e164 || row.telefono) || null;
  }
  if (row.es_interno === undefined) {
    row.es_interno = /CIRENEO/i.test((row.nombre || '') + ' ' + (row.empresa || ''));
  }
  // Antes de crear, se verifica que ese teléfono no tenga ya una ficha.
  if (row.telefono_e164) {
    const { data: ya } = await sb.from('clients').select('id,nombre').eq('telefono_e164', row.telefono_e164).limit(1);
    const otro = ya && ya[0];
    if (otro && otro.id !== row.id) {
      throw new Error(`Ya existe el cliente "${otro.nombre}" con ese teléfono. Editá esa ficha en vez de crear otra.`);
    }
  }
  if (!row.id) {
    const { data: { user } } = await sb.auth.getUser();
    row.vendedor_user_id = user?.id || null;
    if (!row.vendedor) row.vendedor = await currentVendorName();
    if (!row.origen) row.origen = 'cotizador';
    const { data, error } = await sb.from('clients').insert(row).select().single();
    if (error) throw error;
    return data;
  }
  const { id, ...patch } = row;
  const { data, error } = await sb.from('clients').update(patch).eq('id', id).select().single();
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
// Crear un lead SIEMPRE deja: cliente (sin duplicar) + lead + cotización borrador.
// El teléfono es obligatorio porque es el identificador del cliente.
export async function createIntakeCard(card) {
  const { data: { user } } = await db().auth.getUser();
  const e164 = normalizePhoneUY(card.client_phone_e164 || card.telefono);
  if (!e164) throw new Error('El teléfono es obligatorio y tiene que ser válido (ej: 099 123 456)');

  const cliente = await ensureClient({
    nombre: card.client_query, telefono: e164, email: card.client_email,
    direccion: card.direccion || null, origen: 'crm',
  });

  const row = {
    id: newId('in'), stage_key: 'mensaje_entrante', status: 'abierta',
    vendor: card.vendor || 'Comercial', vendor_user_id: user?.id || null,
    ...card, client_phone_e164: e164, client_id: cliente.id,
  };
  delete row.telefono; delete row.direccion;
  const { data, error } = await db().from('intake_cards').insert(row).select().single();
  if (error) throw new Error('No se pudo crear la consulta: ' + error.message);

  // Cada mensaje entrante nace con su cotización en borrador (requisito 6).
  try {
    const q = await ensureDraftQuote(data);
    data.resulting_quote_id = q.id;
  } catch (e) { console.warn('[crm] no se pudo crear la cotización borrador:', e.message); }
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
  if (stage_key === 'entregado') {
    patch.completed_at = new Date().toISOString();
    patch.fecha_real_fin = new Date().toISOString().slice(0, 10);
  }
  const card = await saveProductionCard({ id, ...patch });
  // Al entregar: la venta pasa a "entregada" y queda lista la encuesta NPS.
  if (stage_key === 'entregado') {
    try {
      if (card.sale_id) await db().from('sales').update({ estado: 'entregada' }).eq('id', card.sale_id);
      await ensureNpsSurvey(card, null);
    } catch (e) { console.warn('[produccion] cierre de entrega:', e.message); }
  }
  return card;
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
  if (error) throw new Error('No se pudo publicar el comentario: ' + error.message);

  // Comercial y Producción conversan dentro de la tarjeta: avisamos a todos los
  // que ya participaron y al vendedor, menos al que acaba de escribir.
  try {
    const [{ data: previos }, { data: card }] = await Promise.all([
      sb.from('card_stories').select('user_id').eq('card_id', cardId).eq('type', 'comment'),
      sb.from('production_cards').select('client_name,vendor_user_id').eq('id', cardId).single(),
    ]);
    const destinos = [...(previos || []).map(p => p.user_id), card?.vendor_user_id]
      .filter(u => u && u !== user?.id);
    await notificar(destinos, {
      tipo: 'comentario',
      titulo: `${label} comentó en ${card?.client_name || cardId}`,
      cuerpo: String(notes || '').slice(0, 180),
      url: `/production.html?card=${cardId}`,
      entity_type: 'production_card', entity_id: cardId,
    });
  } catch (e) { console.warn('[comentarios] aviso', e.message); }
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
//
// IDEMPOTENTE: si el lead ya derivó en una tarjeta (o la cotización ya tiene una),
// devuelve ESA en vez de crear otra. Mover la tarjeta dos veces o recargar la página
// no puede generar dos pedidos de producción.
export async function createProductionFromIntake(intake, quote) {
  const sb = db();

  // ¿Ya existe? Se busca por las dos puntas: el lead y la cotización.
  const yaId = intake?.resulting_production_card_id || quote?.production_card_id || null;
  if (yaId) {
    const { data: ya } = await sb.from('production_cards').select('*').eq('id', yaId).single();
    if (ya) return ya;
  }
  const { data: porLead } = await sb.from('production_cards').select('*').eq('intake_card_id', intake.id).limit(1);
  if (porLead && porLead[0]) return porLead[0];

  const { data: { user } } = await sb.auth.getUser();
  const lines = [];
  if (quote) {
    const { data: ql } = await sb.from('quote_lines').select('*').eq('quote_id', quote.id).order('display_order');
    // Todo lo que Producción necesita para FABRICAR viaja acá: dimensiones,
    // terminación y los comentarios que escribió el comercial.
    (ql || []).forEach(l => lines.push({
      quote_line_id: l.id,
      producto: l.producto,
      cantidad: n(l.cantidad) || 1,
      precio: n(l.precio_venta),
      dimensiones: {
        ancho: l.ancho, ancho_unidad: l.ancho_unidad,
        alto: l.alto, alto_unidad: l.alto_unidad,
        largo: l.largo, largo_unidad: l.largo_unidad,
        diametro: l.diametro, diametro_unidad: l.diametro_unidad,
      },
      tamano: l.tamano || null,
      terminacion: l.terminacion_nombre || null,
      comentarios_produccion: l.comentarios_produccion || null,
      materiales: l.materiales || [],
      mano_obra: l.mano_obra || [],
    }));
  }
  const notasProd = [
    quote?.comentarios_produccion || '',
    quote?.colocacion_comentarios ? 'Colocación: ' + quote.colocacion_comentarios : '',
  ].filter(Boolean).join('\n');

  const card = {
    id: newId('pr'), source: 'quote_approved', stage_key: 'procesar',
    vendor: intake.vendor, vendor_user_id: user?.id || null,
    intake_card_id: intake.id, quote_id: quote?.id || null,
    client_name: intake.client_query, client_phone_e164: intake.client_phone_e164 || (quote?.cliente_telefono || null),
    direccion: quote?.cliente_direccion || null,
    description: [intake.description || '', notasProd].filter(Boolean).join('\n') || null,
    product_lines: lines, total_venta: quote?.precio_venta || 0, estado_pago: 'NO',
    due_date: intake.target_date || null, billing_month: new Date().toISOString().slice(0, 7),
  };
  const { data: pc, error } = await sb.from('production_cards').insert(card).select().single();
  if (error) throw new Error('No se pudo crear el pedido de producción: ' + error.message);
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
  // La cuenta a cobrar del pedido, si existe, queda enganchada al cobro.
  const rec = await getReceivableByCard(card.id).catch(() => null);
  const { data: pay, error } = await sb.from('job_payments').insert({ production_card_id: card.id, tipo, monto, metodo: metodo || null, fecha: fecha || today(), cash_session_id: ses?.id || null, registrado_por: user?.id || null, receivable_id: rec?.id || null }).select().single();
  if (error) throw new Error('No se pudo registrar el cobro: ' + error.message);
  await sb.from('cash_movements').insert({ tipo: 'ingreso', categoria: 'venta', monto, metodo: metodo || null, fecha: fecha || today(), production_card_id: card.id, job_payment_id: pay.id, cash_session_id: ses?.id || null, descripcion: 'Cobro ' + (card.client_name || card.id), registrado_por: user?.id || null });
  const bal = await jobBalance(card);
  await sb.from('production_cards').update({ estado_pago: bal.estado, contabilidad: 'Agregado' }).eq('id', card.id);
  if (rec) {
    const cobrado = bal.pagado;
    const patch = { cobrado, saldo: Math.max(0, num(rec.monto) - cobrado) };
    if (tipo === 'sena' && !rec.fecha_sena) { patch.monto_sena = num(monto); patch.fecha_sena = fecha || today(); }
    await sb.from('receivables').update(patch).eq('id', rec.id);
  }
  auditar('cobro_registrado', {
    entity_type: 'production_card', entity_id: card.id,
    details: { tipo, monto: num(monto), metodo: metodo || null, saldo: bal.saldo },
  });
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

/* ═══════════════════════════════════════════════════════════════════════
   AMPLIACIÓN FASES 2 a 7
   CRM/Clientes · Ventas · Producción · Abastecimiento · Finanzas · NPS
   ═══════════════════════════════════════════════════════════════════════ */

/* ───────────── Fechas y semanas ─────────────
   La planificación de producción es SEMANAL (la capacidad diaria varía demasiado
   como para prometer por día). Semana ISO: 'YYYY-Www'. */
export function semanaISO(d = new Date()) {
  const f = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dia = f.getUTCDay() || 7;           // lunes = 1 … domingo = 7
  f.setUTCDate(f.getUTCDate() + 4 - dia);   // jueves de esa semana
  const inicioAnio = new Date(Date.UTC(f.getUTCFullYear(), 0, 1));
  const semana = Math.ceil(((f - inicioAnio) / 86400000 + 1) / 7);
  return `${f.getUTCFullYear()}-W${String(semana).padStart(2, '0')}`;
}
// 'YYYY-Www' → { desde: Date(lunes), hasta: Date(domingo) }
export function rangoSemana(semana) {
  const m = /^(\d{4})-W(\d{1,2})$/.exec(semana || '');
  if (!m) return null;
  const [, anio, sem] = m;
  const cuatroEnero = new Date(Date.UTC(+anio, 0, 4));
  const diaSemana = cuatroEnero.getUTCDay() || 7;
  const lunesSemana1 = new Date(cuatroEnero);
  lunesSemana1.setUTCDate(cuatroEnero.getUTCDate() - diaSemana + 1);
  const desde = new Date(lunesSemana1);
  desde.setUTCDate(lunesSemana1.getUTCDate() + (+sem - 1) * 7);
  const hasta = new Date(desde);
  hasta.setUTCDate(desde.getUTCDate() + 6);
  return { desde, hasta };
}
export function etiquetaSemana(semana) {
  const r = rangoSemana(semana);
  if (!r) return semana || '—';
  const f = (d) => d.toISOString().slice(8, 10) + '/' + d.toISOString().slice(5, 7);
  return `${f(r.desde)} – ${f(r.hasta)}`;
}
export function semanasAlrededor(cantidad = 8, desdeOffset = -1) {
  const out = [];
  const hoy = new Date();
  for (let i = desdeOffset; i < desdeOffset + cantidad; i++) {
    const d = new Date(hoy); d.setDate(hoy.getDate() + i * 7);
    out.push(semanaISO(d));
  }
  return out;
}
// Días que faltan para una fecha (negativo = vencida).
export function diasHasta(fecha) {
  if (!fecha) return null;
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const f = new Date(fecha + (String(fecha).length === 10 ? 'T00:00:00' : ''));
  if (isNaN(f)) return null;
  return Math.round((f - hoy) / 86400000);
}
// Escala de urgencia por cercanía (requisito 14). NO cambia el estado del pedido.
export function urgenciaPorFecha(fecha) {
  const d = diasHasta(fecha);
  if (d === null) return { nivel: 'sin', color: '#C9CCD1', label: 'Sin fecha' };
  if (d < 0)   return { nivel: 'vencida', color: '#A33A3A', label: `Vencida hace ${-d} d` };
  if (d <= 2)  return { nivel: 'critica', color: '#D2691E', label: d === 0 ? 'Hoy' : `En ${d} d` };
  if (d <= 7)  return { nivel: 'cerca',   color: '#C9A227', label: `En ${d} d` };
  return          { nivel: 'lejos',   color: '#2E7D46', label: `En ${d} d` };
}

/* ───────────── Clientes: una sola ficha por teléfono ─────────────
   El teléfono normalizado a E.164 es el identificador. Así "099 123 456",
   "+59899123456" y "099-123-456" son el MISMO cliente. */
export { normalizePhoneUY };

export async function findClientByPhone(telefono) {
  const e164 = normalizePhoneUY(telefono);
  if (!e164) return null;
  const { data } = await db().from('clients').select('*').eq('telefono_e164', e164).limit(1);
  return (data && data[0]) || null;
}

// Devuelve el cliente existente con ese teléfono o crea uno nuevo. Nunca duplica.
export async function ensureClient({ nombre, telefono, email, direccion, empresa, origen = 'crm' }) {
  const e164 = normalizePhoneUY(telefono);
  if (!e164) throw new Error('El teléfono no es válido. Ej: 099 123 456');
  const existente = await findClientByPhone(telefono);
  if (existente) {
    // Se completa lo que falte, pero no se pisa lo que ya estaba cargado.
    const patch = {};
    if (!existente.email && email) patch.email = email;
    if (!existente.direccion && direccion) patch.direccion = direccion;
    if (!existente.empresa && empresa) patch.empresa = empresa;
    if (Object.keys(patch).length) {
      const { data } = await db().from('clients').update(patch).eq('id', existente.id).select().single();
      return data || existente;
    }
    return existente;
  }
  const esInterno = /CIRENEO/i.test((nombre || '') + ' ' + (empresa || ''));
  return upsertClient({
    nombre: (nombre || '').trim() || e164, empresa: empresa || null, telefono: telefono || null,
    telefono_e164: e164, email: email || null, direccion: direccion || null,
    es_interno: esInterno, origen, activo: true,
  });
}

/* ───────────── CRM: cotización asociada al lead ─────────────
   Cada lead tiene su cotización. Si todavía no se trabajó, es un BORRADOR vacío
   que se puede abrir, editar y guardar las veces que haga falta. */
export async function ensureDraftQuote(intake) {
  const ya = await getQuoteByIntake(intake.id);
  if (ya) return ya;
  const sb = db();
  const uid = await currentUserId();
  const { data, error } = await sb.from('quotes').insert({
    estado: 'borrador',
    cliente_nombre: intake.client_query || null,
    cliente_contacto: intake.client_phone_e164 || null,
    cliente_telefono: intake.client_phone_e164 || null,
    cliente_id: intake.client_id || null,
    vendedor: intake.vendor || null, vendedor_user_id: intake.vendor_user_id || uid,
    intake_card_id: intake.id, updated_by: uid,
  }).select().single();
  if (error) throw new Error('No se pudo crear la cotización del lead: ' + error.message);
  await sb.from('intake_cards').update({ resulting_quote_id: data.id }).eq('id', intake.id);
  return data;
}

/* ───────────── Lead ganado → Venta → Producción → Cuenta a cobrar ─────────────
   TODO idempotente. Mover la tarjeta dos veces, recargar o reintentar deja
   exactamente UNA venta, UN pedido de producción y UNA cuenta a cobrar. */
export async function winLead(intake) {
  const sb = db();
  const quote = await getQuoteByIntake(intake.id);
  const card = await createProductionFromIntake(intake, quote);

  // 1) Venta (unique por quote_id y por production_card_id)
  let sale = null;
  if (quote?.id) {
    const { data } = await sb.from('sales').select('*').eq('quote_id', quote.id).limit(1);
    sale = (data && data[0]) || null;
  }
  if (!sale) {
    const { data } = await sb.from('sales').select('*').eq('production_card_id', card.id).limit(1);
    sale = (data && data[0]) || null;
  }
  if (!sale) {
    const uid = await currentUserId();
    const fecha = new Date().toISOString().slice(0, 10);
    const { data, error } = await sb.from('sales').insert({
      quote_id: quote?.id || null, intake_card_id: intake.id, production_card_id: card.id,
      client_id: intake.client_id || quote?.cliente_id || null,
      cliente_nombre: intake.client_query || quote?.cliente_nombre || null,
      vendedor: intake.vendor || quote?.vendedor || null,
      vendedor_user_id: quote?.vendedor_user_id || intake.vendor_user_id || uid,
      monto: n(quote?.precio_venta) || n(card.total_venta),
      fecha, billing_month: fecha.slice(0, 7), estado: 'confirmada',
    }).select().single();
    if (error) throw new Error('No se pudo registrar la venta: ' + error.message);
    sale = data;
  }

  // 2) La tarjeta y el lead apuntan a la venta
  await sb.from('production_cards').update({ sale_id: sale.id, client_id: sale.client_id || null }).eq('id', card.id);
  await sb.from('intake_cards').update({
    stage_key: 'lead_ganado', status: 'aceptada', won_at: new Date().toISOString(),
    sale_id: sale.id, resulting_production_card_id: card.id,
    resulting_quote_id: quote?.id || intake.resulting_quote_id || null,
  }).eq('id', intake.id);

  // 3) Cuenta a cobrar / factura interna
  const receivable = await ensureReceivable(card, sale, quote);

  auditar('lead_ganado', {
    entity_type: 'intake_card', entity_id: intake.id,
    details: { venta: sale.id, pedido: card.id, cotizacion: quote?.id || null, monto: num(sale.monto) },
  });
  return { sale, card, receivable, quote };
}

/* ───────────── Operarios ───────────── */
export async function listOperators({ incluirInactivos = false } = {}) {
  let q = db().from('operators').select('*').order('nombre');
  if (!incluirInactivos) q = q.eq('activo', true);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}
export async function upsertOperator(o) {
  const sb = db();
  const row = { ...o, updated_by: await currentUserId() };
  if (row.id) {
    const { id, ...patch } = row;
    const { data, error } = await sb.from('operators').update(patch).eq('id', id).select().single();
    if (error) throw error;
    return data;
  }
  delete row.id;
  const { data, error } = await sb.from('operators').insert(row).select().single();
  if (error) throw error;
  return data;
}

/* ───────────── Subtareas de producción ─────────────
   Inicio / Pausa / Fin con timestamps reales: de ahí sale la productividad. */
export async function listSubtasks(cardId) {
  const { data, error } = await db().from('production_subtasks').select('*')
    .eq('card_id', cardId).order('display_order');
  if (error) throw error;
  return data || [];
}
export async function listAllSubtasks() {
  const { data, error } = await db().from('production_subtasks').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}
export async function saveSubtask(t) {
  const sb = db();
  if (t.id) {
    const { id, ...patch } = t;
    const { data, error } = await sb.from('production_subtasks').update(patch).eq('id', id).select().single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await sb.from('production_subtasks').insert(t).select().single();
  if (error) throw error;
  return data;
}
export async function deleteSubtask(id) {
  const { error } = await db().from('production_subtasks').delete().eq('id', id);
  if (error) throw error;
}
// Plantilla del taller: el gerente parte el pedido con un clic y después ajusta.
export const SUBTAREAS_ESTANDAR = ['Corte', 'Preparación', 'Soldadura', 'Pulido', 'Pintura', 'Armado', 'Colocación'];

export async function startSubtask(t) {
  if (t.estado === 'en_curso') return t;
  const ahora = new Date().toISOString();
  const sb = db();
  const saved = await saveSubtask({
    id: t.id, estado: 'en_curso', last_started_at: ahora,
    started_at: t.started_at || ahora, finished_at: null,
  });
  await sb.from('subtask_time_logs').insert({
    subtask_id: t.id, card_id: t.card_id, operator_id: t.operator_id || null, started_at: ahora,
  });
  return saved;
}
// Cierra el tramo abierto y acumula los segundos trabajados.
async function cerrarTramo(t, motivo) {
  const sb = db();
  const fin = new Date();
  const ini = t.last_started_at ? new Date(t.last_started_at) : null;
  const segundos = ini ? Math.max(0, Math.round((fin - ini) / 1000)) : 0;
  if (ini) {
    const { data: abiertos } = await sb.from('subtask_time_logs').select('*')
      .eq('subtask_id', t.id).is('ended_at', null).order('started_at', { ascending: false }).limit(1);
    const log = abiertos && abiertos[0];
    if (log) {
      await sb.from('subtask_time_logs').update({
        ended_at: fin.toISOString(), segundos, motivo_fin: motivo,
      }).eq('id', log.id);
    }
  }
  return { segundos, fin };
}
export async function pauseSubtask(t) {
  if (t.estado !== 'en_curso') return t;
  const { segundos } = await cerrarTramo(t, 'pausa');
  const saved = await saveSubtask({
    id: t.id, estado: 'pausada', last_started_at: null,
    segundos_trabajados: (t.segundos_trabajados || 0) + segundos,
  });
  await recalcularHorasReales(t.card_id);
  return saved;
}
export async function finishSubtask(t) {
  const suma = t.estado === 'en_curso' ? (await cerrarTramo(t, 'fin')).segundos : 0;
  const saved = await saveSubtask({
    id: t.id, estado: 'terminada', last_started_at: null,
    finished_at: new Date().toISOString(),
    segundos_trabajados: (t.segundos_trabajados || 0) + suma,
  });
  await recalcularHorasReales(t.card_id);
  return saved;
}
// Las horas reales del pedido salen SIEMPRE de las subtareas, no de un campo suelto.
export async function recalcularHorasReales(cardId) {
  const tareas = await listSubtasks(cardId);
  const horas = tareas.reduce((s, t) => s + n(t.segundos_trabajados), 0) / 3600;
  await db().from('production_cards').update({ horas_reales: Math.round(horas * 100) / 100 }).eq('id', cardId);
  return horas;
}
// Segundos trabajados incluyendo el tramo en curso (para mostrar el cronómetro).
export function segundosSubtarea(t) {
  const base = n(t.segundos_trabajados);
  if (t.estado === 'en_curso' && t.last_started_at) {
    return base + Math.max(0, Math.round((Date.now() - new Date(t.last_started_at).getTime()) / 1000));
  }
  return base;
}
export function hhmm(segundos) {
  const s = Math.max(0, Math.round(segundos));
  return String(Math.floor(s / 3600)).padStart(2, '0') + ':' + String(Math.floor((s % 3600) / 60)).padStart(2, '0');
}

/* ───────────── Capacidad semanal y semáforo ───────────── */
export async function listWeeks() {
  const { data, error } = await db().from('production_weeks').select('*').order('semana', { ascending: false }).limit(60);
  if (error) throw error;
  return data || [];
}
export async function upsertWeek(w) {
  const sb = db();
  const row = { ...w, updated_by: await currentUserId() };
  const { data: ya } = await sb.from('production_weeks').select('semana').eq('semana', row.semana).limit(1);
  if (ya && ya[0]) {
    const { semana, ...patch } = row;
    const { data, error } = await sb.from('production_weeks').update(patch).eq('semana', semana).select().single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await sb.from('production_weeks').insert(row).select().single();
  if (error) throw error;
  return data;
}

// Semáforo de capacidad: compara el PLAN contra la capacidad REAL de esa semana.
//   verde    → la capacidad alcanza
//   amarillo → ajustado: hay que priorizar
//   rojo     → no da: hay pedidos para reprogramar
// Un cumplimiento bajo NO es automáticamente bajo rendimiento: por eso se
// devuelven las dos cosas (cumplimiento y capacidad disponible) por separado.
export function semaforoSemana({ semana, week, cards }) {
  const dela = (cards || []).filter(c => c.semana_produccion === semana);
  const planificadas = dela.reduce((s, c) => s + n(c.horas_estimadas), 0);
  const realizadas = dela.reduce((s, c) => s + n(c.horas_reales), 0);
  const prevista = n(week?.capacidad_prevista_horas);
  const real = n(week?.capacidad_real_horas) || prevista;

  const terminadas = dela.filter(c => c.stage_key === 'entregado' || c.fecha_real_fin).length;
  const cumplimiento = dela.length ? (terminadas / dela.length) * 100 : 0;

  // Producción adicional: lo que se hizo por encima de lo planificado (trabajo
  // adelantado tomado de la cola, no un error de planificación).
  const adicional = Math.max(0, realizadas - planificadas);

  const hoy = new Date().toISOString().slice(0, 10);
  const atrasados = dela.filter(c => {
    const lim = c.fecha_objetivo_interna || c.due_date;
    return lim && lim < hoy && c.stage_key !== 'entregado' && c.stage_key !== 'cancelado';
  });
  const prioritarios = dela.filter(c => c.priority === 'urgente' || (c.due_date && c.due_date <= hoy));

  let estado = 'verde';
  if (week?.semaforo_manual) estado = week.semaforo_manual;
  else if (!real && planificadas > 0) estado = 'amarillo';
  else if (planificadas > real * 1.1) estado = 'rojo';
  else if (planificadas > real * 0.9) estado = 'amarillo';

  return {
    semana, prevista, real, planificadas, realizadas, adicional,
    cumplimiento, terminadas, total: dela.length,
    atrasados, prioritarios, cards: dela, estado,
    holgura: real - planificadas,
  };
}
export const SEMAFORO = {
  verde:    { emoji: '🟢', label: 'Capacidad normal',  color: '#2E7D46', ayuda: 'Equipo estable: alcanza para avanzar según el plan.' },
  amarillo: { emoji: '🟡', label: 'Capacidad reducida', color: '#C9A227', ayuda: 'Faltas o menor rendimiento: priorizar lo más urgente.' },
  rojo:     { emoji: '🔴', label: 'Capacidad crítica',  color: '#A33A3A', ayuda: 'No alcanza: hay que reprogramar pedidos.' },
};

/* ───────────── Proveedores ───────────── */
export async function listSuppliers({ incluirInactivos = false } = {}) {
  let q = db().from('suppliers').select('*').order('nombre');
  if (!incluirInactivos) q = q.eq('activo', true);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}
export async function upsertSupplier(s) {
  const sb = db();
  const row = { ...s };
  if (row.id) {
    const { id, ...patch } = row;
    const { data, error } = await sb.from('suppliers').update(patch).eq('id', id).select().single();
    if (error) throw error;
    return data;
  }
  delete row.id;
  const { data, error } = await sb.from('suppliers').insert(row).select().single();
  if (error) throw error;
  return data;
}

/* ───────────── Órdenes de compra ───────────── */
export async function listPurchaseOrders({ estado, supplierId } = {}) {
  let q = db().from('purchase_orders').select('*').order('fecha', { ascending: false }).limit(300);
  if (estado) q = q.eq('estado', estado);
  if (supplierId) q = q.eq('supplier_id', supplierId);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}
export async function getPurchaseOrder(id) {
  const sb = db();
  const [{ data: oc, error: e1 }, { data: lines }] = await Promise.all([
    sb.from('purchase_orders').select('*').eq('id', id).single(),
    sb.from('purchase_order_lines').select('*').eq('purchase_order_id', id).order('display_order'),
  ]);
  if (e1) throw new Error('No se pudo abrir la OC ' + id + ': ' + e1.message);
  return { oc, lines: lines || [] };
}
// Igual que las cotizaciones: con id actualiza, sin id crea. Nunca duplica.
export async function savePurchaseOrder(oc, lines) {
  const sb = db();
  const total = (lines || []).reduce((s, l) => s + num(l.cantidad) * num(l.costo_unit), 0);
  let saved;
  if (oc.id) {
    const { id, numero, created_at, ...patch } = oc;
    patch.total = total;
    const { data, error } = await sb.from('purchase_orders').update(patch).eq('id', id).select().single();
    if (error) throw new Error('No se pudo guardar la OC: ' + error.message);
    saved = data;
  } else {
    const { id, numero, created_at, ...row } = oc;
    row.total = total; row.created_by = await currentUserId();
    const { data, error } = await sb.from('purchase_orders').insert(row).select().single();
    if (error) throw new Error('No se pudo crear la OC: ' + error.message);
    saved = data;
  }
  await sb.from('purchase_order_lines').delete().eq('purchase_order_id', saved.id);
  if (lines?.length) {
    const rows = lines.map((l, i) => ({
      purchase_order_id: saved.id, material_id: l.material_id || null,
      descripcion: l.descripcion || null, unidad: l.unidad || null,
      cantidad: num(l.cantidad), costo_unit: num(l.costo_unit),
      costo_total: num(l.cantidad) * num(l.costo_unit),
      cantidad_recibida: num(l.cantidad_recibida), display_order: i,
    }));
    const { error } = await sb.from('purchase_order_lines').insert(rows);
    if (error) throw new Error('La OC se guardó pero fallaron las líneas: ' + error.message);
  }
  return saved;
}

// Recibir una OC: entra el stock, se actualiza el costo del material y queda el
// gasto asociado. IDEMPOTENTE: si ya está recibida no vuelve a mover stock.
export async function receivePurchaseOrder(id, { fecha, forma_pago } = {}) {
  const sb = db();
  const { oc, lines } = await getPurchaseOrder(id);
  if (!oc) throw new Error('No existe la OC ' + id);
  if (oc.estado === 'recibida') return { oc, yaRecibida: true };

  const hoy = fecha || new Date().toISOString().slice(0, 10);
  const uid = await currentUserId();
  for (const l of lines) {
    const pendiente = num(l.cantidad) - num(l.cantidad_recibida);
    if (!l.material_id || pendiente <= 0) continue;
    await registerStockMovement({
      material_id: l.material_id, tipo: 'entrada', cantidad: pendiente,
      costo_unit: num(l.costo_unit), motivo: 'compra', purchase_order_id: id,
      fecha: hoy, notas: 'Recepción ' + id,
    });
    await sb.from('purchase_order_lines').update({ cantidad_recibida: num(l.cantidad) }).eq('id', l.id);
    // El costo del catálogo se actualiza con lo que realmente se pagó.
    if (num(l.costo_unit) > 0) {
      await sb.from('materials').update({ precio_unit: num(l.costo_unit), updated_by: uid }).eq('id', l.material_id);
    }
  }
  const { data: actualizada } = await sb.from('purchase_orders').update({
    estado: 'recibida', fecha_recibida: hoy, forma_pago: forma_pago || oc.forma_pago || null,
  }).eq('id', id).select().single();
  auditar('oc_recibida', {
    entity_type: 'purchase_order', entity_id: id,
    details: { proveedor: oc.proveedor_nombre, total: num(oc.total), lineas: lines.length },
  });

  // Gasto de materiales, conectado a la OC (requisito 24).
  const { data: yaGasto } = await sb.from('expenses').select('id').eq('purchase_order_id', id).limit(1);
  if (!yaGasto || !yaGasto[0]) {
    await saveExpense({
      fecha: hoy, categoria: 'Materiales', descripcion: 'Compra ' + id + ' · ' + (oc.proveedor_nombre || ''),
      monto: num(oc.total), supplier_id: oc.supplier_id || null, purchase_order_id: id,
      forma_pago: (forma_pago === 'cuenta_corriente') ? 'cuenta_corriente' : 'organizacion',
    }).catch(e => console.warn('[compras] no se pudo registrar el gasto:', e.message));
  }
  return { oc: actualizada, yaRecibida: false };
}

/* ───────────── Stock ───────────── */
export async function listStockMovements({ materialId, from, to, limite = 400 } = {}) {
  let q = db().from('stock_movements').select('*').order('fecha', { ascending: false }).order('created_at', { ascending: false }).limit(limite);
  if (materialId) q = q.eq('material_id', materialId);
  if (from) q = q.gte('fecha', from);
  if (to) q = q.lte('fecha', to);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}
// Un movimiento = una línea del historial + el saldo del material actualizado.
export async function registerStockMovement(m) {
  const sb = db();
  const { data: mat } = await sb.from('materials').select('*').eq('id', m.material_id).single();
  if (!mat) throw new Error('El material no existe');
  const cant = Math.abs(num(m.cantidad));
  const signo = m.tipo === 'salida' ? -1 : (m.tipo === 'ajuste' ? 0 : 1);
  const resultante = m.tipo === 'ajuste' ? cant : num(mat.stock_actual) + signo * cant;

  const { data, error } = await sb.from('stock_movements').insert({
    material_id: m.material_id, tipo: m.tipo, cantidad: cant, costo_unit: m.costo_unit ?? null,
    motivo: m.motivo || null, purchase_order_id: m.purchase_order_id || null,
    production_card_id: m.production_card_id || null, subtask_id: m.subtask_id || null,
    stock_resultante: resultante, fecha: m.fecha || new Date().toISOString().slice(0, 10),
    notas: m.notas || null, registrado_por: await currentUserId(),
  }).select().single();
  if (error) throw new Error('No se pudo registrar el movimiento: ' + error.message);

  await sb.from('materials').update({ stock_actual: resultante }).eq('id', m.material_id);
  auditar('stock_movimiento', {
    entity_type: 'material', entity_id: m.material_id,
    details: { tipo: m.tipo, cantidad: cant, motivo: m.motivo, resultante, oc: m.purchase_order_id || null, pedido: m.production_card_id || null },
  });
  return data;
}

// Consumo real de materiales de un pedido. Idempotente por tarjeta: si ya se
// descontó para esa tarjeta, no vuelve a descontar.
export async function consumirMaterialesDePedido(card, lineas) {
  const sb = db();
  const { data: ya } = await sb.from('stock_movements').select('id')
    .eq('production_card_id', card.id).eq('motivo', 'produccion').limit(1);
  if (ya && ya[0]) return { yaConsumido: true, movimientos: 0 };
  let cuenta = 0;
  for (const l of (lineas || [])) {
    if (!l.material_id || num(l.cantidad) <= 0) continue;
    await registerStockMovement({
      material_id: l.material_id, tipo: 'salida', cantidad: num(l.cantidad),
      costo_unit: l.costoUnit ?? l.costo_unit ?? null, motivo: 'produccion',
      production_card_id: card.id, notas: 'Consumo ' + card.id,
    });
    cuenta++;
  }
  return { yaConsumido: false, movimientos: cuenta };
}

// Materiales que un pedido tiene comprometidos según su cotización.
export function materialesDePedido(card) {
  const out = new Map();
  for (const l of (card.product_lines || [])) {
    const cant = num(l.cantidad) || 1;
    for (const m of (l.materiales || [])) {
      if (!m.material_id) continue;
      const total = num(m.cantidad) * cant;
      const ya = out.get(m.material_id) || { material_id: m.material_id, descripcion: m.descripcion, cantidad: 0, costoUnit: num(m.costoUnit) };
      ya.cantidad += total;
      out.set(m.material_id, ya);
    }
  }
  return [...out.values()];
}

// Tablero de stock: disponible real = actual − comprometido en producción.
export async function stockReport() {
  const [materiales, cards, ocs] = await Promise.all([
    listMaterials({ incluirInactivos: false }),
    listProductionCards(),
    listPurchaseOrders(),
  ]);
  const abiertas = ocs.filter(o => ['borrador', 'enviada', 'confirmada', 'recibida_parcial'].includes(o.estado));
  const pendientePorMaterial = new Map();
  if (abiertas.length) {
    const { data: lineas } = await db().from('purchase_order_lines').select('*')
      .in('purchase_order_id', abiertas.map(o => o.id));
    (lineas || []).forEach(l => {
      if (!l.material_id) return;
      const falta = num(l.cantidad) - num(l.cantidad_recibida);
      if (falta > 0) pendientePorMaterial.set(l.material_id, (pendientePorMaterial.get(l.material_id) || 0) + falta);
    });
  }
  // Comprometido = lo que piden los pedidos que todavía no se entregaron.
  const enCurso = cards.filter(c => !['entregado', 'cancelado'].includes(c.stage_key));
  const comprometido = new Map();
  enCurso.forEach(c => materialesDePedido(c).forEach(m => {
    comprometido.set(m.material_id, (comprometido.get(m.material_id) || 0) + m.cantidad);
  }));

  return materiales.map(m => {
    const comp = comprometido.get(m.id) || 0;
    const pend = pendientePorMaterial.get(m.id) || 0;
    const disponible = num(m.stock_actual) - comp;
    const necesidad = Math.max(0, num(m.stock_minimo) - (disponible + pend));
    return {
      ...m, comprometido: comp, disponible, pendiente_oc: pend, necesidad_compra: necesidad,
      bajo_minimo: num(m.stock_actual) < num(m.stock_minimo),
      falta_para_produccion: disponible < 0,
    };
  });
}

/* ───────────── Cuentas a cobrar / factura interna ───────────── */
export async function listReceivables() {
  const { data, error } = await db().from('receivables').select('*').order('fecha_esperada_cobro', { ascending: true, nullsFirst: false });
  if (error) throw error;
  return (data || []).map(recalcEstadoCobro);
}
export async function getReceivableByCard(cardId) {
  const { data } = await db().from('receivables').select('*').eq('production_card_id', cardId).limit(1);
  return (data && data[0]) ? recalcEstadoCobro(data[0]) : null;
}
// Estado derivado: nunca se guarda "vencido" a mano, se calcula contra la fecha.
export function recalcEstadoCobro(r) {
  const total = num(r.monto), cobrado = num(r.cobrado);
  const saldo = Math.max(0, total - cobrado);
  let estado = r.estado;
  if (estado !== 'anulado') {
    if (total > 0 && saldo <= 0.01) estado = 'cobrado';
    else if (cobrado > 0) estado = 'parcial';
    else estado = 'a_cobrar';
    const hoy = new Date().toISOString().slice(0, 10);
    if (estado !== 'cobrado' && r.fecha_esperada_cobro && r.fecha_esperada_cobro < hoy) estado = 'vencido';
  }
  return { ...r, saldo, estado };
}
// Una cuenta a cobrar por pedido. Se crea sola al pasar a Producción.
export async function ensureReceivable(card, sale, quote) {
  const ya = await getReceivableByCard(card.id);
  if (ya) return ya;
  const monto = n(sale?.monto) || n(card.total_venta) || n(quote?.precio_venta);
  // Por defecto se espera cobrar el día de la entrega (requisito 23).
  const esperada = card.due_date || card.fecha_objetivo_interna || null;
  const { data, error } = await db().from('receivables').insert({
    production_card_id: card.id, sale_id: sale?.id || null, quote_id: quote?.id || null,
    client_id: card.client_id || sale?.client_id || null,
    cliente_nombre: card.client_name || sale?.cliente_nombre || null,
    monto, saldo: monto, fecha: new Date().toISOString().slice(0, 10),
    forma_cobro: 'credito_entrega', fecha_esperada_cobro: esperada, estado: 'a_cobrar',
  }).select().single();
  if (error) throw new Error('No se pudo crear la cuenta a cobrar: ' + error.message);
  return recalcEstadoCobro(data);
}
export async function saveReceivable(r) {
  const { id, saldo, ...patch } = r;
  const { data, error } = await db().from('receivables').update(patch).eq('id', id).select().single();
  if (error) throw error;
  return recalcEstadoCobro(data);
}

/* ───────────── Gastos ───────────── */
export const CATEGORIAS_GASTO = ['Materiales', 'Sueldos', 'Cargas sociales', 'Servicios', 'Transporte', 'Reintegros', 'Mantenimiento', 'Amortizaciones', 'Otros'];
export const FORMAS_PAGO_GASTO = [
  { key: 'organizacion',          label: 'Organización (pagó De Cirene)' },
  { key: 'funcionario_reintegro', label: 'Funcionario · pendiente de reintegro' },
  { key: 'cuenta_corriente',      label: 'Cuenta corriente con proveedor' },
];
export async function listExpenses({ from, to, categoria } = {}) {
  let q = db().from('expenses').select('*').order('fecha', { ascending: false }).limit(1000);
  if (from) q = q.gte('fecha', from);
  if (to) q = q.lte('fecha', to);
  if (categoria) q = q.eq('categoria', categoria);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}
export async function saveExpense(g) {
  const sb = db();
  const row = { ...g };
  if (row.forma_pago === 'funcionario_reintegro' && !row.estado_reintegro) row.estado_reintegro = 'pendiente';
  if (row.id) {
    const { id, ...patch } = row;
    const { data, error } = await sb.from('expenses').update(patch).eq('id', id).select().single();
    if (error) throw error;
    return data;
  }
  delete row.id;
  row.registrado_por = await currentUserId();
  const { data, error } = await sb.from('expenses').insert(row).select().single();
  if (error) throw new Error('No se pudo guardar el gasto: ' + error.message);
  auditar('gasto_registrado', {
    entity_type: 'expense', entity_id: data.id,
    details: { categoria: data.categoria, monto: num(data.monto), forma_pago: data.forma_pago, oc: data.purchase_order_id || null },
  });
  // Compra a crédito → queda como deuda con el proveedor.
  if (data.forma_pago === 'cuenta_corriente' && data.supplier_id) {
    await addSupplierLedger({ supplier_id: data.supplier_id, tipo: 'cargo', monto: num(data.monto), fecha: data.fecha, expense_id: data.id, purchase_order_id: data.purchase_order_id || null, notas: data.descripcion });
  }
  return data;
}
export async function deleteExpense(id) {
  const { error } = await db().from('expenses').delete().eq('id', id);
  if (error) throw error;
}
export async function listPayrollCharges() {
  const { data, error } = await db().from('payroll_charges').select('*').order('display_order');
  if (error) throw error;
  return data || [];
}
export async function upsertPayrollCharge(c) {
  const sb = db();
  const row = { ...c, updated_by: await currentUserId() };
  if (row.id) {
    const { id, ...patch } = row;
    const { data, error } = await sb.from('payroll_charges').update(patch).eq('id', id).select().single();
    if (error) throw error;
    return data;
  }
  delete row.id;
  const { data, error } = await sb.from('payroll_charges').insert(row).select().single();
  if (error) throw error;
  return data;
}

/* ───────────── Cuenta corriente de proveedores ───────────── */
export async function listSupplierLedger(supplierId) {
  let q = db().from('supplier_ledger').select('*').order('fecha', { ascending: false });
  if (supplierId) q = q.eq('supplier_id', supplierId);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}
export async function addSupplierLedger(e) {
  const sb = db();
  const { data, error } = await sb.from('supplier_ledger').insert({ ...e, registrado_por: await currentUserId() }).select().single();
  if (error) throw error;
  // El saldo del proveedor se recalcula del libro entero: nunca queda desfasado.
  const movs = await listSupplierLedger(e.supplier_id);
  const saldo = movs.reduce((s, m) => s + (m.tipo === 'cargo' ? num(m.monto) : -num(m.monto)), 0);
  await sb.from('suppliers').update({ saldo }).eq('id', e.supplier_id);
  return data;
}

/* ───────────── Activos y amortización lineal ───────────── */
export async function listAssets() {
  const { data, error } = await db().from('assets').select('*').order('fecha_compra', { ascending: false });
  if (error) throw error;
  return (data || []).map(calcAsset);
}
export async function upsertAsset(a) {
  const sb = db();
  const row = { ...a };
  if (row.id) {
    const { id, ...patch } = row;
    const { data, error } = await sb.from('assets').update(patch).eq('id', id).select().single();
    if (error) throw error;
    return calcAsset(data);
  }
  delete row.id;
  const { data, error } = await sb.from('assets').insert(row).select().single();
  if (error) throw error;
  return calcAsset(data);
}
export async function deleteAsset(id) {
  const { error } = await db().from('assets').delete().eq('id', id);
  if (error) throw error;
}
// Amortización lineal: (costo − residual) / vida útil en meses.
export function calcAsset(a) {
  const costo = num(a.costo), residual = num(a.valor_residual);
  const meses = Math.max(1, parseInt(a.vida_util_meses, 10) || 1);
  const mensual = Math.max(0, (costo - residual) / meses);
  const compra = a.fecha_compra ? new Date(a.fecha_compra + 'T00:00:00') : null;
  let transcurridos = 0;
  if (compra) {
    const hoy = new Date();
    transcurridos = Math.max(0, (hoy.getFullYear() - compra.getFullYear()) * 12 + (hoy.getMonth() - compra.getMonth()));
  }
  const mesesAmortizados = Math.min(meses, transcurridos);
  const acumulada = Math.min(costo - residual, mensual * mesesAmortizados);
  return { ...a, amortizacion_mensual: mensual, amortizacion_acumulada: acumulada, valor_contable: costo - acumulada, meses_amortizados: mesesAmortizados, vida_util_meses: meses };
}
// Amortización que corresponde imputar a un mes 'YYYY-MM'.
export function amortizacionDelMes(assets, periodo) {
  const [a, m] = (periodo || '').split('-').map(Number);
  if (!a || !m) return 0;
  const fin = new Date(a, m, 0);
  return assets.reduce((s, x) => {
    if (!x.fecha_compra) return s;
    const compra = new Date(x.fecha_compra + 'T00:00:00');
    if (compra > fin) return s;
    const transcurridos = (a - compra.getFullYear()) * 12 + (m - 1 - compra.getMonth());
    if (transcurridos < 0 || transcurridos >= x.vida_util_meses) return s;
    if (x.estado !== 'activo' && x.fecha_baja && x.fecha_baja < fin.toISOString().slice(0, 10)) return s;
    return s + num(x.amortizacion_mensual);
  }, 0);
}

/* ───────────── Impacto social ───────────── */
export async function listSocialImpact() {
  const { data, error } = await db().from('social_impact').select('*').order('fecha', { ascending: false }).limit(120);
  if (error) throw error;
  return data || [];
}
export async function saveSocialImpact({ fecha, personas_historico, personas_actuales, notas }) {
  const sb = db();
  const f = fecha || new Date().toISOString().slice(0, 10);
  const { data: ya } = await sb.from('social_impact').select('id').eq('fecha', f).limit(1);
  const row = {
    personas_historico: parseInt(personas_historico, 10) || 0,
    personas_actuales: parseInt(personas_actuales, 10) || 0,
    notas: notas || null, registrado_por: await currentUserId(),
  };
  if (ya && ya[0]) {
    const { data, error } = await sb.from('social_impact').update(row).eq('id', ya[0].id).select().single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await sb.from('social_impact').insert({ fecha: f, ...row }).select().single();
  if (error) throw error;
  return data;
}

/* ───────────── Ventas ───────────── */
export async function listSales({ from, to } = {}) {
  let q = db().from('sales').select('*').order('fecha', { ascending: false }).limit(2000);
  if (from) q = q.gte('fecha', from);
  if (to) q = q.lte('fecha', to);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}
export async function saveSale(s) {
  const { id, ...patch } = s;
  const { data, error } = await db().from('sales').update(patch).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

/* ───────────── NPS ───────────── */
export async function listNpsSurveys() {
  const { data, error } = await db().from('nps_surveys').select('*').order('created_at', { ascending: false }).limit(1000);
  if (error) throw error;
  return data || [];
}
export async function listNpsOptions() {
  const { data, error } = await db().from('nps_options').select('*').eq('activo', true).order('display_order');
  if (error) throw error;
  return data || [];
}
// Una encuesta por pedido (índice único): reenviar no duplica.
export async function ensureNpsSurvey(card, sale) {
  const sb = db();
  const { data: ya } = await sb.from('nps_surveys').select('*').eq('production_card_id', card.id).limit(1);
  if (ya && ya[0]) return ya[0];
  const { data, error } = await sb.from('nps_surveys').insert({
    production_card_id: card.id, sale_id: sale?.id || card.sale_id || null,
    client_id: card.client_id || null, cliente_nombre: card.client_name || null,
    vendedor: card.vendor || null, vendedor_user_id: card.vendor_user_id || null,
    token: newId('nps'), estado: 'pendiente',
  }).select().single();
  if (error) throw new Error('No se pudo crear la encuesta: ' + error.message);
  return data;
}
export async function saveNpsSurvey(s) {
  const { id, ...patch } = s;
  const { data, error } = await db().from('nps_surveys').update(patch).eq('id', id).select().single();
  if (error) throw error;
  return data;
}
// NPS = % promotores − % detractores. Promotor 9-10, pasivo 7-8, detractor 0-6.
export function npsMetrics(surveys) {
  const enviadas = surveys.filter(s => s.estado === 'enviada' || s.estado === 'respondida');
  const respondidas = surveys.filter(s => s.estado === 'respondida' && s.recomendacion !== null && s.recomendacion !== undefined);
  const total = respondidas.length;
  const prom = respondidas.filter(s => s.recomendacion >= 9).length;
  const pas = respondidas.filter(s => s.recomendacion >= 7 && s.recomendacion <= 8).length;
  const det = respondidas.filter(s => s.recomendacion <= 6).length;
  const nps = total ? Math.round(((prom - det) / total) * 100) : 0;
  const avg = (campo) => {
    const vals = respondidas.map(s => s[campo]).filter(v => v !== null && v !== undefined);
    return vals.length ? vals.reduce((a, b) => a + Number(b), 0) / vals.length : 0;
  };
  const conteo = (lista) => {
    const map = {};
    lista.forEach(v => { if (v) map[v] = (map[v] || 0) + 1; });
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  };
  return {
    enviadas: enviadas.length, respondidas: total,
    tasa: enviadas.length ? (total / enviadas.length) * 100 : 0,
    nps, promotores: prom, pasivos: pas, detractores: det,
    recomendacionPromedio: avg('recomendacion'), impactoPromedio: avg('impacto_social'),
    aspectos: conteo(respondidas.flatMap(s => Array.isArray(s.aspectos) ? s.aspectos : [])),
    canales: conteo(respondidas.map(s => s.como_conocio)),
    mejoras: respondidas.map(s => s.mejoras).filter(Boolean),
  };
}

/* ───────────── Notificaciones / centro de actividad ───────────── */
export async function listNotifications({ soloNoLeidas = false, limite = 60 } = {}) {
  const uid = await currentUserId();
  if (!uid) return [];
  let q = db().from('notifications').select('*').eq('user_id', uid).order('created_at', { ascending: false }).limit(limite);
  if (soloNoLeidas) q = q.eq('leida', false);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}
export async function markNotificationRead(id) {
  const { error } = await db().from('notifications').update({ leida: true }).eq('id', id);
  if (error) throw error;
}
export async function markAllNotificationsRead() {
  const uid = await currentUserId();
  if (!uid) return;
  await db().from('notifications').update({ leida: true }).eq('user_id', uid).eq('leida', false);
}
// Avisa a un conjunto de usuarios. Nunca tira: una notificación que falla no
// puede romper la acción que la disparó.
export async function notificar(userIds, { titulo, cuerpo, url, tipo = 'comentario', entity_type, entity_id }) {
  try {
    const ids = [...new Set((userIds || []).filter(Boolean))];
    if (!ids.length) return;
    await db().from('notifications').insert(ids.map(uid => ({
      user_id: uid, tipo, titulo, cuerpo: cuerpo || null, url: url || null,
      entity_type: entity_type || null, entity_id: entity_id || null,
    })));
  } catch (e) { console.warn('[notificaciones]', e.message); }
}

/* ───────────── Trazabilidad ─────────────
   Devuelve toda la historia de un pedido para poder navegarla desde cualquier
   punta (requisito 36). Las partes que fallan vuelven en null, no rompen. */
export async function trazabilidad(cardId) {
  const sb = db();
  const { data: card } = await sb.from('production_cards').select('*').eq('id', cardId).single();
  if (!card) throw new Error('No existe el pedido ' + cardId);
  const nada = () => ({ data: null });
  const [lead, quote, sale, receivable, subtareas, movimientos, comentarios, nps, cobros] = await Promise.all([
    card.intake_card_id ? sb.from('intake_cards').select('*').eq('id', card.intake_card_id).single() : nada(),
    card.quote_id ? sb.from('quotes').select('*').eq('id', card.quote_id).single() : nada(),
    card.sale_id ? sb.from('sales').select('*').eq('id', card.sale_id).single() : nada(),
    sb.from('receivables').select('*').eq('production_card_id', cardId).limit(1),
    sb.from('production_subtasks').select('*').eq('card_id', cardId).order('display_order'),
    sb.from('stock_movements').select('*').eq('production_card_id', cardId).order('fecha'),
    sb.from('card_stories').select('*').eq('card_id', cardId).order('occurred_at', { ascending: false }),
    sb.from('nps_surveys').select('*').eq('production_card_id', cardId).limit(1),
    listJobPayments(cardId).then(d => ({ data: d })).catch(() => ({ data: [] })),
  ]);
  return {
    card, lead: lead.data || null, quote: quote.data || null, sale: sale.data || null,
    receivable: (receivable.data || [])[0] || null,
    subtareas: subtareas.data || [], movimientos: movimientos.data || [],
    comentarios: comentarios.data || [], nps: (nps.data || [])[0] || null,
    cobros: cobros.data || [],
  };
}

/* ───────────── Presupuestado vs. real ─────────────
   Presupuestado sale de la cotización (foto del momento).
   Real sale de lo que efectivamente pasó: materiales consumidos y horas fichadas. */
export function presupuestadoVsReal({ cards, quotes, movimientos, subtareas, operarios }) {
  const quotePorId = new Map((quotes || []).map(q => [q.id, q]));
  const opPorId = new Map((operarios || []).map(o => [o.id, o]));
  const acc = {
    materiales: { presupuestado: 0, real: 0 },
    manoObra:   { presupuestado: 0, real: 0 },
    transporte: { presupuestado: 0, real: 0 },
    colocacion: { presupuestado: 0, real: 0 },
    total:      { presupuestado: 0, real: 0 },
  };
  for (const c of (cards || [])) {
    const q = c.quote_id ? quotePorId.get(c.quote_id) : null;
    if (q) {
      acc.materiales.presupuestado += num(q.subtotal_materiales);
      acc.manoObra.presupuestado   += num(q.subtotal_mo);
      acc.transporte.presupuestado += num(q.transporte_costo);
      acc.colocacion.presupuestado += num(q.costo_colocacion_mo) + num(q.colocacion_viaticos);
    }
    const mats = (movimientos || []).filter(m => m.production_card_id === c.id && m.tipo === 'salida');
    acc.materiales.real += mats.reduce((s, m) => s + num(m.cantidad) * num(m.costo_unit), 0);
    const tareas = (subtareas || []).filter(t => t.card_id === c.id);
    acc.manoObra.real += tareas.reduce((s, t) => {
      const op = t.operator_id ? opPorId.get(t.operator_id) : null;
      return s + (num(t.segundos_trabajados) / 3600) * num(op?.costo_hora);
    }, 0);
  }
  acc.total.presupuestado = acc.materiales.presupuestado + acc.manoObra.presupuestado + acc.transporte.presupuestado + acc.colocacion.presupuestado;
  acc.total.real = acc.materiales.real + acc.manoObra.real + acc.transporte.real + acc.colocacion.real;
  for (const k of Object.keys(acc)) acc[k].desvio = acc[k].real - acc[k].presupuestado;
  return acc;
}

/* ───────────── Productividad ─────────────
   horas pagadas → las que se le pagan al equipo en el período
   horas en trabajos → las fichadas en subtareas
   sin asignación → la diferencia (no es "tiempo perdido": es tiempo sin imputar) */
export function productividad({ timeLogs, operarios, horasPagadas = 0 }) {
  const porOperario = new Map();
  let segundos = 0;
  (timeLogs || []).forEach(l => {
    const s = num(l.segundos);
    segundos += s;
    if (l.operator_id) porOperario.set(l.operator_id, (porOperario.get(l.operator_id) || 0) + s);
  });
  const horasTrabajadas = segundos / 3600;
  const sinAsignacion = Math.max(0, horasPagadas - horasTrabajadas);
  return {
    horasPagadas, horasTrabajadas, sinAsignacion,
    utilizacion: horasPagadas ? (horasTrabajadas / horasPagadas) * 100 : 0,
    porOperario: (operarios || []).map(o => ({
      ...o, horas: (porOperario.get(o.id) || 0) / 3600,
      costo: ((porOperario.get(o.id) || 0) / 3600) * num(o.costo_hora),
    })).sort((a, b) => b.horas - a.horas),
  };
}
