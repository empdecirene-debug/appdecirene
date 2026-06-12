-- De Cirene ERP · esquema completo + seed (001–009). Pegar y ejecutar en Supabase SQL Editor.

-- ============================== 001_core.sql ==============================
-- =====================================================================
-- De Cirene ERP — 001 núcleo
-- Tablas operativas base del ERP de De Cirene (herrería).
-- Ejecutar en el SQL Editor del proyecto Supabase de De Cirene.
-- =====================================================================

-- ── USER PROFILES (extiende auth.users con rol) ──────────────────────
create table if not exists user_profiles (
  id uuid references auth.users(id) on delete cascade primary key,
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
create or replace function is_admin() returns boolean
  language sql security definer stable as $$
  select exists (
    select 1 from user_profiles
    where id = auth.uid() and role in ('admin','director') and active = true
  );
$$;

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
  vendor_user_id uuid references auth.users(id),
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
  vendor_user_id uuid references auth.users(id),
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
  archived_by uuid references auth.users(id),

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
  user_id uuid references auth.users(id),
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
  actor_id uuid references auth.users(id),
  occurred_at timestamptz not null default now()
);
create index if not exists idx_transitions_card on production_card_transitions(card_id, occurred_at);

-- ── COMMENT READS (tracking de comentarios leídos) ───────────────────
create table if not exists card_comment_reads (
  story_id uuid references card_stories(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (story_id, user_id)
);

-- ── AUDIT LOG ────────────────────────────────────────────────────────
create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id),
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

-- ============================== 002_seed_stages.sql ==============================
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

-- ============================== 003_materials.sql ==============================
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
  updated_by uuid references auth.users(id)
);
create index if not exists idx_materials_tipo on materials(tipo);
create index if not exists idx_materials_activo on materials(activo);

drop trigger if exists trg_materials_updated on materials;
create trigger trg_materials_updated before update on materials
  for each row execute function set_updated_at();

-- ============================== 004_labor_rates.sql ==============================
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

-- ============================== 005_product_templates.sql ==============================
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

-- ============================== 006_quotes.sql ==============================
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
  vendedor_user_id uuid references auth.users(id),
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

-- ============================== 007_accounting.sql ==============================
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
  abierta_por uuid references auth.users(id),
  cerrada_por uuid references auth.users(id),
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
  registrado_por uuid references auth.users(id),
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
  registrado_por uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_cash_mov_fecha on cash_movements(fecha);
create index if not exists idx_cash_mov_session on cash_movements(cash_session_id);
create index if not exists idx_cash_mov_card on cash_movements(production_card_id);

-- ============================== 008_rls.sql ==============================
-- =====================================================================
-- De Cirene ERP — 008 Row Level Security
-- Equipo chico: lectura/escritura autenticada en lo operativo (CRM, quotes,
-- producción), lectura auth / escritura admin en catálogos, y SOLO admin
-- en contabilidad y usuarios.
-- =====================================================================

alter table user_profiles               enable row level security;
alter table kanban_stages               enable row level security;
alter table custom_fields                enable row level security;
alter table intake_cards                 enable row level security;
alter table production_cards             enable row level security;
alter table card_stories                 enable row level security;
alter table production_card_transitions  enable row level security;
alter table card_comment_reads           enable row level security;
alter table audit_log                    enable row level security;
alter table materials                    enable row level security;
alter table labor_rates                  enable row level security;
alter table product_templates            enable row level security;
alter table template_material_lines      enable row level security;
alter table template_labor_lines         enable row level security;
alter table quotes                       enable row level security;
alter table quote_lines                  enable row level security;
alter table cash_sessions                enable row level security;
alter table job_payments                 enable row level security;
alter table cash_movements               enable row level security;

-- Helper: ¿hay sesión autenticada?
-- (auth.role() = 'authenticated')

-- ── user_profiles: lee la propia + admin lee todas; admin escribe ──────
drop policy if exists "up_self_read" on user_profiles;
create policy "up_self_read" on user_profiles for select using (id = auth.uid() or is_admin());
drop policy if exists "up_self_update" on user_profiles;
create policy "up_self_update" on user_profiles for update using (id = auth.uid()) with check (id = auth.uid());
drop policy if exists "up_admin_all" on user_profiles;
create policy "up_admin_all" on user_profiles for all using (is_admin()) with check (is_admin());

-- ── Config (stages, custom_fields, materials, labor_rates, templates) ──
--    lectura autenticada / escritura admin
do $$
declare t text;
begin
  foreach t in array array[
    'kanban_stages','custom_fields','materials','labor_rates',
    'product_templates','template_material_lines','template_labor_lines'
  ] loop
    execute format('drop policy if exists "%1$s_read" on %1$s;', t);
    execute format('create policy "%1$s_read" on %1$s for select using (auth.role() = ''authenticated'');', t);
    execute format('drop policy if exists "%1$s_write" on %1$s;', t);
    execute format('create policy "%1$s_write" on %1$s for all using (is_admin()) with check (is_admin());', t);
  end loop;
end $$;

-- ── Operativo (CRM, quotes, producción): autenticado lee/escribe ───────
do $$
declare t text;
begin
  foreach t in array array[
    'intake_cards','production_cards','card_stories','production_card_transitions',
    'card_comment_reads','quotes','quote_lines'
  ] loop
    execute format('drop policy if exists "%1$s_auth" on %1$s;', t);
    execute format('create policy "%1$s_auth" on %1$s for all using (auth.role() = ''authenticated'') with check (auth.role() = ''authenticated'');', t);
  end loop;
end $$;

-- ── audit_log: insert autenticado, lectura admin ──────────────────────
drop policy if exists "audit_insert" on audit_log;
create policy "audit_insert" on audit_log for insert with check (auth.role() = 'authenticated');
drop policy if exists "audit_read" on audit_log;
create policy "audit_read" on audit_log for select using (is_admin());

-- ── Contabilidad: SOLO admin/director ─────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['cash_sessions','job_payments','cash_movements'] loop
    execute format('drop policy if exists "%1$s_admin" on %1$s;', t);
    execute format('create policy "%1$s_admin" on %1$s for all using (is_admin()) with check (is_admin());', t);
  end loop;
end $$;

-- ============================== 009_seed_materials.sql ==============================
-- =====================================================================
-- De Cirene ERP — 009 seed de materiales (desde Cotizador Herrería.xlsx, hoja Materiales)
-- Lista de precios real de la herrería. Idempotente por nombre+proveedor via delete previo.
-- =====================================================================
delete from materials where notas = 'seed-excel-2026';

insert into materials (nombre,tipo,unidad,precio_unit,compra_min,precio_compra,proveedor,activo,notas) values
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
  ('Hormigón Pedregullo','Hormigón','m3',0,null,null,'',true,'seed-excel-2026');

