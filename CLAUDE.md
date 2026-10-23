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
| `api/session.js` | scrypt (contraseñas) + HMAC (tokens), con `node:crypto`. Sin dependencias nativas. Además la **cookie de taller** (`cirene_taller`), firmada igual pero que solo abre `/api/taller/*` |
| `api/taller.js` | **Fichadas de los operarios**. PIN → operario, estado recortado de la pantalla del taller, `iniciar` y `terminar` en una transacción. La bitácora `subtask_time_logs` es la verdad: los acumulados de subtarea y pedido se **recalculan** de ella |
| `api/asana.js` | **Importar desde Asana**: lee los dos CSV (`leerCSV`, `leerNotas`, `armar`, puros) y reemplaza el movimiento con respaldo previo (`importarAsana`). Ver la sección *Importar desde Asana* |
| `api/tickets.js` | **Sugerencias → tickets de customERP**: cola en `suggestions.ticket_*`, envío con reintentos (`enviarPendientes`, `arrancarEnvio`). Ver la sección *Sugerencias → tickets* |
| `api/router.js` | `/api/auth/{pin,login,logout,me,password,usuarios,usuarios/pin,usuarios/pines}`, `/api/taller/{login,logout,estado,inicio,fin}`, `/api/q`, `/api/upload`, `/api/admin/{demo,reset,importar-asana}`, `/api/health` |
| `server.js` | Estáticos + fallback SPA + monta la API. ESM (`"type":"module"`) |

**Variables en Railway**: `DATABASE_URL` (referencia a `${{Postgres.DATABASE_URL}}`),
`SESSION_SECRET`, `ADMIN_EMAIL`, `ADJUNTOS_DIR=/data/adjuntos`, `NODE_ENV=production`.
Si falta `SESSION_SECRET` la app anda pero las sesiones se caen en cada reinicio.

**Deploy**: el servicio debería estar conectado a `empdecirene-debug/appdecirene` rama `main` →
push = deploy. URL: https://appdecirene-production.up.railway.app

**Dominio propio: `decirene.customerp.dev`** (alta en Railway el 2026-10-23, `railway domain status d76cb5d1-d6af-476e-bdbc-0c8c44683695`).
La zona `customerp.dev` está en el Cloudflare de customERP, donde un Worker (`erp-edge`) toma `*.customerp.dev/*`.
Por eso el registro tiene que ser **solo DNS (nube gris)**: con proxy, el Worker se queda con el pedido. Registros:
`CNAME decirene → mcgtr1xd.up.railway.app` y `TXT _railway-verify.decirene → railway-verify=1cfdeb6a829c812cfe62af8d029c7cfecafd914e97e7ea55c5d6da0f8f863e7d`.

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
> Estado al 2026-09-03 después de desplegar: `?v=7`, 44 tablas.

**Aplicar SQL**: ya no hace falta herramienta externa — editá `db/schema.sql` y el próximo
deploy lo aplica. Como es idempotente, agregá `create ... if not exists` / `alter ... if not exists`.

**Antes de pushear SQL, correr `perl tools/check-sql.pl db/schema.sql`.** Parsea el archivo como lo
haría Postgres (comentarios, literales, dollar quoting) y avisa de paréntesis desbalanceados o
comillas sin cerrar. El primer deploy a Railway murió con *mismatched parentheses* y el error solo
se vio en los logs; el esquema se aplica entero en una sola query, así que un error de sintaxis en
cualquier línea deja **toda** la migración sin aplicar (la app levanta igual, pero sin las tablas
nuevas). Estado esperado hoy: 276 sentencias, 44 tablas, 0 desbalanceadas.

## Stack y entorno
- **Auth**: propia (`api/session.js`). El rol vive en `user_profiles.role` y **ya no es una lista
  fija**: los roles se crean desde Administración (tabla `app_roles`). Cada rol declara un
  **`perfil_base`** (`admin` | `comercial` | `produccion` | `operario`) del que hereda los permisos
  de tabla, y una lista de **`modulos`** que decide qué ve en el menú. Admin = perfil base `admin`.
  Usuario admin: `admin@decirene.uy`.
