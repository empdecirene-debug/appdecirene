# CLAUDE.md — ERP De Cirene

Guía para Claude (y humanos) sobre este repo. **Mantener actualizado** ante cambios estructurales.

## Qué es
ERP de **Emprendimientos De Cirene** (herrería social, Uruguay). SPA en JavaScript puro
(sin build/bundler): cada página es un `.html` con `<script type="module">` que importa de `js/`.
Datos en **Supabase** (Postgres + Auth + RLS). PDFs con **jsPDF** (CDN). Estética **blanco/negro
premium** con el logo oficial (mano + brote). Deploy en **Netlify**.

> Clonado de la estructura de la app de Glide (uniformes) y reescrito a herrería. **No debe quedar
> ningún rastro de "Glide"** en el código (clases CSS, ids, textos): todo es `cirene`.

## Stack y entorno
- **Supabase**: proyecto ref `bxlnsbkglxtxqceagsyr`. La **publishable/anon key** va embebida en
  `js/supa.js` (es pública por diseño; la seguridad la dan las políticas RLS). Fallback local:
  `localStorage cirene_supabase_url` / `cirene_supabase_key`.
- **Auth**: Supabase Auth (email+password). Roles en `user_profiles.role`: `comercial`,
  `produccion`, `admin`, `director`. `is_admin()` = admin|director. Usuario admin: `admin@decirene.uy`.
- **Deploy**: Netlify site `appdecirene` (id `b0e7b6f5-5696-493f-9ac6-10cdfa98ec6a`) →
  https://appdecirene.netlify.app. Se despliega por **zip directo a la API de Netlify** (sin build;
  la key está embebida). GitHub: `empdecirene-debug/appdecirene` (gh local = cuenta `contacto254`).
- **Aplicar SQL** a Supabase: Management API `POST /v1/projects/{ref}/database/query` con el PAT
  (`sbp_…`) **y un User-Agent de navegador** (si no, Cloudflare devuelve 403/error 1010).
- **Entorno local**: no hay `node`/`curl`/`brew`. Servir con `python3 -m http.server`. Para PDFs
  binarios se rasteriza con un binario Swift+PDFKit.

## Páginas (raíz)
| Página | Propósito |
|---|---|
| `login.html` | Login Supabase (fondo negro + logo + patrón de rejas) |
| `home.html` | Landing: grid de tiles a cada módulo |
| `index.html` | **Cotizador**: builder por producto (materiales + mano de obra × multiplicador), plantillas estándar, cliente, ítems, guarda en `quotes` y genera **PDF molde De Cirene**. Soporta `?intake=<id>` (precarga cliente, vincula al lead) y `?quote=<id>` (carga) |
| `catalog.html` | **Catálogo**: tabs Materiales / Plantillas (BOM) / Mano de obra (CRUD) |
| `intake.html` | **CRM**: kanban del pipeline comercial (drag&drop), nueva consulta, detalle con Cotizar y Aceptar→Producción |
| `production.html` | **Producción**: vistas Kanban / Lista / Calendario (doble modo **Entrega** por `due_date` y **Producción** por `production_date`). Tarjeta con total editable, aviso "⚠ sin precio", comentarios |
| `contabilidad.html` | **Contabilidad** (solo admin): Caja del día (abrir/cerrar), Cobros por trabajo, Movimientos, Balance |
| `ventas.html` | **Ventas**: KPIs (facturado/cobrado/conversión) por período, evolución 12 meses, por vendedor, pipeline, productos top |

## Módulos `js/`
| Archivo | Qué hace |
|---|---|
| `supa.js` | Cliente Supabase singleton (key embebida + fallback localStorage) |
| `auth.js` | `requireAuth`, `isAdmin` (admin\|director), `signIn/Out`, `getProfile` |
| `navbar.js` | Navbar compartida (logo + tabs por rol). Clase `.cirene-nav` |
| `quote-engine.js` | Motor de cálculo (réplica del Excel): `calcLine`, `calcQuoteTotals`, `money`, `pct`, `n` |
| `cirene-data.js` | **Capa de datos única** sobre Supabase: materiales, tarifas MO, plantillas/BOM, quotes, intake (CRM), producción, contabilidad (caja/cobros/movimientos), comentarios (`card_stories`) |
| `icons.js` | Iconos SVG inline |

## Supabase — tablas (migraciones en `supabase/migrations/`, `_ALL.sql` = todo junto)
`user_profiles`, `kanban_stages` (category `comercial`/`produccion`/`finalizado`/`cancelado`),
`custom_fields`, `intake_cards` (CRM), `production_cards` (kanban prod: total_venta, billing_month,
estado_pago, due_date, production_date, entrega, product_lines jsonb…), `card_stories` (comentarios),
`materials` (catálogo de precios), `labor_rates` (Jefe 350/Oficial 250/Aprendiz 125/Transporte 250),
`product_templates` + `template_material_lines` + `template_labor_lines` (BOM), `quotes` + `quote_lines`,
`cash_sessions`, `job_payments`, `cash_movements`, `audit_log`.
**RLS**: config (materiales/tarifas/plantillas/stages) lectura auth / escritura admin; operativo
(intake/quotes/producción/comentarios) auth full; contabilidad solo admin.
**Seed**: 90 materiales + 6 plantillas estándar del Excel (Leñero $7.109 = exacto).

## Cotizador — modelo de precio (clave)
`costo_materiales = Σ(material × cantidad)` · `costo_mo = Σ(rol × horas)` ·
`costo_directo = materiales + mo` · `precio = costo_directo × multiplicador` (default 1.5) ·
`margen = (precio − costo) / precio`.

## Reglas
1. Mantener este CLAUDE.md actualizado ante cambios estructurales.
2. **Cero "Glide"** en el código.
3. Antes de crear algo nuevo, reusar funciones de `cirene-data.js` / `quote-engine.js`.
4. La publishable key es segura de versionar; el **PAT de Supabase y el token de Netlify NO** se versionan.
5. Migraciones aplicadas son inmutables: agregar nuevas, no editar.

## Datos importados (de Asana)
Los CSV `~/Desktop/CIRENE/{Presupuestos,Herreria_Operativa}*.csv` se migraron a `intake_cards` y
`production_cards` (ids `in-<taskAsana>` / `pr-<taskAsana>`, idempotente). Los precios salen del
campo Notes (tabla "Producto/Medidas/Cantidad/Precio", a veces como número pelado) + cruce por
cliente con las notas de Presupuestos + hojas por cliente del Excel. Trabajos internos de Cireneos
suelen no tener precio (quedan en $0, marcados "⚠ sin precio").
