# CLAUDE.md — ERP De Cirene

Guía para Claude (y humanos) sobre este repo. **Mantener actualizado** ante cambios estructurales.

## Qué es
ERP de **Emprendimientos De Cirene** (herrería social, Uruguay). SPA en JavaScript puro
(sin build/bundler): cada página es un `.html` con `<script type="module">` que importa de `js/`.
Datos en **Postgres sobre Railway**, detrás de una **API propia** (`api/`). PDFs con **jsPDF**
(CDN). Estética **blanco/negro premium** con el logo oficial (mano + brote).

> La estructura se clonó de otra app (uniformes) y se reescribió a herrería. **No debe quedar
> ningún rastro del proyecto de origen** en el código (clases CSS, ids, textos): todo es `cirene`.

> **De Cirene NO discrimina IVA.** Es una asociación civil sin fines de lucro y su gestión
> interna trabaja con importes finales. No agregar campos ni cálculos de IVA en ningún módulo
> (cotizaciones, ventas, compras, facturación interna, reportes).

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

**Lo que NO soporta** el cliente nuevo: los *embeds* de PostgREST — `select('*, tabla(campo)')`.
Devuelve todas las columnas y avisa por consola. Solo los usaban módulos heredados, que ya se
eliminaron: ninguna página viva de Cirene los usa. Si necesitás datos de dos tablas, traelas por
separado y cruzalas en JS (es lo que hace `cirene-data.js`).

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

**Deploy**: el servicio debería estar conectado a `empdecirene-debug/appdecirene` rama `main` →
push = deploy. URL: https://appdecirene-production.up.railway.app

> ⚠ **El push solo no siempre dispara el deploy.** Pasó el 10 de julio (servía un build viejo, por
> eso faltaba `clientes.html`) y de nuevo el 2026-08-20: tres pushes seguidos no movieron el
> servicio. **Lo que sí lo fuerza es guardar una variable** en *Variables* (cualquier cambio ahí
> redespliega). Verificación rápida de qué build hay arriba:
>
> ```
> curl -s https://appdecirene-production.up.railway.app/index.html | grep -o 'cirene-data.js?v=[0-9]*'
> curl -s https://appdecirene-production.up.railway.app/api/health
> ```
>
> El `?v=N` tiene que coincidir con el del repo y `tablas` tiene que subir cuando `db/schema.sql`
> agrega tablas. Si no coincide, **el push no se desplegó**: tocá una variable en *Variables*
> (o *Deployments → Redeploy*); si aun así no sale, reconectá el repo en *Settings → Source*.
> Estado al 2026-08-20 después de desplegar: `?v=5`, 41 tablas.

**Aplicar SQL**: ya no hace falta herramienta externa — editá `db/schema.sql` y el próximo
deploy lo aplica. Como es idempotente, agregá `create ... if not exists` / `alter ... if not exists`.

**Antes de pushear SQL, correr `perl tools/check-sql.pl db/schema.sql`.** Parsea el archivo como lo
haría Postgres (comentarios, literales, dollar quoting) y avisa de paréntesis desbalanceados o
comillas sin cerrar. El primer deploy a Railway murió con *mismatched parentheses* y el error solo
se vio en los logs; el esquema se aplica entero en una sola query, así que un error de sintaxis en
cualquier línea deja **toda** la migración sin aplicar (la app levanta igual, pero sin las tablas
nuevas). Estado esperado hoy: 237 sentencias, 41 tablas, 0 desbalanceadas.

## Stack y entorno
- **Auth**: propia (`api/session.js`). Roles en `user_profiles.role`: `comercial`,
  `produccion`, `admin`, `director`. Admin = admin|director. Usuario admin: `admin@decirene.uy`.
- **Alta de usuarios**: `POST /api/auth/usuarios` (solo admin) → devuelve la contraseña generada.
- **Entorno local**: la máquina de desarrollo **no tiene `node`, `python`, `psql` ni Docker**. No se
  puede levantar la app ni la base localmente: la verificación end-to-end se hace **contra el deploy
  de Railway**. Sí hay `git` y `perl` (útil para el bump de `?v=N`).