- **Entrada con PIN por usuario (2026-10-23)**: `login.html` pide un PIN de 4 números y **cada usuario tiene
  el suyo** (`app_users.pin_hash`, scrypt): entra con SU sesión y los permisos de su rol. `/api/auth/pin` prueba
  el PIN contra todos los hash en paralelo (`usuarioPorPin`). Los asigna administración en Usuarios
  (`POST /api/auth/usuarios/pin`; `GET /api/auth/usuarios/pines` dice quién tiene, nunca el PIN). Un PIN no se
  repite entre usuarios ni con el número de taller de un operario (`motivoPinOcupado`). El alta de usuario
  acepta **sin email**: se guarda un identificador `…@sin-email.decirene` que no sirve para entrar con
  contraseña. La cookie lleva una **huella del hash del PIN**: si se lo cambian, la sesión se cae.
  Antes hubo un PIN único (`app_settings 'login_pin'`): al arrancar la primera vez pasó a ser el PIN del admin
  (`sembrarPin` en `api/db.js`, marca `pin_por_usuario`). `app_users` NO está en `api/registry.js`.
  **Freno**: 5 intentos/15 min por IP + 20 fallos/hora y 60/día **globales** (`frenoPin`); trabado el global,
  se entra con email y contraseña. Recuperación sin entrar: variable `LOGIN_PIN_RESET=<4 números>` en Railway
  (se lo pone al admin), deploy, y **borrarla**.
- **Alta de usuarios**: `POST /api/auth/usuarios` (solo admin) → devuelve la contraseña generada.
  El rol se valida contra `app_roles` (`rolExiste`), no contra una lista en el código.
- **Taller**: los operarios **no tienen usuario**. Entran a `/taller.html` con un **PIN de 4 dígitos**
  (`operators.pin`, índice único parcial) y solo pueden fichar.
