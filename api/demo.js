// Datos de prueba y reinicio.
//
// Dos operaciones que solo puede disparar un admin desde Administración:
//
//   generarDemo()  → carga un juego de datos ficticio pero COHERENTE, que recorre
//                    todos los módulos: clientes, leads, cotizaciones, ventas,
//                    producción con subtareas y horas fichadas, compras, stock,
//                    cobros, gastos, activos, impacto social y NPS.
//   reiniciar(modo) → 'demo' borra solo lo generado acá (filtra por la columna
//                    `demo`); 'operativo' vacía todo el movimiento y deja la
//                    instalación como recién estrenada, conservando usuarios,
//                    catálogo y configuración.
//
// Las dos corren dentro de una transacción: o queda todo, o no queda nada.
// El orden de borrado respeta las claves foráneas; está escrito a mano y no
// generado, porque `production_cards` y `sales` se referencian mutuamente.

import { pool } from './db.js';

const hoy = () => new Date().toISOString().slice(0, 10);
const diasAtras = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
const diasAdelante = (n) => diasAtras(-n);
const horasAtras = (n) => new Date(Date.now() - n * 3600_000).toISOString();
const id = (pre) => pre + '-' + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36);

// Semana ISO 'YYYY-Www', igual que js/cirene-data.js
function semanaISO(d = new Date()) {
  const f = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dia = f.getUTCDay() || 7;
  f.setUTCDate(f.getUTCDate() + 4 - dia);
  const ini = new Date(Date.UTC(f.getUTCFullYear(), 0, 1));
  const sem = Math.ceil(((f - ini) / 86400000 + 1) / 7);
  return `${f.getUTCFullYear()}-W${String(sem).padStart(2, '0')}`;
}

// Tablas de movimiento, en orden seguro de borrado (hijas primero).
// `production_cards.sale_id` y `sales.production_card_id` se apuntan entre sí:
// por eso el sale_id se pone en null antes de borrar.
const ORDEN_BORRADO = [
  'subtask_time_logs', 'production_subtasks', 'nps_surveys', 'supplier_ledger',
  'job_payments', 'cash_movements', 'cash_sessions', 'expenses',
  'receivables', 'stock_movements', 'purchase_order_lines', 'purchase_orders',
  'card_stories', 'notifications', 'production_card_transitions',
  'sales', 'production_cards', 'quote_lines', 'quotes', 'intake_cards',
  'clients', 'production_weeks', 'assets', 'social_impact',
];

