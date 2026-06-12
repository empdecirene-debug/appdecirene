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