- **Entorno local**: la máquina de desarrollo **no tiene `python`, `psql` ni Docker**, y no se puede
  levantar la base: la verificación end-to-end se hace **contra el deploy de Railway**. Sí hay `git`,
  `perl` (para el bump de `?v=N` y los verificadores) y **`node` (v24)**, que sirve para
  `node --check` de cada `.js` y de los `<script>` de los HTML antes de pushear.
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
| `login.html` | Login (fondo negro + logo + patrón de rejas): **teclado de PIN** (entra solo al cuarto número, acepta el teclado físico) y, abajo, "Entrar con email y contraseña" |
| `home.html` | Landing: **centro de actividad** (notificaciones de comentarios y respuestas, marcar leídas) + cuadrados de acceso **agrupados por área** (Comercial / Producción / Dirección, y "Ayuda" para Manual y Diagrama) |
| `index.html` | **Cotizador**: builder por producto (materiales + mano de obra + terminación, × multiplicador), **dimensiones** de fabricación, **comentarios para producción**, plantillas, alta/edición de materiales sin salir del flujo, sección **Servicios** (transporte + colocación), cliente, ítems, estado, guarda en `quotes` y genera **PDF molde De Cirene** (sin IVA). `?intake=<id>` y `?quote=<id>` |
| `catalog.html` | **Catálogo**: Materiales (con stock y última actualización) / Plantillas (BOM) / **Terminaciones-pintado** / Mano de obra |
| `intake.html` | **CRM**: kanban comercial con columna **Lead ganado**, teléfono obligatorio, aviso de cliente duplicado en vivo, cotización asociada visible en la tarjeta, botón "Lead ganado" que dispara venta + producción + cuenta a cobrar |
| `clientes.html` | **Clientes**: cartera con clasificación **Nuevo / Recurrente / Interno (CIRENEOS)**; el teléfono E.164 impide fichas duplicadas |
| `production.html` | **Producción**: tablero superior (productos a producir, horas estimadas, atrasados, valor en producción, **semáforo DIARIO** con selector de día) + vistas **Kanban / Lista / Día / Calendario / Listos para producir**. Modal: planificación (**día de fabricación**, horas, prioridad, responsable, fechas), **subtareas con Iniciar/Pausar/Finalizar y cronómetro**, materiales del pedido y descuento de stock, trazabilidad, adjuntos, comentarios y **🖨 etiqueta térmica**. Deep-link `?card=<id>` |
| `taller.html` | **Pantalla del taller** (operarios, sin usuario): PIN de 4 dígitos → elegir trabajo → elegir tarea → **INICIO / FIN**. Botones de 96 px, un paso por pantalla, verde=empezar / rojo=parar. Habla solo con `/api/taller/*` |
| `metricas.html` | **Métricas de producción**: horas por día, **tiempo por producto** (horas por unidad = el número para cotizar), **tiempo por proceso** con desvío contra lo estimado, **plazo de los pedidos** partido en espera / taller / entrega, puntualidad y horas por operario |
| `etiqueta.html` | **Etiqueta térmica** de una orden (`?card=<id>`): 80 mm, se imprime sola, copias configurables, precio opcional (por defecto NO), casillas para tildar y **QR** a `/production.html?card=…` |
| `compras.html` | **Compras** (admin): proveedores con estadísticas (OC, monto comprado, última compra, cuenta corriente) y **órdenes de compra** con recepción que suma stock, actualiza el costo del catálogo y deja el gasto |
| `stock.html` | **Stock**: existencias con comprometido / disponible / pendiente de OC / necesidad de compra, alertas de mínimo, ajustes manuales e historial de movimientos |
| `ventas.html` | **Ventas**, dos paneles con el selector de arriba: **global** (KPIs, ticket, evolución 12 meses, tabla comparativa por vendedor — cada fila abre su panel) y **panel del vendedor** (sus KPIs, ranking del período, su embudo lead por lead, **sus cotizaciones esperando respuesta**, sus ventas, sus productos). Un comercial entra directo al suyo |
| `nps.html` | **NPS**: dashboard (NPS, tasa de respuesta, distribución, aspectos, canales, evolución) y listado de encuestas con formulario de respuesta |
| `contabilidad.html` | **Contabilidad** (admin): Cuentas a cobrar · Calendario de cobros · Cobros por trabajo · Gastos · Reintegros · Cuenta corriente de proveedores · Activos y amortización · Caja · Movimientos · Balance |
| `dashboard.html` | **Dashboard general** (admin): período configurable, **estado de resultados** mensual, presupuestado vs. real, horas y productividad, clientes, **impacto social**, resumen NPS |
| `admin.html` | **Administración**: Operarios (**con su PIN de taller**, botón 🎲 para generar uno libre) · Usuarios (alta con nombre, rol y **PIN propio**, email opcional; columna para asignar o cambiar el PIN) · **Roles y permisos** (crear rol, perfil base, casillas de módulos) · **Sugerencias** (bandeja con respuesta y estado) · Cargas sociales · Impacto social · Etapas · Campos · Datos de prueba |
| `manual.html` | **Manual de uso** en tres pestañas: A · la app, B · producción, C · operarios. Índice automático de los `<h2>`, imprimible. El texto vive en el HTML (se puede leer con el backend caído) |
| `manual-taller.html` | **Manual del operario**, público (sin login): 5 pasos, letra grande, un dibujo por paso, los botones reproducidos igual que en la pantalla real. Pensado para imprimir en A4 y pegarlo al lado del tablet |
| `diagrama.html` | **Diagrama de flujo del ERP** de la consulta al cobro y el NPS. SVG generado a partir de dos listas (`NODOS` / `FLECHAS`) con carriles por responsable; imprime en A3 apaisado |

## Menú por áreas (2026-10-23)
El menú se ordena en **Comercial** (CRM, Clientes, Cotizar, Ventas, NPS), **Producción** (Tablero de
producción, Métricas, Catálogo, Stock) y **Dirección** (Dashboard, Contabilidad, Compras, Administración).
La fuente única es `area` en `MODULOS` (`js/cirene-data.js`): la usan la navbar, los cuadrados de Inicio
y las casillas de Administración → Roles. **Para mover un módulo de área se cambia solo ahí.** El área es
solo orden visual: qué se ve lo decide el rol, qué se puede, el perfil base.

