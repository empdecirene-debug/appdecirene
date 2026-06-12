// Motor de reglas: dado un par (estado_stock, estado_insumo) decide en qué
// columna del Kanban tiene que vivir la tarjeta.
//
// Las 9 columnas están en `kanban_stages` (migration 004) con estas keys:
//   a_pedir_insumos | produccion_local | enviar_tercerizar | laser |
//   costurero_user | en_bordador | muestras | a_entregarse | entregado
//
// Las reglas se evalúan EN ORDEN — primera que matchea, gana. Devuelve null
// cuando ninguna regla dispara movimiento (el caller deja la tarjeta donde está).
//
// Si querés tocar el mapping, este archivo es el único lugar que hay que editar.

export const STAGE_KEYS = {
  A_PEDIR_INSUMOS:    'a_pedir_insumos',
  PRODUCCION_LOCAL:   'produccion_local',
  ENVIAR_TERCERIZAR:  'enviar_tercerizar',
  LASER:              'laser',
  COSTURERO_USER:     'costurero_user',
  EN_BORDADOR:        'en_bordador',
  MUESTRAS:           'muestras',
  A_ENTREGARSE:       'a_entregarse',
  ENTREGADO:          'entregado',
};

// 13 opciones. Este campo cumple dos funciones en el workflow real:
//   (a) control de materia prima:  Registrar → Comprar → En oficina
//   (b) control de entrega:        7 sub-estados según destino
//   + 3 estados finales/especiales
export const STOCK_STATES_GROUPED = [
  { group: 'Materia prima', items: ['Registrar / Chequear','Comprar','Esperando que llegue','En oficina'] },
  { group: 'Entrega',       items: ['Entregar en DAC','Entregar en Phonetec','Entregar en Bolivia','Entrega a cadetería','Entrega personal','Entrega a definir','El bordador entrega'] },
  { group: 'Finales',       items: ['Entregado','En Pausa','Cancelado'] },
];

export const INSUMO_STATES_GROUPED = [
  { group: 'Edición',                items: ['No esta editado'] },
  { group: 'DTF',                    items: ['Pedir DTF','Falta pedir parte del DTF','Falta que llegue el DTF','Esta el DTF','Pedir error/Reposicion/Cambio de DTF','Sin DTF'] },
  { group: 'Bordado y tercerización',items: ['Enviar a bordar','Esperando al bordador','Tercerizado'] },
  { group: 'Proveedores específicos',items: ['GIOVANNI - JUAN PAULLIER 2293','Bordados pando','YENIFFER - CURIALES 1531'] },
  { group: 'Otras técnicas',         items: ['LASER','SERIGRAFIA MARCELO','Jornalero','Modista'] },
  { group: 'Otros',                  items: ['Enviar muestra','Neutralizar'] },
];

export const STOCK_STATES  = STOCK_STATES_GROUPED.flatMap(g => g.items);
export const INSUMO_STATES = INSUMO_STATES_GROUPED.flatMap(g => g.items);

// (#10) Pesos de criticidad por estado: 0 = OK (verde), 1 = bloqueado/atrasado (rojo).
// Usado para el chip con gradiente rojo→amarillo→verde en production.html.
//
// La heurística:
//   0.0 - 0.2  → verde (estado terminado o listo para avanzar)
//   0.3 - 0.5  → amarillo (en progreso / esperando)
//   0.6 - 0.9  → rojo (acción requerida o demorado)
//   1.0        → rojo intenso (problema bloqueante)
//
// Cuando un estado no está mapeado, se asume 0.5 (amarillo neutro).
export const STOCK_WEIGHTS = {
  'Registrar / Chequear':     0.85,
  'Comprar':                  0.80,
  'Esperando que llegue':     0.50,
  'En oficina':               0.05,
  'Entregar en DAC':          0.15,
  'Entregar en Phonetec':     0.15,
  'Entregar en Bolivia':      0.15,
  'Entrega a cadetería':      0.15,
  'Entrega personal':         0.15,
  'Entrega a definir':        0.25,
  'El bordador entrega':      0.15,
  'Entregado':                0.00,
  'En Pausa':                 1.00,
  'Cancelado':                1.00,
};

