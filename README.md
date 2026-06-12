# De Cirene · ERP

ERP de **Emprendimientos De Cirene** (herrería social). Cotizador paramétrico,
CRM, producción (kanban), ventas y contabilidad/caja. SPA en JavaScript puro
(sin build), datos en **Supabase**, deploy en **Netlify**. PDFs con jsPDF.

> ERP propio de De Cirene (proyecto Supabase propio). Estética blanco/negro premium.

## Módulos
- **CRM / Leads** (`intake.html`) — consultas, medidas, seguimiento (pipeline comercial).
- **Cotizador** (`index.html`) — materiales + mano de obra × multiplicador → precio + PDF.
- **Catálogo** (`catalog.html`) — materiales (precios), plantillas de producto (BOM), tarifas de mano de obra.
- **Producción** (`production.html`) — kanban de 6 estados + calendario.
- **Ventas** (`ventas.html`) — KPIs e indicadores.
- **Contabilidad** (`contabilidad.html`) — caja, cobros por trabajo, cierres de caja.

## Correr local (sin build)
```bash
# Server estático (no requiere Netlify):
npx serve .            # o:  python3 -m http.server 8080
# Abrir http://localhost:8080 (o el puerto que indique).
```
La primera vez, conectar a Supabase pegando en la consola del navegador:
```js
localStorage.setItem('cirene_supabase_url', 'https://TU-PROYECTO.supabase.co');
localStorage.setItem('cirene_supabase_key', 'TU-ANON-KEY');
location.reload();
```
Ver **[SETUP_SUPABASE.md](SETUP_SUPABASE.md)** para crear el proyecto, aplicar el
esquema y crear el usuario admin.

## Deploy (Netlify Free)
Repo conectado a Netlify. Build: `node inject-env.js`, publish `.`. Env vars:
`SUPABASE_URL`, `SUPABASE_ANON_KEY`. (Sin Odoo, sin APIs pagas.)

## Estado
- ✅ Fase 0: scaffold, branding B&N premium, esquema Supabase (`supabase/migrations/`).
- ⏳ Fase 1: catálogo de materiales/plantillas + cotizador paramétrico.
- ⏳ Fase 2: CRM + producción (6 estados) + aprobación → producción.
- ⏳ Fase 3: contabilidad/caja.
- ⏳ Fase 4: ventas/métricas.