## Módulos `js/`
| Archivo | Qué hace |
|---|---|
| `supa.js` | Cliente de datos: misma interfaz encadenable que supabase-js, pero contra `POST /api/q` |
| `auth.js` | `requireAuth`, `isAdmin` (admin\|director), `signIn/Out`, `getProfile` |
| `navbar.js` | Navbar compartida. **Las tabs las decide el rol** (`modulosDelRol`), no una regla en el código. **Agrupada por área**: Inicio suelto, un desplegable por área (`AREAS` + `MODULOS[].area` de `cirene-data.js`; se abre con hover en mouse y con toque en celular; un área con una sola página va como pestaña común) y Manual suelto. También **monta el botón de sugerencias** en todas las páginas. Clase `.cirene-nav` |
| `sugerencias.js` | Botón 💡 fijo abajo a la derecha + modal (categoría, texto, fotos adjuntas). Se monta desde `navbar.js`: así aparece en toda la app sin repetir el import en trece HTML |
| `quote-engine.js` | Motor de cálculo: `calcLine` (materiales + MO + terminación → × multiplicador), `calcServices` (transporte y viáticos **sin** markup, MO de colocación **con** markup), `calcQuoteTotals`, `dimsText`, `UNIDADES_DIM`, `money`, `pct`, `n` |
| `cirene-data.js` | **Capa de datos única**. Catálogo (materiales, `finishes`, tarifas, plantillas) · cotizaciones (`saveQuote` idempotente, `rowALinea`) · clientes (`ensureClient` anti-duplicados) · CRM (`ensureDraftQuote`, **`winLead`**) · producción (operarios, subtareas con `startSubtask`/`pauseSubtask`/`finishSubtask`, `semaforoDia` y capacidad diaria, `semaforoSemana` y semanas ISO para los agregados, `listTimeLogs`) · métricas (`tiempoPorProducto`, `tiempoPorProceso`, `plazoDePedidos`, `horasPorOperario`, `horasPorDia`) · sugerencias (`createSuggestion`, `listSuggestions`) · roles y módulos (`MODULOS`, `listRoles`, `upsertRole`, `modulosDelRol`) · abastecimiento (`suppliers`, OC, `receivePurchaseOrder`, `stockReport`, `consumirMaterialesDePedido`) · finanzas (`ensureReceivable`, gastos, cuenta corriente, `calcAsset`) · NPS (`ensureNpsSurvey`, `npsMetrics`) · notificaciones · `trazabilidad`, `presupuestadoVsReal`, `productividad` · `auditar`. **Toda página de datos pasa por acá** |
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

## Ampliación 2026-09 — Fase 8 (semáforo diario · taller · sugerencias · roles)
Tercer bloque al final de `db/schema.sql` (`AMPLIACIÓN 2026-09 · FASE 8`), también idempotente.

| Qué | Dónde | Por qué |
|---|---|---|
| **Semáforo POR DÍA** | `production_days` + `semaforoDia()` + vista **Día** de `production.html` | La semana promediaba y escondía el problema: un lunes con tres faltas y un viernes completo daban "semana verde" mientras el lunes se caían las entregas. `production_weeks` **se conserva** para el histórico y los agregados |
| El día del pedido es `production_date` | `production.html`, `planificarEnDia()` | Ya existía como "fecha de fabricación". La **semana se deriva** del día al guardar: cargar la misma cosa dos veces era la forma segura de que no coincidieran |
| Horas reales del día | `subtask_time_logs.started_at` | La tarjeta acumula todo su historial y no sabe de qué día es cada hora. Solo la bitácora lo sabe |
| **Interfaz de taller** | `taller.html` + `api/taller.js` + `operators.pin` | El operario no tiene usuario ni email. PIN de 4 dígitos → cookie `cirene_taller` que **solo** abre `/api/taller/*`, con la respuesta recortada del lado del servidor (nunca viajan montos) y freno de fuerza bruta por IP en `api/router.js` |
| `subtask_time_logs.fuente` | `db/schema.sql` | `'taller'` (lo marcó el operario) o `'app'` (lo marcó el gerente). Sin eso no se puede auditar un tiempo raro |
| **Métricas** | `metricas.html` + `tiempoPorProducto`/`tiempoPorProceso`/`plazoDePedidos`/`horasPorOperario` | Es el retorno de todo el fichaje: **horas por unidad** es el número que vuelve al cotizador |
| **Etiqueta térmica** | `etiqueta.html` | Página aparte porque su CSS de impresión (80 mm, sin márgenes, sin navbar) es incompatible con el de la app |
| **Sugerencias** | `suggestions` + `js/sugerencias.js` (montado desde `navbar.js`) | Que lo que hoy se dice de palabra quede escrito, con foto |
| **Roles configurables** | `app_roles` + `cargarRoles()`/`perfilDe()` en `api/registry.js` | Antes los roles eran cuatro constantes. Ahora se crean por pantalla, pero **los permisos de tabla no**: cada rol declara un `perfil_base` y hereda los suyos. Los módulos deciden qué se VE, el perfil base qué se PUEDE |
| Se quitó el CHECK de `user_profiles.role` | `db/schema.sql`, bloque `do $$` | Con roles creados por pantalla, el CHECK de cuatro valores hacía fallar toda alta con un rol nuevo. Se busca por catálogo porque el nombre autogenerado puede variar. **Quitar un CHECK no borra datos** |
| Perfil `operario` | `api/registry.js` (`CON_OPERARIO`) | Solo lectura de producción y escritura de subtareas y tiempos. Sin precios, sin clientes, sin contabilidad |

