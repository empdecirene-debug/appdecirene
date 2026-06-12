// Netlify build script: inyecta SUPABASE_URL y SUPABASE_ANON_KEY en los archivos
// que tienen los placeholders __SUPABASE_URL__ / __SUPABASE_ANON_KEY__.
//
// Antes solo tocaba index.html, pero los placeholders están en js/supa.js (el
// cliente Supabase compartido). Sin reemplazarlos ahí, el frontend cree que
// Supabase no está configurado y muestra "Supabase no configurado".
//
// Si las env vars no están seteadas, dejamos los placeholders intactos para
// que la app caiga al modo local-only.

const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

// Archivos que pueden contener los placeholders. Si se agregan más, sumarlos acá.
const TARGETS = [
  path.join(__dirname, 'index.html'),
  path.join(__dirname, 'js', 'supa.js'),
  path.join(__dirname, 'production.html'),
];

function replaceInFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.log(`[inject-env] saltando (no existe): ${filePath}`);
    return;
  }
  let content = fs.readFileSync(filePath, 'utf-8');
  let changed = false;
  if (SUPABASE_URL && content.includes('__SUPABASE_URL__')) {
    content = content.split('__SUPABASE_URL__').join(SUPABASE_URL);
    changed = true;
  }
  if (SUPABASE_ANON_KEY && content.includes('__SUPABASE_ANON_KEY__')) {
    content = content.split('__SUPABASE_ANON_KEY__').join(SUPABASE_ANON_KEY);
    changed = true;
  }
  if (changed) {
    fs.writeFileSync(filePath, content);
    console.log(`[inject-env] ${path.basename(filePath)} actualizado`);
  } else {
    console.log(`[inject-env] ${path.basename(filePath)} sin cambios`);
  }
}

if (!SUPABASE_URL) console.log('[inject-env] SUPABASE_URL no configurado (modo local-only)');
else                console.log('[inject-env] SUPABASE_URL OK');
if (!SUPABASE_ANON_KEY) console.log('[inject-env] SUPABASE_ANON_KEY no configurado (modo local-only)');
else                    console.log('[inject-env] SUPABASE_ANON_KEY OK');

for (const t of TARGETS) replaceInFile(t);
