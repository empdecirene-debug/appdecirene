-- Crea el perfil ADMIN para el usuario que ya creaste en Authentication → Users.
-- 1) Primero creá el usuario en el dashboard (Authentication → Add user), con
--    "Auto Confirm User" tildado, usando el email de abajo.
-- 2) Reemplazá el email y ejecutá esto en el SQL Editor.

insert into user_profiles (id, email, full_name, vendor_name, role)
select id, email, 'Administrador', 'Administrador', 'admin'
from auth.users
where email = 'TU-EMAIL@dominio.com'
on conflict (id) do update set role = 'admin', active = true;