> ⚠ **El semáforo es por día, no por semana.** Si aparece código nuevo que planifica por
> `semana_produccion`, está yendo para atrás: el compromiso operativo es `production_date` y la
> semana se calcula sola. `semaforoSemana()` sigue exportada solo para agregados semanales.

## Tablas (esquema completo en `db/schema.sql`; el histórico Supabase queda en `supabase/migrations/`)
**Base**: `app_users`, `user_profiles`, `app_roles`, `app_settings`, `kanban_stages`, `custom_fields`, `audit_log`,
`notifications`, `suggestions`.
**Comercial**: `clients`, `intake_cards`, `quotes` + `quote_lines`, `sales`.
**Catálogo**: `materials`, `finishes`, `labor_rates`, `product_templates` + `template_material_lines`
+ `template_labor_lines`.
**Producción**: `production_cards`, `production_subtasks`, `subtask_time_logs`, **`production_days`**
(capacidad y semáforo diarios), `production_weeks` (histórico y agregados), `operators` (con `pin`),
`card_stories`, `production_card_transitions`, `card_comment_reads`.
**Abastecimiento**: `suppliers`, `purchase_orders` + `purchase_order_lines`, `stock_movements`.
**Finanzas**: `receivables`, `job_payments`, `cash_sessions`, `cash_movements`, `expenses`,
`payroll_charges`, `supplier_ledger`, `assets`.
**Gestión**: `social_impact`. **NPS**: `nps_surveys`, `nps_options`.

**Permisos** (`api/registry.js`, no hay RLS): el rol se resuelve primero a su **perfil base** con
`perfilDe()` (mapa cargado de `app_roles` al arrancar y recargado cuando `/api/q` escribe esa tabla),
y el perfil es lo que se compara contra el registro. Catálogo y maestros (tarifas, plantillas,
stages, terminaciones, operarios, proveedores, cargas, opciones NPS) lectura auth / escritura admin;
`materials` escritura admin **+ comercial** (alta desde el cotizador); operativo (CRM, cotizaciones,
producción, subtareas, tiempos, días, stock, ventas, cuentas a cobrar, NPS, notificaciones) auth full;
órdenes de compra y contabilidad (caja, cobros, gastos, cuenta corriente, activos) solo admin;
`app_roles` lectura todos (la navbar necesita los módulos) / escritura admin; `suggestions` todos.
El perfil **`operario`** solo agrega lectura de producción y escritura de subtareas y tiempos.
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
   "cargando"). Va bien un `perl -pi -e 's/\.js\?v=N/.js?v=N+1/g' *.html js/*.js`. **Versión actual: `v=9`.**
7. Páginas de datos: indicador "Cargando…" inmediato + `try/catch` con mensaje visible
   (que nunca quede colgado sin avisar).
7b. **Los helpers de nivel superior van como `function`, no como `const … =>`.** Las páginas
   arrancan con código suelto arriba (`await requireAuth()`, `render()`), y `const`/`let` no se
   izan: si el helper se declara más abajo, al llamarlo tira *"Cannot access 'X' before
   initialization"*, el módulo se corta y la pantalla **queda con el "Cargando…" puesto, sin
   ningún error visible**. Rompió Producción, Contabilidad, Dashboard, Ventas y el Cotizador a la
   vez. Verificar con `perl tools/check-tdz.pl *.html` antes de pushear.
8. **Sin IVA** en ningún módulo.
9. Toda transición entre módulos (CRM → Venta → Producción → Cobro) tiene que ser **idempotente**:
   antes de crear, buscar si ya existe. Ver `winLead` y `createProductionFromIntake`.
10. Los costos se guardan como **snapshot** en el documento (cotización); el catálogo no reescribe
    el pasado.
