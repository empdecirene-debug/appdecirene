// Autorización: qué tabla puede leer/escribir cada rol.
//
// Reemplaza a las políticas RLS de Supabase. Antes el navegador hablaba directo con
// PostgREST y Postgres decidía con `auth.uid()`; ahora toda consulta pasa por esta API,
// que se conecta con UN usuario de base de datos, así que la decisión la tomamos acá.
//
// Criterio (el mismo de supabase/migrations/008_rls.sql):
//   config      → lee cualquier autenticado, escribe solo admin
//   operativo   → autenticado full (comercial y producción trabajan sobre esto)
//   contable    → solo admin
//   propio      → cada uno lo suyo (perfiles)
//
// Las COLUMNAS no se listan a mano: se leen del catálogo de Postgres al arrancar
// (ver cargarColumnas). Así no hay forma de que esta lista quede desfasada del esquema,
// y cualquier identificador que llegue del cliente se valida contra columnas reales
// antes de tocar el SQL.

const ADMIN = ['admin', 'director'];
const TODOS = ['admin', 'director', 'comercial', 'produccion'];

// leer / escribir = roles habilitados. `escribir: []` ⇒ nadie por la API.
const TABLAS = {
  // ── Configuración ─────────────────────────────────────────────
  materials:               { leer: TODOS, escribir: ADMIN },
  labor_rates:             { leer: TODOS, escribir: ADMIN },
  product_templates:       { leer: TODOS, escribir: ADMIN },
  template_material_lines: { leer: TODOS, escribir: ADMIN },
  template_labor_lines:    { leer: TODOS, escribir: ADMIN },
  kanban_stages:           { leer: TODOS, escribir: ADMIN },
  custom_fields:           { leer: TODOS, escribir: ADMIN },

  // ── Operativo ─────────────────────────────────────────────────
  intake_cards:                { leer: TODOS, escribir: TODOS },
  production_cards:            { leer: TODOS, escribir: TODOS },
  card_stories:                { leer: TODOS, escribir: TODOS },
  production_card_transitions: { leer: TODOS, escribir: TODOS },
  card_comment_reads:          { leer: TODOS, escribir: TODOS },
  quotes:                      { leer: TODOS, escribir: TODOS },
  quote_lines:                 { leer: TODOS, escribir: TODOS },
  clients:                     { leer: TODOS, escribir: TODOS },

  // ── Contabilidad (solo admin, igual que la RLS original) ──────
  cash_sessions:  { leer: ADMIN, escribir: ADMIN },
  job_payments:   { leer: ADMIN, escribir: ADMIN },
  cash_movements: { leer: ADMIN, escribir: ADMIN },

  // ── Perfiles y auditoría ──────────────────────────────────────
  // Los perfiles los lee cualquiera (la navbar muestra nombres); escribe solo admin.
  user_profiles: { leer: TODOS, escribir: ADMIN },
  // La auditoría se escribe sola desde la API; nadie la borra ni la edita.
  audit_log:     { leer: ADMIN, escribir: TODOS, soloInsert: true },
};

// Columnas reales por tabla, cargadas del catálogo al arrancar.
const columnas = new Map();

export async function cargarColumnas(pool) {
  const { rows } = await pool.query(
    `select table_name, column_name
       from information_schema.columns
      where table_schema = 'public'
      order by table_name, ordinal_position`
  );
  columnas.clear();
  for (const r of rows) {
    if (!columnas.has(r.table_name)) columnas.set(r.table_name, new Set());
    columnas.get(r.table_name).add(r.column_name);
  }
  const faltan = Object.keys(TABLAS).filter(t => !columnas.has(t));
  if (faltan.length) console.warn('[registry] tablas del registro que no existen en la BD:', faltan.join(', '));
  return columnas.size;
}

export function tablaPermitida(tabla) {
  return Object.prototype.hasOwnProperty.call(TABLAS, tabla) && columnas.has(tabla);
}

export function columnaPermitida(tabla, col) {
  // `*` lo resuelve el armador de SQL; acá solo validamos identificadores concretos.
  const set = columnas.get(tabla);
  if (!set) return false;
  // PostgREST permite "tabla.columna"; nos quedamos con la parte final.
  const limpio = String(col).includes('.') ? String(col).split('.').pop() : String(col);
  return set.has(limpio);
}

export function columnasDe(tabla) {
  return [...(columnas.get(tabla) || [])];
}

// Devuelve null si puede, o el motivo del rechazo.
export function puede(tabla, accion, rol) {
  const reglas = TABLAS[tabla];
  if (!reglas) return `Tabla no permitida: ${tabla}`;
  if (reglas.soloInsert && accion !== 'select' && accion !== 'insert') {
    return `Sobre ${tabla} solo se puede insertar o leer`;
  }
  const permitidos = accion === 'select' ? reglas.leer : reglas.escribir;
  if (!permitidos.includes(rol)) {
    return accion === 'select'
      ? `Tu rol (${rol}) no puede leer ${tabla}`
      : `Tu rol (${rol}) no puede modificar ${tabla}`;
  }
  return null;
}

export const ES_ADMIN = (rol) => ADMIN.includes(rol);
export const ROLES = TODOS;