export async function reiniciar(modo = 'demo') {
  if (!['demo', 'operativo'].includes(modo)) throw new Error('Modo de reinicio desconocido: ' + modo);
  const c = await pool.connect();
  const borrados = {};
  try {
    await c.query('begin');

    // Qué materiales tocó la demo. Hay que anotarlos ANTES de borrar los
    // movimientos, porque después no hay forma de saber cuáles fueron.
    let materialesDemo = [];
    if (modo === 'demo') {
      const { rows } = await c.query(
        `select distinct material_id from stock_movements where demo and material_id is not null`);
      materialesDemo = rows.map(r => r.material_id);
    }

    // Romper el ciclo production_cards ↔ sales antes de borrar.
    await c.query(modo === 'demo'
      ? 'update production_cards set sale_id = null where demo'
      : 'update production_cards set sale_id = null');

    for (const t of ORDEN_BORRADO) {
      // Las tablas hijas no tienen columna `demo`: se borran por cascada del
      // padre, o por su vínculo cuando el borrado es total.
      const tieneDemo = await c.query(
        `select 1 from information_schema.columns where table_schema='public' and table_name=$1 and column_name='demo'`, [t]);
      let sql;
      if (modo === 'operativo') sql = `delete from "${t}"`;
      else if (tieneDemo.rowCount) sql = `delete from "${t}" where demo`;
      else continue;   // hija sin marca: ya cayó por cascada
      const r = await c.query(sql);
      if (r.rowCount) borrados[t] = r.rowCount;
    }

    if (modo === 'demo') {
      const r1 = await c.query('delete from operators where demo');
      if (r1.rowCount) borrados.operators = r1.rowCount;
      const r2 = await c.query('delete from suppliers where demo');
      if (r2.rowCount) borrados.suppliers = r2.rowCount;
    }

    // Sin movimientos de stock, el saldo de cada material vuelve a cero; lo mismo
    // la cuenta corriente de los proveedores. Si no, quedarían saldos huérfanos.
    if (modo === 'operativo') {
      await c.query('update materials set stock_actual = 0, stock_comprometido = 0');
      await c.query('update suppliers set saldo = 0');
    } else {
      await c.query(`update suppliers s set saldo = coalesce((
        select sum(case when l.tipo='cargo' then l.monto else -l.monto end)
          from supplier_ledger l where l.supplier_id = s.id), 0)`);
      // Los materiales que movió la demo vuelven al saldo que dejan los
      // movimientos reales que queden (0 si no hay), y se les saca el mínimo
      // que puso la demo. Si no, quedaban existencias y alertas fantasma.
      if (materialesDemo.length) {
        await c.query(
          `update materials m set
             stock_actual = coalesce((select sm.stock_resultante from stock_movements sm
                                       where sm.material_id = m.id
                                       order by sm.fecha desc, sm.created_at desc limit 1), 0),
             stock_minimo = 0
           where m.id = any($1)`, [materialesDemo]);
      }
    }

    await c.query('commit');
    return { modo, borrados };
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally { c.release(); }
}

export async function generarDemo() {
  const c = await pool.connect();
  try {
    await c.query('begin');

    const ya = await c.query('select count(*)::int n from clients where demo');
    if (ya.rows[0].n > 0) {
      await c.query('rollback');
      return { ya: true, mensaje: 'Ya hay datos de prueba cargados. Borralos antes de volver a generar.' };
    }

    // Catálogo real de la instalación: la demo lo usa en vez de inventar precios.
    const { rows: mats } = await c.query(
      `select id, nombre, unidad, precio_unit from materials where activo order by nombre limit 4`);
    const { rows: tarifas } = await c.query(
      `select id, rol, costo_hora from labor_rates where activo order by display_order limit 3`);
    const { rows: terms } = await c.query(
      `select id, nombre, costo from finishes where activo order by display_order limit 1`);
    const term = terms[0] || null;
    const tarifa = tarifas[0] || { id: null, rol: 'Oficial', costo_hora: 250 };
    const { rows: adminU } = await c.query(
      `select id from user_profiles where role in ('admin','director') order by created_at limit 1`);
    const uid = adminU[0]?.id || null;

    const cuenta = {};
    const sumar = (k, n = 1) => { cuenta[k] = (cuenta[k] || 0) + n; };

    /* ── Operarios ── */
    const operarios = [];
    for (const [nombre, funcion, costo] of [
      ['Marcos Silva', 'Herrero', 320], ['Diego Pereira', 'Soldador', 280], ['Bruno Cardozo', 'Ayudante', 180],
    ]) {
      const r = await c.query(
        `insert into operators (nombre, funcion, costo_hora, activo, demo) values ($1,$2,$3,true,true) returning id`,
        [nombre, funcion, costo]);
      operarios.push({ id: r.rows[0].id, nombre, costo });
      sumar('operarios');
    }

    /* ── Proveedores ── */
    const provs = [];
    for (const [nombre, contacto, tel, mat, cond] of [
      ['Barraca Hierros del Sur', 'Ana Rodríguez', '+59824001122', 'Hierro, caños, chapa', 'Cuenta corriente 30 días'],
      ['Pinturas del Oeste', 'Sergio Bentancor', '+59824003344', 'Pinturas y convertidor', 'Contado'],
    ]) {
      const r = await c.query(
        `insert into suppliers (nombre, contacto, telefono, materiales, condiciones_pago, cuenta_corriente, activo, demo)
         values ($1,$2,$3,$4,$5,$6,true,true) returning id`,
        [nombre, contacto, tel, mat, cond, cond.startsWith('Cuenta')]);
      provs.push({ id: r.rows[0].id, nombre });
      sumar('proveedores');
    }

    /* ── Clientes ── */
    const clientes = [];
    for (const [nombre, empresa, tel, mail, dir, interno] of [
      ['Almacén La Esquina', 'La Esquina SRL', '+59899111222', 'contacto@laesquina.uy', 'Av. Italia 3820', false],
      ['Colegio San José', null, '+59899333444', 'administracion@sanjose.edu.uy', 'Rivera 2145', false],
      ['Rosana Méndez', null, '+59899777888', 'rosana.mendez@gmail.com', 'Bulevar Artigas 1190', false],
      ['CIRENEOS · Taller interno', 'De Cirene', '+59899555666', null, 'Sede', true],
    ]) {
      const r = await c.query(
        `insert into clients (nombre, empresa, telefono, telefono_e164, email, direccion, es_interno, origen, activo, demo)
         values ($1,$2,$3,$3,$4,$5,$6,'demo',true,true) returning id`,
        [nombre, empresa, tel, mail, dir, interno]);
      clientes.push({ id: r.rows[0].id, nombre, tel });
      sumar('clientes');
    }

    /* ── Helper: arma una cotización completa con sus líneas ── */
    async function crearCotizacion({ cliente, lead, estado, producto, cantidad, dims, comentario, horas, transporte, colocHoras }) {
      const materiales = mats.slice(0, 3).map((m, i) => ({
        material_id: m.id, descripcion: m.nombre, dimension: null,
        costoUnit: Number(m.precio_unit), cantidad: [3, 2, 1.5][i] || 1,
      }));
      const manoObra = [{ labor_rate_id: tarifa.id, rol: tarifa.rol, costoHora: Number(tarifa.costo_hora), horas }];
      const costoMat = materiales.reduce((s, m) => s + m.costoUnit * m.cantidad, 0);
      const costoMO = manoObra.reduce((s, l) => s + l.costoHora * l.horas, 0);
      const costoTerm = term ? Number(term.costo) : 0;
      const mult = 1.5;
      const costoDirecto = costoMat + costoMO + costoTerm;
      const precioProd = costoDirecto * mult * cantidad;
      const colocCosto = colocHoras * Number(tarifa.costo_hora);
      const colocPrecio = colocCosto * mult;
      const viaticos = colocHoras ? 800 : 0;
      const precioTotal = precioProd + transporte + colocPrecio + viaticos;

      const q = await c.query(
        `insert into quotes (estado, cliente_nombre, cliente_contacto, cliente_telefono, cliente_direccion,
           cliente_id, vendedor, vendedor_user_id, intake_card_id,
           subtotal_materiales, subtotal_mo, costo_terminaciones, subtotal_productos, costo_directo,
           multiplicador, precio_venta, ganancia, margen,
           transporte_costo, transporte_notas,
           colocacion_horas, colocacion_operarios, colocacion_labor_rate_id, colocacion_rol,
           colocacion_costo_hora, colocacion_multiplicador, colocacion_viaticos, colocacion_comentarios,
           costo_colocacion_mo, precio_colocacion_mo, subtotal_servicios,
           comentarios_produccion, updated_by, demo)
         values ($1,$2,$3,$3,$4,$5,'Comercial',$6,$7,
                 $8,$9,$10,$11,$12,
                 1.5,$13,$14,$15,
                 $16,$17,
                 $18,1,$19,$20,
                 $21,1.5,$22,$23,
                 $24,$25,$26,
                 $27,$6,true)
         returning id, numero`,
        [estado, cliente.nombre, cliente.tel, 'Dirección de entrega a coordinar', cliente.id, uid, lead,
         costoMat * cantidad, costoMO * cantidad, costoTerm * cantidad, precioProd,
         costoDirecto * cantidad + transporte + colocCosto + viaticos,
         precioTotal, precioTotal - (costoDirecto * cantidad + transporte + colocCosto + viaticos),
         precioTotal ? (precioTotal - (costoDirecto * cantidad + transporte + colocCosto + viaticos)) / precioTotal : 0,
         transporte, transporte ? 'Flete hasta el domicilio del cliente' : null,
         colocHoras, tarifa.id, colocHoras ? tarifa.rol : null,
         Number(tarifa.costo_hora), viaticos, colocHoras ? 'Coordinar acceso con el cliente' : null,
         colocCosto, colocPrecio, transporte + colocPrecio + viaticos,
         comentario]);

      await c.query(
        `insert into quote_lines (quote_id, producto, es_estandar, cantidad,
           ancho, ancho_unidad, alto, alto_unidad, largo, largo_unidad,
           comentarios_produccion, terminacion_id, terminacion_nombre, terminacion_costo, costo_terminacion,
           pintado, materiales, mano_obra,
           costo_materiales, costo_mo, costo_directo, multiplicador, precio_venta, display_order)
         values ($1,$2,false,$3, $4,'cm',$5,'cm',$6,'cm', $7,$8,$9,$10,$10, $11,$12,$13,
                 $14,$15,$16,1.5,$17,0)`,
        [q.rows[0].id, producto, cantidad,
         dims[0], dims[1], dims[2], comentario,
         term?.id || null, term?.nombre || null, costoTerm,
         !!term, JSON.stringify(materiales), JSON.stringify(manoObra),
         costoMat, costoMO, costoDirecto, costoDirecto * mult]);

      sumar('cotizaciones');
      return { id: q.rows[0].id, precio: precioTotal, materiales, manoObra, producto, cantidad, dims, comentario };
    }

    /* ── Leads del pipeline (sin cerrar) ── */
    const pipeline = [
      ['mensaje_entrante', clientes[2], 'Reja para ventana de living, 2 hojas', 'alta'],
      ['a_presupuestar', clientes[0], 'Estantería de hierro para depósito', 'normal'],
      ['presupuestado', clientes[1], 'Portón corredizo de acceso vehicular', 'urgente'],
      ['en_seguimiento', clientes[3], 'Mesada de trabajo para el taller', 'baja'],
    ];
    let i = 0;
    for (const [etapa, cli, desc, urg] of pipeline) {
      const lid = id('in');
      await c.query(
        `insert into intake_cards (id, vendor, vendor_user_id, client_query, client_phone_e164, client_email,
           description, target_date, urgency, stage_key, status, client_id, created_at, demo)
         values ($1,'Comercial',$2,$3,$4,$5,$6,$7,$8,$9,'abierta',$10,
                 now() - ($11::text || ' days')::interval, true)`,
        [lid, uid, cli.nombre, cli.tel, null, desc, diasAdelante(20 + i * 5), urg, etapa, cli.id, String(12 - i * 3)]);
      sumar('leads');
      // Las dos últimas ya tienen presupuesto hecho.
      if (etapa === 'presupuestado' || etapa === 'en_seguimiento') {
        const cot = await crearCotizacion({
          cliente: cli, lead: lid, estado: etapa === 'presupuestado' ? 'presupuestado' : 'en_seguimiento',
          producto: desc, cantidad: 1, dims: [180, 120, null],
          comentario: 'Confirmar medidas en obra antes de cortar.', horas: 6, transporte: 1200, colocHoras: 0,
        });
        await c.query(`update intake_cards set resulting_quote_id = $1 where id = $2`, [cot.id, lid]);
      } else {
        // Los que todavía no se trabajaron nacen con su cotización en borrador.
        const cot = await c.query(
          `insert into quotes (estado, cliente_nombre, cliente_telefono, cliente_id, vendedor, vendedor_user_id,
             intake_card_id, updated_by, demo)
           values ('borrador',$1,$2,$3,'Comercial',$4,$5,$4,true) returning id`,
          [cli.nombre, cli.tel, cli.id, uid, lid]);
        await c.query(`update intake_cards set resulting_quote_id = $1 where id = $2`, [cot.rows[0].id, lid]);
        sumar('cotizaciones');
      }
      i++;
    }

    /* ── Dos leads ganados: venta + producción + cuenta a cobrar ── */
    const ganados = [
      { cli: clientes[0], desc: 'Maceteros de hierro 5 unidades', cant: 5, dims: [40, 60, 40], horas: 4,
        transporte: 1500, coloc: 0, etapa: 'a_producir', semanas: 0, entrega: 12 },
      { cli: clientes[1], desc: 'Baranda de escalera con pasamanos', cant: 1, dims: [null, 95, 620], horas: 14,
        transporte: 2200, coloc: 6, etapa: 'procesar', semanas: 1, entrega: 25 },
    ];
    const pedidos = [];
    for (const g of ganados) {
      const lid = id('in');
      await c.query(
        `insert into intake_cards (id, vendor, vendor_user_id, client_query, client_phone_e164, description,
           target_date, urgency, stage_key, status, client_id, won_at, created_at, demo)
         values ($1,'Comercial',$2,$3,$4,$5,$6,'normal','lead_ganado','aceptada',$7, now(), now() - interval '20 days', true)`,
        [lid, uid, g.cli.nombre, g.cli.tel, g.desc, diasAdelante(g.entrega), g.cli.id]);
      sumar('leads');

      const cot = await crearCotizacion({
        cliente: g.cli, lead: lid, estado: 'aceptado', producto: g.desc, cantidad: g.cant, dims: g.dims,
        comentario: 'Terminación prolija en las soldaduras vistas. Verificar escuadra antes de pintar.',
        horas: g.horas, transporte: g.transporte, colocHoras: g.coloc,
      });

      const pid = id('pr');
      const lineas = [{
        producto: g.desc, cantidad: g.cant, precio: cot.precio / g.cant,
        dimensiones: { ancho: g.dims[0], ancho_unidad: 'cm', alto: g.dims[1], alto_unidad: 'cm', largo: g.dims[2], largo_unidad: 'cm' },
        terminacion: term?.nombre || null,
        comentarios_produccion: cot.comentario,
        materiales: cot.materiales, mano_obra: cot.manoObra,
      }];
      await c.query(
        `insert into production_cards (id, source, vendor, vendor_user_id, intake_card_id, quote_id, client_id,
           client_name, client_phone_e164, direccion, description, product_lines, total_venta, estado_pago,
           stage_key, priority, due_date, fecha_solicitada_cliente, fecha_objetivo_interna,
           semana_produccion, horas_estimadas, responsable_operator_id, listo_para_producir,
           billing_month, entrega, created_at, demo)
         values ($1,'quote_approved','Comercial',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'NO',
                 $12,'normal',$13,$13,$14,$15,$16,$17,$18,$19,$20, now() - interval '18 days', true)`,
        [pid, uid, lid, cot.id, g.cli.id, g.cli.nombre, g.cli.tel, 'Dirección de entrega a coordinar',
         g.desc, JSON.stringify(lineas), cot.precio,
         g.etapa, diasAdelante(g.entrega), diasAdelante(g.entrega - 3),
         semanaISO(new Date(Date.now() + g.semanas * 7 * 86400000)), g.horas * g.cant,
         operarios[0].id, g.etapa === 'a_producir',
         hoy().slice(0, 7), g.coloc ? 'Instalación' : 'Retiro en el taller']);
      sumar('pedidos');

      const venta = await c.query(
        `insert into sales (quote_id, intake_card_id, production_card_id, client_id, cliente_nombre,
           vendedor, vendedor_user_id, monto, fecha, billing_month, estado, demo)
         values ($1,$2,$3,$4,$5,'Comercial',$6,$7,$8,$9,'confirmada',true) returning id`,
        [cot.id, lid, pid, g.cli.id, g.cli.nombre, uid, cot.precio, diasAtras(18), hoy().slice(0, 7)]);
      sumar('ventas');

      await c.query(`update production_cards set sale_id = $1 where id = $2`, [venta.rows[0].id, pid]);
      await c.query(`update intake_cards set sale_id = $1, resulting_quote_id = $2, resulting_production_card_id = $3 where id = $4`,
        [venta.rows[0].id, cot.id, pid, lid]);
      await c.query(`update quotes set production_card_id = $1 where id = $2`, [pid, cot.id]);

      await c.query(
        `insert into receivables (production_card_id, sale_id, quote_id, client_id, cliente_nombre, monto,
           fecha, forma_cobro, monto_sena, fecha_sena, fecha_esperada_cobro, cobrado, saldo, estado, demo)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true)`,
        [pid, venta.rows[0].id, cot.id, g.cli.id, g.cli.nombre, cot.precio, diasAtras(18),
         g.coloc ? 'sena_saldo' : 'credito_entrega',
         g.coloc ? Math.round(cot.precio * 0.5) : 0, g.coloc ? diasAtras(15) : null,
         diasAdelante(g.entrega), g.coloc ? Math.round(cot.precio * 0.5) : 0,
         g.coloc ? cot.precio - Math.round(cot.precio * 0.5) : cot.precio,
         g.coloc ? 'parcial' : 'a_cobrar']);
      sumar('cuentas_a_cobrar');

      pedidos.push({ id: pid, cot, cliente: g.cli, precio: cot.precio, coloc: g.coloc });
    }

    /* ── Subtareas con horas fichadas de verdad en el primer pedido ── */
    const p0 = pedidos[0];
    const etapas = [
      ['Corte', 0, 3, 'terminada'], ['Preparación', 1, 2, 'terminada'],
      ['Soldadura', 0, 5, 'en_curso'], ['Pulido', 2, 2, 'pendiente'],
      ['Pintura', 1, 2, 'pendiente'], ['Armado', 2, 1, 'pendiente'],
    ];
    let orden = 0, segTotal = 0;
    for (const [nombre, op, est, estado] of etapas) {
      const seg = estado === 'terminada' ? Math.round(est * 3600 * 0.9) : (estado === 'en_curso' ? 4200 : 0);
      segTotal += seg;
      const st = await c.query(
        `insert into production_subtasks (card_id, nombre, display_order, operator_id, horas_estimadas, estado,
           started_at, last_started_at, finished_at, segundos_trabajados, comentarios, demo)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true) returning id`,
        [p0.id, nombre, orden * 10, operarios[op].id, est, estado,
         estado === 'pendiente' ? null : horasAtras(30 - orden * 4),
         estado === 'en_curso' ? horasAtras(1.2) : null,
         estado === 'terminada' ? horasAtras(28 - orden * 4) : null,
         seg, estado === 'terminada' ? 'Sin novedades.' : null]);
      if (seg > 0) {
        await c.query(
          `insert into subtask_time_logs (subtask_id, card_id, operator_id, started_at, ended_at, segundos, motivo_fin)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [st.rows[0].id, p0.id, operarios[op].id, horasAtras(30 - orden * 4),
           estado === 'terminada' ? horasAtras(28 - orden * 4) : null, seg,
           estado === 'terminada' ? 'fin' : 'pausa']);
      }
      sumar('subtareas');
      orden++;
    }
    await c.query(`update production_cards set horas_reales = $1 where id = $2`,
      [Math.round((segTotal / 3600) * 100) / 100, p0.id]);

    /* ── Capacidad de la semana ── */
    for (const [sem, prev, real, ops, opsr] of [
      [semanaISO(), 40, 32, 3, 2],
      [semanaISO(new Date(Date.now() + 7 * 86400000)), 40, 40, 3, 3],
    ]) {
      await c.query(
        `insert into production_weeks (semana, capacidad_prevista_horas, capacidad_real_horas,
           operarios_previstos, operarios_reales, notas, updated_by, demo)
         values ($1,$2,$3,$4,$5,$6,$7,true)
         on conflict (semana) do update set capacidad_prevista_horas = excluded.capacidad_prevista_horas,
           capacidad_real_horas = excluded.capacidad_real_horas, demo = true`,
        [sem, prev, real, ops, opsr, real < prev ? 'Un operario con licencia médica.' : null, uid]);
      sumar('semanas');
    }

    /* ── Compra: OC recibida, entra el stock y queda el gasto ── */
    if (mats.length) {
      const oc = await c.query(
        `insert into purchase_orders (supplier_id, proveedor_nombre, fecha, estado, fecha_esperada, fecha_recibida,
           forma_pago, total, observaciones, created_by, demo)
         values ($1,$2,$3,'recibida',$4,$5,'cuenta_corriente',0,'Reposición mensual',$6,true) returning id`,
        [provs[0].id, provs[0].nombre, diasAtras(22), diasAtras(18), diasAtras(18), uid]);
      const ocId = oc.rows[0].id;
      let totalOC = 0, ln = 0;
      for (const m of mats.slice(0, 3)) {
        // Cantidades holgadas a propósito: si se compra apenas lo que consume el
        // pedido, el stock queda en cero y la pantalla de Stock no muestra nada.
        const cant = [60, 40, 30][ln] || 25;
        const costo = Number(m.precio_unit) || 100;
        totalOC += cant * costo;
        await c.query(
          `insert into purchase_order_lines (purchase_order_id, material_id, descripcion, unidad, cantidad,
             costo_unit, costo_total, cantidad_recibida, display_order)
           values ($1,$2,$3,$4,$5,$6,$7,$5,$8)`,
          [ocId, m.id, m.nombre, m.unidad, cant, costo, cant * costo, ln]);
        await c.query(
          `insert into stock_movements (material_id, tipo, cantidad, costo_unit, motivo, purchase_order_id,
             stock_resultante, fecha, notas, registrado_por, demo)
           values ($1,'entrada',$2,$3,'compra',$4,$2,$5,$6,$7,true)`,
          [m.id, cant, costo, ocId, diasAtras(18), 'Recepción ' + ocId, uid]);
        // Un stock mínimo por material para que el tablero de Stock tenga algo que
        // avisar. El de la mitad queda por debajo a propósito: así se ve la alerta.
        await c.query(`update materials set stock_actual = stock_actual + $1, stock_minimo = $2 where id = $3`,
          [cant, [20, 45, 10][ln] || 5, m.id]);
        ln++;
      }
      await c.query(`update purchase_orders set total = $1 where id = $2`, [totalOC, ocId]);
      sumar('ordenes_compra');
      sumar('movimientos_stock', ln);

      const gasto = await c.query(
        `insert into expenses (fecha, categoria, descripcion, monto, supplier_id, purchase_order_id,
           forma_pago, registrado_por, demo)
         values ($1,'Materiales',$2,$3,$4,$5,'cuenta_corriente',$6,true) returning id`,
        [diasAtras(18), 'Compra ' + ocId + ' · ' + provs[0].nombre, totalOC, provs[0].id, ocId, uid]);
      sumar('gastos');
      await c.query(
        `insert into supplier_ledger (supplier_id, tipo, monto, fecha, purchase_order_id, expense_id, notas, registrado_por, demo)
         values ($1,'cargo',$2,$3,$4,$5,'Compra a crédito',$6,true)`,
        [provs[0].id, totalOC, diasAtras(18), ocId, gasto.rows[0].id, uid]);
      await c.query(`update suppliers set saldo = $1 where id = $2`, [totalOC, provs[0].id]);

      // Consumo del primer pedido: sale del stock.
      for (const m of cot0Materiales(pedidos[0])) {
        await c.query(
          `insert into stock_movements (material_id, tipo, cantidad, costo_unit, motivo, production_card_id,
             stock_resultante, fecha, notas, registrado_por, demo)
           values ($1,'salida',$2,$3,'produccion',$4,0,$5,$6,$7,true)`,
          [m.material_id, m.cantidad, m.costoUnit, pedidos[0].id, diasAtras(6), 'Consumo ' + pedidos[0].id, uid]);
        await c.query(`update materials set stock_actual = greatest(0, stock_actual - $1) where id = $2`,
          [m.cantidad, m.material_id]);
        sumar('movimientos_stock');
      }
      // Recalcular el resultante de cada material para que el historial cierre.
      await c.query(`update stock_movements sm set stock_resultante = m.stock_actual
                       from materials m where m.id = sm.material_id and sm.demo`);
    }

    /* ── Más gastos del mes ── */
    const cargas = await c.query(`select coalesce(sum(porcentaje),0) p from payroll_charges where activo`);
    const pct = Number(cargas.rows[0].p) || 0;
    const nominal = 42000;
    for (const [fecha, cat, desc, monto, forma, extra] of [
      [diasAtras(10), 'Sueldos', 'Sueldo de taller · ' + hoy().slice(0, 7), Math.round(nominal * (1 + pct / 100)), 'organizacion', { nominal }],
      [diasAtras(9), 'Servicios', 'UTE y OSE del taller', 6800, 'organizacion', null],
      [diasAtras(7), 'Transporte', 'Flete de entrega', 1500, 'organizacion', null],
      [diasAtras(4), 'Mantenimiento', 'Discos de corte y repuestos', 2300, 'funcionario_reintegro', { quien: 'Marcos Silva' }],
    ]) {
      await c.query(
        `insert into expenses (fecha, categoria, descripcion, monto, forma_pago, pagado_por_nombre,
           estado_reintegro, es_sueldo, salario_nominal, cargas_sociales, periodo, registrado_por, demo)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true)`,
        [fecha, cat, desc, monto, forma, extra?.quien || null,
         forma === 'funcionario_reintegro' ? 'pendiente' : null,
         !!extra?.nominal, extra?.nominal || null,
         extra?.nominal ? monto - extra.nominal : null,
         extra?.nominal ? hoy().slice(0, 7) : null, uid]);
      sumar('gastos');
    }

    /* ── Un cobro sobre la seña del segundo pedido ── */
    const p1 = pedidos[1];
    if (p1) {
      const rec = await c.query(`select id, monto_sena from receivables where production_card_id = $1`, [p1.id]);
      const sena = Number(rec.rows[0]?.monto_sena) || 0;
      if (sena > 0) {
        const pay = await c.query(
          `insert into job_payments (production_card_id, tipo, monto, metodo, fecha, registrado_por, receivable_id, demo)
           values ($1,'sena',$2,'Transferencia',$3,$4,$5,true) returning id`,
          [p1.id, sena, diasAtras(15), uid, rec.rows[0].id]);
        await c.query(
          `insert into cash_movements (tipo, categoria, monto, metodo, fecha, production_card_id, job_payment_id,
             descripcion, registrado_por, demo)
           values ('ingreso','venta',$1,'Transferencia',$2,$3,$4,$5,$6,true)`,
          [sena, diasAtras(15), p1.id, pay.rows[0].id, 'Seña ' + p1.cliente.nombre, uid]);
        await c.query(`update production_cards set estado_pago = 'SEÑA', contabilidad = 'Agregado' where id = $1`, [p1.id]);
        sumar('cobros');
      }
    }

    /* ── Activo, impacto social, comentarios, notificaciones ── */
    await c.query(
      `insert into assets (nombre, categoria, fecha_compra, costo, vida_util_meses, valor_residual, metodo, estado, demo)
       values ('Soldadora MIG 250A','Maquinaria',$1,68000,60,8000,'lineal','activo',true)`, [diasAtras(400)]);
    await c.query(
      `insert into assets (nombre, categoria, fecha_compra, costo, vida_util_meses, valor_residual, metodo, estado, demo)
       values ('Amoladora angular','Herramientas',$1,9500,36,0,'lineal','activo',true)`, [diasAtras(150)]);
    sumar('activos', 2);

    await c.query(
      `insert into social_impact (fecha, personas_historico, personas_actuales, notas, registrado_por, demo)
       values ($1,47,6,'Datos de prueba',$2,true) on conflict (fecha) do nothing`, [hoy(), uid]);
    sumar('impacto_social');

    for (const [card, quien, texto, hs] of [
      [p0.id, 'Comercial', 'El cliente pidió que los maceteros queden todos del mismo alto.', 30],
      [p0.id, 'Producción', 'Recibido. Ya cortamos las bases, arrancamos con la soldadura.', 20],
      [p0.id, 'Comercial', '¿Llegamos con la entrega para la fecha comprometida?', 4],
    ]) {
      await c.query(
        `insert into card_stories (card_id, user_id, user_label, type, notes, occurred_at, demo)
         values ($1,$2,$3,'comment',$4,$5,true)`, [card, uid, quien, texto, horasAtras(hs)]);
      sumar('comentarios');
    }
    if (uid) {
      await c.query(
        `insert into notifications (user_id, tipo, titulo, cuerpo, url, entity_type, entity_id, demo)
         values ($1,'comentario',$2,$3,$4,'production_card',$5,true)`,
        [uid, 'Comercial comentó en ' + p0.cliente.nombre, '¿Llegamos con la entrega para la fecha comprometida?',
         '/production.html?card=' + p0.id, p0.id]);
      sumar('notificaciones');
    }

    /* ── NPS: una encuesta respondida y una enviada sin responder ── */
    let n = 0;
    for (const p of pedidos) {
      const respondida = n === 0;
      await c.query(
        `insert into nps_surveys (client_id, cliente_nombre, production_card_id, sale_id, vendedor, vendedor_user_id,
           token, estado, enviada_at, respondida_at, recomendacion, impacto_social, aspectos, mejoras,
           como_conocio, comentarios, demo)
         values ($1,$2,$3,(select sale_id from production_cards where id = $3),'Comercial',$4,
                 $5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true)`,
        [p.cliente.id, p.cliente.nombre, p.id, uid, id('nps'),
         respondida ? 'respondida' : 'enviada', horasAtras(96), respondida ? horasAtras(70) : null,
         respondida ? 9 : null, respondida ? 10 : null,
         JSON.stringify(respondida ? ['Calidad del producto', 'Impacto social del proyecto', 'Atención y comunicación'] : []),
         respondida ? 'Los plazos se podrían avisar con más anticipación.' : null,
         respondida ? 'Recomendación de un conocido' : null,
         respondida ? 'Muy conformes con el trabajo.' : null]);
      sumar('encuestas_nps');
      n++;
    }

    await c.query('commit');
    return { ya: false, cuenta };
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally { c.release(); }
}

// Materiales que consumió un pedido, sacados de la cotización que le dio origen.
function cot0Materiales(pedido) {
  return (pedido.cot.materiales || []).map(m => ({
    material_id: m.material_id,
    cantidad: Number(m.cantidad) * Number(pedido.cot.cantidad || 1),
    costoUnit: Number(m.costoUnit),
  })).filter(m => m.material_id && m.cantidad > 0);
}
