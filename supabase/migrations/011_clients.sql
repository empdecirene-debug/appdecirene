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
  vendedor_user_id uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_clients_owner on clients(vendedor_user_id);

alter table clients enable row level security;
drop policy if exists "clients_sel" on clients;
create policy "clients_sel" on clients for select
  using (vendedor_user_id = auth.uid() or vendedor_user_id is null or is_admin());
drop policy if exists "clients_all" on clients;
create policy "clients_all" on clients for all
  using (vendedor_user_id = auth.uid() or is_admin())
  with check (vendedor_user_id = auth.uid() or is_admin());

drop trigger if exists trg_clients_updated on clients;
create trigger trg_clients_updated before update on clients
  for each row execute function set_updated_at();

-- Seed inicial: clientes distintos desde intake_cards + production_cards (ver script de import).
