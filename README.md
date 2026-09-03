# De Cirene · ERP

ERP de **Emprendimientos De Cirene** (herrería social, Uruguay). Del primer mensaje del cliente
al cobro y la encuesta de satisfacción, en un solo camino.

SPA en **JavaScript puro sin build ni bundler**: cada página es un `.html` con
`<script type="module">` que importa de `js/`. Los datos viven en **Postgres sobre Railway**,
detrás de una **API propia** (`api/`, Node sin dependencias más que `pg`). PDFs con jsPDF.

> El detalle técnico —arquitectura, esquema, reglas y verificadores— está en
> **[CLAUDE.md](CLAUDE.md)**. Este README es el mapa rápido.

## Módulos

| Módulo | Página | Qué hace |
|---|---|---|
| CRM / Leads | `intake.html` | Toda consulta que llega, en un kanban comercial |
| Clientes | `clientes.html` | Cartera, con el teléfono E.164 como identidad única |
| Cotizador | `index.html` | Materiales + mano de obra + terminación × multiplicador → precio y PDF |
| Catálogo | `catalog.html` | Materiales, plantillas (BOM), terminaciones y tarifas de mano de obra |
| Producción | `production.html` | Kanban, lista, **día** (capacidad + semáforo), calendario y cola |
| **Taller** | `taller.html` | Pantalla de fichadas del operario: PIN → trabajo → tarea → **INICIO / FIN** |
| **Métricas** | `metricas.html` | Horas por producto, por proceso y por operario; plazos y puntualidad |
| Stock | `stock.html` | Existencias, comprometido, disponible y alertas de compra |
| Compras | `compras.html` | Proveedores y órdenes de compra; recibir suma stock y actualiza costos |
| Ventas | `ventas.html` | Panel global **y panel por vendedor** |
| NPS | `nps.html` | Encuestas de satisfacción y su tablero |
| Contabilidad | `contabilidad.html` | Cuentas a cobrar, cobros, gastos, caja, activos y balance |
| Dashboard | `dashboard.html` | Resumen ejecutivo, presupuestado vs. real e impacto social |
| Administración | `admin.html` | Usuarios, **roles y módulos**, operarios y su PIN, sugerencias, configuración |
| Manuales | `manual.html` · `manual-taller.html` | Manual de la app y de producción · manual del operario |
| Diagrama | `diagrama.html` | El flujo completo del ERP, imprimible |

## El flujo

```
Consulta → Lead → Cotización → Lead ganado ─┬→ Venta
                                            ├→ Pedido de producción → Día → Taller (INICIO/FIN) → Entrega
                                            └→ Cuenta a cobrar → Cobro
                                                                    Entrega → NPS
                              Métricas (horas reales) ──────────────────────────┘ vuelve al cotizador
```

Cada salto **busca antes de crear**: apretar dos veces, recargar o reintentar nunca duplica una
venta, un pedido ni una cuenta a cobrar.

## Dos cosas que no hay que olvidar

- **De Cirene no discrimina IVA.** Es una asociación civil sin fines de lucro y trabaja con
  importes finales. No hay campos de IVA en ningún módulo, y es a propósito.
- **Al cambiar un archivo de `js/`, subir el `?v=N` de los imports** en todos los HTML y entre
  módulos. Sin build step no hay hashing de assets: ese número es lo único que evita que el
  navegador sirva código viejo cacheado.

## Correr y desplegar

```bash
npm install          # solo pg
node server.js       # necesita DATABASE_URL apuntando a un Postgres
```

El esquema (`db/schema.sql`) es idempotente y **se aplica solo al arrancar**: la base nunca queda
atrás del código. Deploy: `git push` a `main` → Railway.

Antes de pushear, los verificadores estáticos tienen que dar OK:

```bash
perl tools/check-sql.pl db/schema.sql
perl tools/check-tdz.pl *.html
perl tools/check-columns.pl db/schema.sql js/*.js *.html
for f in api/*.js js/*.js server.js; do node --check "$f" || echo "FAIL $f"; done
```

`netlify.toml`, `netlify/`, `inject-env.js` y `supabase/` son restos del hosting anterior: no
intervienen (el histórico de migraciones de Supabase se conserva como referencia).
