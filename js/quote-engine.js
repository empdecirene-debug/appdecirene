// Motor de cálculo del cotizador de De Cirene.
// Réplica de la lógica del Excel "Cotizador Herrería", ampliada 2026-08:
//
//   ── por producto (línea) ──
//   costo_materiales  = Σ(material.costoUnit × cantidad)
//   costo_mo          = Σ(rol.costoHora × horas)
//   costo_terminacion = terminación elegida del catálogo (0 si no hay)
//   costo_directo     = materiales + mo + terminación
//   precio_venta      = costo_directo × multiplicador   (default 1,5)
//
//   ── servicios (cotización) ──
//   transporte              → NO lleva markup: precio = costo
//   colocación (mano obra)  → SÍ lleva markup × multiplicador
//   colocación (viáticos)   → NO lleva markup
//
//   ganancia = precio_venta − costo_directo
//   margen   = ganancia / precio_venta
//
// Las DIMENSIONES (ancho/alto/largo/diámetro) son información de fabricación:
// viajan a Producción y NO intervienen en ningún cálculo de precio.
//
// SIN IVA: De Cirene es una asociación civil sin fines de lucro y su gestión
// interna no discrimina IVA en ningún módulo.

export const DEFAULT_MULTIPLICADOR = 1.5;

export function n(x) { const v = parseFloat(x); return Number.isFinite(v) ? v : 0; }

export function calcMaterialLine(m) { return n(m.costoUnit) * n(m.cantidad); }
export function calcLaborLine(l)   { return n(l.costoHora) * n(l.horas); }

// Las listas guardadas en jsonb pueden volver como objeto `{}` si en su momento
// se escribieron mal (un array de JS que el driver mandó como literal de ARRAY).
// `{} || []` da `{}`, que no tiene .reduce ni .map y voltea la pantalla entera:
// por eso todo lo que venga de jsonb pasa por acá.
export function arr(x) { return Array.isArray(x) ? x : []; }

// Calcula y MUTA los derivados de una línea de cotización. Devuelve la línea.
export function calcLine(line) {
  const mult = n(line.multiplicador) || DEFAULT_MULTIPLICADOR;
  const costoMateriales = arr(line.materiales).reduce((s, m) => s + calcMaterialLine(m), 0);
  const costoMO = arr(line.manoObra).reduce((s, l) => s + calcLaborLine(l), 0);
  // Terminación/pintado: costo del catálogo `finishes`, congelado en la línea.
  const costoTerminacion = n(line.terminacionCosto);
  const costoDirecto = costoMateriales + costoMO + costoTerminacion;
  const precioVenta = costoDirecto * mult;
  const ganancia = precioVenta - costoDirecto;
  const margen = precioVenta ? ganancia / precioVenta : 0;
  Object.assign(line, {
    costoMateriales, costoMO, costoTerminacion, costoDirecto,
    precioVenta, ganancia, margen, multiplicador: mult,
  });
  return line;
}

// ── Servicios de la cotización ────────────────────────────────────────────
// `srv` = { transporteCosto, colocacionHoras, colocacionOperarios,
//           colocacionCostoHora, colocacionMultiplicador, colocacionViaticos }
//
// Devuelve costos y precios separados para poder analizarlos después
// (fabricación vs. servicios) sin volver a recalcular nada.
export function calcServices(srv = {}) {
  const transporte = n(srv.transporteCosto);                 // sin markup
  const viaticos = n(srv.colocacionViaticos);                // sin markup
  const mult = n(srv.colocacionMultiplicador) || DEFAULT_MULTIPLICADOR;
  const operarios = Math.max(1, Math.round(n(srv.colocacionOperarios) || 1));
  const costoColocacionMO = n(srv.colocacionHoras) * n(srv.colocacionCostoHora) * operarios;
  const precioColocacionMO = costoColocacionMO * mult;       // con markup

  const costo = transporte + viaticos + costoColocacionMO;
  const precio = transporte + viaticos + precioColocacionMO;
  return {
    transporte, viaticos, operarios, multiplicador: mult,
    costoColocacionMO, precioColocacionMO,
    costoColocacion: costoColocacionMO + viaticos,
    precioColocacion: precioColocacionMO + viaticos,
    costo, precio,
    hay: (transporte + viaticos + costoColocacionMO) > 0,
  };
}

// Totales de la cotización completa: productos (× cantidad) + servicios.
export function calcQuoteTotals(cot) {
  let subtotalMateriales = 0, subtotalMO = 0, subtotalTerminaciones = 0, precioProductos = 0;
  for (const line of arr(cot.lineas)) {
    calcLine(line);
    const q = n(line.cantidad) || 1;
    subtotalMateriales += line.costoMateriales * q;
    subtotalMO += line.costoMO * q;
    subtotalTerminaciones += line.costoTerminacion * q;
    precioProductos += line.precioVenta * q;
  }
  const srv = calcServices(cot.servicios || {});
  const costoProductos = subtotalMateriales + subtotalMO + subtotalTerminaciones;
  const costoDirecto = costoProductos + srv.costo;
  const precio = precioProductos + srv.precio;
  const ganancia = precio - costoDirecto;
  const margen = precio ? ganancia / precio : 0;
  return {
    subtotalMateriales, subtotalMO, subtotalTerminaciones,
    costoProductos, precioProductos,
    servicios: srv,
    costoDirecto, precioVenta: precio, ganancia, margen,
  };
}

// ── Dimensiones (solo presentación; no afectan el precio) ─────────────────
export const UNIDADES_DIM = ['mm', 'cm', 'mt', 'pulg'];

// { ancho, anchoUnidad, alto, ... } → "120 cm × 40 cm × 90 cm · Ø 15 cm"
// Acepta las dos formas de la misma cosa: el objeto del cotizador (camelCase) y
// la fila / el jsonb que llega desde la base y desde Producción (snake_case).
export function dimsText(d = {}) {
  if (!d) return '';
  const uno = (v, u, etq) => (v === null || v === undefined || v === '' || !Number.isFinite(parseFloat(v)))
    ? null : `${etq}${(+v)} ${u || 'cm'}`;
  const lineales = [
    uno(d.ancho, d.anchoUnidad ?? d.ancho_unidad, ''),
    uno(d.alto, d.altoUnidad ?? d.alto_unidad, ''),
    uno(d.largo, d.largoUnidad ?? d.largo_unidad, ''),
  ].filter(Boolean);
  const diam = uno(d.diametro, d.diametroUnidad ?? d.diametro_unidad, 'Ø ');
  const partes = [];
  if (lineales.length) partes.push(lineales.join(' × '));
  if (diam) partes.push(diam);
  return partes.join(' · ');
}

// Formato de moneda uruguaya ($ 1.234)
export function money(x) {
  return '$ ' + Math.round(n(x)).toLocaleString('es-UY');
}
export function pct(x) { return (n(x) * 100).toFixed(1) + '%'; }