export const INSUMO_WEIGHTS = {
  'No esta editado':                       0.95,
  'Pedir DTF':                             0.75,
  'Falta pedir parte del DTF':             0.70,
  'Falta que llegue el DTF':               0.45,
  'Esta el DTF':                           0.05,
  'Pedir error/Reposicion/Cambio de DTF':  0.85,
  'Sin DTF':                               0.10,
  'Enviar a bordar':                       0.60,
  'Esperando al bordador':                 0.40,
  'Tercerizado':                           0.40,
  'GIOVANNI - JUAN PAULLIER 2293':         0.40,
  'Bordados pando':                        0.40,
  'YENIFFER - CURIALES 1531':              0.40,
  'LASER':                                 0.40,
  'SERIGRAFIA MARCELO':                    0.40,
  'Jornalero':                             0.45,
  'Modista':                               0.45,
  'Enviar muestra':                        0.30,
  'Neutralizar':                           0.50,
};

// Devuelve un peso 0..1 para el estado. Si no está mapeado, 0.5 (neutro).
export function stockWeight(s) { return STOCK_WEIGHTS[s] ?? 0.5; }
export function insumoWeight(s) { return INSUMO_WEIGHTS[s] ?? 0.5; }

// Convierte un peso 0..1 en un color HSL (verde→amarillo→rojo) apto como
// background del chip. Saturación y luminosidad fijas para preservar contraste
// con texto oscuro #333.
export function weightToBg(w) {
  const clamped = Math.max(0, Math.min(1, w));
  const hue = Math.round((1 - clamped) * 130); // 0 (rojo) ↔ 130 (verde)
  return `hsl(${hue}, 70%, 84%)`;
}

// ────────────────────────────────────────────────────────────────────────
// Reglas de movimiento (#3). Primera que matchea gana. Devuelve stage_key o null.
//
// Las reglas viven en Supabase (tabla `stage_rules`, migración 016) y se
// cachean en localStorage. Hay un fallback hardcodeado en este archivo para
// que la app siga funcionando offline o si la tabla está vacía.
//
// El caller invoca `computeTargetStage(card)` después de actualizar
// estado_stock o estado_insumo y, si el resultado difiere del stage_key actual,
// mueve la tarjeta (con su correspondiente card_story).
//
// API:
//   computeTargetStage(card)            → síncrono. Usa _rulesCache si está
//                                          cargado, sino el fallback.
//   loadStageRules({force})             → async. Carga de Supabase + cache
//                                          localStorage. Llamar al boot.
//   saveStageRule(rule)                 → async. UPSERT a Supabase.
//   deleteStageRule(id)                 → async. DELETE.
//   listStageRules()                    → array de reglas (raw, para la UI).
//
// Las reglas externas tienen forma:
//   { id, priority, estado_stock_pattern, estado_insumo_pattern,
//     target_stage_key, description, enabled }
//
// Pattern matching:
//   - null → wildcard (matchea siempre)
//   - String que arranca con '^' → regex case-insensitive
//   - Cualquier otra string → igualdad exacta
// ────────────────────────────────────────────────────────────────────────

