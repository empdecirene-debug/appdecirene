// Parser robusto de notas de Asana → líneas de producto.
// Acepta 4 formatos (los que De Cirene usa históricamente):
//
//  1) tabla con separador pipe (|):
//       Producto | Color | Talle | Cantidad | Precio
//       Remera   | Negro | M     | 10       | 450
//
//  2) tabla separada por tabs (\t)
//
//  3) tabla separada por múltiples espacios (>=2)
//
//  4) formato vertical (cada campo en su línea):
//       Producto: Remera
//       Color: Negro
//       Talle: M
//       Cantidad: 10
//       Precio: 450
//
// Tolerante a errores menores, campos vacíos, signos de moneda, miles con punto, decimales con coma.

const HEADER_KEYS = ['producto', 'color', 'talle', 'cantidad', 'precio'];

function normalize(s) {
  return (s || '').toString().trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function parseNumber(s) {
  if (s === null || s === undefined) return 0;
  const cleaned = String(s).replace(/[^\d.,-]/g, '').trim();
  if (!cleaned) return 0;
  // si hay coma decimal y punto miles: "1.234,56"
  if (/^\d{1,3}(\.\d{3})+,\d+$/.test(cleaned)) return parseFloat(cleaned.replace(/\./g, '').replace(',', '.'));
  // solo coma decimal: "1234,56"
  if (/^\d+,\d+$/.test(cleaned)) return parseFloat(cleaned.replace(',', '.'));
  // formato americano "1,234.56"
  if (/^\d{1,3}(,\d{3})+\.\d+$/.test(cleaned)) return parseFloat(cleaned.replace(/,/g, ''));
  // miles con punto sin decimal: "1.234"
  if (/^\d{1,3}(\.\d{3})+$/.test(cleaned)) return parseFloat(cleaned.replace(/\./g, ''));
  return parseFloat(cleaned.replace(/,/g, '')) || 0;
}

function detectSeparator(line) {
  if (line.includes('|')) return /\s*\|\s*/;
  if (line.includes('\t')) return /\t+/;
  // 2 o más espacios consecutivos
  if (/\s{2,}/.test(line)) return /\s{2,}/;
  return null;
}

function mapHeaderCells(cells) {
  return cells.map(c => normalize(c)).map(c => {
    if (c.startsWith('produc')) return 'producto';
    if (c.startsWith('color')) return 'color';
    if (c.startsWith('tall')) return 'talle';
    if (c.startsWith('cant')) return 'cantidad';
    if (c.startsWith('prec') || c.startsWith('p. ') || c.startsWith('p.u') || c.startsWith('p u')) return 'precio';
    return c;
  });
}

function looksLikeHeader(cells) {
  const norm = cells.map(normalize);
  let hits = 0;
  for (const c of norm) {
    if (HEADER_KEYS.some(k => c.startsWith(k.slice(0, 4)))) hits++;
  }
  return hits >= 2;
}

function parseTabular(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const sep = detectSeparator(lines[0]);
  if (!sep) return [];
  // buscar la fila de encabezado: la primera que parezca header
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const cells = lines[i].split(sep);
    if (looksLikeHeader(cells)) { headerIdx = i; break; }
  }
  if (headerIdx < 0) return [];
  const headerCells = mapHeaderCells(lines[headerIdx].split(sep));
  const out = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = lines[i].split(sep).map(c => c.trim());
    if (!cells.some(Boolean)) continue;
    const row = { producto: '', color: '', talle: '', cantidad: 1, precio_unit: 0 };
    for (let j = 0; j < cells.length && j < headerCells.length; j++) {
      const key = headerCells[j];
      const val = cells[j];
      if (key === 'cantidad') row.cantidad = parseNumber(val) || 1;
      else if (key === 'precio') row.precio_unit = parseNumber(val);
      else if (['producto','color','talle'].includes(key)) row[key] = val;
    }
    if (row.producto || row.color || row.cantidad > 1 || row.precio_unit > 0) out.push(row);
  }
  return out;
}

function parseVertical(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim());
  // detectar grupos: cada grupo tiene "Producto:" + ... separados por línea en blanco
  const groups = [];
  let cur = [];
  for (const l of lines) {
    if (!l) {
      if (cur.length) { groups.push(cur); cur = []; }
    } else {
      cur.push(l);
    }
  }
  if (cur.length) groups.push(cur);

  const out = [];
  for (const g of groups) {
    const obj = { producto: '', color: '', talle: '', cantidad: 1, precio_unit: 0 };
    let hits = 0;
    for (const l of g) {
      const m = l.match(/^([^:]+):\s*(.*)$/);
      if (!m) continue;
      const k = normalize(m[1]);
      const v = m[2].trim();
      if (k.startsWith('produc')) { obj.producto = v; hits++; }
      else if (k.startsWith('color')) { obj.color = v; hits++; }
      else if (k.startsWith('tall')) { obj.talle = v; hits++; }
      else if (k.startsWith('cant')) { obj.cantidad = parseNumber(v) || 1; hits++; }
      else if (k.startsWith('prec')) { obj.precio_unit = parseNumber(v); hits++; }
    }
    if (hits >= 2) out.push(obj);
  }
  return out;
}

export function parseProductLines(notes) {
  if (!notes) return [];
  const text = String(notes);
  // probar tabular primero
  const tab = parseTabular(text);
  if (tab.length) return tab;
  // si no hubo, probar vertical
  return parseVertical(text);
}
