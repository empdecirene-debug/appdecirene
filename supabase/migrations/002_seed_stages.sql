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
