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