- **Storage**: volumen del servicio en `/data/adjuntos`, servido en `/adjuntos/*` (`api/router.js`).
  Los adjuntos de cada trabajo se guardan en `production_cards.attachments jsonb`.
- **Caché (importante)**: todos los imports de JS llevan `?v=N` (ej. `./js/cirene-data.js?v=2`) y hay
  un archivo `_headers` con `Cache-Control: no-cache`. **Al cambiar cualquier módulo `js/`, subir el
  número `?v=N` en TODOS los HTML** (un `perl -pi` sobre los imports) para forzar al navegador a bajar
  la versión nueva — si no, queda sirviendo la vieja y las páginas "se cuelgan cargando".
- **Deploy**: `git push` a `main` → Railway compila y sirve. `netlify.toml`, `netlify/` e
  `inject-env.js` son restos del hosting anterior y no intervienen.

## Páginas (raíz)
| Página | Propósito |
|---|---|
| `login.html` | Login (fondo negro + logo + patrón de rejas) |
| `home.html` | Landing: **centro de actividad** (notificaciones de comentarios y respuestas, marcar leídas) + grid de tiles |
| `index.html` | **Cotizador**: builder por producto (materiales + mano de obra + terminación, × multiplicador), **dimensiones** de fabricación, **comentarios para producción**, plantillas, alta/edición de materiales sin salir del flujo, sección **Servicios** (transporte + colocación), cliente, ítems, estado, guarda en `quotes` y genera **PDF molde De Cirene** (sin IVA). `?intake=<id>` y `?quote=<id>` |
| `catalog.html` | **Catálogo**: Materiales (con stock y última actualización) / Plantillas (BOM) / **Terminaciones-pintado** / Mano de obra |
| `intake.html` | **CRM**: kanban comercial con columna **Lead ganado**, teléfono obligatorio, aviso de cliente duplicado en vivo, cotización asociada visible en la tarjeta, botón "Lead ganado" que dispara venta + producción + cuenta a cobrar |
| `clientes.html` | **Clientes**: cartera con clasificación **Nuevo / Recurrente / Interno (CIRENEOS)**; el teléfono E.164 impide fichas duplicadas |
| `production.html` | **Producción**: tablero superior (productos a producir, horas estimadas, atrasados, valor en producción, **semáforo semanal**) + vistas **Kanban / Lista / Semana / Calendario / Listos para producir**. Modal: planificación (semana, horas, prioridad, responsable, 3 fechas), **subtareas con Iniciar/Pausar/Finalizar y cronómetro**, materiales del pedido y descuento de stock, trazabilidad, adjuntos y comentarios. Deep-link `?card=<id>` |
| `compras.html` | **Compras** (admin): proveedores con estadísticas (OC, monto comprado, última compra, cuenta corriente) y **órdenes de compra** con recepción que suma stock, actualiza el costo del catálogo y deja el gasto |
| `stock.html` | **Stock**: existencias con comprometido / disponible / pendiente de OC / necesidad de compra, alertas de mínimo, ajustes manuales e historial de movimientos |
| `ventas.html` | **Ventas**: KPIs, ticket promedio, evolución 12 meses, **estadísticas por vendedor** (leads, cotizaciones, ganados, conversión, monto, ticket), clientes del período, pipeline, productos top |
| `nps.html` | **NPS**: dashboard (NPS, tasa de respuesta, distribución, aspectos, canales, evolución) y listado de encuestas con formulario de respuesta |
| `contabilidad.html` | **Contabilidad** (admin): Cuentas a cobrar · Calendario de cobros · Cobros por trabajo · Gastos · Reintegros · Cuenta corriente de proveedores · Activos y amortización · Caja · Movimientos · Balance |
| `dashboard.html` | **Dashboard general** (admin): período configurable, **estado de resultados** mensual, presupuestado vs. real, horas y productividad, clientes, **impacto social**, resumen NPS |
| `admin.html` | **Administración**: Operarios · Cargas sociales · Impacto social · Etapas · Campos · Usuarios (alta por API con contraseña generada) |