11. **Nada destructivo en `db/schema.sql`.** Se aplica entero en cada arranque, así que un
    `delete`/`truncate` ahí borra datos del usuario en cada deploy — y en cuanto una FK lo bloquea,
    **falla toda la migración** y la app levanta sin registro de tablas, respondiendo *"Tabla no
    permitida"* a todo. Los seeds van con `where not exists` o con un `if exists (…) then return`.
12. **Las listas van a columnas `jsonb`, y el driver de Postgres manda los arrays de JS como literal
    de ARRAY.** `api/query.js` las serializa según el tipo de columna (`esJson`); del lado del
    cliente, todo lo que salga de un jsonb pasa por `arr()` de `quote-engine.js`, porque las filas
    viejas pueden volver como `{}`.
13. **La planificación de producción es POR DÍA** (`production_date` + `production_days`). La semana
    se deriva, no se carga. Ver la advertencia de la Fase 8.
14. **Las horas reales nunca se escriben a mano.** Se recalculan de `subtask_time_logs`, que es la
    única fuente. Si un número está mal, se arregla el tramo, no el acumulado.
15. **Los permisos de tabla no se editan por pantalla.** Un rol nuevo elige uno de los cuatro
    perfiles base y hereda los suyos. Si algún día una pantalla puede otorgar permisos de tabla,
    cualquiera que la abra puede darse la contabilidad.

## Verificaciones antes de pushear
No se puede levantar la base localmente, así que hay tres verificadores estáticos más `node --check`.
Todos tienen que dar OK:

| Comando | Qué evita |
|---|---|
| `perl tools/check-sql.pl db/schema.sql` | Paréntesis o comillas sin cerrar en el esquema. Un error de sintaxis deja **toda** la migración sin aplicar |
| `perl tools/check-tdz.pl *.html` | Helpers `const … =>` declarados debajo del arranque. Rompen la página entera y la dejan en "Cargando…" **sin ningún mensaje** |
| `perl tools/check-columns.pl db/schema.sql js/*.js *.html` | Columnas que se escriben y no existen. La API las descarta en silencio: el registro se guarda **sin ese dato** |
| `for f in api/*.js js/*.js server.js; do node --check "$f" \|\| echo "FAIL $f"; done` | Errores de sintaxis en los módulos. En el backend, uno solo deja el servicio en crash-loop |

Los `<script>` de los HTML también se pueden chequear extrayéndolos a un `.mjs` temporal y pasándoles
`node --check` (el `.mjs` acepta `import` y el `await` de nivel superior).

Nada de eso reemplaza probar contra el deploy: el bug de las listas `jsonb` y el del seed destructivo
solo aparecieron ejecutando de verdad contra Railway y leyendo los logs del arranque.

## Datos de prueba y reinicio
Administración → **Datos de prueba** (`api/demo.js`, solo admin, todo en una transacción):

- **Generar**: carga un juego ficticio coherente que recorre todos los módulos y usa el catálogo
  real. Cada fila queda marcada con `demo = true`.
- **Borrar los de prueba**: filtra por `demo`, no toca nada real. Devuelve los materiales que tocó
  a su saldo real y les saca el mínimo que había puesto.
- **Reiniciar todo**: vacía el movimiento (clientes, leads, cotizaciones, ventas, producción, stock,
  cobros, gastos) y deja stock y cuentas corrientes en cero. Conserva usuarios, catálogo,
  proveedores, operarios y configuración. Pide escribir `REINICIAR`.

El orden de borrado está escrito a mano en `ORDEN_BORRADO` y respeta las FK: `production_cards` y
`sales` se apuntan mutuamente, así que primero se anula `sale_id`.

## Importar desde Asana (2026-10-23)
Administración → **Importar y datos** → *Importar desde Asana* (`api/asana.js`, `POST /api/admin/importar-asana`).
Recibe los dos CSV que exporta Asana y **reemplaza todo el movimiento** en UNA transacción: respaldo → `vaciar`
(lo mismo que "Reiniciar todo", `api/demo.js`) → carga. `soloVer: true` corre todo y hace rollback: es la vista
previa de la pantalla. Sin `confirmacion: 'REINICIAR'` no borra.

