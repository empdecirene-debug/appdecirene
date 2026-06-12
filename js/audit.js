// Helper para registrar eventos críticos en audit_log.
// Uso:
//   await logAudit({ action: 'sale_order_create', entity_type: 'production_card', entity_id: pid, details: {...}, status: 'ok' });

import { getSupa } from './supa.js?v=2';
import { getCurrentUser, getProfile } from './auth.js?v=2';

export async function logAudit({ action, entity_type, entity_id, details, status = 'ok', error_message }) {
  try {
    const supa = getSupa();
    const user = await getCurrentUser().catch(() => null);
    const profile = await getProfile().catch(() => null);
    await supa.from('audit_log').insert({
      user_id: user?.id || null,
      user_label: profile?.full_name || user?.email || 'system',
      action, entity_type: entity_type || null, entity_id: entity_id || null,
      details: details || null,
      status, error_message: error_message || null,
    });
  } catch (e) {
    // never throw from audit logging
    console.warn('[audit] failed:', e.message);
  }
}