## Módulos `js/`
| Archivo | Qué hace |
|---|---|
| `supa.js` | Cliente de datos: misma interfaz encadenable que supabase-js, pero contra `POST /api/q` |
| `auth.js` | `requireAuth`, `isAdmin` (admin\|director), `signIn/Out`, `getProfile` |
| `navbar.js` | Navbar compartida (logo + tabs por rol). Clase `.cirene-nav` |
| `quote-engine.js` | Motor de cálculo: `calcLine` (materiales + MO + terminación → × multiplicador), `calcServices` (transporte y viáticos **sin** markup, MO de colocación **con** markup), `calcQuoteTotals`, `dimsText`, `UNIDADES_DIM`, `money`, `pct`, `n` |
| `cirene-data.js` | **Capa de datos única**. Catálogo (materiales, `finishes`, tarifas, plantillas) · cotizaciones (`saveQuote` idempotente, `rowALinea`) · clientes (`ensureClient` anti-duplicados) · CRM (`ensureDraftQuote`, **`winLead`**) · producción (operarios, subtareas con `startSubtask`/`pauseSubtask`/`finishSubtask`, `semaforoSemana`, semanas ISO) · abastecimiento (`suppliers`, OC, `receivePurchaseOrder`, `stockReport`, `consumirMaterialesDePedido`) · finanzas (`ensureReceivable`, gastos, cuenta corriente, `calcAsset`) · NPS (`ensureNpsSurvey`, `npsMetrics`) · notificaciones · `trazabilidad`, `presupuestadoVsReal`, `productividad` · `auditar`. **Toda página de datos pasa por acá** |
| `icons.js` | Iconos SVG inline |
| `phone-normalizer.js` | `normalizePhoneUY` / `formatPhoneUY` a E.164. Base del anti-duplicados de clientes |
| `ids.js`, `audit.js` | Ids legibles y `logAudit` sobre `audit_log` (helpers sueltos; `cirene-data.auditar` es el que usan las páginas) |

> Los módulos heredados que dependían de un ERP externo (`catalog.js`, `intake.js`,
> `production.js`, `purchase-orders.js`, `stock.js`, `workshops.js`, `stage-rules.js`,
> `production-metrics.js`, `gantt-pdf.js`, `image-store.js`, `notes-parser.js`,
> `save-guard.js`, `catalog-store.js`, `catalog-picker.js`) **se eliminaron**: importaban
> un `odoo-client.js` que no existe y ninguna página viva los usaba. `purchase-orders.html`
> quedó reemplazada por `compras.html`.

## Ampliación 2026-08 — Fase 1 (Cotizador)
Todo el SQL nuevo está al final de `db/schema.sql`, bajo `AMPLIACIÓN 2026-08 · FASE 1`, y es
idempotente. **No se borró ni se migró nada**: las columnas nuevas son NULL o traen default neutro,
así que una cotización vieja calcula exactamente lo mismo que antes.

| Cambio | Dónde |
|---|---|
| Tabla `finishes` (terminaciones/pintado: nombre, costo, unidad, activo, `updated_at`/`updated_by`) | `db/schema.sql`, `catalog.html` tab Terminaciones |
| `quote_lines`: `ancho/alto/largo/diametro` + `*_unidad`, `comentarios_produccion`, `terminacion_id/_nombre/_costo`, `costo_terminacion` | `db/schema.sql` |
| `quote_lines.pintado` queda **obsoleto** (solo datos históricos) | — |
| `quotes`: `transporte_*`, `colocacion_*`, denormalizados de servicios, `comentarios_produccion`, `cliente_id`, `updated_by` | `db/schema.sql` |
| `materials`: `stock_actual`, `stock_minimo`, `stock_comprometido`, `proveedor_id` (FK a `suppliers`, Fase 4) | `db/schema.sql` |
| `labor_rates`: `updated_by`, `notas` + trigger de `updated_at` | `db/schema.sql` |
| Secuencia `quotes_numero_seq` + trigger `trg_quotes_asignar_id` (numeración sin carreras) | `db/schema.sql` |
| **Permisos**: `comercial` ahora escribe `materials` (crear material desde el cotizador). `finishes` = lectura todos / escritura admin | `api/registry.js` |

