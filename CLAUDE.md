# CLAUDE.md — ERP De Cirene

Guía para Claude (y humanos) sobre este repo. **Mantener actualizado** ante cambios estructurales.

## Qué es
ERP de **Emprendimientos De Cirene** (herrería social, Uruguay). SPA en JavaScript puro
(sin build/bundler): cada página es un `.html` con `<script type="module">` que importa de `js/`.
Datos en **Supabase** (Postgres + Auth + RLS). PDFs con **jsPDF** (CDN). Estética **blanco/negro
premium** con el logo oficial (mano + brote). Deploy en **Netlify**.

> Clonado de la estructura de la app de Glide (uniformes) y reescrito a herrería. **No debe quedar
> ningún rastro de "Glide"** en el código (clases CSS, ids, textos): todo es `cirene`.

## ⚠ Migración a Railway (2026-08-13) — SUPABASE YA NO SE USA

El proyecto de Supabase `bxlnsbkglxtxqceagsyr` **fue eliminado** (su hostname da NXDOMAIN en
Google y Cloudflare — un proyecto *pausado* sí resolvería). Con el backend caído la app cargaba
el login pero ninguna consulta salía. **Los datos operativos se perdieron**; el esquema y el
seed estaban versionados y se recuperaron.

Todo vive ahora dentro del **proyecto de Railway** `appdecirene`
(`cef6a051-58ba-4e5a-a197-cfca13f7580f`), sin dependencias externas:

| Antes (Supabase) | Ahora (Railway) |
|---|---|
| Postgres gestionado | Servicio **Postgres** en red privada (`postgres.railway.internal`), no expuesto |
| Supabase Auth | `app_users` + scrypt + cookie httpOnly firmada (`api/session.js`) |
| PostgREST (API automática) | `POST /api/q` — descriptor → SQL (`api/query.js`) |
| RLS / policies | `api/registry.js`: rol × tabla. Un navegador ya no habla con la base |
| Storage (bucket `adjuntos`) | Volumen en `/data/adjuntos`, servido en `/adjuntos/*` |

**Lo clave para no romper nada:** `js/supa.js` mantiene **la misma interfaz encadenable** que
supabase-js (`from().select().eq().single()`, `auth.*`, `storage.*`). Por eso `cirene-data.js`,
las 9 páginas y las ~60 llamadas **no se tocaron**: solo cambió la implementación de abajo.
Si agregás una consulta, escribila como si fuera Supabase y anda.

**Lo que NO soporta** el cliente nuevo: los *embeds* de PostgREST — `select('*, workshops(name)')`.
Devuelve todas las columnas y avisa por consola. Solo los usaban módulos heredados de Glide
(`workshops.js`, `purchase-orders.js`, `production.js`) que ninguna página viva de Cirene importa.

### Backend (`api/` + `server.js`)
| Archivo | Qué hace |
|---|---|
| `api/db.js` | Pool de `pg` + **migración al arrancar**: aplica `db/schema.sql` (idempotente), siembra plantillas si faltan y crea el admin inicial. La base nunca queda atrás del código |
| `api/registry.js` | Autorización por rol y tabla (réplica de `008_rls.sql`). **Las columnas se leen del catálogo de Postgres al arrancar**, no se listan a mano → el registro no puede desfasarse |
| `api/query.js` | Descriptor → SQL. **Valores siempre parametrizados, identificadores siempre validados** contra el catálogo. UPDATE/DELETE sin filtros bloqueados |
| `api/session.js` | scrypt (contraseñas) + HMAC (tokens), con `node:crypto`. Sin dependencias nativas |
| `api/router.js` | `/api/auth/{login,logout,me,password,usuarios}`, `/api/q`, `/api/upload`, `/api/health` |
| `server.js` | Estáticos + fallback SPA + monta la API. ESM (`"type":"module"`) |

**Variables en Railway**: `DATABASE_URL` (referencia a `${{Postgres.DATABASE_URL}}`),
`SESSION_SECRET`, `ADMIN_EMAIL`, `ADJUNTOS_DIR=/data/adjuntos`, `NODE_ENV=production`.
Si falta `SESSION_SECRET` la app anda pero las sesiones se caen en cada reinicio.

**Deploy**: el servicio está conectado a `empdecirene-debug/appdecirene` rama `main` → push =
deploy. (Antes **no tenía trigger**: servía un build del 10 de julio, por eso faltaba
`clientes.html`.) URL: https://appdecirene-production.up.railway.app

**Aplicar SQL**: ya no hace falta herramienta externa — editá `db/schema.sql` y el próximo
deploy lo aplica. Como es idempotente, agregá `create ... if not exists` / `alter ... if not exists`.

## Stack y entorno
- **Auth**: propia (`api/session.js`). Roles en `user_profiles.role`: `comercial`,
  `produccion`, `admin`, `director`. Admin = admin|director. Usuario admin: `admin@decirene.uy`.
