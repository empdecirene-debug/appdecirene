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