## Ampliación 2026-08 — Fases 2 a 7
Segundo bloque al final de `db/schema.sql` (`AMPLIACIÓN 2026-08 · FASES 2 a 7`), también idempotente.

| Fase | Qué se agregó |
|---|---|
| **2 · CRM / Clientes** | Etapa `lead_ganado`. `clients.telefono_e164` con **índice único parcial** (desduplica lo existente antes de crearlo) + `es_interno` (CIRENEOS). `intake_cards.client_id/won_at/sale_id`. Tabla **`sales`** con `quote_id` UNIQUE y `production_card_id` UNIQUE → una sola venta por cotización |
| **3 · Producción** | `operators`; `production_cards` con `semana_produccion`, `horas_estimadas/reales`, `responsable_operator_id`, `fecha_solicitada_cliente`, `fecha_objetivo_interna`, `fecha_real_fin`, `listo_para_producir`; `production_subtasks` + `subtask_time_logs` (inicio/pausa/fin reales); `production_weeks` (capacidad y semáforo) |
| **4 · Abastecimiento** | `suppliers` (sembrada desde el texto libre de `materials.proveedor`), `purchase_orders` + `purchase_order_lines` con secuencia y trigger de id (`OC-00001`), `stock_movements` |
| **5 · Finanzas** | `receivables` (una por pedido, UNIQUE), `job_payments.receivable_id`, `payroll_charges` (cargas configurables), `expenses` (con forma de pago y reintegros), `supplier_ledger`, `assets` |
| **6 · Gestión** | `social_impact` (histórico por fecha) |
| **7 · NPS** | `nps_surveys` (1 por pedido, UNIQUE) + `nps_options` (aspectos y canales administrables) |
| **Transversal** | `notifications` (centro de actividad) y auditoría vía `cirene-data.auditar` |

### Flujo y garantías de idempotencia
`Cliente → Lead → Cotización → Lead ganado → Venta → Producción → Subtareas/horas/materiales →
Entrega → Cobro → NPS`. Cada salto busca antes de crear:

| Transición | Qué la hace idempotente |
|---|---|
| Guardar cotización | `saveQuote`: con `id` hace UPDATE; el número lo da la secuencia |
| Lead → cotización | `ensureDraftQuote` reusa la del lead |
| Lead ganado | `winLead` → `createProductionFromIntake` (busca por lead y por cotización) + `sales` UNIQUE por `quote_id`/`production_card_id` + `ensureReceivable` UNIQUE por pedido |
| Recibir OC | `receivePurchaseOrder` sale temprano si ya está `recibida` |
| Consumir materiales | `consumirMaterialesDePedido` verifica si ya hay movimientos `produccion` de esa tarjeta |
| Entregar | `moveProductionStage('entregado')` → `ensureNpsSurvey` UNIQUE por pedido |

## Tablas (esquema completo en `db/schema.sql`; el histórico Supabase queda en `supabase/migrations/`)
**Base**: `app_users`, `user_profiles`, `kanban_stages`, `custom_fields`, `audit_log`, `notifications`.
**Comercial**: `clients`, `intake_cards`, `quotes` + `quote_lines`, `sales`.
**Catálogo**: `materials`, `finishes`, `labor_rates`, `product_templates` + `template_material_lines`
+ `template_labor_lines`.
**Producción**: `production_cards`, `production_subtasks`, `subtask_time_logs`, `production_weeks`,
`operators`, `card_stories`, `production_card_transitions`, `card_comment_reads`.
**Abastecimiento**: `suppliers`, `purchase_orders` + `purchase_order_lines`, `stock_movements`.
**Finanzas**: `receivables`, `job_payments`, `cash_sessions`, `cash_movements`, `expenses`,
`payroll_charges`, `supplier_ledger`, `assets`.
**Gestión**: `social_impact`. **NPS**: `nps_surveys`, `nps_options`.

