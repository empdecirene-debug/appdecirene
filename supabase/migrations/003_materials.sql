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
