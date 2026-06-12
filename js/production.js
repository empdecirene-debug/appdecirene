// Lógica del Kanban de producción.

import { getSupa } from './supa.js';
import { getCurrentUser, getProfile, isAdmin, getOdooUserIdForCurrentUser } from './auth.js';
import { productionCardId } from './ids.js';
import { logAudit } from './audit.js';
import { createCustomerInvoiceDraft, createSaleOrderDraft, updateSaleOrder, cancelSaleOrder,
         findVatSaleTaxId, findAccountByCode, createPostedInvoiceFromCard } from './odoo-client.js';
import { computeTargetStage } from './stage-rules.js';

export async function loadStages() {
  const supa = getSupa();
  const { data, error } = await supa.from('kanban_stages')
    .select('*').eq('active', true).order('display_order', { ascending: true });
  if (error) throw error;
  return data || [];
}

// `archived`:
//   false (default) → solo tarjetas activas (archived_at IS NULL)
//   true            → solo tarjetas archivadas
export async function loadCards({ stageKey = null, vendorOnly = null, includeFinished = false, limit = 200, archived = false } = {}) {
  const supa = getSupa();
  let q = supa.from('production_cards').select('*');
  if (stageKey) q = q.eq('stage_key', stageKey);
  if (vendorOnly) q = q.eq('vendor_user_id', vendorOnly);
  if (!includeFinished) q = q.not('stage_key', 'in', '("entregado","cancelado")');
  // Archivado: por default solo activas. Si archived=true, solo archivadas.
  if (archived) q = q.not('archived_at', 'is', null);
  else          q = q.is('archived_at', null);
  q = q.order('updated_at', { ascending: false }).limit(limit);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// Archiva/desarchiva una tarjeta (soft-archive). Archivada → fuera de
// kanban/listas/métricas; desarchivada → vuelve a contar en todos lados.
export async function setCardArchived(card, archived) {
  if (!(await getCurrentUser())) throw new Error('Necesitás iniciar sesión');
  const supa = getSupa();
  const user = await getCurrentUser();
  const profile = await getProfile();
  const patch = archived
    ? { archived_at: new Date().toISOString(), archived_by: user?.id || null }
    : { archived_at: null, archived_by: null };
  const { error } = await supa.from('production_cards').update(patch).eq('id', card.id);
  if (error) throw error;
  await supa.from('card_stories').insert({
    card_id: card.id,
    user_id: user?.id || null,
    user_label: profile?.full_name || user?.email || 'system',
    type: 'field_change',
    field_name: 'archived_at',
    from_value: archived ? null : 'archivada',
    to_value: archived ? 'archivada' : null,
    notes: archived ? 'Tarjeta archivada' : 'Tarjeta desarchivada',
  });
  await logAudit({
    action: archived ? 'card_archive' : 'card_unarchive',
    entity_type: 'production_card', entity_id: card.id,
  });
  return { ...card, ...patch };
}

export async function loadCard(id) {
  const supa = getSupa();
  const { data, error } = await supa.from('production_cards').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

export async function loadStories(cardId) {
  const supa = getSupa();
  const { data, error } = await supa.from('card_stories').select('*')
    .eq('card_id', cardId).order('occurred_at', { ascending: false }).limit(200);
  if (error) throw error;
  return data || [];
}

// Campos obligatorios para que una tarjeta pueda salir de "Borrador".
// Si falta cualquiera de estos, moveCardToStage los reporta y aborta.
const BORRADOR_REQUIRED_FIELDS = [
  { key: 'client_name',         label: 'Cliente' },
  { key: 'descripcion_pedido',  label: 'Descripción del pedido' },
  { key: 'vendor',              label: 'Vendedor' },
  { key: 'channel_venta',       label: 'Canal de venta' },
  { key: 'modo_pago',           label: 'Modo de pago' },
];

// Devuelve un array con los labels de los campos faltantes (o []).
// Verifica también que product_lines tenga al menos una línea con producto.
export function missingFieldsForBorradorExit(card) {
  const missing = [];
  for (const f of BORRADOR_REQUIRED_FIELDS) {
    const v = card?.[f.key];
    if (v == null || String(v).trim() === '') missing.push(f.label);
  }
  const lines = Array.isArray(card?.product_lines) ? card.product_lines : [];
  if (!lines.length) {
    missing.push('Líneas de productos (al menos una)');
  } else {
    const hasValidLine = lines.some(l => l && l.producto && String(l.producto).trim());
    if (!hasValidLine) missing.push('Producto en la línea (al menos una con nombre)');
  }
  return missing;
}

export async function moveCardToStage(card, newStageKey, stagesMap = null) {
  if (!(await getCurrentUser())) throw new Error('Necesitás iniciar sesión para mover tarjetas');
  if (card.stage_key === newStageKey) return card;

  // Gate Borrador → cualquier otra: validar que los campos obligatorios estén completos.
  // Sin esto, la tarea puede salir de Borrador con datos faltantes y romper compras/producción.
  if (card.stage_key === 'borrador' && newStageKey !== 'borrador') {
    const missing = missingFieldsForBorradorExit(card);
    if (missing.length) {
      throw new Error(
        'No se puede salir de Borrador — faltan: ' + missing.join(', ')
      );
    }
  }

  const supa = getSupa();
  const user = await getCurrentUser();
  const profile = await getProfile();

  const patch = { stage_key: newStageKey };
  if (newStageKey === 'entregado' && !card.completed_at) {
    patch.completed_at = new Date().toISOString();
  }

  const { error: e1 } = await supa.from('production_cards').update(patch).eq('id', card.id);
  if (e1) throw e1;

  await supa.from('card_stories').insert({
    card_id: card.id,
    user_id: user?.id || null,
    user_label: profile?.full_name || user?.email || 'system',
    type: 'stage_change',
    field_name: 'stage_key',
    from_value: card.stage_key,
    to_value: newStageKey,
  });

  // (#13) Tabla dedicada para métricas. Best-effort: si falla, no rompemos el flow.
  try {
    await supa.from('production_card_transitions').insert({
      card_id: card.id,
      field_changed: 'stage_key',
      from_value: card.stage_key,
      to_value: newStageKey,
      card_vendor: card.vendor || null,
      actor_id: user?.id || null,
      actor_label: profile?.full_name || user?.email || null,
    });
  } catch (e) { console.warn('[pct] insert stage_change falló:', e?.message); }

  await logAudit({
    action: 'card_stage_change',
    entity_type: 'production_card',
    entity_id: card.id,
    details: { from: card.stage_key, to: newStageKey },
  });

  // (#15) Side-effect retirado: la creación automática de factura al pasar a
  // "entregado" se mueve a flujo manual desde el botón del modal. Si la
  // tarjeta tiene invoice_mode='factura' o 'ticket' y aún no hay invoice,
  // draftCustomerInvoiceForCard se sigue llamando para no romper el flujo
  // de los usuarios. Si invoice_mode es 'sin_factura' o null, no toca Odoo.
  let invoiceResult = null;
  if (newStageKey === 'entregado'
      && !card.invoice_drafted_at
      && !card.is_sample
      && (card.invoice_mode === 'factura' || card.invoice_mode === 'ticket')) {
    try {
      invoiceResult = await draftCustomerInvoiceForCard(card);
    } catch (e) {
      await logAudit({
        action: 'card_invoice_draft_failed',
        entity_type: 'production_card', entity_id: card.id,
        status: 'error', error_message: e.message,
      });
      console.warn('No se pudo crear borrador de factura:', e.message);
    }
  }

  return { ...card, ...patch, _invoiceResult: invoiceResult };
}

// Crea borrador de factura de cliente en Odoo a partir de una tarjeta.
// Idempotente: si ya existe (por ref o por invoice_drafted_at) no duplica.
export async function draftCustomerInvoiceForCard(card) {
  if (card.invoice_drafted_at) return { skipped: 'ya tenía borrador' };

  const supa = getSupa();
  const ref = card.id;  // usamos id de la tarjeta como external ref
  const odooUserId = await getOdooUserIdForCurrentUser();
  const { moveId, alreadyExisted, name } = await createCustomerInvoiceDraft({
    clientName: card.client_name,
    partnerId: card.odoo_partner_id || null,
    ref,
    productLines: card.product_lines || [],
    notes: card.description || '',
    odooUserId,
  });

  await supa.from('production_cards').update({
    invoice_drafted_at: new Date().toISOString(),
    invoice_odoo_move_id: moveId,
  }).eq('id', card.id);

  await logAudit({
    action: 'card_invoice_draft',
    entity_type: 'production_card', entity_id: card.id,
    details: { odoo_move_id: moveId, already_existed: alreadyExisted, odoo_name: name },
  });

  return { moveId, alreadyExisted, name };
}

// Actualiza estado_stock y/o estado_insumo de una tarjeta y aplica el motor
// de reglas (stage-rules.js): si la regla dice que la tarjeta debería estar
// en otra columna, la mueve automáticamente y deja un story.
//
// `patch` puede incluir { estado_stock, estado_insumo }.
// Devuelve la tarjeta actualizada (con el stage_key final si hubo movimiento).
export async function setCardStateFields(card, patch) {
  const supa = getSupa();
  const user = await getCurrentUser();
  const profile = await getProfile();

  const updates = {};
  if (Object.prototype.hasOwnProperty.call(patch, 'estado_stock'))  updates.estado_stock  = patch.estado_stock  || null;
  if (Object.prototype.hasOwnProperty.call(patch, 'estado_insumo')) updates.estado_insumo = patch.estado_insumo || null;
  if (!Object.keys(updates).length) return card;

  const { error } = await supa.from('production_cards').update(updates).eq('id', card.id);
  if (error) throw error;

  // Historial granular para cada campo cambiado.
  for (const [field, to] of Object.entries(updates)) {
    const from = card[field];
    if (from === to) continue;
    await supa.from('card_stories').insert({
      card_id: card.id,
      user_id: user?.id || null,
      user_label: profile?.full_name || user?.email || 'system',
      type: 'field_change',
      field_name: field,
      from_value: from || null,
      to_value: to || null,
    });
    // (#13) idem tabla dedicada (best-effort).
    try {
      await supa.from('production_card_transitions').insert({
        card_id: card.id,
        field_changed: field,
        from_value: from || null,
        to_value: to || null,
        card_vendor: card.vendor || null,
        actor_id: user?.id || null,
        actor_label: profile?.full_name || user?.email || null,
      });
    } catch (e) { console.warn('[pct] insert', field, 'falló:', e?.message); }
  }

  const merged = { ...card, ...updates };

  // ── Aplicar reglas → mover de columna si corresponde ──
  const target = computeTargetStage(merged);
  if (target && target !== merged.stage_key) {
    // moveCardToStage exige admin; acá lo hacemos como movimiento automático
    // (no requiere admin porque lo dispara una regla, no un usuario).
    const movePatch = { stage_key: target };
    if (target === 'entregado' && !merged.completed_at) {
      movePatch.completed_at = new Date().toISOString();
    }
    const { error: e2 } = await supa.from('production_cards').update(movePatch).eq('id', card.id);
    if (e2) throw e2;
    await supa.from('card_stories').insert({
      card_id: card.id,
      user_id: user?.id || null,
      user_label: profile?.full_name || user?.email || 'system',
      type: 'stage_change',
      field_name: 'stage_key',
      from_value: merged.stage_key,
      to_value: target,
      notes: 'Movimiento automático por cambio de estado',
    });
    Object.assign(merged, movePatch);

    // Side-effect de factura al pasar a "entregado" (mismo comportamiento
    // que moveCardToStage manual).
    if (target === 'entregado' && !card.invoice_drafted_at && !card.is_sample) {
      try {
        const invoiceResult = await draftCustomerInvoiceForCard(card);
        merged._invoiceResult = invoiceResult;
      } catch (e) {
        console.warn('No se pudo crear borrador de factura:', e.message);
      }
    }
  }

  await logAudit({ action: 'card_state_update', entity_type: 'production_card', entity_id: card.id, details: updates });
  return merged;
}

// Persiste `fields` de la tarjeta en Supabase. RÁPIDO: hace solo el UPDATE y
// retorna. La auditoría y la sincronización con Odoo se disparan en background
// (fire-and-forget) para NO bloquear el autosave — antes cada cambio de precio
// esperaba el RPC a Odoo (varios segundos) y se perdían datos al cerrar el
// modal antes de que terminara.
export async function updateCardFields(card, fields) {
  if (!(await getCurrentUser())) throw new Error('Necesitás iniciar sesión para editar tarjetas');
  const supa = getSupa();
  // Lo único que se espera: el UPDATE a Supabase. Si esto confirma, el dato
  // está a salvo. Es rápido (un round-trip).
  const { error } = await supa.from('production_cards').update(fields).eq('id', card.id);
  if (error) throw error;

  // ── Background, sin await: auditoría + sync Odoo ──────────────────────────
  // No bloquean el retorno. Si fallan, quedan logueados pero la edición en
  // De Cirene ya está persistida.
  logAudit({ action: 'card_update', entity_type: 'production_card', entity_id: card.id, details: fields })
    .catch(e => console.warn('[production] logAudit falló:', e?.message));

  if (card.odoo_sale_order_id) {
    const relevant = ['client_name', 'description', 'descripcion_pedido', 'product_lines'].some(k => k in fields);
    if (relevant) {
      // Capturar valores ANTES de salir (card puede mutar después).
      const newDescPedido = 'descripcion_pedido' in fields ? fields.descripcion_pedido : card.descripcion_pedido;
      const newDesc = 'description' in fields ? fields.description : card.description;
      const newClientName = 'client_name' in fields ? fields.client_name : card.client_name;
      const newLines = 'product_lines' in fields ? fields.product_lines : card.product_lines;
      const noteParts = [];
      if (newDescPedido) noteParts.push(newDescPedido);
      if (newDesc) noteParts.push(newDesc);
      const odooId = card.odoo_sale_order_id;
      const patch = {
        clientName: newClientName,
        note: noteParts.join('\n\n'),
        productLines: newLines || [],
      };
      // Fire-and-forget: la sync a Odoo corre en background.
      updateSaleOrder(odooId, patch)
        .then(r => logAudit({
          action: r.error ? 'card_odoo_sync_failed' : 'card_odoo_sync',
          entity_type: 'production_card', entity_id: card.id,
          details: { odoo_sale_order_id: odooId, ...r },
          status: r.error ? 'error' : 'ok',
          error_message: r.error || null,
        }))
        .catch(e => {
          console.warn('[production] sync Odoo falló:', e.message);
          logAudit({
            action: 'card_odoo_sync_failed',
            entity_type: 'production_card', entity_id: card.id,
            status: 'error', error_message: e.message,
          }).catch(() => {});
        });
    }
  }
}

// Crea una production_card desde el formulario "Nueva tarea" (entrada simple
// desde el vendedor, antes era Intake). Va directo a la columna `pendiente_compra`
// ("A Pedir Insumos") y NO requiere admin: cualquier vendedor puede crearla.
// Elimina una tarjeta de producción de forma permanente.
// Solo admin/director/ceo. Cascade borra card_stories asociados (FK ON DELETE CASCADE).
// Si la tarjeta tiene un sale.order en Odoo, lo CANCELA (no se puede borrar SOs
// confirmadas con facturas — Odoo no lo permite; cancel es lo más cercano).
export async function deleteCard(card) {
  if (!(await getCurrentUser())) throw new Error('Necesitás iniciar sesión para eliminar tareas');
  if (!card?.id) throw new Error('Tarjeta sin id');
  const supa = getSupa();
  const user = await getCurrentUser();
  const profile = await getProfile();

  // Cancelar en Odoo PRIMERO (antes de borrar local), así si falla podemos avisar.
  let odooResult = null;
  if (card.odoo_sale_order_id) {
    odooResult = await cancelSaleOrder(card.odoo_sale_order_id);
    if (!odooResult.ok) {
      console.warn('[production] no se pudo cancelar sale.order en Odoo:', odooResult.error);
      // No tiramos — el usuario puede haber querido borrar la card aún si Odoo falla.
    }
  }

  // Log antes de borrar para tener huella aún si la fila desaparece
  await logAudit({
    action: 'card_delete',
    entity_type: 'production_card',
    entity_id: card.id,
    details: {
      stage_key: card.stage_key,
      client_name: card.client_name,
      odoo_sale_order_id: card.odoo_sale_order_id || null,
      odoo_cancelled: odooResult?.ok || false,
      odoo_cancel_error: odooResult?.error || null,
      deleted_by: profile?.full_name || user?.email || 'unknown',
    },
  });

  const { error } = await supa.from('production_cards').delete().eq('id', card.id);
  if (error) throw error;
  return { ok: true, odooResult };
}

// Crea una tarea nueva desde el form de Intake.
// IMPORTANTE: arranca SIEMPRE en 'borrador'. El admin la mueve a 'a_pedir_insumos' cuando
// completa los campos obligatorios (ver missingFieldsForBorradorExit).
export async function createTaskFromForm({
  clientName, clientPartnerId, clientPhone, description, descripcionPedido, targetDate,
  vendor, channelSale, paymentMethod, senalAmount,
  productLines, attachments,
  // legacy: si todavía se llama con `photoDataUrl`, lo convertimos al nuevo shape.
  photoDataUrl,
  stageKey = 'borrador',
}) {
  const supa = getSupa();
  const user = await getCurrentUser();
  const profile = await getProfile();
  if (!user || !profile) throw new Error('Sin sesión');

  const id = productionCardId();
  let finalAttachments = Array.isArray(attachments) ? attachments : [];
  if (!finalAttachments.length && photoDataUrl) {
    finalAttachments = [{ kind: 'photo', url: photoDataUrl, name: 'foto-1' }];
  }
  // En Supabase real estos campos tienen default now(), pero el mock del demo no, así
  // que los seteamos explícitamente — si no, el ORDER BY updated_at DESC manda la card
  // nueva al fondo de la lista y "no aparece".
  const nowIso = new Date().toISOString();

  const { error } = await supa.from('production_cards').insert({
    id,
    source: 'manual',
    vendor: vendor || profile.vendor_name || profile.full_name,
    vendor_user_id: user.id,
    client_name: clientName,
    odoo_partner_id: clientPartnerId || null,
    client_phone_e164: clientPhone || null,
    channel_venta: channelSale || null,
    modo_pago: paymentMethod || null,
    monto_sena: senalAmount ?? null,
    product_lines: productLines || [],
    description: description || null,
    descripcion_pedido: descripcionPedido || null,
    stage_key: stageKey,
    is_sample: false,
    due_date: targetDate || null,
    // Mes de facturación: el de la fecha objetivo, o el mes actual. Editable
    // luego desde el modal de la tarjeta; ventas.html agrupa por este campo.
    billing_month: (targetDate || nowIso).slice(0, 7),
    priority: 'normal',
    estado_stock: 'Registrar / Chequear',
    estado_insumo: 'No esta editado',
    attachments: finalAttachments,
    created_at: nowIso,
    updated_at: nowIso,
  });
  if (error) throw error;

  await supa.from('card_stories').insert({
    card_id: id,
    user_id: user.id,
    user_label: profile.full_name || user.email || 'system',
    type: 'created',
    to_value: stageKey,
    occurred_at: nowIso,
  });

  await logAudit({ action: 'card_create_task', entity_type: 'production_card', entity_id: id, details: { stage_key: stageKey } });

  // (#15) La creación automática de sale.order al crear la tarjeta fue retirada.
  // Ahora el usuario decide el modo (factura / ticket / sin factura) desde el
  // botón "Crear OV en Odoo" del modal. Ver createSaleOrderManual().
  return { id, saleOrder: null };
}

// (#15) Crear OV en Odoo manualmente, con uno de tres modos:
//   'factura'      → arma payload para Kitfe (no llama todavía), Y crea sale.order en Odoo
//   'ticket'       → crea sale.order en Odoo sin datos de facturación
//   'sin_factura'  → no toca Odoo ni Kitfe; solo registra invoice_mode='sin_factura' en la card
//
// payload (solo para 'factura'): { rut, razon_social, direccion, localidad }
// Devuelve { ok, mode, odoo_sale_order_id?, kitfe_payload? }
export async function createSaleOrderManual(card, mode, payload = {}) {
  if (!(await getCurrentUser())) throw new Error('Necesitás iniciar sesión');
  if (!card?.id) throw new Error('Tarjeta sin id');
  const supa = getSupa();
  const user = await getCurrentUser();
  const profile = await getProfile();

  if (mode === 'sin_factura') {
    await supa.from('production_cards').update({
      invoice_mode: 'sin_factura',
      sale_order_manual: true,
    }).eq('id', card.id);
    await logAudit({ action: 'card_sale_order_sin_factura', entity_type: 'production_card', entity_id: card.id });
    return { ok: true, mode };
  }

  // Para 'factura' y 'ticket' creamos el sale.order en Odoo.
  if (card.odoo_sale_order_id) {
    throw new Error('Esta tarjeta ya tiene odoo_sale_order_id = ' + card.odoo_sale_order_id);
  }

  const odooUserId = await getOdooUserIdForCurrentUser();
  const { orderId, name, alreadyExisted } = await createSaleOrderDraft({
    clientName: card.client_name,
    partnerId: card.odoo_partner_id || undefined,
    ref: card.id,
    productLines: card.product_lines || [],
    notes: card.description || '',
    odooUserId,
  });

  const patch = {
    odoo_sale_order_id: orderId,
    invoice_mode: mode,
    sale_order_manual: true,
  };

  if (mode === 'factura') {
    // Payload Kitfe (no se envía todavía, queda guardado para integración futura).
    const kitfePayload = {
      rut:           payload.rut || null,
      razon_social:  payload.razon_social || null,
      direccion:     payload.direccion || null,
      localidad:     payload.localidad || null,
      credit_days:   15,
      issue_date:    (card.created_at || new Date().toISOString()).slice(0, 10),
      iva_percent:   22,
      lines: (card.product_lines || []).map(l => ({
        description: `${l.producto || ''} ${l.color || ''} ${l.talle || ''}`.trim(),
        quantity:    Number(l.cantidad) || 0,
        unit_price:  Number(l.precio) || 0,
        iva:         22,
      })),
    };
    patch.invoice_payload = kitfePayload;
  }

  await supa.from('production_cards').update(patch).eq('id', card.id);
  await supa.from('card_stories').insert({
    card_id: card.id,
    user_id: user.id,
    user_label: profile.full_name || user.email || 'system',
    type: 'odoo_sync',
    field_name: 'sale_order',
    to_value: String(orderId),
    notes: `OV creada manualmente · modo=${mode}` + (alreadyExisted ? ' (ya existía)' : ''),
    occurred_at: new Date().toISOString(),
  });
  await logAudit({
    action: 'card_sale_order_manual',
    entity_type: 'production_card', entity_id: card.id,
    details: { mode, odoo_sale_order_id: orderId, already_existed: alreadyExisted, odoo_name: name },
  });

  return { ok: true, mode, odoo_sale_order_id: orderId, kitfe_payload: patch.invoice_payload || null };
}

export async function createCardManual({ clientName, description, vendorUserId, vendor, stageKey = 'nuevo', isSample = false, dueDate, priority = 'normal' }) {
  if (!(await getCurrentUser())) throw new Error('Necesitás iniciar sesión para crear tarjetas');
  const supa = getSupa();
  const id = productionCardId();
  const { error } = await supa.from('production_cards').insert({
    id, source: 'manual',
    client_name: clientName,
    description,
    vendor: vendor || null,
    vendor_user_id: vendorUserId || null,
    stage_key: isSample ? 'muestra_pedir' : stageKey,
    is_sample: isSample,
    due_date: dueDate || null,
    billing_month: (dueDate || new Date().toISOString()).slice(0, 7),
    priority,
  });
  if (error) throw error;
  const user = await getCurrentUser();
  const profile = await getProfile();
  await supa.from('card_stories').insert({
    card_id: id, user_id: user?.id || null, user_label: profile?.full_name || 'system',
    type: 'created', to_value: isSample ? 'muestra_pedir' : stageKey,
  });
  return id;
}

// (#T7) Comentarios en tarjetas. Reusamos card_stories.type='comment'.
// El tracking de "leído por usuario" vive en card_comment_reads (migración 022).
export async function addComment(cardId, notes) {
  if (!(await getCurrentUser())) throw new Error('Necesitás iniciar sesión');
  const user = await getCurrentUser();
  const profile = await getProfile();
  const supa = getSupa();
  const { data, error } = await supa.from('card_stories').insert({
    card_id: cardId,
    user_id: user.id,
    user_label: profile?.full_name || user.email || 'system',
    type: 'comment',
    notes,
  }).select().single();
  if (error) throw error;
  // Marcar el propio comment como leído por su autor (para que el contador
  // global sea correcto). Best-effort.
  try { await markCommentsRead([data.id]); } catch {}
  return data;
}

// Marca uno o más comments como leídos por el usuario actual.
// UPSERT con onConflict: ignora duplicados (si ya estaba leído).
export async function markCommentsRead(storyIds) {
  if (!storyIds?.length) return;
  const user = await getCurrentUser();
  if (!user) return;
  const supa = getSupa();
  const rows = storyIds.map(id => ({ story_id: id, user_id: user.id }));
  const { error } = await supa.from('card_comment_reads')
    .upsert(rows, { onConflict: 'story_id,user_id' });
  if (error) console.warn('[markCommentsRead] falló:', error.message);
}

// Devuelve { cardId → [{id, notes, user_label, occurred_at}] } de comments
// NO leídos por el usuario actual (excluye los propios). Usado para:
//   - Pintar el badge "(N)" en el card del kanban (count por cardId).
//   - (#5) Tooltip al hover con el contenido de los comments sin abrir el modal.
//
// Una sola query trae todo. Si solo necesitás los counts, usá
// loadUnreadCommentCounts (wrapper sobre este).
export async function loadUnreadCommentsMap(cardIds) {
  if (!cardIds?.length) return {};
  const user = await getCurrentUser();
  if (!user) return {};
  const supa = getSupa();
  const { data: comments, error: e1 } = await supa.from('card_stories')
    .select('id, card_id, user_id, user_label, notes, occurred_at')
    .in('card_id', cardIds).eq('type', 'comment')
    .order('occurred_at', { ascending: false });
  if (e1) { console.warn('[unreadCommentsMap]', e1.message); return {}; }
  if (!comments?.length) return {};
  const others = comments.filter(c => c.user_id !== user.id);
  if (!others.length) return {};
  const ids = others.map(c => c.id);
  const { data: reads, error: e2 } = await supa.from('card_comment_reads')
    .select('story_id').in('story_id', ids).eq('user_id', user.id);
  if (e2) { console.warn('[unreadCommentsMap reads]', e2.message); return {}; }
  const readSet = new Set((reads || []).map(r => r.story_id));
  const map = {};
  for (const c of others) {
    if (readSet.has(c.id)) continue;
    (map[c.card_id] ||= []).push({
      id: c.id,
      notes: c.notes || '',
      user_label: c.user_label || '',
      occurred_at: c.occurred_at,
    });
  }
  return map;
}

export async function loadUnreadCommentCounts(cardIds) {
  const map = await loadUnreadCommentsMap(cardIds);
  const counts = {};
  for (const [k, v] of Object.entries(map)) counts[k] = v.length;
  return counts;
}

// Últimos N comentarios por tarjeta, sin filtrar por leído ni por autor.
// Usado para el tooltip que aparece al hover sobre el badge de comentarios.
export async function loadRecentCommentsMap(cardIds, limit = 4) {
  if (!cardIds?.length) return {};
  const supa = getSupa();
  const { data, error } = await supa
    .from('card_stories')
    .select('id, card_id, user_label, notes, occurred_at')
    .in('card_id', cardIds).eq('type', 'comment')
    .order('occurred_at', { ascending: false });
  if (error || !data?.length) return {};
  const map = {};
  for (const c of data) {
    if (!map[c.card_id]) map[c.card_id] = [];
    if (map[c.card_id].length < limit)
      map[c.card_id].push({ id: c.id, notes: c.notes || '', user_label: c.user_label || '', occurred_at: c.occurred_at });
  }
  return map;
}

// Botón "Crear factura" del modal de tarjeta.
//
// De un click: si no hay sale.order la crea, después crea (o recupera) la
// factura CONFIRMADA en Odoo. Idempotente por ref=card.id.
//
// - Cliente: card.client_name (crea partner si no existe).
// - Fecha factura: card.created_at (.slice(0,10)).
// - Líneas: card.product_lines mapeadas — matched → product_id; libre → account 4101.
// - IVA: 22% (account.tax con amount=22, type_tax_use='sale').
// - Estado final: 'posted' (confirmada) — no es "oficial" en términos del
//   usuario, pero queda contabilizada en Odoo.
export async function createInvoiceForCard(card) {
  if (!(await getCurrentUser())) throw new Error('Necesitás iniciar sesión');
  if (!card?.id) throw new Error('Tarjeta sin id');
  if (!card.client_name) throw new Error('La tarjeta no tiene cliente');
  if (!(card.product_lines || []).length) throw new Error('La tarjeta no tiene líneas de producto');

  const supa = getSupa();
  const user = await getCurrentUser();
  const profile = await getProfile();
  const odooUserId = await getOdooUserIdForCurrentUser();

  // Resolver tax + account contable (cache 5 min en odoo-client)
  const [taxId, accountId] = await Promise.all([
    findVatSaleTaxId(22),
    findAccountByCode('4101'),
  ]);

  // 1) Asegurar sale.order. Si la tarjeta ya tiene una, reutiliza.
  let orderId = card.odoo_sale_order_id;
  if (!orderId) {
    const so = await createSaleOrderDraft({
      clientName: card.client_name,
      partnerId: card.odoo_partner_id || undefined,
      ref: card.id,
      productLines: card.product_lines,
      notes: card.description || '',
      odooUserId,
    });
    orderId = so.orderId;
  }

  // 2) Crear (o recuperar) factura posted
  const inv = await createPostedInvoiceFromCard({
    clientName: card.client_name,
    partnerId: card.odoo_partner_id || undefined,
    ref: card.id,
    productLines: card.product_lines,
    notes: card.description || '',
    invoiceDate: (card.created_at || new Date().toISOString()).slice(0, 10),
    odooUserId,
    taxId, accountId,
  });

  // 3) Persistir en Supabase
  const patch = {
    odoo_sale_order_id: orderId,
    invoice_odoo_move_id: inv.moveId,
    invoice_drafted_at: card.invoice_drafted_at || new Date().toISOString(),
    invoice_mode: card.invoice_mode || 'factura',
    sale_order_manual: true,
  };
  const { error } = await supa.from('production_cards').update(patch).eq('id', card.id);
  if (error) console.warn('[createInvoiceForCard] update Supabase falló:', error.message);

  // 4) Audit + story (best-effort)
  try {
    await supa.from('card_stories').insert({
      card_id: card.id,
      user_id: user.id,
      user_label: profile?.full_name || user.email || 'system',
      type: 'odoo_sync', field_name: 'invoice',
      to_value: String(inv.moveId),
      notes: `Factura ${inv.name || '#'+inv.moveId} ${inv.alreadyExisted ? 'recuperada' : 'creada'} · ${inv.posted ? 'CONFIRMADA' : 'BORRADOR'}` + (inv.postError ? ` (post falló: ${inv.postError})` : ''),
    });
  } catch (e) { console.warn('[createInvoiceForCard] story falló:', e?.message); }
  logAudit({
    action: inv.alreadyExisted ? 'card_invoice_recover' : 'card_invoice_create',
    entity_type: 'production_card', entity_id: card.id,
    details: { odoo_move_id: inv.moveId, posted: inv.posted, post_error: inv.postError || null, ref: card.id },
    status: inv.posted ? 'ok' : 'error',
    error_message: inv.postError || null,
  }).catch(() => {});

  return { odoo_sale_order_id: orderId, ...inv };
}

// (#T1) Duplica una tarjeta. Si reposicion=true, todos los precios quedan en 0
// y el resultado se marca como is_reposicion + reposicion_of=card.id.
// Crea una nueva en stage_key='borrador' con created_at = now y sin
// odoo_sale_order_id ni attachments (empieza limpia). Los datos comerciales
// (forma_cobro, modo_pago, monto_sena) NO se copian en modo reposición.
export async function duplicateCard(card, { reposicion = false } = {}) {
  if (!(await getCurrentUser())) throw new Error('Necesitás iniciar sesión');
  const supa = getSupa();
  const newId = productionCardId();
  const lines = (card.product_lines || []).map(l => ({
    ...l,
    precio: reposicion ? 0 : l.precio,
  }));
  const nowIso = new Date().toISOString();
  const payload = {
    id: newId,
    source: 'manual',
    client_name: card.client_name,
    client_phone_e164: card.client_phone_e164,
    vendor: card.vendor,
    vendor_user_id: card.vendor_user_id,
    odoo_partner_id: card.odoo_partner_id,
    channel_venta: card.channel_venta,
    modo_pago:   reposicion ? null : card.modo_pago,
    metodo_pago: reposicion ? null : card.metodo_pago,
    monto_sena:  reposicion ? null : card.monto_sena,
    forma_cobro: reposicion ? null : card.forma_cobro,
    product_lines: lines,
    description: card.description,
    descripcion_pedido: card.descripcion_pedido,
    stage_key: 'borrador',
    is_sample: false,
    priority: card.priority || 'normal',
    due_date: null,                  // el usuario re-planifica
    production_date: null,
    billing_month: nowIso.slice(0, 7),
    estado_stock: 'Registrar / Chequear',
    estado_insumo: 'No esta editado',
    attachments: [],                 // adjuntos NO se duplican
    is_reposicion: reposicion,
    reposicion_of: reposicion ? card.id : null,
    created_at: nowIso,
    updated_at: nowIso,
  };
  const { error } = await supa.from('production_cards').insert(payload);
  if (error) throw error;
  const user = await getCurrentUser();
  const profile = await getProfile();
  await supa.from('card_stories').insert({
    card_id: newId,
    user_id: user?.id || null,
    user_label: profile?.full_name || user?.email || 'system',
    type: 'created',
    to_value: 'borrador',
    notes: reposicion ? `Reposición de ${card.id}` : `Duplicada de ${card.id}`,
  });
  await logAudit({
    action: reposicion ? 'card_repose' : 'card_duplicate',
    entity_type: 'production_card', entity_id: newId,
    details: { source: card.id, lines_count: lines.length },
  });
  return newId;
}
