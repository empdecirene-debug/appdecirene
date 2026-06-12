// Normaliza teléfonos uruguayos a formato E.164 (+598...).
// Acepta entradas como:
//   099123456    →  +59899123456
//   99123456     →  +59899123456
//   59899123456  →  +59899123456
//   +598 99 123 456 → +59899123456
//   099-123-456  →  +59899123456
//
// Si no puede normalizar, devuelve null.

export function normalizePhoneUY(input) {
  if (!input) return null;
  // dejar solo dígitos y '+'
  let s = String(input).replace(/[^\d+]/g, '');
  if (!s) return null;

  // ya tiene +
  if (s.startsWith('+')) {
    if (s.startsWith('+598') && s.length >= 11) return s.slice(0, 12);
    if (s.length >= 12) return s; // otro país, lo dejo igual
    return null;
  }

  // sin +
  // 59899... (12 dígitos con código país)
  if (s.startsWith('598') && s.length === 11) return '+' + s;

  // 099... (formato local con cero) → 99...
  if (s.startsWith('0')) s = s.slice(1);

  // 99... (8 dígitos)
  if (s.length === 8) return '+598' + s;

  // 9 dígitos arrancando con 9 (algunas variantes)
  if (s.length === 9 && s.startsWith('9')) return '+598' + s.slice(1);

  return null;
}

// Para mostrar más amigable: +598 99 123 456
export function formatPhoneUY(e164) {
  if (!e164 || !e164.startsWith('+598')) return e164 || '';
  const rest = e164.slice(4);
  return '+598 ' + rest.slice(0, 2) + ' ' + rest.slice(2, 5) + ' ' + rest.slice(5);
}