const FALLBACK_RULES = [
  { priority: 10,  estado_stock_pattern: 'Entregado',                       estado_insumo_pattern: null,                          target_stage_key: STAGE_KEYS.ENTREGADO,         description: 'Stock Entregado → columna entregado' },
  { priority: 20,  estado_stock_pattern: 'En Pausa',                        estado_insumo_pattern: null,                          target_stage_key: null,                          description: 'En Pausa → no mover' },
  { priority: 21,  estado_stock_pattern: 'Cancelado',                       estado_insumo_pattern: null,                          target_stage_key: null,                          description: 'Cancelado → no mover' },
  { priority: 30,  estado_stock_pattern: '^(Entregar |Entrega |El bordador entrega)', estado_insumo_pattern: null,                target_stage_key: STAGE_KEYS.A_ENTREGARSE,        description: 'Sub-estado de entrega' },
  { priority: 40,  estado_stock_pattern: null,                              estado_insumo_pattern: 'Enviar muestra',              target_stage_key: STAGE_KEYS.MUESTRAS,           description: 'Enviar muestra' },
  { priority: 41,  estado_stock_pattern: null,                              estado_insumo_pattern: 'Neutralizar',                 target_stage_key: STAGE_KEYS.MUESTRAS,           description: 'Neutralizar' },
  { priority: 50,  estado_stock_pattern: null,                              estado_insumo_pattern: 'LASER',                       target_stage_key: STAGE_KEYS.LASER,              description: 'Insumo LASER' },
  { priority: 60,  estado_stock_pattern: null,                              estado_insumo_pattern: 'Modista',                     target_stage_key: STAGE_KEYS.COSTURERO_USER,     description: 'Modista' },
  { priority: 61,  estado_stock_pattern: null,                              estado_insumo_pattern: 'Jornalero',                   target_stage_key: STAGE_KEYS.COSTURERO_USER,     description: 'Jornalero' },
  { priority: 70,  estado_stock_pattern: null,                              estado_insumo_pattern: 'Esperando al bordador',       target_stage_key: STAGE_KEYS.EN_BORDADOR,        description: 'Esperando al bordador' },
  { priority: 71,  estado_stock_pattern: null,                              estado_insumo_pattern: 'Tercerizado',                 target_stage_key: STAGE_KEYS.EN_BORDADOR,        description: 'Tercerizado' },
  { priority: 72,  estado_stock_pattern: null,                              estado_insumo_pattern: '^GIOVANNI',                   target_stage_key: STAGE_KEYS.EN_BORDADOR,        description: 'GIOVANNI' },
  { priority: 73,  estado_stock_pattern: null,                              estado_insumo_pattern: '^Bordados pando',             target_stage_key: STAGE_KEYS.EN_BORDADOR,        description: 'Bordados pando' },
  { priority: 74,  estado_stock_pattern: null,                              estado_insumo_pattern: '^YENIFFER',                   target_stage_key: STAGE_KEYS.EN_BORDADOR,        description: 'YENIFFER' },
  { priority: 75,  estado_stock_pattern: null,                              estado_insumo_pattern: 'SERIGRAFIA MARCELO',          target_stage_key: STAGE_KEYS.EN_BORDADOR,        description: 'SERIGRAFIA MARCELO' },
  { priority: 80,  estado_stock_pattern: null,                              estado_insumo_pattern: 'Enviar a bordar',             target_stage_key: STAGE_KEYS.ENVIAR_TERCERIZAR,  description: 'Enviar a bordar' },
  { priority: 90,  estado_stock_pattern: 'En oficina',                      estado_insumo_pattern: 'Esta el DTF',                 target_stage_key: STAGE_KEYS.PRODUCCION_LOCAL,   description: 'Stock + DTF listos' },
  { priority: 100, estado_stock_pattern: 'Esperando que llegue',            estado_insumo_pattern: null,                          target_stage_key: STAGE_KEYS.PRODUCCION_LOCAL,   description: 'Stock por llegar → producción local' },
  { priority: 110, estado_stock_pattern: null,                              estado_insumo_pattern: 'Falta que llegue el DTF',     target_stage_key: STAGE_KEYS.PRODUCCION_LOCAL,   description: 'Falta DTF → producción local' },
  { priority: 120, estado_stock_pattern: '^Registrar',                      estado_insumo_pattern: null,                          target_stage_key: STAGE_KEYS.A_PEDIR_INSUMOS,    description: 'Stock a Registrar' },
  { priority: 999, estado_stock_pattern: null,                              estado_insumo_pattern: null,                          target_stage_key: STAGE_KEYS.A_PEDIR_INSUMOS,    description: 'Fallback' },
];

