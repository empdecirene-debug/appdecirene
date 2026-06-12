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