**Permisos** (`api/registry.js`, no hay RLS): catálogo y maestros (tarifas, plantillas, stages,
terminaciones, operarios, proveedores, cargas, opciones NPS) lectura auth / escritura admin;
`materials` escritura admin **+ comercial** (alta desde el cotizador); operativo (CRM, cotizaciones,
producción, subtareas, tiempos, stock, ventas, cuentas a cobrar, NPS, notificaciones) auth full;
órdenes de compra y contabilidad (caja, cobros, gastos, cuenta corriente, activos) solo admin.
**Seed**: 90 materiales + 6 plantillas estándar del Excel (Leñero $7.109 = exacto) + la terminación
inicial `Pintado en aerosol` (costo 0, a definir desde Catálogo).
**Storage**: volumen `/data/adjuntos`; los adjuntos de cada trabajo se guardan en
`production_cards.attachments jsonb` como `[{name,url,type,path}]`.

## Cotizador — modelo de precio (clave)
**Por producto (línea)**
`costo_materiales = Σ(material × cantidad)` · `costo_mo = Σ(rol × horas)` ·
`costo_terminacion` = costo de la opción elegida de `finishes` ·
`costo_directo = materiales + mo + terminación` ·
`precio = costo_directo × multiplicador` (default 1.5).

**Servicios (nivel cotización)**
`transporte` → **sin markup** (precio = costo) ·
`colocación · mano de obra = horas × costo_hora × operarios` → **con markup** ×`multiplicador` ·
`colocación · viáticos` → **sin markup**.

`precio_total = Σ(línea × cantidad) + servicios` · `margen = (precio − costo) / precio`. **Sin IVA.**

**Las dimensiones no entran al cálculo.** Ancho / alto / largo / diámetro (cada una con su unidad)
son información de fabricación: se guardan en `quote_lines` y viajan a `production_cards.product_lines`.

**La cotización es una foto del momento.** El costo/hora, el costo del material y el costo de la
terminación se guardan como *snapshot* dentro de la cotización: actualizar el Catálogo no reescribe
presupuestos ya hechos.

**Guardar es idempotente.** `numero` sale de la secuencia `quotes_numero_seq` y el id `COT-XXXX` lo
arma el trigger `trg_quotes_asignar_id`; con `id` presente `saveQuote` hace UPDATE. Apretar Guardar
dos veces, recargar o reabrir **nunca** crea una cotización nueva.

## Reglas
1. Mantener este CLAUDE.md actualizado ante cambios estructurales.
2. **Cero referencias al proyecto de origen** en el código (nombres, ids, clases, textos).
3. Antes de crear algo nuevo, reusar funciones de `cirene-data.js` / `quote-engine.js`.
4. Ningún token ni PAT se versiona.
5. `db/schema.sql` se aplica **entero en cada arranque**: todo lo que se agregue tiene que ser
   idempotente (`create ... if not exists`, `alter table ... add column if not exists`,
   `on conflict do nothing`). Nunca `drop`/`delete` de datos operativos.
6. **Caché**: al cambiar un `.js`, subir el `?v=N` de los imports en todos los HTML **y en los
   imports entre módulos `js/`** (si no, el navegador usa la versión vieja y la página queda
   "cargando"). Va bien un `perl -pi -e 's/\.js\?v=N/.js?v=N+1/g' *.html js/*.js`. **Versión actual: `v=5`.**
7. Páginas de datos: indicador "Cargando…" inmediato + `try/catch` con mensaje visible
   (que nunca quede colgado sin avisar).
8. **Sin IVA** en ningún módulo.
9. Toda transición entre módulos (CRM → Venta → Producción → Cobro) tiene que ser **idempotente**:
   antes de crear, buscar si ya existe. Ver `winLead` y `createProductionFromIntake`.
10. Los costos se guardan como **snapshot** en el documento (cotización); el catálogo no reescribe
    el pasado.

## Datos importados (de Asana)
Los CSV `~/Desktop/CIRENE/{Presupuestos,Herreria_Operativa}*.csv` se migraron a `intake_cards` y
`production_cards` (ids `in-<taskAsana>` / `pr-<taskAsana>`, idempotente). Los precios salen del
campo Notes (tabla "Producto/Medidas/Cantidad/Precio", a veces como número pelado) + cruce por
cliente con las notas de Presupuestos + hojas por cliente del Excel. Trabajos internos de Cireneos
suelen no tener precio (quedan en $0, marcados "⚠ sin precio").
