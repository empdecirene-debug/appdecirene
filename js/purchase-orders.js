// Órdenes de compra operativas (a talleres o proveedores).
// Se crean en Supabase y opcionalmente se "empujan" a Odoo como purchase.order borrador.

import { getSupa } from './supa.js?v=2';
import { getCurrentUser, isAdmin, getOdooUserIdForCurrentUser } from './auth.js?v=2';
import { purchaseOrderId } from './ids.js?v=2';
import { logAudit } from './audit.js?v=2';
import { createPurchaseOrderDraft } from './odoo-client.js?v=2';

export async function listPurchaseOrders({ cardId = null, status = null } = {}) {
  const supa = getSupa();
  let q = supa.from('purchase_orders').select('*, workshops(name)').order('created_at', { ascending: false });
  if (cardId) q = q.eq('production_card_id', cardId);
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function getPurchaseOrder(id) {
  const supa = getSupa();
  const { data, error } = await supa.from('purchase_orders').select('*, workshops(name, odoo_partner_id)').eq('id', id).single();
  if (error) throw error;
  return data;
}

export async function createPurchaseOrder({ productionCardId, workshopId, notes, lines, pushToOdoo = false }) {
  if (!(await isAdmin())) throw new Error('Solo admin/director puede crear OC');
  const supa = getSupa();
  const user = await getCurrentUser();
  const id = purchaseOrderId();
  const total = (lines || []).reduce((a, l) => a + (parseFloat(l.quantity) || 0) * (parseFloat(l.unit_price) || 0), 0);

  const { data, error } = await supa.from('purchase_orders').insert({
    id,
    production_card_id: productionCardId || null,
    workshop_id: workshopId || null,
    notes: notes || null,
    lines: lines || [],
    total,
    status: 'borrador',
    created_by: user?.id || null,
  }).select().single();
  if (error) throw error;

  let odooResult = null;
  if (pushToOdoo) {
    try {
      // Resolver datos del workshop
      let workshopName = null, workshopPartnerId = null;
      if (workshopId) {
        const { data: w } = await supa.from('workshops').select('name, odoo_partner_id').eq('id', workshopId).single();
        if (w) { workshopName = w.name; workshopPartnerId = w.odoo_partner_id; }
      }
      const odooUserId = await getOdooUserIdForCurrentUser();
      odooResult = await createPurchaseOrderDraft({
        workshopName, workshopPartnerId,
        ref: id,
        lines,
        notes,
        odooUserId,
      });
      await supa.from('purchase_orders').update({
        odoo_purchase_order_id: odooResult.orderId,
        status: 'enviada',
      }).eq('id', id);
      data.odoo_purchase_order_id = odooResult.orderId;
      data.status = 'enviada';
    } catch (e) {
      await logAudit({
        action: 'po_push_odoo_failed',
        entity_type: 'purchase_order', entity_id: id,
        status: 'error', error_message: e.message,
      });
      throw new Error(`OC creada en De Cirene pero falló el push a Odoo: ${e.message}`);
    }
  }

  await logAudit({
    action: 'po_create',
    entity_type: 'purchase_order', entity_id: id,
    details: { total, lines_count: (lines || []).length, push_odoo: pushToOdoo, odoo_id: odooResult?.orderId },
  });
  return data;
}

export async function updatePurchaseOrderStatus(id, status) {
  if (!(await isAdmin())) throw new Error('Solo admin');
  const supa = getSupa();
  const patch = { status };
  if (status === 'confirmada') patch.confirmed_at = new Date().toISOString();
  const { error } = await supa.from('purchase_orders').update(patch).eq('id', id);
  if (error) throw error;
  await logAudit({ action: 'po_status_change', entity_type: 'purchase_order', entity_id: id, details: { status } });
}