- **Alta de usuarios**: `POST /api/auth/usuarios` (solo admin) → devuelve la contraseña generada.
- **Entorno local**: no hay `node`/`curl`/`brew`. Servir con `python3 -m http.server`. Para PDFs
  binarios se rasteriza con un binario Swift+PDFKit.
- **Storage**: bucket público `adjuntos` (Supabase Storage) para archivos de tarjetas de producción
  (RLS en `storage.objects`: lectura pública, insert/delete autenticado).
- **Caché (importante)**: todos los imports de JS llevan `?v=N` (ej. `./js/cirene-data.js?v=2`) y hay
  un archivo `_headers` con `Cache-Control: no-cache`. **Al cambiar cualquier módulo `js/`, subir el
  número `?v=N` en TODOS los HTML** (un `perl -pi` sobre los imports) para forzar al navegador a bajar
  la versión nueva — si no, queda sirviendo la vieja y las páginas "se cuelgan cargando".
- **Deploy**: el zip a Netlify excluye `.git`, `supabase/`, `netlify/`, `node_modules`, `*.md`,
  `netlify.toml`, `inject-env.js`. Token de Netlify (`nfp_…`) y PAT de Supabase NO se versionan.

## Páginas (raíz)
| Página | Propósito |
|---|---|
| `login.html` | Login Supabase (fondo negro + logo + patrón de rejas) |
| `home.html` | Landing: grid de tiles a cada módulo |
| `index.html` | **Cotizador**: builder por producto (materiales + mano de obra × multiplicador), plantillas estándar, cliente, ítems, guarda en `quotes` y genera **PDF molde De Cirene**. Soporta `?intake=<id>` (precarga cliente, vincula al lead) y `?quote=<id>` (carga) |
| `catalog.html` | **Catálogo**: tabs Materiales / Plantillas (BOM) / Mano de obra (CRUD) |
| `intake.html` | **CRM**: kanban del pipeline comercial (drag&drop), nueva consulta, detalle con Cotizar y Aceptar→Producción |
| `production.html` | **Producción**: vistas **Kanban** (drag&drop) / **Lista** (agrupada por etapa, tipo Asana) / **Calendario** (doble modo **Entrega** por `due_date` y **Producción** por `production_date`). Modal de tarjeta: total editable, aviso "⚠ sin precio", **comentarios** (`card_stories`) y **adjuntos** (Storage `adjuntos`). Deep-link `?card=<id>` |
| `contabilidad.html` | **Contabilidad** (solo admin): Caja del día (abrir/cerrar), Cobros por trabajo, Movimientos, Balance |
| `ventas.html` | **Ventas**: KPIs (facturado/cobrado/conversión) por período, evolución 12 meses, por vendedor, pipeline, productos top |

## Módulos `js/`
| Archivo | Qué hace |
|---|---|
| `supa.js` | Cliente Supabase singleton (key embebida + fallback localStorage) |
| `auth.js` | `requireAuth`, `isAdmin` (admin\|director), `signIn/Out`, `getProfile` |
| `navbar.js` | Navbar compartida (logo + tabs por rol). Clase `.cirene-nav` |
| `quote-engine.js` | Motor de cálculo (réplica del Excel): `calcLine`, `calcQuoteTotals`, `money`, `pct`, `n` |
| `cirene-data.js` | **Capa de datos única** sobre Supabase: materiales, tarifas MO, plantillas/BOM, quotes, `listStages`, intake/CRM, producción, contabilidad (caja/cobros/movimientos), comentarios (`listComments`/`addComment`/`countCommentsByCard`), adjuntos (`uploadAttachment`/`deleteAttachment`). **Toda página de datos pasa por acá** |
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
**Storage**: bucket público `adjuntos`; los adjuntos de cada trabajo se guardan en
`production_cards.attachments jsonb` como `[{name,url,type,path}]`.

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
6. **Caché**: al cambiar un `.js`, subir el `?v=N` de los imports en todos los HTML (si no, el navegador usa la versión vieja y la página queda "cargando").
7. Páginas de datos: indicador "Cargando…" inmediato + `try/catch` con mensaje visible + `Promise.race` con timeout (que nunca quede colgado sin avisar).

## Datos importados (de Asana)
Los CSV `~/Desktop/CIRENE/{Presupuestos,Herreria_Operativa}*.csv` se migraron a `intake_cards` y
`production_cards` (ids `in-<taskAsana>` / `pr-<taskAsana>`, idempotente). Los precios salen del
campo Notes (tabla "Producto/Medidas/Cantidad/Precio", a veces como número pelado) + cruce por
cliente con las notas de Presupuestos + hojas por cliente del Excel. Trabajos internos de Cireneos
suelen no tener precio (quedan en $0, marcados "⚠ sin precio").