const STAGE_RULES_CACHE_KEY = 'cirene_stage_rules_v1';
let _rulesCache = null;  // array de reglas activas; null = aún no cargado → usar fallback

// Convierte una regla "raw" (con patterns string/null) en una función matcher.
function _matcher(rule) {
  const stockP  = rule.estado_stock_pattern;
  const insumoP = rule.estado_insumo_pattern;
  const matchOne = (value, pattern) => {
    if (pattern == null) return true;        // wildcard
    if (typeof pattern === 'string' && pattern.startsWith('^')) {
      try { return new RegExp(pattern, 'i').test(value || ''); }
      catch { return false; }
    }
    return value === pattern;
  };
  return c => matchOne(c.estado_stock, stockP) && matchOne(c.estado_insumo, insumoP);
}

function _activeRules() {
  const rs = (_rulesCache && _rulesCache.length) ? _rulesCache : FALLBACK_RULES;
  return rs.filter(r => r.enabled !== false)
           .slice()
           .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
}

// Síncrono. Si _rulesCache no se cargó aún, usa FALLBACK_RULES.
// `card` debe tener al menos las propiedades `estado_stock` y `estado_insumo`.
export function computeTargetStage(card) {
  for (const rule of _activeRules()) {
    if (_matcher(rule)(card)) return rule.target_stage_key ?? null;
  }
  return null;
}

// Carga las reglas desde Supabase. Best-effort: si falla, intenta cache local;
// si tampoco, usa FALLBACK_RULES. Cachea en localStorage.
export async function loadStageRules({ force = false } = {}) {
  if (_rulesCache && !force) return _rulesCache;
  // Intentar cache localStorage primero — es lo que evita parpadeos en cargas
  // posteriores y permite trabajar offline.
  if (!force) {
    try {
      const raw = localStorage.getItem(STAGE_RULES_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) _rulesCache = parsed;
      }
    } catch {}
  }
  try {
    const { getSupa } = await import('./supa.js?v=2');
    const supa = getSupa();
    const { data, error } = await supa.from('stage_rules').select('*').order('priority', { ascending: true });
    if (error) throw error;
    if (Array.isArray(data) && data.length) {
      _rulesCache = data;
      try { localStorage.setItem(STAGE_RULES_CACHE_KEY, JSON.stringify(data)); } catch {}
    }
  } catch (e) {
    console.warn('[stage-rules] Supabase falló, usando cache/fallback:', e?.message || e);
  }
  return _rulesCache || FALLBACK_RULES;
}

export function listStageRules() {
  return _rulesCache || FALLBACK_RULES;
}

// UPSERT en Supabase. Si `rule.id` viene, hace UPDATE; sino INSERT.
export async function saveStageRule(rule) {
  const { getSupa } = await import('./supa.js?v=2');
  const supa = getSupa();
  const payload = {
    priority:               Number(rule.priority) || 999,
    estado_stock_pattern:   rule.estado_stock_pattern || null,
    estado_insumo_pattern:  rule.estado_insumo_pattern || null,
    target_stage_key:       rule.target_stage_key || null,
    description:            rule.description || null,
    enabled:                rule.enabled !== false,
    updated_at:             new Date().toISOString(),
  };
  if (rule.id) {
    const { error } = await supa.from('stage_rules').update(payload).eq('id', rule.id);
    if (error) throw error;
  } else {
    const { error } = await supa.from('stage_rules').insert(payload);
    if (error) throw error;
  }
  await loadStageRules({ force: true });
  try { window.dispatchEvent(new CustomEvent('cirene:stage-rules-updated')); } catch {}
}

export async function deleteStageRule(id) {
  const { getSupa } = await import('./supa.js?v=2');
  const supa = getSupa();
  const { error } = await supa.from('stage_rules').delete().eq('id', id);
  if (error) throw error;
  await loadStageRules({ force: true });
  try { window.dispatchEvent(new CustomEvent('cirene:stage-rules-updated')); } catch {}
}
