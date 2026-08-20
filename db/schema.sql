-- ═══════════════════════════════════════════════════════════════════════════
-- ESQUEMA DE CIRENE PARA POSTGRES EN RAILWAY
--
-- Generado a partir de supabase/migrations/_ALL.sql + 011_clients.sql.
-- El proyecto de Supabase original (bxlnsbkglxtxqceagsyr) fue eliminado; esta es
-- la base de reemplazo, corriendo en el propio proyecto de Railway.
--
-- Diferencias con el original:
--   · auth.users  → app_users (tabla propia con hash de contraseña)
--   · RLS/policies eliminadas: la app NO habla directo con Postgres. Toda consulta
--     entra por la API (api/), que valida sesión y rol contra api/registry.js.
--   · is_admin() eliminada (dependía de auth.uid()).
--
-- Idempotente: create table if not exists / create index if not exists.
-- ═══════════════════════════════════════════════════════════════════════════

-- Usuarios de la aplicación. Reemplaza a auth.users de Supabase.
-- password_hash = scrypt (node:crypto, sin dependencias nativas): "scrypt$N$r$p$salt$hash".
create table if not exists app_users (
  id             uuid primary key default gen_random_uuid(),
  email          text unique not null,
  password_hash  text not null,
  must_change_pw boolean not null default false,
  created_at     timestamptz not null default now(),
  last_login_at  timestamptz
);
create index if not exists idx_app_users_email on app_users (lower(email));

-- De Cirene ERP · esquema + seed (001–010). Pegar y ejecutar en Supabase SQL Editor.

-- ====== 001_core.sql ======
-- =====================================================================
-- De Cirene ERP — 001 núcleo
-- Tablas operativas base del ERP de De Cirene (herrería).
-- Ejecutar en el SQL Editor del proyecto Supabase de De Cirene.
-- =====================================================================

