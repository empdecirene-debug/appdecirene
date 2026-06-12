-- =====================================================================
-- De Cirene ERP — 001 núcleo
-- Tablas operativas base. Adaptado del schema de Glide, sin Odoo ni
-- indumentaria. Ejecutar en el SQL Editor del proyecto Supabase de Cirene.
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
