// Lógica de Intake / Bandeja de entrada.
// El vendedor crea tarjetas rápidas; admin las procesa (triaje).

import { getSupa } from './supa.js?v=3';
import { getCurrentUser, getProfile, isAdmin } from './auth.js?v=3';
import { intakeId, productionCardId } from './ids.js?v=3';
import { logAudit } from './audit.js?v=3';

export async function listMyIntakes() {
  const supa = getSupa();
  const user = await getCurrentUser();
  if (!user) return [];
  const { data, error } = await supa.from('intake_cards')
    .select('*')
    .eq('vendor_user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return data || [];
}

export async function listPendingTriage() {
  const supa = getSupa();
  const { data, error } = await supa.from('intake_cards')
    .select('*')
    .eq('status', 'pendiente_triaje')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function createIntake({
  clientQuery, description, targetDate, photoDataUrl,
  // Nuevo: archivos múltiples (imágenes + SVG/PDF). Cada item: { name, mime, dataUrl, kind }
  files,
  phone, vendor, channelSale, paymentMethod, senalAmount, productLines,
}) {
  const supa = getSupa();
  const user = await getCurrentUser();
  const profile = await getProfile();
  if (!user || !profile) throw new Error('Sin sesión');

  const id = intakeId();
  // Por compatibilidad con la columna actual `photo_urls` (text[]/jsonb de URLs),
  // guardamos solo los dataURLs de las imágenes en ese campo. Si hay archivos no-imagen,
  // van también pero el triaje a producción solo los enganchará como attachments.
  let photo_urls = null;
  if (Array.isArray(files) && files.length) {
    photo_urls = files.filter(f => f.kind === 'photo').map(f => f.dataUrl);
    if (!photo_urls.length) photo_urls = null;
  } else if (photoDataUrl) {
    photo_urls = [photoDataUrl];
  }

  const { error } = await supa.from('intake_cards').insert({
    id,
    vendor: vendor || profile.vendor_name || profile.full_name,
    vendor_user_id: user.id,
    client_query: clientQuery,
    client_phone_e164: phone || null,
    description: description || null,
    target_date: targetDate || null,
    channel_venta: channelSale || null,
    modo_pago: paymentMethod || null,
    monto_sena: senalAmount ?? null,
    product_lines: productLines || [],
    photo_urls,
    status: 'pendiente_triaje',
  });
  if (error) throw error;
  await logAudit({ action: 'intake_create', entity_type: 'intake_card', entity_id: id });
  return id;
}

// Triaje: convertir intake en production_card (en stage Diseño / Arte por defecto).
export async function triageToProduction(intake, { stageKey = 'diseno_arte', isSample = false } = {}) {
  if (!(await isAdmin())) throw new Error('Solo admin puede triajear');
  const supa = getSupa();

  const pid = productionCardId();
  // crear production_card
  const { error: e1 } = await supa.from('production_cards').insert({
    id: pid,
    source: 'intake',
    intake_card_id: intake.id,
    vendor: intake.vendor,
    vendor_user_id: intake.vendor_user_id,
    client_name: intake.client_query,
    client_phone_e164: intake.client_phone_e164 || null,
    channel_venta: intake.channel_venta || null,
    modo_pago: intake.modo_pago || null,
    monto_sena: intake.monto_sena ?? null,
    product_lines: intake.product_lines || [],
    description: intake.description,
    stage_key: isSample ? 'muestra_pedir' : stageKey,
    is_sample: isSample,
    due_date: intake.target_date,
    priority: 'normal',
    attachments: intake.photo_urls ? intake.photo_urls.map((u, i) => ({ kind: 'photo', url: u, name: `foto-${i+1}` })) : [],
  });
  if (e1) throw e1;

  // marcar intake como triajeada
  const user = await getCurrentUser();
  const { error: e2 } = await supa.from('intake_cards').update({
    status: isSample ? 'enviada_muestra' : 'convertida_produccion',
    triaged_by: user?.id || null,
    triaged_at: new Date().toISOString(),
    resulting_production_card_id: pid,
  }).eq('id', intake.id);
  if (e2) throw e2;

  // story de creación
  const profile = await getProfile();
  await supa.from('card_stories').insert({
    card_id: pid, user_id: user?.id || null, user_label: profile?.full_name || 'system',
    type: 'created', to_value: isSample ? 'muestra_pedir' : stageKey,
    notes: `Triajeada desde intake ${intake.id}`,
  });

  await logAudit({ action: 'intake_triage', entity_type: 'intake_card', entity_id: intake.id, details: { production_card_id: pid, is_sample: isSample } });
  return pid;
}

export async function discardIntake(intake, notes = '') {
  if (!(await isAdmin())) throw new Error('Solo admin puede descartar');
  const supa = getSupa();
  const user = await getCurrentUser();
  const { error } = await supa.from('intake_cards').update({
    status: 'descartada',
    triaged_by: user?.id || null,
    triaged_at: new Date().toISOString(),
    triage_notes: notes,
  }).eq('id', intake.id);
  if (error) throw error;
  await logAudit({ action: 'intake_discard', entity_type: 'intake_card', entity_id: intake.id, details: { notes } });
}

// Reduce una imagen a max 1200px de lado y devuelve un data URL JPEG ~80% calidad.
export async function compressImage(file, maxSide = 1200, quality = 0.78) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxSide || height > maxSide) {
          if (width > height) { height = Math.round(height * maxSide / width); width = maxSide; }
          else { width = Math.round(width * maxSide / height); height = maxSide; }
        }
        const c = document.createElement('canvas');
        c.width = width; c.height = height;
        c.getContext('2d').drawImage(img, 0, 0, width, height);
        res(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = rej;
      img.src = r.result;
    };
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}
