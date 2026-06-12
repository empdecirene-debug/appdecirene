// Cliente Supabase compartido entre todos los módulos.
// Las env vars SUPABASE_URL y SUPABASE_ANON_KEY son inyectadas en build (ver inject-env.js).
// Fallback local: pegar URL/key en localStorage (cirene_supabase_url / cirene_supabase_key).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL_PLACEHOLDER = '__SUPABASE_URL__';
const SUPABASE_ANON_KEY_PLACEHOLDER = '__SUPABASE_ANON_KEY__';

function resolveSupabaseConfig() {
  const url = (SUPABASE_URL_PLACEHOLDER.startsWith('__') ? null : SUPABASE_URL_PLACEHOLDER)
    || localStorage.getItem('cirene_supabase_url') || '';
  const key = (SUPABASE_ANON_KEY_PLACEHOLDER.startsWith('__') ? null : SUPABASE_ANON_KEY_PLACEHOLDER)
    || localStorage.getItem('cirene_supabase_key') || '';
  return { url, key };
}

let _client = null;
export function getSupa() {
  if (_client) return _client;
  const { url, key } = resolveSupabaseConfig();
  if (!url || !key) {
    throw new Error('Supabase no configurado. Configurar SUPABASE_URL y SUPABASE_ANON_KEY en Netlify, o pegar URL/key en el panel del cotizador.');
  }
  _client = createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'cirene_supa_session' },
  });
  return _client;
}

export function supaConfigured() {
  const { url, key } = resolveSupabaseConfig();
  return !!(url && key);
}