-- ── USER PROFILES (rol y datos de perfil; la identidad vive en app_users) ──
create table if not exists user_profiles (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  full_name text not null,
  vendor_name text,                       -- nombre mostrado (comercial/operario)
  role text not null default 'comercial'
    check (role in ('comercial','produccion','admin','director')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Helper: ¿el usuario actual es admin/director?


-- ── KANBAN STAGES (etapas configurables: pipeline comercial + producción) ──
create table if not exists kanban_stages (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  label text not null,
  category text not null check (category in
    ('comercial','produccion','finalizado','cancelado')),
  display_order int not null default 0,
  color text default '#888888',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ── CUSTOM FIELDS (campos personalizados por admin) ──────────────────
create table if not exists custom_fields (
  id uuid primary key default gen_random_uuid(),
  applies_to text not null check (applies_to in ('production_card','intake_card','quote')),
  field_key text not null,
  label text not null,
  field_type text not null check (field_type in ('text','number','select','date','boolean')),
  options jsonb,
  required boolean not null default false,
  display_order int not null default 0,
  active boolean not null default true,
  unique (applies_to, field_key)
);

-- ── INTAKE CARDS (CRM: consultas / leads) ────────────────────────────
create table if not exists intake_cards (
  id text primary key,
  vendor text not null,
  vendor_user_id uuid references app_users(id),
  client_query text not null,             -- nombre/empresa del cliente
  client_phone_e164 text,
  client_email text,
  description text,                        -- producto, medidas, color, terminación, lugar
  photo_urls text[],
  target_date date,
  urgency text default 'normal' check (urgency in ('baja','normal','alta','urgente')),
  stage_key text references kanban_stages(key),   -- etapa del pipeline comercial
  status text not null default 'abierta' check (status in
    ('abierta','cotizada','aceptada','rechazada','descartada')),
  resulting_quote_id text,
  resulting_production_card_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_intake_stage on intake_cards(stage_key);
create index if not exists idx_intake_vendor on intake_cards(vendor_user_id);

-- ── PRODUCTION CARDS (corazón del kanban de producción) ──────────────
create table if not exists production_cards (
  id text primary key,
  source text not null default 'manual' check (source in ('intake','quote_approved','manual')),

  -- vínculos
  vendor text,
  vendor_user_id uuid references app_users(id),
  intake_card_id text references intake_cards(id),
  quote_id text,

  -- comercial / cliente
  client_name text,
  client_phone_e164 text,
  direccion text,
  total_venta numeric(12,2) default 0,    -- total del trabajo (= quote.precio_venta)
  billing_month text,                     -- 'YYYY-MM' (para Ventas)
  forma_cobro text check (forma_cobro in ('sena','total','credito')),
  modo_pago text,
  metodo_pago text,
  monto_sena numeric(12,2),
  estado_pago text default 'NO',          -- 'NO' | 'SEÑA' | 'SI' (derivado de job_payments)
  contabilidad text,                      -- 'Agregado' | null
  entrega text,                           -- 'RETIRO SE' | 'Flete' | ...

  -- producción
  description text,
  stage_key text not null references kanban_stages(key),
  estado_stock text,                      -- chip de estado (libre)
  estado_insumo text,
  priority text default 'normal' check (priority in ('baja','normal','urgente')),
  due_date date,                          -- fecha de entrega
  production_date date,                   -- fecha de fabricación (≠ entrega)
  is_sample boolean not null default false,
  is_reposicion boolean default false,
  reposicion_of text,

  -- adjuntos / datos flexibles
  attachments jsonb default '[]'::jsonb,
  custom_fields jsonb default '{}'::jsonb,
  product_lines jsonb default '[]'::jsonb,   -- [{producto,cantidad,precio,...}]

  -- soft-archive
  archived_at timestamptz,
  archived_by uuid references app_users(id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists idx_production_stage on production_cards(stage_key);
create index if not exists idx_production_vendor on production_cards(vendor_user_id);
create index if not exists idx_production_due on production_cards(due_date);
create index if not exists idx_production_billing on production_cards(billing_month);

-- ── CARD STORIES (historial + comentarios) ───────────────────────────
create table if not exists card_stories (
  id uuid primary key default gen_random_uuid(),
  card_id text not null references production_cards(id) on delete cascade,
  user_id uuid references app_users(id),
  user_label text,
  occurred_at timestamptz not null default now(),
  type text not null check (type in ('stage_change','field_change','comment','attachment','created')),
  field_name text,
  from_value text,
  to_value text,
  notes text
);
create index if not exists idx_stories_card on card_stories(card_id, occurred_at desc);

-- ── CARD TRANSITIONS (métricas de demoras) ───────────────────────────
create table if not exists production_card_transitions (
  id uuid primary key default gen_random_uuid(),
  card_id text references production_cards(id) on delete cascade,
  field_changed text,
  from_value text,
  to_value text,
  card_vendor text,
  actor_id uuid references app_users(id),
  occurred_at timestamptz not null default now()
);
create index if not exists idx_transitions_card on production_card_transitions(card_id, occurred_at);

-- ── COMMENT READS (tracking de comentarios leídos) ───────────────────
create table if not exists card_comment_reads (
  story_id uuid references card_stories(id) on delete cascade,
  user_id uuid references app_users(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (story_id, user_id)
);

-- ── AUDIT LOG ────────────────────────────────────────────────────────
create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references app_users(id),
  user_label text,
  action text not null,
  entity_type text,
  entity_id text,
  details jsonb,
  status text default 'ok' check (status in ('ok','error','pending')),
  error_message text,
  occurred_at timestamptz not null default now()
);
create index if not exists idx_audit_occurred on audit_log(occurred_at desc);

-- ── TRIGGERS updated_at ──────────────────────────────────────────────
create or replace function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists trg_user_profiles_updated on user_profiles;
create trigger trg_user_profiles_updated before update on user_profiles
  for each row execute function set_updated_at();
drop trigger if exists trg_intake_updated on intake_cards;
create trigger trg_intake_updated before update on intake_cards
  for each row execute function set_updated_at();
drop trigger if exists trg_production_cards_updated on production_cards;
create trigger trg_production_cards_updated before update on production_cards
  for each row execute function set_updated_at();

-- ====== 002_seed_stages.sql ======
-- =====================================================================
-- De Cirene ERP — 002 seed de etapas (kanban_stages)
-- Pipeline COMERCIAL (CRM, del procedimiento/Asana) + pipeline PRODUCCIÓN
-- (6 estados del diagrama). Idempotente por `key`.
-- =====================================================================

insert into kanban_stages (key, label, category, display_order, color) values
  -- Pipeline comercial (CRM)
  ('mensaje_entrante', 'Mensaje entrante', 'comercial', 10, '#6B7280'),
  ('a_presupuestar',   'A presupuestar',   'comercial', 20, '#5B86A8'),
  ('necesita_info',    'Necesita más info','comercial', 30, '#C9A227'),
  ('presupuestado',    'Presupuestado',    'comercial', 40, '#7A8290'),
  ('enviado',          'Enviado',          'comercial', 50, '#4A4A4A'),
  ('en_seguimiento',   'En seguimiento',   'comercial', 60, '#3A6EA5'),
  ('aceptado',         'Aceptado',         'comercial', 70, '#2E7D46'),
  ('rechazado',        'Rechazado',        'comercial', 80, '#A33A3A'),
  -- Pipeline producción (6 estados)
  ('procesar',     'Procesar',     'produccion', 110, '#6B7280'),
  ('falta_llegar', 'Falta llegar', 'produccion', 120, '#C9A227'),
  ('a_producir',   'A producir',   'produccion', 130, '#5B86A8'),
  ('colocacion',   'Colocación',   'produccion', 140, '#3A6EA5'),
  ('a_entregar',   'A entregar',   'produccion', 150, '#2E7D46'),
  ('entregado',    'Entregado',    'finalizado', 200, '#1F1F1F'),
  ('cancelado',    'Cancelado',    'cancelado',  210, '#A33A3A')
on conflict (key) do update
  set label = excluded.label,
      category = excluded.category,
      display_order = excluded.display_order,
      color = excluded.color;

-- ====== 003_materials.sql ======
-- =====================================================================
-- De Cirene ERP — 003 materiales
-- Catálogo de materiales con precios (hoja "Materiales" del Excel cotizador).
-- Fuente del cálculo de costo de materiales en el cotizador.
-- =====================================================================

create table if not exists materials (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,                   -- "Hierro redondo 6mm", "Caño 30x30x2", "Pintura"
  tipo text,                              -- "Hierro redondo","Caño cuadrado","Varilla","Chapa","Pintura"...
  unidad text not null default 'mt',      -- 'mt' | 'm2' | 'm3' | 'litro' | 'unidad' | 'kg'
  precio_unit numeric(12,4) not null default 0,   -- precio por unidad (col "Precio por unidad")
  compra_min numeric(12,3),               -- compra mínima
  precio_compra numeric(12,2),            -- precio total de compra (IVA inc.)
  proveedor text,                         -- "Barraca HN"
  activo boolean not null default true,
  notas text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references app_users(id)
);
create index if not exists idx_materials_tipo on materials(tipo);
create index if not exists idx_materials_activo on materials(activo);

drop trigger if exists trg_materials_updated on materials;
create trigger trg_materials_updated before update on materials
  for each row execute function set_updated_at();

-- ====== 004_labor_rates.sql ======
-- =====================================================================
-- De Cirene ERP — 004 tarifas de mano de obra
-- Roles y costo/hora del Excel. Configurables desde el catálogo (admin).
-- =====================================================================

create table if not exists labor_rates (
  id uuid primary key default gen_random_uuid(),
  rol text not null unique,                -- 'Jefe de taller','Oficial','Aprendiz','Transporte'
  costo_hora numeric(12,2) not null default 0,
  es_transporte boolean not null default false,   -- el transporte se cobra por viaje, no por hora
  display_order int not null default 0,
  activo boolean not null default true,
  updated_at timestamptz not null default now()
);

insert into labor_rates (rol, costo_hora, es_transporte, display_order) values
  ('Jefe de taller', 350, false, 10),
  ('Oficial',        250, false, 20),
  ('Aprendiz',       125, false, 30),
  ('Transporte',     250, true,  40)
on conflict (rol) do nothing;

-- ====== 005_product_templates.sql ======
-- =====================================================================
-- De Cirene ERP — 005 plantillas de producto (BOM)
-- Cada hoja del Excel (Leñero, Parrilla, Quemador, Chispero...) = una
-- plantilla con su lista típica de materiales y horas. El cotizador la
-- clona a una cotización. También alimenta el Catálogo de productos.
-- =====================================================================

create table if not exists product_templates (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,                    -- "Leñero", "Parrilla móvil", ...
  categoria text,                          -- familia/categoría del catálogo
  descripcion text,
  dimensiones text,                        -- "90x40x110 cm" (referencia)
  terminacion text,                        -- "Convertidor 3 en 1", "Pintura negra mate"
  precio_referencia numeric(12,2),         -- precio mostrado en catálogo (opcional)
  multiplicador numeric(6,3) not null default 1.5,  -- override del 1.5 por producto
  es_estandar boolean not null default true,        -- estándar vs a-medida
  imagen_url text,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_templates_categoria on product_templates(categoria);

-- Líneas de material por defecto del BOM
create table if not exists template_material_lines (
  id uuid primary key default gen_random_uuid(),
  template_id uuid references product_templates(id) on delete cascade,
  material_id uuid references materials(id),   -- nullable: línea libre
  descripcion text,                            -- snapshot/override del nombre
  dimension text,                              -- "30x30x2mm", "1 litro"
  costo_unit numeric(12,4),                    -- snapshot del precio al crear
  cantidad numeric(12,3) not null default 1,
  display_order int not null default 0
);
create index if not exists idx_tpl_mat_template on template_material_lines(template_id);

-- Líneas de mano de obra por defecto del BOM
create table if not exists template_labor_lines (
  id uuid primary key default gen_random_uuid(),
  template_id uuid references product_templates(id) on delete cascade,
  labor_rate_id uuid references labor_rates(id),
  rol text,                                    -- snapshot
  costo_hora numeric(12,2),
  horas numeric(8,2) not null default 0,
  display_order int not null default 0
);
create index if not exists idx_tpl_lab_template on template_labor_lines(template_id);

drop trigger if exists trg_templates_updated on product_templates;
create trigger trg_templates_updated before update on product_templates
  for each row execute function set_updated_at();

-- ====== 006_quotes.sql ======
-- =====================================================================
-- De Cirene ERP — 006 cotizaciones (presupuestos)
-- Modelo relacional: quotes + quote_lines (el detalle fino de materiales
-- y mano de obra de cada línea va en jsonb dentro de la línea).
-- =====================================================================

create table if not exists quotes (
  id text primary key,                     -- 'COT-0007'
  numero int,                              -- secuencial
  estado text not null default 'borrador'
    check (estado in ('borrador','presupuestado','enviado','en_seguimiento','aceptado','rechazado')),

  -- cliente (sin Odoo)
  cliente_nombre text,
  cliente_contacto text,
  cliente_telefono text,
  cliente_direccion text,

  -- comercial
  vendedor text,
  vendedor_user_id uuid references app_users(id),
  intake_card_id text references intake_cards(id),
  production_card_id text,                 -- a qué trabajo derivó al aceptar

  -- totales (denormalizados para reportes rápidos)
  subtotal_materiales numeric(12,2) default 0,
  subtotal_mo numeric(12,2) default 0,
  costo_directo numeric(12,2) default 0,
  multiplicador numeric(6,3) default 1.5,
  precio_venta numeric(12,2) default 0,
  ganancia numeric(12,2) default 0,
  margen numeric(6,4) default 0,

  -- términos del PDF
  validez_dias int default 15,
  adelanto_pct int default 50,
  cronograma text,
  notas text,

  pdf_generado_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_quotes_estado on quotes(estado);
create index if not exists idx_quotes_vendedor on quotes(vendedor_user_id);
create index if not exists idx_quotes_intake on quotes(intake_card_id);

create table if not exists quote_lines (
  id uuid primary key default gen_random_uuid(),
  quote_id text references quotes(id) on delete cascade,
  template_id uuid references product_templates(id),  -- nullable (a medida)
  producto text not null,
  es_estandar boolean default true,
  pintado boolean default false,
  tamano text,
  cantidad numeric(12,3) default 1,

  -- detalle fino (jsonb dentro de la línea)
  materiales jsonb default '[]'::jsonb,    -- [{material_id,descripcion,dimension,costo_unit,cantidad,costo_total}]
  mano_obra jsonb default '[]'::jsonb,     -- [{rol,costo_hora,horas,costo_total}]
  especificaciones text,

  -- subtotales de la línea
  costo_materiales numeric(12,2) default 0,
  costo_mo numeric(12,2) default 0,
  costo_directo numeric(12,2) default 0,
  multiplicador numeric(6,3) default 1.5,
  precio_venta numeric(12,2) default 0,
  display_order int not null default 0
);
create index if not exists idx_quote_lines_quote on quote_lines(quote_id);

drop trigger if exists trg_quotes_updated on quotes;
create trigger trg_quotes_updated before update on quotes
  for each row execute function set_updated_at();

-- ====== 007_accounting.sql ======
-- =====================================================================
-- De Cirene ERP — 007 contabilidad y cierres de caja
-- Reemplaza a Odoo. Cobros por trabajo + movimientos de caja + cierres.
-- =====================================================================

-- Cierre de caja diario (se crea primero por las FK)
create table if not exists cash_sessions (
  id uuid primary key default gen_random_uuid(),
  fecha date not null default current_date,
  estado text not null default 'abierta' check (estado in ('abierta','cerrada')),
  saldo_inicial numeric(12,2) default 0,
  total_ingresos numeric(12,2) default 0,
  total_egresos numeric(12,2) default 0,
  saldo_final numeric(12,2) default 0,
  abierta_por uuid references app_users(id),
  cerrada_por uuid references app_users(id),
  cerrada_at timestamptz,
  notas text,
  created_at timestamptz not null default now()
);
create index if not exists idx_cash_sessions_fecha on cash_sessions(fecha);

-- Cobros asociados a un trabajo (seña, saldo, total)
create table if not exists job_payments (
  id uuid primary key default gen_random_uuid(),
  production_card_id text references production_cards(id) on delete cascade,
  tipo text not null check (tipo in ('sena','saldo','total','ajuste')),
  monto numeric(12,2) not null,
  metodo text,                             -- 'efectivo'|'transferencia'|'mercadopago'|...
  fecha date not null default current_date,
  cash_session_id uuid references cash_sessions(id),
  registrado_por uuid references app_users(id),
  notas text,
  created_at timestamptz not null default now()
);
create index if not exists idx_job_payments_card on job_payments(production_card_id);
create index if not exists idx_job_payments_session on job_payments(cash_session_id);

-- Movimientos de caja (ingresos/egresos; los cobros generan un ingreso espejo)
create table if not exists cash_movements (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('ingreso','egreso')),
  categoria text,                          -- 'venta'|'compra_materiales'|'sueldo'|'transporte'|'otro'
  monto numeric(12,2) not null,
  metodo text,
  fecha date not null default current_date,
  production_card_id text references production_cards(id) on delete set null,
  job_payment_id uuid references job_payments(id) on delete set null,
  material_id uuid references materials(id),
  cash_session_id uuid references cash_sessions(id),
  descripcion text,
  registrado_por uuid references app_users(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_cash_mov_fecha on cash_movements(fecha);
create index if not exists idx_cash_mov_session on cash_movements(cash_session_id);
create index if not exists idx_cash_mov_card on cash_movements(production_card_id);

-- ====== 008_rls.sql ======
-- =====================================================================
-- De Cirene ERP — 008 Row Level Security
-- Equipo chico: lectura/escritura autenticada en lo operativo (CRM, quotes,
-- producción), lectura auth / escritura admin en catálogos, y SOLO admin
-- en contabilidad y usuarios.
-- =====================================================================





















-- ── TALLERES ──────────────────────────────────────────────────────────
-- Heredada de la app original (talleres tercerizados), pero `admin.html` la sigue usando y
-- ADEMÁS es su pestaña por defecto: sin esta tabla, entrar a Administración rompía
-- antes de mostrar nada — incluida la pestaña de Usuarios. Se crea vacía.
-- `odoo_partner_id` no se usa en Cirene (no hay Odoo); queda porque el form lo lee.
create table if not exists workshops (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  contact_name    text,
  contact_email   text,
  contact_phone   text,
  tecnicas        text,
  odoo_partner_id integer,
  notes           text,
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);
create index if not exists idx_workshops_active on workshops (active);

-- ── PERMISOS ──────────────────────────────────────────────────────────
-- Acá iban las políticas RLS de Supabase (008_rls.sql). Se eliminaron a propósito:
-- con Supabase el navegador hablaba DIRECTO con la base y Postgres decidía con
-- auth.uid(); ahora toda consulta entra por la API, que se conecta con un único
-- usuario de base. La autorización equivalente (qué rol lee/escribe cada tabla)
-- vive en api/registry.js y se aplica en api/router.js antes de armar el SQL.

-- ====== 009_seed_materials.sql ======
-- =====================================================================
-- De Cirene ERP — 009 seed de materiales (desde Cotizador Herrería.xlsx, hoja Materiales)
-- Lista de precios real de la herrería. SOLO siembra lo que falta.
--
-- Antes esto era `delete from materials where notas='seed-excel-2026'` + insert,
-- y se ejecutaba en CADA arranque. Dos problemas graves:
--
--   1. En cuanto un material quedó referenciado por una orden de compra o un
--      movimiento de stock, el delete se volvió imposible y tumbó la migración
--      ENTERA. Y como el esquema se aplica en una sola query, la app levantaba
--      sin registro de tablas: toda consulta respondía "Tabla no permitida".
--   2. Cada deploy pisaba los precios que se hubieran actualizado desde el
--      Catálogo, devolviéndolos a los del archivo.
--
-- Ahora se insertan únicamente los materiales cuyo nombre todavía no existe.
-- Los precios los manda el Catálogo, que es donde se editan.
-- =====================================================================
insert into materials (nombre,tipo,unidad,precio_unit,compra_min,precio_compra,proveedor,activo,notas)
select v.nombre, v.tipo, v.unidad, v.precio_unit, v.compra_min, v.precio_compra, v.proveedor, v.activo, v.notas
from (values
  ('Hierro redondo 6mm','Hierro redondo','mt',16.3333,6.0,98.0,'Barraca HN',true,'seed-excel-2026'),
  ('Hierro redondo 8mm','Hierro redondo','mt',27.6667,6.0,166.0,'Barraca HN',true,'seed-excel-2026'),
  ('Hierro redondo 10mm','Hierro redondo','mt',51.6667,6.0,310.0,'Barraca HN',true,'seed-excel-2026'),
  ('Hierro redondo 12mm','Hierro redondo','mt',57.0,6.0,342.0,'Barraca HN',true,'seed-excel-2026'),
  ('Hierro redondo 14mm','Hierro redondo','mt',75.8067,6.0,454.84,'Barraca HN',true,'seed-excel-2026'),
  ('Hierro redondo 16mm','Hierro redondo','mt',95.8333,6.0,575.0,'Barraca HN',true,'seed-excel-2026'),
  ('Hierro redondo 19mm','Hierro redondo','mt',141.0,6.0,846.0,'Barraca HN',true,'seed-excel-2026'),
  ('Caño cuadrado 15x15x1,6','Caño cuadrado','mt',49.1667,6.0,295.0,'Barraca HN',true,'seed-excel-2026'),
  ('Caño cuadrado 20x20x2','Caño cuadrado','mt',78.3333,6.0,470.0,'Barraca HN',true,'seed-excel-2026'),
  ('Caño cuadrado 25x25x1,6','Caño cuadrado','mt',75.8767,6.0,455.26,'Barraca HN',true,'seed-excel-2026'),
  ('Caño cuadrado 25x25x2','Caño cuadrado','mt',99.1667,6.0,595.0,'Barraca HN',true,'seed-excel-2026'),
  ('Caño cuadrado 30x30x1,6','Caño cuadrado','mt',91.6667,6.0,550.0,'Barraca HN',true,'seed-excel-2026'),
  ('Caño cuadrado 30x30x2','Caño cuadrado','mt',116.1317,6.0,696.79,'Barraca HN',true,'seed-excel-2026'),
  ('Caño cuadrado 40x40x1,6','Caño cuadrado','mt',115.1667,6.0,691.0,'Barraca HN',true,'seed-excel-2026'),
  ('Caño rectangular 40x20x2','Caño rectangular','mt',123.3333,6.0,740.0,'Barraca HN',true,'seed-excel-2026'),
  ('Caño cuadrado 50x50x1,6','Caño cuadrado','mt',152.5,6.0,915.0,'Barraca HN',true,'seed-excel-2026'),
  ('Caño cuadrado 50x50x2','Caño cuadrado','mt',199.1667,6.0,1195.0,'Barraca HN',true,'seed-excel-2026'),
  ('Varilla cuadrada 8 mm','Varilla cuadrada','mt',39.1667,6.0,235.0,'Barraca HN',true,'seed-excel-2026'),
  ('Varilla cuadrada 10 mm','Varilla cuadrada','mt',56.1667,6.0,337.0,'',true,'seed-excel-2026'),
  ('Varilla cuadrada 12mm','Varilla cuadrada','mt',100.0,6.0,600.0,'',true,'seed-excel-2026'),
  ('Varilla cuadrada 19mm','Varilla cuadrada','mt',240.8333,6.0,1445.0,'',true,'seed-excel-2026'),
  ('Planchuela perforada 19mm 1 1/2 x 1/4','Planchuela perforada','mt',163.3333,6.0,980.0,'Barraca HN',true,'seed-excel-2026'),
  ('Planchuela 3/4 x 3/16','Planchuela','mt',51.6667,6.0,310.0,'Barraca HN',true,'seed-excel-2026'),
  ('Caño redondo 3/4 x2mm','Caño redondo','mt',68.3333,6.0,410.0,'Barraca HN',true,'seed-excel-2026'),
  ('Caño redondo 7/8 x 1,6mm','Caño redondo','mt',341.13,6.0,330.0,'Barraca HN',true,'seed-excel-2026'),
  ('Planchuela perforada 14 mm 1 1/4 x 3/16','Planchuela perforada','mt',116.6667,6.0,700.0,'Barraca HN',true,'seed-excel-2026'),
  ('Planchuela 1 3/4 x 1/4','Planchuela','mt',150.8333,6.0,905.0,'Barraca HN',true,'seed-excel-2026'),
  ('Angulo 1 1/2 x 3/16','Angulo','mt',171.3333,6.0,1028.0,'Barraca HN',true,'seed-excel-2026'),
  ('Angulo 2 x 1/4','Angulo','mt',235.0,6.0,1410.0,'Barraca HN',true,'seed-excel-2026'),
  ('Caño redondo 1 x 1.6mm','Caño redondo','mt',60.2617,6.0,361.57,'Barraca HN',true,'seed-excel-2026'),
  ('Planchuela 1/2 x1/8','Planchuela','mt',27.5,6.0,165.0,'Barraca HN',true,'seed-excel-2026'),
  ('tratado 6mm','tratado','mt',0.0,6.0,null,'',true,'seed-excel-2026'),
  ('tratado 8mm','tratado','mt',0.0,6.0,null,'',true,'seed-excel-2026'),
  ('tratado 10mm','tratado','mt',45.0,6.0,270.0,'Barraca HN',true,'seed-excel-2026'),
  ('tratado 12mm','tratado','mt',0.0,6.0,null,'',true,'seed-excel-2026'),
  ('tratado 14mm','tratado','mt',0.0,6.0,null,'',true,'seed-excel-2026'),
  ('Caño rectangular 70x30x2','Caño rectangular','mt',201.6667,6.0,1210.0,'Barraca HN',true,'seed-excel-2026'),
  ('Caño rectangular 40x30x2','Caño rectangular','mt',142.5,6.0,855.0,'Barraca HN',true,'seed-excel-2026'),
  ('Planchuela 1 x 3/8','Planchuela','mt',139.1667,6.0,835.0,'Barraca HN',true,'seed-excel-2026'),
  ('Planchuela 1 1/4 x 1/8','Planchuela','mt',56.6667,6.0,340.0,'Barraca HN',true,'seed-excel-2026'),
  ('Planchuela 1 1/2 x 1/4','Planchuela','mt',132.135,6.0,792.81,'Barraca HN',true,'seed-excel-2026'),
  ('Caño rectangular 40x30x1.6','Caño rectangular','mt',105.8333,6.0,635.0,'Barraca HN',true,'seed-excel-2026'),
  ('Chapa decapada Cal 16 3x1,5mts','Chapa decapada','un',3026.0,1.0,3026.0,'Hierromat',true,'seed-excel-2026'),
  ('Caño rectangular 60x30x2','Caño rectangular','mt',167.1667,6.0,1003.0,'Hierromat',true,'seed-excel-2026'),
  ('Metal Desplegable MD433 3x1,5','Metal Desplegable','un',2757.0,1.0,2757.0,'Hierromat',true,'seed-excel-2026'),
  ('Angulo Tee 1 x 1/8','Angulo Tee','mt',75.6667,6.0,454.0,'Hierromat',true,'seed-excel-2026'),
  ('Planchuela 1 x 1/8','Planchuela','mt',38.6667,6.0,232.0,'Hierromat',true,'seed-excel-2026'),
  ('Caño cuadrado 40x40x2mm','Caño cuadrado','mt',147.6667,6.0,886.0,'Hierromat',true,'seed-excel-2026'),
  ('Planchuela perforada 12mm 1 1/4 x 3/16','Planchuela perforada','mt',112.6667,6.0,676.0,'Hierromat',true,'seed-excel-2026'),
  ('Hierro redondo 12mm','Hierro redondo','mt',56.0,6.0,336.0,'Hierromat',true,'seed-excel-2026'),
  ('Chapa decapada Cal 20 2x1','Chapa decapada','un',965.29,1.0,965.29,'Barraca HN',true,'seed-excel-2026'),
  ('Angulo 3/4 x 1/8','Angulo','mt',54.1667,6.0,325.0,'Barraca HN',true,'seed-excel-2026'),
  ('Metal Desplegable MD411 25 x 12 x 2 x 1.5 mm de 1 x 3 mt','Metal Desplegable','un',1477.42,1.0,1477.42,'Hierromat',true,'seed-excel-2026'),
  ('Angulo 1 1/2 x 1/8','Angulo','mt',119.7967,6.0,718.78,'Barraca HN',true,'seed-excel-2026'),
  ('Angulo 1 1/4 x1/8','Angulo','mt',125.6667,6.0,754.0,'Barraca HN',true,'seed-excel-2026'),
  ('Planchuela 1 x 1/8','Planchuela','mt',45.8333,6.0,275.0,'Barraca HN',true,'seed-excel-2026'),
  ('Caño redondo 5/8 x 1.6mm','Caño redondo','mt',43.6667,6.0,262.0,'Barraca HN',true,'seed-excel-2026'),
  ('Caño redondo 3/4 x 1.6mm','Caño redondo','mt',48.5,6.0,291.0,'Barraca HN',true,'seed-excel-2026'),
  ('Planchuela 1 x 1/4','Planchuela','mt',82.1667,6.0,493.0,'Barraca HN',true,'seed-excel-2026'),
  ('Angulo 1 x 1/8','Angulo','mt',76.6667,6.0,460.0,'Barraca HN',true,'seed-excel-2026'),
  ('Chapa decapada Cal 18 2x1','Chapa decapada','mt',1668.0,null,1668.0,'Barraca HN',true,'seed-excel-2026'),
  ('Caño rectangular caño 50x30 2mm','Caño rectangular','mt',162.5,6.0,975.0,'Barraca HN',true,'seed-excel-2026'),
  ('Caño rectangular caño 50x30 1.6mm','Caño rectangular','mt',124.1667,6.0,745.0,'Barraca HN',true,'seed-excel-2026'),
  ('Caño rectangular 80x40x2mm','Caño rectangular','mt',232.0533,6.0,1392.32,'',true,'seed-excel-2026'),
  ('Caño cuadrado 80x80x2mm','Caño cuadrado','mt',313.3333,6.0,1880.0,'Barraca HN',true,'seed-excel-2026'),
  ('Caño cuadrado 40x40x2mm','Caño cuadrado','mt',152.6667,6.0,916.0,'Barraca HN',true,'seed-excel-2026'),
  ('Pirámide 80x80','Pirámide','un',140.0,1.0,140.0,'Barraca HN',true,'seed-excel-2026'),
  ('Pintura Fondo antióxido rojo','Pintura','lts',313.8889,3.6,1130.0,'Crisoles',true,'seed-excel-2026'),
  ('Pintura Negro semibrillo','Pintura','lts',465.2778,3.6,1675.0,'Crisoles',true,'seed-excel-2026'),
  ('Pintura Fondo antióxido gris','Pintura','lts',313.8889,3.6,1130.0,'Crisoles',true,'seed-excel-2026'),
  ('Pomela Pomela (Serie N3)','Pomela','un',90.0,1.0,90.0,'Barraca HN',true,'seed-excel-2026'),
  ('Tejido Tejido Electrosoldado','Tejido','un',1669.0,1.0,1669.0,'',true,'seed-excel-2026'),
  ('Platina 3mm 15x15cm','Platina','un',120.0,1.0,120.0,'Barraca HN',true,'seed-excel-2026'),
  ('Varilla roscada 8mm','Varilla roscada','mt',80.0,1.0,80.0,'',true,'seed-excel-2026'),
  ('Chapa negra Cal.12 1x2','Chapa negra','un',3600.0,1.0,3600.0,'Barraca HN',true,'seed-excel-2026'),
  ('Chapa negra Cal.12 1,5x3','Chapa negra','un',5505.0,1.0,5505.0,'Barraca HN',true,'seed-excel-2026'),
  ('Caño redondo 7/8x2mm','Caño redondo','mt',67.5,6.0,405.0,'Barraca HN',true,'seed-excel-2026'),
  ('Caño redondo 8´´x2mm','Caño redondo','mt',974.3333,6.0,5846.0,'Barraca HN',true,'seed-excel-2026'),
  ('Caño redondo 2´´x2mm','Caño redondo','mt',162.6667,6.0,976.0,'Barraca HN',true,'seed-excel-2026'),
  ('Chapa negra 1.5mm 3x1.5m','Chapa negra','un',3793.0,1.0,3793.0,'Barraca HN',true,'seed-excel-2026'),
  ('Chapa negra 2mm 3x1.5m','Chapa negra','un',4219.0,1.0,4219.0,'Barraca HN',true,'seed-excel-2026'),
  ('Chapa negra 3mm 3x1.5m','Chapa negra','un',6900.0,1.0,6900.0,'Barraca HN',true,'seed-excel-2026'),
  ('Chapa negra 5mm 3x1.5m','Chapa negra','un',10411.0,1.0,10411.0,'Barraca HN',true,'seed-excel-2026'),
  ('Planchuela 2x3/16','Planchuela','mt',134.8333,6.0,809.0,'Barraca HN',true,'seed-excel-2026'),
  ('Planchuela 2x1/8','Planchuela','mt',94.6667,6.0,568.0,'Barraca HN',true,'seed-excel-2026'),
  ('Planchuela 3x3/16','Planchuela','mt',225.1667,6.0,1351.0,'Barraca HN',true,'seed-excel-2026'),
  ('Caño redondo 1 1/2 x 1.6mm','Caño redondo','mt',94.4133,6.0,566.48,'Barraca HN',true,'seed-excel-2026'),
  ('Tapas de plástico 30x30','Tapas de plástico','un',30.0,1.0,30.0,'Barraca HN',true,'seed-excel-2026'),
  ('Chapa labrada 3mm 100cmx300cm','Chapa labrada','un',8577.0,1.0,8577.0,'',true,'seed-excel-2026'),
  ('Hormigón Pedregullo','Hormigón','m3',0,null,null,'',true,'seed-excel-2026')
) as v(nombre,tipo,unidad,precio_unit,compra_min,precio_compra,proveedor,activo,notas)
where not exists (select 1 from materials m where m.nombre = v.nombre);

-- ====== 010_seed_templates.sql ======
-- Igual que los materiales: esto hacía `delete from product_templates` en CADA
-- arranque. Borraba las plantillas creadas desde Catálogo, y en cuanto una
-- cotización referenciara una (quote_lines.template_id) el borrado iba a fallar
-- y tumbar la migración entera. Ahora cada bloque se planta solo si todavía no
-- hay ninguna plantilla.
do $$ declare tid uuid; begin
  if exists (select 1 from product_templates) then return; end if;
  insert into product_templates (nombre,categoria,dimensiones,multiplicador,es_estandar,precio_referencia,activo)
  values ('Leñero','Almacenaje','90x40x110 cm',1.45,true,7109,true) returning id into tid;
  insert into template_material_lines (template_id,descripcion,dimension,costo_unit,cantidad,display_order) values (tid,'Caño','30x30x2mm',700.0,2.0,0),(tid,'Varilla','10mm',310.0,1.0,1),(tid,'Tejido Electrosoldado','1.7x1.1m',120.0,1.0,2),(tid,'Pintura','1 litro',1675.0,0.33,3),(tid,'Tapas Caño','30x30',30.0,4.0,4);
  insert into template_labor_lines (template_id,labor_rate_id,rol,costo_hora,horas,display_order) values (tid,(select id from labor_rates where rol='Jefe de taller'),'Jefe de taller',350.0,4.0,0),(tid,(select id from labor_rates where rol='Aprendiz'),'Aprendiz',125.0,8.0,1);
end $$;
do $$ declare tid uuid; begin
  if exists (select 1 from product_templates) then return; end if;
  insert into product_templates (nombre,categoria,dimensiones,multiplicador,es_estandar,precio_referencia,activo)
  values ('Parrilla móvil','Cocina','',1.45,true,8996,true) returning id into tid;
  insert into template_material_lines (template_id,descripcion,dimension,costo_unit,cantidad,display_order) values (tid,'Varilla','10mm',254.0,5.0,0),(tid,'Ángulo','1 1/4x1/8',754.0,1.0,1),(tid,'Manivela y cadena','',2100.0,1.0,2),(tid,'Pomela','Serie N3',90.0,2.0,3);
  insert into template_labor_lines (template_id,labor_rate_id,rol,costo_hora,horas,display_order) values (tid,(select id from labor_rates where rol='Jefe de taller'),'Jefe de taller',350.0,4.0,0),(tid,(select id from labor_rates where rol='Aprendiz'),'Aprendiz',125.0,4.0,1);
end $$;
do $$ declare tid uuid; begin
  if exists (select 1 from product_templates) then return; end if;
  insert into product_templates (nombre,categoria,dimensiones,multiplicador,es_estandar,precio_referencia,activo)
  values ('Parrilla fija','Cocina','',1.4,true,4304,true) returning id into tid;
  insert into template_material_lines (template_id,descripcion,dimension,costo_unit,cantidad,display_order) values (tid,'Varilla','10mm',254.0,5.0,0),(tid,'Ángulo','1 1/4x1/8',754.0,1.0,1);
  insert into template_labor_lines (template_id,labor_rate_id,rol,costo_hora,horas,display_order) values (tid,(select id from labor_rates where rol='Jefe de taller'),'Jefe de taller',350.0,3.0,0);
end $$;
do $$ declare tid uuid; begin
  if exists (select 1 from product_templates) then return; end if;
  insert into product_templates (nombre,categoria,dimensiones,multiplicador,es_estandar,precio_referencia,activo)
  values ('Quemador','Cocina','',1.45,true,4162,true) returning id into tid;
  insert into template_material_lines (template_id,descripcion,dimension,costo_unit,cantidad,display_order) values (tid,'Varilla','14mm',455.0,4.0,0);
  insert into template_labor_lines (template_id,labor_rate_id,rol,costo_hora,horas,display_order) values (tid,(select id from labor_rates where rol='Jefe de taller'),'Jefe de taller',350.0,3.0,0);
end $$;
do $$ declare tid uuid; begin
  if exists (select 1 from product_templates) then return; end if;
  insert into product_templates (nombre,categoria,dimensiones,multiplicador,es_estandar,precio_referencia,activo)
  values ('Sacabotas','Accesorios','6 pares',1.4,true,3597,true) returning id into tid;
  insert into template_material_lines (template_id,descripcion,dimension,costo_unit,cantidad,display_order) values (tid,'Planchuela','1 1/4x1/8',340.0,1.0,0),(tid,'Ángulo','1 1/4x1/8',754.0,1.0,1),(tid,'Pintura','0.1lt',1675.0,0.03,2);
  insert into template_labor_lines (template_id,labor_rate_id,rol,costo_hora,horas,display_order) values (tid,(select id from labor_rates where rol='Jefe de taller'),'Jefe de taller',350.0,3.0,0),(tid,(select id from labor_rates where rol='Aprendiz'),'Aprendiz',125.0,3.0,1);
end $$;
do $$ declare tid uuid; begin
  if exists (select 1 from product_templates) then return; end if;
  insert into product_templates (nombre,categoria,dimensiones,multiplicador,es_estandar,precio_referencia,activo)
  values ('Chispero','Estufa','1.20 x 0.60 m',1.5,true,4958,true) returning id into tid;
  insert into template_material_lines (template_id,descripcion,dimension,costo_unit,cantidad,display_order) values (tid,'Tejido electrosoldado','',80.0,1.0,0),(tid,'Angulo','3/4x1/8',325.0,1.0,1),(tid,'Pintura y gastos','',500.0,1.0,2);
  insert into template_labor_lines (template_id,labor_rate_id,rol,costo_hora,horas,display_order) values (tid,(select id from labor_rates where rol='Jefe de taller'),'Jefe de taller',350.0,4.0,0),(tid,(select id from labor_rates where rol='Aprendiz'),'Aprendiz',125.0,8.0,1);
end $$;


-- ── CLIENTES (migración 011) ──────────────────────────────────────────
-- =====================================================================
-- De Cirene ERP — 011 clientes (portal por vendedor)
-- Cada vendedor ve/gestiona sus clientes; admin ve todos. Los clientes
-- sin dueño (vendedor_user_id null, ej. importados) son visibles para todos.
-- =====================================================================

create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  empresa text,
  telefono text,
  email text,
  direccion text,
  notas text,
  vendedor text,
  vendedor_user_id uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_clients_owner on clients(vendedor_user_id);





drop trigger if exists trg_clients_updated on clients;
create trigger trg_clients_updated before update on clients
  for each row execute function set_updated_at();

-- Seed inicial: clientes distintos desde intake_cards + production_cards (ver script de import).


-- ═══════════════════════════════════════════════════════════════════════════
-- AMPLIACIÓN 2026-08 · FASE 1 — COTIZADOR
--
-- Todo lo de abajo es idempotente (add column if not exists / create if not
-- exists / on conflict do nothing) y NO toca datos históricos: las columnas
-- nuevas admiten NULL o traen un default neutro (0 / false), de modo que una
-- cotización vieja sigue calculando exactamente lo mismo que antes.
--
-- Se diseñó pensando en las fases siguientes (CRM, Producción, Stock,
-- Contabilidad, Dashboard): las dimensiones y los comentarios de fabricación
-- viven en la línea de cotización y viajan a `production_cards.product_lines`;
-- el costo de mano de obra y de terminación queda CONGELADO en la cotización
-- (snapshot) para que actualizar el catálogo no reescriba presupuestos viejos.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── TERMINACIONES / PINTADO ───────────────────────────────────────────
-- Reemplaza al viejo booleano `quote_lines.pintado`. Ahora es un catálogo:
-- se agregan opciones nuevas desde Catálogo sin tocar código.
create table if not exists finishes (
  id            uuid primary key default gen_random_uuid(),
  nombre        text not null unique,
  descripcion   text,
  costo         numeric(12,2) not null default 0,   -- costo por unidad de producto
  unidad        text not null default 'producto',   -- 'producto' | 'm2' | 'litro'
  activo        boolean not null default true,
  display_order int not null default 0,
  notas         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    uuid references app_users(id)
);
create index if not exists idx_finishes_activo on finishes(activo);

drop trigger if exists trg_finishes_updated on finishes;
create trigger trg_finishes_updated before update on finishes
  for each row execute function set_updated_at();

-- Opción inicial pedida por De Cirene. El costo queda en 0 (a definir):
-- se completa desde Catálogo. `do nothing` para no pisar el costo ya cargado.
insert into finishes (nombre, costo, unidad, display_order, notas) values
  ('Pintado en aerosol', 0, 'producto', 10, 'Costo a definir desde Catalogo')
on conflict (nombre) do nothing;

-- ── MATERIALES: fuente única de datos ─────────────────────────────────
-- Se pueden crear/editar desde Catálogo y desde el Cotizador; ambos escriben
-- sobre esta misma tabla (no hay copias). Stock preparado para la Fase 4.
alter table materials add column if not exists stock_actual        numeric(12,3) not null default 0;
alter table materials add column if not exists stock_minimo        numeric(12,3) not null default 0;
alter table materials add column if not exists stock_comprometido  numeric(12,3) not null default 0;
alter table materials add column if not exists proveedor_id        uuid;   -- FK a suppliers (Fase 4)

-- ── MANO DE OBRA: trazabilidad del cambio de costo ────────────────────
alter table labor_rates add column if not exists updated_by uuid references app_users(id);
alter table labor_rates add column if not exists notas      text;
drop trigger if exists trg_labor_rates_updated on labor_rates;
create trigger trg_labor_rates_updated before update on labor_rates
  for each row execute function set_updated_at();

-- ── LÍNEA DE COTIZACIÓN: dimensiones, terminación y comentarios ───────
-- Dimensiones = información PARA FABRICAR. No intervienen en el cálculo:
-- son datos que viajan a Producción. Cada una con su unidad, todas opcionales.
alter table quote_lines add column if not exists ancho            numeric(12,3);
alter table quote_lines add column if not exists ancho_unidad     text default 'cm';
alter table quote_lines add column if not exists alto             numeric(12,3);
alter table quote_lines add column if not exists alto_unidad      text default 'cm';
alter table quote_lines add column if not exists largo            numeric(12,3);
alter table quote_lines add column if not exists largo_unidad     text default 'cm';
alter table quote_lines add column if not exists diametro         numeric(12,3);
alter table quote_lines add column if not exists diametro_unidad  text default 'cm';

-- Texto libre del comercial para el equipo de producción.
alter table quote_lines add column if not exists comentarios_produccion text;

-- Terminación elegida del catálogo `finishes`. Se guarda el id + un SNAPSHOT
-- del nombre y del costo: si mañana cambia el precio en Catálogo, esta
-- cotización sigue mostrando lo que se presupuestó.
alter table quote_lines add column if not exists terminacion_id      uuid references finishes(id);
alter table quote_lines add column if not exists terminacion_nombre  text;
alter table quote_lines add column if not exists terminacion_costo   numeric(12,2) not null default 0;
alter table quote_lines add column if not exists costo_terminacion   numeric(12,2) not null default 0;

-- `pintado` (booleano) queda para no romper cotizaciones históricas, pero la UI
-- ya no lo usa: la terminación se elige del catálogo.
comment on column quote_lines.pintado is 'OBSOLETO: reemplazado por terminacion_id. Se conserva por datos historicos.';

-- ── COTIZACIÓN: servicios (transporte + colocación) y trazabilidad ────
-- Transporte: se carga a mano, NO lleva markup, suma al precio final y queda
-- separado del costo de fabricación para poder analizarlo después.
alter table quotes add column if not exists transporte_costo  numeric(12,2) not null default 0;
alter table quotes add column if not exists transporte_notas  text;

-- Colocación: la MANO DE OBRA sí lleva markup; los viáticos NO.
alter table quotes add column if not exists colocacion_horas          numeric(10,2) not null default 0;
alter table quotes add column if not exists colocacion_operarios      int           not null default 1;
alter table quotes add column if not exists colocacion_labor_rate_id  uuid references labor_rates(id);
alter table quotes add column if not exists colocacion_rol            text;
alter table quotes add column if not exists colocacion_costo_hora     numeric(12,2) not null default 0;  -- snapshot
alter table quotes add column if not exists colocacion_multiplicador  numeric(6,3)  not null default 1.5;
alter table quotes add column if not exists colocacion_viaticos       numeric(12,2) not null default 0;
alter table quotes add column if not exists colocacion_comentarios    text;

-- Denormalizados de servicios (para Ventas / Dashboard sin recalcular)
alter table quotes add column if not exists costo_colocacion_mo   numeric(12,2) not null default 0;
alter table quotes add column if not exists precio_colocacion_mo  numeric(12,2) not null default 0;
alter table quotes add column if not exists subtotal_servicios    numeric(12,2) not null default 0;
alter table quotes add column if not exists costo_terminaciones   numeric(12,2) not null default 0;
alter table quotes add column if not exists subtotal_productos    numeric(12,2) not null default 0;

-- Comentarios generales para producción (a nivel cotización).
alter table quotes add column if not exists comentarios_produccion text;

-- Vínculo permanente con el cliente (Fase 2: CRM ↔ Cliente ↔ Cotización).
alter table quotes add column if not exists cliente_id uuid references clients(id);
create index if not exists idx_quotes_cliente on quotes(cliente_id);

-- Quién guardó por última vez (auditoría liviana; el detalle va en audit_log).
alter table quotes add column if not exists updated_by uuid references app_users(id);

-- ── NUMERACIÓN DE COTIZACIONES: una sola fuente, sin carreras ─────────
-- Antes el navegador calculaba max(numero)+1 y armaba el id. Dos pestañas (o
-- un doble clic) sacaban el mismo número y la segunda PISABA la primera con
-- un upsert. Ahora el número lo da una secuencia de Postgres y el id lo arma
-- un trigger: guardar dos veces la misma cotización actualiza, nunca duplica.
create sequence if not exists quotes_numero_seq;

do $ciren$
declare m int;
begin
  select coalesce(max(numero), 0) into m from quotes;
  if m >= 1 then perform setval('quotes_numero_seq', m, true);
  else            perform setval('quotes_numero_seq', 1, false);
  end if;
end $ciren$;

alter table quotes alter column numero set default nextval('quotes_numero_seq');

create or replace function quotes_asignar_id() returns trigger language plpgsql as $ciren$
declare intentos int := 0;
begin
  -- Si el id vino de afuera, se respeta tal cual: que un choque falle como choque
  -- y no se renumere solo (eso taparia un error de la app).
  if new.id is not null and new.id <> '' then return new; end if;

  if new.numero is null then new.numero := nextval('quotes_numero_seq'); end if;
  new.id := 'COT-' || lpad(new.numero::text, 4, '0');
  -- Cotizaciones viejas pueden tener `numero` null y ya ocupar ese id: se avanza
  -- la secuencia hasta el primer id libre.
  while exists (select 1 from quotes q where q.id = new.id) and intentos < 10000 loop
    new.numero := nextval('quotes_numero_seq');
    new.id := 'COT-' || lpad(new.numero::text, 4, '0');
    intentos := intentos + 1;
  end loop;
  return new;
end $ciren$;

drop trigger if exists trg_quotes_asignar_id on quotes;
create trigger trg_quotes_asignar_id before insert on quotes
  for each row execute function quotes_asignar_id();


-- ═══════════════════════════════════════════════════════════════════════════
-- AMPLIACIÓN 2026-08 · FASES 2 a 7
--
-- CRM/Clientes · Producción (operarios, subtareas, capacidad) · Abastecimiento
-- (proveedores, órdenes de compra, stock) · Finanzas (cuentas a cobrar, gastos,
-- reintegros, activos) · Gestión (impacto social) · NPS · Notificaciones.
--
-- Mismas reglas que la Fase 1: todo idempotente, nada se borra, columnas nuevas
-- con NULL o default neutro. SIN IVA en ningún lado.
-- ═══════════════════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────────────
-- FASE 2 · CRM, CLIENTES Y VENTAS
-- ─────────────────────────────────────────────────────────────────────

-- Etapa "Lead ganado": entre "Aceptado" y el cierre del pipeline comercial.
insert into kanban_stages (key, label, category, display_order, color) values
  ('lead_ganado', 'Lead ganado', 'comercial', 75, '#2E7D46')
on conflict (key) do update
  set label = excluded.label, category = excluded.category,
      display_order = excluded.display_order, color = excluded.color;

-- CLIENTES: el teléfono normalizado a E.164 es el identificador anti-duplicados.
alter table clients add column if not exists telefono_e164 text;
alter table clients add column if not exists es_interno   boolean not null default false;
alter table clients add column if not exists origen       text;   -- 'crm' | 'cotizador' | 'import'
alter table clients add column if not exists activo       boolean not null default true;

-- Rellena el normalizado de los clientes ya cargados (solo los que se pueden
-- resolver sin ambigüedad: 8 dígitos locales, con o sin 0, o ya con 598).
update clients set telefono_e164 = (
  case
    when regexp_replace(coalesce(telefono,''), '[^0-9]', '', 'g') = '' then null
    when length(regexp_replace(telefono, '[^0-9]', '', 'g')) = 11
     and left(regexp_replace(telefono, '[^0-9]', '', 'g'), 3) = '598'
      then '+' || regexp_replace(telefono, '[^0-9]', '', 'g')
    when length(regexp_replace(telefono, '[^0-9]', '', 'g')) = 9
     and left(regexp_replace(telefono, '[^0-9]', '', 'g'), 1) = '0'
      then '+598' || right(regexp_replace(telefono, '[^0-9]', '', 'g'), 8)
    when length(regexp_replace(telefono, '[^0-9]', '', 'g')) = 8
      then '+598' || regexp_replace(telefono, '[^0-9]', '', 'g')
    else null
  end)
where telefono_e164 is null and telefono is not null;

-- "CIRENEOS" = trabajo interno de la organización (requisito 27).
update clients set es_interno = true
where es_interno = false and upper(coalesce(nombre,'') || ' ' || coalesce(empresa,'')) like '%CIRENEO%';

-- Un solo cliente por teléfono. Índice parcial: los clientes sin teléfono no chocan.
-- Antes de crearlo hay que desduplicar lo que ya está (se queda el más viejo).
do $ciren$
begin
  if not exists (select 1 from pg_class where relname = 'ux_clients_telefono_e164') then
    update clients c set telefono_e164 = null
    where telefono_e164 is not null
      and exists (select 1 from clients o
                   where o.telefono_e164 = c.telefono_e164 and o.created_at < c.created_at);
    create unique index ux_clients_telefono_e164 on clients(telefono_e164)
      where telefono_e164 is not null;
  end if;
end $ciren$;

-- LEADS: vínculo permanente con cliente, cotización y venta.
alter table intake_cards add column if not exists client_id  uuid references clients(id);
alter table intake_cards add column if not exists won_at     timestamptz;
alter table intake_cards add column if not exists sale_id    uuid;
create index if not exists idx_intake_client on intake_cards(client_id);

-- VENTAS CONFIRMADAS. Una venta nace cuando la cotización aprobada pasa a
-- Producción. `quote_id` es UNIQUE: por más veces que se mueva la tarjeta a
-- "Lead ganado", la venta es una sola.
create table if not exists sales (
  id                  uuid primary key default gen_random_uuid(),
  quote_id            text unique references quotes(id),
  intake_card_id      text references intake_cards(id),
  production_card_id  text references production_cards(id),
  client_id           uuid references clients(id),
  cliente_nombre      text,
  vendedor            text,
  vendedor_user_id    uuid references app_users(id),
  monto               numeric(12,2) not null default 0,
  fecha               date not null default current_date,
  billing_month       text,
  estado              text not null default 'confirmada'
    check (estado in ('confirmada','entregada','anulada')),
  notas               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists idx_sales_fecha on sales(fecha);
create index if not exists idx_sales_vendedor on sales(vendedor_user_id);
create index if not exists idx_sales_client on sales(client_id);
create unique index if not exists ux_sales_production_card on sales(production_card_id)
  where production_card_id is not null;

drop trigger if exists trg_sales_updated on sales;
create trigger trg_sales_updated before update on sales
  for each row execute function set_updated_at();


-- ─────────────────────────────────────────────────────────────────────
-- FASE 3 · PRODUCCIÓN: operarios, subtareas, planificación y capacidad
-- ─────────────────────────────────────────────────────────────────────

-- OPERARIOS. Se administran desde Admin. `user_id` es opcional: no todo operario
-- tiene usuario de la app.
create table if not exists operators (
  id          uuid primary key default gen_random_uuid(),
  nombre      text not null,
  funcion     text,                               -- 'Herrero', 'Ayudante', 'Pintor'…
  costo_hora  numeric(12,2) not null default 0,
  user_id     uuid references app_users(id),
  activo      boolean not null default true,
  notas       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references app_users(id)
);
create index if not exists idx_operators_activo on operators(activo);
drop trigger if exists trg_operators_updated on operators;
create trigger trg_operators_updated before update on operators
  for each row execute function set_updated_at();

-- PLANIFICACIÓN DEL PEDIDO.
-- Tres fechas distintas y explícitas, porque significan cosas distintas:
--   fecha_solicitada_cliente → cuándo lo necesita el cliente
--   fecha_objetivo_interna   → cuándo estimamos terminarlo
--   fecha_real_fin           → cuándo se terminó de verdad
-- `due_date` (ya existente) se mantiene como la fecha comprometida de entrega.
alter table production_cards add column if not exists semana_produccion        text;          -- 'YYYY-Www'
alter table production_cards add column if not exists horas_estimadas          numeric(8,2) not null default 0;
alter table production_cards add column if not exists horas_reales             numeric(8,2) not null default 0;
alter table production_cards add column if not exists responsable_operator_id  uuid references operators(id);
alter table production_cards add column if not exists fecha_solicitada_cliente date;
alter table production_cards add column if not exists fecha_objetivo_interna   date;
alter table production_cards add column if not exists fecha_real_fin           date;
alter table production_cards add column if not exists listo_para_producir      boolean not null default false;
alter table production_cards add column if not exists sale_id                  uuid references sales(id);
alter table production_cards add column if not exists client_id                uuid references clients(id);
alter table production_cards add column if not exists costo_estimado           numeric(12,2) not null default 0;
create index if not exists idx_production_semana on production_cards(semana_produccion);
create index if not exists idx_production_cola on production_cards(listo_para_producir);

-- SUBTAREAS. El gerente de producción parte el pedido (corte, soldadura, pintura…)
-- y cada operario arranca / pausa / termina la suya.
create table if not exists production_subtasks (
  id                 uuid primary key default gen_random_uuid(),
  card_id            text not null references production_cards(id) on delete cascade,
  nombre             text not null,
  display_order      int not null default 0,
  operator_id        uuid references operators(id),
  horas_estimadas    numeric(8,2) not null default 0,
  estado             text not null default 'pendiente'
    check (estado in ('pendiente','en_curso','pausada','terminada','cancelada')),
  started_at         timestamptz,      -- primer inicio
  last_started_at    timestamptz,      -- inicio del tramo en curso (null si no corre)
  finished_at        timestamptz,
  segundos_trabajados int not null default 0,   -- acumulado de tramos cerrados
  comentarios        text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists idx_subtasks_card on production_subtasks(card_id, display_order);
create index if not exists idx_subtasks_operator on production_subtasks(operator_id);
drop trigger if exists trg_subtasks_updated on production_subtasks;
create trigger trg_subtasks_updated before update on production_subtasks
  for each row execute function set_updated_at();

-- BITÁCORA DE TIEMPOS. Cada tramo inicio→pausa/fin queda registrado: de acá
-- salen las horas reales y la productividad, no de un campo editable a mano.
create table if not exists subtask_time_logs (
  id          uuid primary key default gen_random_uuid(),
  subtask_id  uuid not null references production_subtasks(id) on delete cascade,
  card_id     text references production_cards(id) on delete cascade,
  operator_id uuid references operators(id),
  started_at  timestamptz not null,
  ended_at    timestamptz,
  segundos    int not null default 0,
  motivo_fin  text,                    -- 'pausa' | 'fin'
  created_at  timestamptz not null default now()
);
create index if not exists idx_timelogs_subtask on subtask_time_logs(subtask_id);
create index if not exists idx_timelogs_card on subtask_time_logs(card_id);
create index if not exists idx_timelogs_fecha on subtask_time_logs(started_at);

-- CAPACIDAD SEMANAL Y SEMÁFORO.
-- La herrería trabaja con personas en proceso de inserción laboral: la asistencia
-- y el rendimiento varían. Por eso la capacidad de cada semana se carga a mano y
-- el semáforo compara PLAN contra CAPACIDAD REAL, no contra un ideal fijo.
create table if not exists production_weeks (
  semana                   text primary key,             -- 'YYYY-Www' (ISO)
  capacidad_prevista_horas numeric(8,2) not null default 0,
  capacidad_real_horas     numeric(8,2) not null default 0,
  operarios_previstos      int not null default 0,
  operarios_reales         int not null default 0,
  semaforo_manual          text check (semaforo_manual in ('verde','amarillo','rojo')),
  notas                    text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  updated_by               uuid references app_users(id)
);
drop trigger if exists trg_weeks_updated on production_weeks;
create trigger trg_weeks_updated before update on production_weeks
  for each row execute function set_updated_at();


-- ─────────────────────────────────────────────────────────────────────
-- FASE 4 · PROVEEDORES, ÓRDENES DE COMPRA Y STOCK
-- ─────────────────────────────────────────────────────────────────────

create table if not exists suppliers (
  id                uuid primary key default gen_random_uuid(),
  nombre            text not null,
  contacto          text,
  telefono          text,
  email             text,
  materiales        text,                -- qué suministra (texto libre)
  condiciones_pago  text,
  cuenta_corriente  boolean not null default false,
  saldo             numeric(12,2) not null default 0,   -- deuda con el proveedor
  observaciones     text,
  activo            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_suppliers_activo on suppliers(activo);
drop trigger if exists trg_suppliers_updated on suppliers;
create trigger trg_suppliers_updated before update on suppliers
  for each row execute function set_updated_at();

-- Los proveedores que ya venían escritos a mano en los materiales se dan de alta
-- una sola vez, y el material queda apuntando a la ficha.
insert into suppliers (nombre)
select distinct on (lower(trim(m.proveedor))) trim(m.proveedor)
from materials m
where coalesce(trim(m.proveedor),'') <> ''
  and not exists (select 1 from suppliers s where lower(s.nombre) = lower(trim(m.proveedor)))
order by lower(trim(m.proveedor));

update materials m set proveedor_id = s.id
from suppliers s
where m.proveedor_id is null and lower(trim(coalesce(m.proveedor,''))) = lower(s.nombre);

-- ÓRDENES DE COMPRA
create table if not exists purchase_orders (
  id              text primary key,                 -- 'OC-000123'
  numero          int,
  supplier_id     uuid references suppliers(id),
  proveedor_nombre text,                            -- snapshot
  fecha           date not null default current_date,
  estado          text not null default 'borrador'
    check (estado in ('borrador','enviada','confirmada','recibida_parcial','recibida','cancelada')),
  fecha_esperada  date,
  fecha_recibida  date,
  forma_pago      text,
  total           numeric(12,2) not null default 0,
  observaciones   text,
  created_by      uuid references app_users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_po_supplier on purchase_orders(supplier_id);
create index if not exists idx_po_estado on purchase_orders(estado);
create index if not exists idx_po_fecha on purchase_orders(fecha);
drop trigger if exists trg_po_updated on purchase_orders;
create trigger trg_po_updated before update on purchase_orders
  for each row execute function set_updated_at();

create table if not exists purchase_order_lines (
  id                 uuid primary key default gen_random_uuid(),
  purchase_order_id  text not null references purchase_orders(id) on delete cascade,
  material_id        uuid references materials(id),
  descripcion        text,
  unidad             text,
  cantidad           numeric(12,3) not null default 0,
  costo_unit         numeric(12,4) not null default 0,
  costo_total        numeric(12,2) not null default 0,
  cantidad_recibida  numeric(12,3) not null default 0,
  display_order      int not null default 0
);
create index if not exists idx_pol_po on purchase_order_lines(purchase_order_id);
create index if not exists idx_pol_material on purchase_order_lines(material_id);

-- Numeración de OC con el mismo criterio que las cotizaciones: la da la base.
create sequence if not exists purchase_orders_numero_seq;
do $ciren$
declare m int;
begin
  select coalesce(max(numero), 0) into m from purchase_orders;
  if m >= 1 then perform setval('purchase_orders_numero_seq', m, true);
  else            perform setval('purchase_orders_numero_seq', 1, false);
  end if;
end $ciren$;
alter table purchase_orders alter column numero set default nextval('purchase_orders_numero_seq');

create or replace function po_asignar_id() returns trigger language plpgsql as $ciren$
declare intentos int := 0;
begin
  if new.id is not null and new.id <> '' then return new; end if;
  if new.numero is null then new.numero := nextval('purchase_orders_numero_seq'); end if;
  new.id := 'OC-' || lpad(new.numero::text, 5, '0');
  while exists (select 1 from purchase_orders p where p.id = new.id) and intentos < 10000 loop
    new.numero := nextval('purchase_orders_numero_seq');
    new.id := 'OC-' || lpad(new.numero::text, 5, '0');
    intentos := intentos + 1;
  end loop;
  return new;
end $ciren$;
drop trigger if exists trg_po_asignar_id on purchase_orders;
create trigger trg_po_asignar_id before insert on purchase_orders
  for each row execute function po_asignar_id();

-- MOVIMIENTOS DE STOCK. Historial completo: la recepción de una OC entra,
-- el consumo en producción sale, y los ajustes quedan asentados igual.
create table if not exists stock_movements (
  id                 uuid primary key default gen_random_uuid(),
  material_id        uuid not null references materials(id),
  tipo               text not null check (tipo in ('entrada','salida','ajuste')),
  cantidad           numeric(12,3) not null,        -- siempre positiva; el signo lo da `tipo`
  costo_unit         numeric(12,4),
  motivo             text,                          -- 'compra' | 'produccion' | 'ajuste' | 'devolucion'
  purchase_order_id  text references purchase_orders(id) on delete set null,
  production_card_id text references production_cards(id) on delete set null,
  subtask_id         uuid references production_subtasks(id) on delete set null,
  stock_resultante   numeric(12,3),
  fecha              date not null default current_date,
  notas              text,
  registrado_por     uuid references app_users(id),
  created_at         timestamptz not null default now()
);
create index if not exists idx_stockmov_material on stock_movements(material_id, fecha desc);
create index if not exists idx_stockmov_card on stock_movements(production_card_id);
create index if not exists idx_stockmov_po on stock_movements(purchase_order_id);


-- ─────────────────────────────────────────────────────────────────────
-- FASE 5 · FINANZAS: cuentas a cobrar, gastos, reintegros, activos
-- ─────────────────────────────────────────────────────────────────────

-- FACTURA INTERNA / CUENTA A COBRAR. No es un comprobante fiscal: es el registro
-- económico de cada pedido que entra a Producción. Uno por tarjeta (UNIQUE).
create table if not exists receivables (
  id                    uuid primary key default gen_random_uuid(),
  production_card_id    text unique references production_cards(id) on delete cascade,
  sale_id               uuid references sales(id),
  quote_id              text references quotes(id),
  client_id             uuid references clients(id),
  cliente_nombre        text,
  monto                 numeric(12,2) not null default 0,
  fecha                 date not null default current_date,
  forma_cobro           text not null default 'credito_entrega'
    check (forma_cobro in ('sena_saldo','credito_entrega','fecha_pactada')),
  monto_sena            numeric(12,2) not null default 0,
  fecha_sena            date,
  fecha_esperada_cobro  date,          -- por defecto = fecha de entrega
  fecha_esperada_saldo  date,
  cobrado               numeric(12,2) not null default 0,
  saldo                 numeric(12,2) not null default 0,
  estado                text not null default 'a_cobrar'
    check (estado in ('a_cobrar','parcial','cobrado','vencido','anulado')),
  notas                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists idx_receivables_estado on receivables(estado);
create index if not exists idx_receivables_fecha on receivables(fecha_esperada_cobro);
create index if not exists idx_receivables_client on receivables(client_id);
drop trigger if exists trg_receivables_updated on receivables;
create trigger trg_receivables_updated before update on receivables
  for each row execute function set_updated_at();

-- Los cobros siguen viviendo en `job_payments`; ahora también apuntan a la cuenta.
alter table job_payments add column if not exists receivable_id uuid references receivables(id) on delete set null;
create index if not exists idx_job_payments_receivable on job_payments(receivable_id);

-- CARGAS SOCIALES / APORTES configurables (no cableados en el frontend).
create table if not exists payroll_charges (
  id           uuid primary key default gen_random_uuid(),
  nombre       text not null unique,
  porcentaje   numeric(6,3) not null default 0,   -- % sobre el salario nominal
  aplica_a     text not null default 'nominal',
  activo       boolean not null default true,
  display_order int not null default 0,
  notas        text,
  updated_at   timestamptz not null default now(),
  updated_by   uuid references app_users(id)
);
drop trigger if exists trg_payroll_updated on payroll_charges;
create trigger trg_payroll_updated before update on payroll_charges
  for each row execute function set_updated_at();

-- Valores de arranque para Uruguay. Se editan desde Administración: son
-- parámetros, no reglas del código.
insert into payroll_charges (nombre, porcentaje, display_order, notas) values
  ('Aporte jubilatorio patronal', 7.5,  10, 'Editable desde Administración'),
  ('FONASA patronal',             5.0,  20, 'Editable desde Administración'),
  ('FRL patronal',                0.1,  30, 'Editable desde Administración'),
  ('Aguinaldo (provisión)',       8.33, 40, 'Provisión mensual'),
  ('Licencia + salario vacacional (provisión)', 11.0, 50, 'Provisión mensual')
on conflict (nombre) do nothing;

-- GASTOS. Categoría + cómo se pagó (organización, funcionario a reintegrar, o
-- cuenta corriente con el proveedor).
create table if not exists expenses (
  id                 uuid primary key default gen_random_uuid(),
  fecha              date not null default current_date,
  categoria          text not null default 'Otros',
  descripcion        text,
  monto              numeric(12,2) not null default 0,
  supplier_id        uuid references suppliers(id),
  purchase_order_id  text references purchase_orders(id) on delete set null,
  material_id        uuid references materials(id),
  production_card_id text references production_cards(id) on delete set null,

  forma_pago         text not null default 'organizacion'
    check (forma_pago in ('organizacion','funcionario_reintegro','cuenta_corriente')),
  pagado_por_user_id uuid references app_users(id),
  pagado_por_nombre  text,
  estado_reintegro   text check (estado_reintegro in ('pendiente','reintegrado','anulado')),
  fecha_reintegro    date,

  -- Sueldos: nominal + cargas calculadas con `payroll_charges`
  es_sueldo          boolean not null default false,
  salario_nominal    numeric(12,2),
  cargas_sociales    numeric(12,2),
  periodo            text,                        -- 'YYYY-MM'

  notas              text,
  registrado_por     uuid references app_users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists idx_expenses_fecha on expenses(fecha);
create index if not exists idx_expenses_categoria on expenses(categoria);
create index if not exists idx_expenses_reintegro on expenses(estado_reintegro);
create index if not exists idx_expenses_supplier on expenses(supplier_id);
drop trigger if exists trg_expenses_updated on expenses;
create trigger trg_expenses_updated before update on expenses
  for each row execute function set_updated_at();

-- CUENTA CORRIENTE CON PROVEEDORES: cargos (compras a crédito) y pagos.
create table if not exists supplier_ledger (
  id                uuid primary key default gen_random_uuid(),
  supplier_id       uuid not null references suppliers(id) on delete cascade,
  tipo              text not null check (tipo in ('cargo','pago')),
  monto             numeric(12,2) not null default 0,
  fecha             date not null default current_date,
  purchase_order_id text references purchase_orders(id) on delete set null,
  expense_id        uuid references expenses(id) on delete set null,
  metodo            text,
  notas             text,
  registrado_por    uuid references app_users(id),
  created_at        timestamptz not null default now()
);
create index if not exists idx_ledger_supplier on supplier_ledger(supplier_id, fecha);

-- ACTIVOS Y AMORTIZACIÓN (lineal).
create table if not exists assets (
  id                     uuid primary key default gen_random_uuid(),
  nombre                 text not null,
  categoria              text,
  fecha_compra           date not null default current_date,
  costo                  numeric(12,2) not null default 0,
  vida_util_meses        int not null default 60,
  valor_residual         numeric(12,2) not null default 0,
  metodo                 text not null default 'lineal' check (metodo in ('lineal')),
  estado                 text not null default 'activo'
    check (estado in ('activo','vendido','baja')),
  fecha_baja             date,
  notas                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index if not exists idx_assets_estado on assets(estado);
drop trigger if exists trg_assets_updated on assets;
create trigger trg_assets_updated before update on assets
  for each row execute function set_updated_at();


-- ─────────────────────────────────────────────────────────────────────
-- FASE 6 · GESTIÓN: impacto social
-- ─────────────────────────────────────────────────────────────────────

-- Bloque manual: cuántas personas pasaron por la herrería y cuántas están hoy
-- en proceso. Se guarda un registro por fecha para poder mostrar la evolución.
create table if not exists social_impact (
  id                  uuid primary key default gen_random_uuid(),
  fecha               date not null default current_date,
  personas_historico  int not null default 0,
  personas_actuales   int not null default 0,
  notas               text,
  registrado_por      uuid references app_users(id),
  created_at          timestamptz not null default now()
);
create unique index if not exists ux_social_impact_fecha on social_impact(fecha);


-- ─────────────────────────────────────────────────────────────────────
-- FASE 7 · NPS
-- ─────────────────────────────────────────────────────────────────────

-- Un formulario por cliente/pedido. Las respuestas viven en la misma fila
-- (relación 1 a 1): así el estado "enviado / respondido" es una sola verdad.
create table if not exists nps_surveys (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid references clients(id),
  cliente_nombre     text,
  production_card_id text references production_cards(id) on delete set null,
  sale_id            uuid references sales(id),
  vendedor           text,
  vendedor_user_id   uuid references app_users(id),
  token              text unique,
  estado             text not null default 'pendiente'
    check (estado in ('pendiente','enviada','respondida','anulada')),
  enviada_at         timestamptz,
  respondida_at      timestamptz,

  -- Respuestas
  recomendacion      int check (recomendacion between 0 and 10),
  impacto_social     int check (impacto_social between 0 and 10),
  aspectos           jsonb default '[]'::jsonb,
  mejoras            text,
  como_conocio       text,
  comentarios        text,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists idx_nps_estado on nps_surveys(estado);
create index if not exists idx_nps_client on nps_surveys(client_id);
create unique index if not exists ux_nps_card on nps_surveys(production_card_id)
  where production_card_id is not null;
drop trigger if exists trg_nps_updated on nps_surveys;
create trigger trg_nps_updated before update on nps_surveys
  for each row execute function set_updated_at();

-- Listas administrables del formulario (aspectos valorados, cómo nos conoció).
create table if not exists nps_options (
  id            uuid primary key default gen_random_uuid(),
  tipo          text not null check (tipo in ('aspecto','canal')),
  valor         text not null,
  display_order int not null default 0,
  activo        boolean not null default true,
  unique (tipo, valor)
);
insert into nps_options (tipo, valor, display_order) values
  ('aspecto','Calidad del producto',10),
  ('aspecto','Cumplimiento de plazos',20),
  ('aspecto','Atención y comunicación',30),
  ('aspecto','Precio',40),
  ('aspecto','Diseño y terminación',50),
  ('aspecto','Impacto social del proyecto',60),
  ('canal','Recomendación de un conocido',10),
  ('canal','Instagram',20),
  ('canal','Facebook',30),
  ('canal','Google',40),
  ('canal','Ya era cliente',50),
  ('canal','Otro',60)
on conflict (tipo, valor) do nothing;


-- ─────────────────────────────────────────────────────────────────────
-- NOTIFICACIONES / CENTRO DE ACTIVIDAD
-- ─────────────────────────────────────────────────────────────────────
create table if not exists notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references app_users(id) on delete cascade,
  tipo        text not null default 'comentario',
  titulo      text not null,
  cuerpo      text,
  url         text,
  entity_type text,
  entity_id   text,
  leida       boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists idx_notif_user on notifications(user_id, leida, created_at desc);


-- ═══════════════════════════════════════════════════════════════════════════
-- DATOS DE DEMO Y REINICIO
--
-- `demo` marca las filas que generó el botón "Generar datos de prueba" de
-- Administración. Sirve para poder borrarlas después SIN tocar lo real: el
-- reinicio de demo filtra por esta columna. Default false, así que nada de lo
-- que ya existe queda marcado.
-- ═══════════════════════════════════════════════════════════════════════════
alter table clients             add column if not exists demo boolean not null default false;
alter table intake_cards        add column if not exists demo boolean not null default false;
alter table quotes              add column if not exists demo boolean not null default false;
alter table sales               add column if not exists demo boolean not null default false;
alter table production_cards    add column if not exists demo boolean not null default false;
alter table production_subtasks add column if not exists demo boolean not null default false;
alter table card_stories        add column if not exists demo boolean not null default false;
alter table receivables         add column if not exists demo boolean not null default false;
alter table job_payments        add column if not exists demo boolean not null default false;
alter table cash_movements      add column if not exists demo boolean not null default false;
alter table cash_sessions       add column if not exists demo boolean not null default false;
alter table expenses            add column if not exists demo boolean not null default false;
alter table supplier_ledger     add column if not exists demo boolean not null default false;
alter table purchase_orders     add column if not exists demo boolean not null default false;
alter table stock_movements     add column if not exists demo boolean not null default false;
alter table suppliers           add column if not exists demo boolean not null default false;
alter table operators           add column if not exists demo boolean not null default false;
alter table assets              add column if not exists demo boolean not null default false;
alter table social_impact       add column if not exists demo boolean not null default false;
alter table production_weeks    add column if not exists demo boolean not null default false;
alter table nps_surveys         add column if not exists demo boolean not null default false;
alter table notifications       add column if not exists demo boolean not null default false;

create index if not exists idx_clients_demo on clients(demo) where demo;
create index if not exists idx_production_demo on production_cards(demo) where demo;
