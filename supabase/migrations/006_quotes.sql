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