| CSV | Va a | Detalle |
|---|---|---|
| Presupuestos Herreria | `intake_cards` (`in-<TaskID>`) | Columna → etapa; "Presupuestado" se abre según *Seguimiento* (Envíado/Rechazado/Aceptado/En seguimiento) |
| Herreria Operativa | `production_cards` (`pr-<TaskID>`) + `sales` | Columna → etapa; productos y precios de la tabla de las notas; PAGO → `estado_pago` |
| Los dos (mismo Task ID) | la consulta queda en **Lead ganado** y apunta al trabajo y la venta, como `winLead` | |
| Subtareas de Operativa | `production_subtasks` (por el NOMBRE del padre, es lo que trae el CSV) | |

- **Clientes**: uno por teléfono E.164; sin teléfono, uno por nombre. "Cliente (PRODUCTO)" → cliente; las viejas
  "Producto (Cliente)" se dan vuelta (`EMPIEZA_CON_PRODUCTO`). Todo lo de Cireneos es UN cliente interno, sin teléfono.
- **La tabla de las notas** (`leerNotas`) viene aplanada y desprolija: renglones vacíos de más entre filas, celdas
  de varios renglones, celdas finales que faltan. Cada fila prueba combinaciones y gana la que pone números donde
  van números. Precio = unitario × Cantidad, salvo que la cantidad sea una medida ("8 mts"): ahí es el total.
  Las líneas de cantidad > 1 y $50.000 o más se avisan para revisar (no se sabe si era unitario o total).
- **Cobros**: cuenta a cobrar por trabajo con precio; PAGO = SI → un cobro por el total (+ movimiento de caja).
  Entregados SIN marca de pago (los viejos, de antes de esa columna) → cobrados "asumidos", anotado en el cobro.
  NO y SEÑA quedan a cobrar (la seña sin monto, con nota).
- **No se importa**: la sección *Stock* (productos terminados; el stock del ERP es de materiales) ni cotizaciones
  (Asana no tiene las líneas de costo del cotizador).
- **Respaldo**: JSON de todas las tablas que se vacían, en `/data/respaldos/` (mismo volumen, FUERA de
  `/data/adjuntos`, que se sirve público). Para restaurar hay que hacerlo a mano desde ese archivo.
- Con los CSV del 2026-10-23: 122 clientes, 182 consultas, 131 trabajos, 113 ventas.

## Sugerencias → tickets de customERP (2026-10-23)
Cada sugerencia del botón 💡 se reenvía como **ticket al ERP interno de customERP** (`intern.customerp.dev`),
que mantiene esta app (`api/tickets.js`). La tabla `suggestions` es la cola: `ticket_estado` 'pendiente' →
'enviada' (con `ticket_id`) o 'error' (con `ticket_error`, reintento solo con espera 1, 2, 4… min, tope 6 h).
Sale al toque cuando se inserta (`/api/q` → `setImmediate(enviarPendientes)`) y cada minuto revisa la cola.

- Variables de Railway: `CUSTOMERP_TICKETS_TOKEN` (sin ella NO se envía nada; las sugerencias esperan) y
  opcional `CUSTOMERP_TICKETS_URL` (default `https://intern.customerp.dev/api/tickets/entrante`).
  `PUBLIC_URL` (o `RAILWAY_PUBLIC_DOMAIN`) arma los links absolutos a los adjuntos.
- Contrato: `POST` con `Authorization: Bearer <token>` y `{titulo, detalle, autor, pagina, ref}`; `ref` = id de
  la sugerencia, para que un reintento no duplique. `origen` lo pone customERP según el token.
- **Del lado de customERP esa entrada no existía** (sus tickets solo aceptan sesión de gerencia): va en un PR del
  repo `erp-backend`. Hasta que esté publicado y den la clave, todo queda en cola.
- Administración → Sugerencias muestra "✓ en customERP" / "sin enviar · se reintenta" y un botón para reintentar.

## Fechas: `date` vuelve como texto
`api/db.js` fija `pg.types.setTypeParser(1082, v => v)`: las columnas `date` llegan como `'YYYY-MM-DD'`, igual
que con Supabase. Sin eso el driver las convertía a `Date` y el JSON salía `'2026-10-27T03:00:00.000Z'`: las
tarjetas lo mostraban así, los `<input type=date>` quedaban vacíos y **guardar un trabajo le borraba las fechas**
(pasó desde la migración a Railway hasta el 2026-10-23).
