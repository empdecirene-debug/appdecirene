// CRUD de talleres.

import { getSupa } from './supa.js?v=3';
import { isAdmin } from './auth.js?v=3';
import { odooExec } from './odoo-client.js?v=3';
import { logAudit } from './audit.js?v=3';

export async function listWorkshops({ activeOnly = false } = {}) {
  const supa = getSupa();
  let q = supa.from('workshops').select('*').order('name');
  if (activeOnly) q = q.eq('active', true);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function createWorkshop({ name, contact_name, contact_phone, contact_email, tecnicas, notes, syncOdoo = false }) {
  if (!(await isAdmin())) throw new Error('Solo admin');
  const supa = getSupa();

  let odoo_partner_id = null;
  if (syncOdoo) {
    try {
      // Find or create supplier en Odoo
      const found = await odooExec('res.partner', 'search_read',
        [[['name', 'ilike', name]]], { fields: ['id'], limit: 1 });
      if (found[0]?.id) odoo_partner_id = found[0].id;
      else odoo_partner_id = await odooExec('res.partner', 'create',
        [{ name, supplier_rank: 1, email: contact_email || false, phone: contact_phone || false }]);
    } catch (e) {
      console.warn('Sync Odoo falló:', e.message);
    }
  }

  const { data, error } = await supa.from('workshops').insert({
    name, contact_name, contact_phone, contact_email,
    tecnicas: tecnicas || null,
    notes,
    odoo_partner_id,
  }).select().single();
  if (error) throw error;
  await logAudit({ action: 'workshop_create', entity_type: 'workshop', entity_id: data.id, details: { syncOdoo } });
  return data;
}

export async function updateWorkshop(id, fields) {
  if (!(await isAdmin())) throw new Error('Solo admin');
  const supa = getSupa();
  const { error } = await supa.from('workshops').update(fields).eq('id', id);
  if (error) throw error;
  await logAudit({ action: 'workshop_update', entity_type: 'workshop', entity_id: id, details: fields });
}

export async function deactivateWorkshop(id) {
  return updateWorkshop(id, { active: false });
}
