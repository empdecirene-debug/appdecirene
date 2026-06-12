// Motor de cálculo del cotizador de De Cirene.
// Réplica de la lógica del Excel "Cotizador Herrería":
//   costo_materiales = Σ(material.costoUnit × cantidad)
//   costo_mo         = Σ(rol.costoHora × horas)
//   costo_directo    = costo_materiales + costo_mo
//   precio_venta     = costo_directo × multiplicador   (default 1,5)
//   ganancia         = precio_venta − costo_directo
//   margen           = ganancia / precio_venta

export const DEFAULT_MULTIPLICADOR = 1.5;

export function n(x) { const v = parseFloat(x); return Number.isFinite(v) ? v : 0; }

export function calcMaterialLine(m) { return n(m.costoUnit) * n(m.cantidad); }
export function calcLaborLine(l)   { return n(l.costoHora) * n(l.horas); }

// Calcula y MUTA los derivados de una línea de cotización. Devuelve la línea.
export function calcLine(line) {
  const mult = n(line.multiplicador) || DEFAULT_MULTIPLICADOR;
  const costoMateriales = (line.materiales || []).reduce((s, m) => s + calcMaterialLine(m), 0);
  const costoMO = (line.manoObra || []).reduce((s, l) => s + calcLaborLine(l), 0);
  const costoDirecto = costoMateriales + costoMO;
  const precioVenta = costoDirecto * mult;
  const ganancia = precioVenta - costoDirecto;
  const margen = precioVenta ? ganancia / precioVenta : 0;
  Object.assign(line, { costoMateriales, costoMO, costoDirecto, precioVenta, ganancia, margen, multiplicador: mult });
  return line;
}

// Totales de la cotización completa (suma de líneas × cantidad de la línea).
export function calcQuoteTotals(cot) {
  let subtotalMateriales = 0, subtotalMO = 0, precio = 0;
  for (const line of (cot.lineas || [])) {
    calcLine(line);
    const q = n(line.cantidad) || 1;
    subtotalMateriales += line.costoMateriales * q;
    subtotalMO += line.costoMO * q;
    precio += line.precioVenta * q;
  }
  const costoDirecto = subtotalMateriales + subtotalMO;
  const ganancia = precio - costoDirecto;
  const margen = precio ? ganancia / precio : 0;
  return { subtotalMateriales, subtotalMO, costoDirecto, precioVenta: precio, ganancia, margen };
}

// Formato de moneda uruguaya ($ 1.234)
export function money(x) {
  return '$ ' + Math.round(n(x)).toLocaleString('es-UY');
}
export function pct(x) { return (n(x) * 100).toFixed(1) + '%'; }
