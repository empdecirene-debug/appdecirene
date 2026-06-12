# Setup de Supabase (proyecto nuevo para De Cirene)

Esto crea la base de datos del ERP. Es un proyecto **aparte** del de Glide → datos separados. Plan **Free** ($0).

## 1. Crear el proyecto
1. Entrar a https://supabase.com → **New project**.
2. Nombre: `de-cirene`. Región: la más cercana (ej. **São Paulo**). Plan **Free**.
3. Anotar la **Database password** (no se usa en la app, pero guardala).
4. Esperar ~2 min a que termine de aprovisionar.

## 2. Aplicar el esquema
1. En el proyecto → **SQL Editor → New query**.
2. Abrir `supabase/migrations/_ALL.sql` de este repo, copiar **todo** y pegarlo.
3. **Run**. Debe terminar sin errores (crea tablas, etapas, tarifas y RLS).
   - (Alternativa: ejecutar los archivos `001_…` a `008_…` en orden.)

## 3. Crear el usuario admin
1. **Authentication → Users → Add user** → email + contraseña (los que vas a usar para entrar).
2. Copiar el **UID** del usuario creado.
3. **SQL Editor**, ejecutar (reemplazando UID, email y nombre):
   ```sql
   insert into user_profiles (id, email, full_name, vendor_name, role)
   values ('PEGAR-UID', 'vos@correo.com', 'Tu Nombre', 'Tu Nombre', 'admin');
   ```

## 4. Conectar la app
**Project Settings → API** → copiar **Project URL** y **anon public key**.

- **Local:** abrir la app (`npx serve .`) y en la consola del navegador:
  ```js
  localStorage.setItem('cirene_supabase_url', 'https://TU-PROYECTO.supabase.co');
  localStorage.setItem('cirene_supabase_key', 'TU-ANON-KEY');
  location.reload();
  ```
- **Netlify (prod):** Site settings → Environment variables → agregar
  `SUPABASE_URL` y `SUPABASE_ANON_KEY` → redeploy (Clear cache and deploy).

## 5. Entrar
Abrir `/login.html`, iniciar sesión con el usuario admin → te lleva a `home.html`.

> Nota: en el plan Free, el proyecto se **pausa** tras 7 días seguidos sin uso
> (despierta solo al entrar). Usándolo a diario nunca se pausa.
