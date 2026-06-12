// Generación de IDs cortos legibles para tarjetas (intake, producción, OC).
// Formato: prefijo + YYYYMM + secuencia aleatoria base36
//   in-202605-7gh3
//   prod-202605-9kx2
//   po-202605-3vm8

function rand4() {
  return Math.random().toString(36).slice(2, 6);
}

function yyyymm(d = new Date()) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function intakeId() { return `in-${yyyymm()}-${rand4()}`; }
export function productionCardId() { return `prod-${yyyymm()}-${rand4()}`; }
export function purchaseOrderId() { return `po-${yyyymm()}-${rand4()}`; }
