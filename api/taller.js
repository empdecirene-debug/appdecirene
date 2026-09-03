// TALLER · Interfaz de fichadas para operarios.
//
// El operario no usa el ERP: usa /taller.html, que tiene tres cosas en pantalla
// —¿qué trabajo?, ¿qué tarea?, INICIO / FIN— y nada más. Se identifica con un PIN
// de 4 dígitos (`operators.pin`), sin email ni contraseña.
//
// POR QUÉ ESTOS ENDPOINTS Y NO /api/q:
//   1. La credencial es otra (cookie de taller, ver api/session.js) y solo abre
//      esto: un PIN no puede leer cotizaciones, precios ni contabilidad.
//   2. Lo que devuelve está RECORTADO acá adentro: la pantalla del taller nunca
//      recibe montos ni datos del cliente más allá del nombre.
//   3. Cada inicio y cada fin tocan tres tablas encadenadas (bitácora, subtarea,
//      pedido). Van en UNA transacción, así no puede quedar un tramo abierto sin
//      su subtarea en curso.
//
// MODELO DE TIEMPO — la bitácora manda. `subtask_time_logs` es la verdad: cada
// tramo inicio→fin es una fila. `production_subtasks.segundos_trabajados` y
// `production_cards.horas_reales` se RECALCULAN a partir de ella, nunca se
// incrementan a mano. Así, si un tramo queda raro, arreglar la fila arregla todo.

import { pool, q } from './db.js';

// Los 7 procesos del taller. Si el pedido todavía no tiene subtareas, el operario
// elige un proceso de esta lista y la subtarea se crea sola en ese momento.
export const PROCESOS = ['Corte', 'Preparación', 'Soldadura', 'Pulido', 'Pintura', 'Armado', 'Colocación'];

const ETAPAS_CERRADAS = ['entregado', 'cancelado'];

export function normalizarPin(pin) {
  const limpio = String(pin ?? '').replace(/\D+/g, '');
  return limpio.length >= 4 && limpio.length <= 8 ? limpio : null;
}

// PIN → operario. Devuelve null si no coincide con ningún operario activo.
export async function operarioPorPin(pin) {
  const limpio = normalizarPin(pin);
  if (!limpio) return null;
  const { rows } = await q(
    `select id, nombre, funcion from operators where pin = $1 and activo order by nombre limit 1`,
    [limpio]);
  return rows[0] || null;
}

export async function operarioPorId(id) {
  const { rows } = await q(
    `select id, nombre, funcion from operators where id = $1 and activo`, [id]);
  return rows[0] || null;
}

// Resumen de qué se está fabricando, SIN precios: solo producto, cantidad y medidas.
function resumenLineas(lineas) {
  if (!Array.isArray(lineas)) return '';
  return lineas
    .map((l) => {
      const cant = Number(l?.cantidad) > 1 ? `${Number(l.cantidad)}× ` : '';
      return (cant + String(l?.producto || '').trim()).trim();
    })
    .filter(Boolean)
    .join(' · ');
}

/* ── Estado de la pantalla ───────────────────────────────────────────────────
   Todo lo que el operario necesita para decidir, en una sola llamada:
   quién es, si tiene un reloj corriendo, cuánto lleva hoy, y qué trabajos y
   tareas puede elegir. */
export async function estadoTaller(operatorId) {
  const operario = await operarioPorId(operatorId);
  if (!operario) return null;

  const [{ rows: cards }, { rows: tareas }, { rows: abiertos }, { rows: hoy }] = await Promise.all([
    q(`select c.id, c.client_name, c.product_lines, c.description, c.due_date, c.priority,
              c.stage_key, s.label as etapa
         from production_cards c
         left join kanban_stages s on s.key = c.stage_key
        where c.archived_at is null
          and coalesce(c.stage_key,'procesar') <> all($1::text[])
        order by (c.priority = 'urgente') desc, c.due_date nulls last, c.created_at`,
      [ETAPAS_CERRADAS]),
    q(`select t.id, t.card_id, t.nombre, t.estado, t.segundos_trabajados, t.operator_id, t.display_order
         from production_subtasks t
         join production_cards c on c.id = t.card_id
        where c.archived_at is null
          and coalesce(c.stage_key,'procesar') <> all($1::text[])
        order by t.display_order, t.nombre`,
      [ETAPAS_CERRADAS]),
    q(`select l.id, l.started_at, l.card_id, l.subtask_id, t.nombre as tarea, c.client_name
         from subtask_time_logs l
         join production_subtasks t on t.id = l.subtask_id
         left join production_cards c on c.id = l.card_id
        where l.operator_id = $1 and l.ended_at is null
        order by l.started_at desc limit 1`, [operatorId]),
    q(`select coalesce(sum(segundos),0)::int as segundos, count(*)::int as tramos
         from subtask_time_logs
        where operator_id = $1 and ended_at is not null
          and started_at >= date_trunc('day', now())`, [operatorId]),
  ]);

  const porCard = new Map();
  for (const t of tareas) {
    if (!porCard.has(t.card_id)) porCard.set(t.card_id, []);
    porCard.get(t.card_id).push({
      id: t.id, nombre: t.nombre, estado: t.estado,
      segundos: Number(t.segundos_trabajados) || 0,
      mio: t.operator_id === operatorId,
    });
  }

  return {
    operario,
    procesos: PROCESOS,
    abierto: abiertos[0]
      ? {
          log_id: abiertos[0].id, started_at: abiertos[0].started_at,
          card_id: abiertos[0].card_id, subtask_id: abiertos[0].subtask_id,
          tarea: abiertos[0].tarea, cliente: abiertos[0].client_name,
        }
      : null,
    hoy: { segundos: Number(hoy[0]?.segundos) || 0, tramos: Number(hoy[0]?.tramos) || 0 },
    tarjetas: cards.map((c) => ({
      id: c.id,
      cliente: c.client_name || 'Sin cliente',
      resumen: resumenLineas(c.product_lines) || (c.description || '').slice(0, 90),
      etapa: c.etapa || c.stage_key || '',
      entrega: c.due_date || null,
      urgente: c.priority === 'urgente',
      tareas: porCard.get(c.id) || [],
    })),
  };
}

// Cierra los tramos abiertos de un operario dentro de una transacción ya iniciada.
// Devuelve las subtareas tocadas, para recalcular sus acumulados.
async function cerrarAbiertos(c, operatorId, motivo) {
  const { rows } = await c.query(
    `update subtask_time_logs
        set ended_at = now(),
            segundos = greatest(0, extract(epoch from (now() - started_at))::int),
            motivo_fin = $2
      where operator_id = $1 and ended_at is null
      returning subtask_id, card_id, segundos`,
    [operatorId, motivo]);
  return rows;
}

// Recalcula el acumulado de una subtarea desde la bitácora y, con eso, las horas
// reales del pedido. `terminada` la cierra; si no, queda pausada y se puede
// reanudar mañana (es lo normal: el operario ficha FIN aunque el trabajo siga).
async function recalcular(c, subtaskId, { terminada = false } = {}) {
  const { rows: sumas } = await c.query(
    `select coalesce(sum(segundos),0)::int as cerrados,
            count(*) filter (where ended_at is null)::int as abiertos
       from subtask_time_logs where subtask_id = $1`, [subtaskId]);
  const cerrados = Number(sumas[0]?.cerrados) || 0;
  const abiertos = Number(sumas[0]?.abiertos) || 0;
  const estado = terminada ? 'terminada' : (abiertos ? 'en_curso' : 'pausada');

  const { rows: st } = await c.query(
    `update production_subtasks
        set segundos_trabajados = $2,
            estado = $3,
            last_started_at = case when $3 = 'en_curso' then last_started_at else null end,
            finished_at = case when $3 = 'terminada' then now() else null end
      where id = $1
      returning card_id`, [subtaskId, cerrados, estado]);

  const cardId = st[0]?.card_id;
  if (cardId) {
    await c.query(
      `update production_cards
          set horas_reales = round(coalesce((
                select sum(segundos_trabajados) from production_subtasks where card_id = $1
              ),0) / 3600.0, 2)
        where id = $1`, [cardId]);
  }
  return { cardId, segundos: cerrados, estado };
}

/* ── INICIO ──────────────────────────────────────────────────────────────────
   Un operario tiene UN reloj: si ya tenía algo corriendo, se cierra solo antes
   de abrir el nuevo (motivo 'cambio'). Así nunca acumula dos tareas a la vez,
   que es el error clásico de las fichadas y arruina las métricas. */
export async function iniciar(operatorId, { card_id, subtask_id, tarea } = {}) {
  const cardId = String(card_id || '').trim();
  if (!cardId) throw new Error('Elegí en qué trabajo estás.');

  const c = await pool.connect();
  try {
    await c.query('begin');

    const { rows: cardRows } = await c.query(
      `select id, stage_key, client_name from production_cards
        where id = $1 and archived_at is null for update`, [cardId]);
    const card = cardRows[0];
    if (!card) throw new Error('Ese trabajo ya no está en el tablero.');
    if (ETAPAS_CERRADAS.includes(card.stage_key)) throw new Error('Ese trabajo ya está cerrado.');

    // Resolver la subtarea: la elegida, la que ya existe con ese nombre, o una nueva.
    let subtask = null;
    if (subtask_id) {
      const { rows } = await c.query(
        `select * from production_subtasks where id = $1 and card_id = $2`, [subtask_id, cardId]);
      subtask = rows[0] || null;
      if (!subtask) throw new Error('Esa tarea no es de este trabajo.');
    } else {
      const nombre = String(tarea || '').trim();
      if (!nombre) throw new Error('Elegí qué tarea vas a hacer.');
      const { rows: ya } = await c.query(
        `select * from production_subtasks where card_id = $1 and lower(nombre) = lower($2) limit 1`,
        [cardId, nombre]);
      subtask = ya[0] || null;
      if (!subtask) {
        const { rows: ord } = await c.query(
          `select coalesce(max(display_order), 0) + 10 as siguiente
             from production_subtasks where card_id = $1`, [cardId]);
        const { rows: nueva } = await c.query(
          `insert into production_subtasks (card_id, nombre, display_order, operator_id, estado)
           values ($1,$2,$3,$4,'pendiente') returning *`,
          [cardId, nombre, ord[0].siguiente, operatorId]);
        subtask = nueva[0];
      }
    }

    // Cerrar lo que estaba corriendo y recalcular esas subtareas.
    const cerrados = await cerrarAbiertos(c, operatorId, 'cambio');
    for (const l of cerrados) if (l.subtask_id !== subtask.id) await recalcular(c, l.subtask_id);

    await c.query(
      `insert into subtask_time_logs (subtask_id, card_id, operator_id, started_at, fuente)
       values ($1,$2,$3, now(), 'taller')`, [subtask.id, cardId, operatorId]);

    await c.query(
      `update production_subtasks
          set estado = 'en_curso', last_started_at = now(),
              started_at = coalesce(started_at, now()), finished_at = null,
              operator_id = coalesce(operator_id, $2)
        where id = $1`, [subtask.id, operatorId]);

    // Se recalcula igual: si el tramo cerrado era de esta misma subtarea, su
    // acumulado tiene que subir antes de devolver el estado nuevo.
    await c.query(
      `update production_subtasks t
          set segundos_trabajados = coalesce((
                select sum(segundos) from subtask_time_logs where subtask_id = t.id and ended_at is not null
              ),0)
        where t.id = $1`, [subtask.id]);

    await c.query('commit');
    return { ok: true, subtask_id: subtask.id, card_id: cardId, tarea: subtask.nombre };
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally { c.release(); }
}

/* ── FIN ─────────────────────────────────────────────────────────────────────
   Para el reloj. La tarea NO se cierra: queda pausada y mañana se reanuda. El
   operario solo marca "terminé" cuando de verdad terminó, y eso es opcional:
   la métrica sale igual de los tramos. */
export async function terminar(operatorId, { terminada = false, nota } = {}) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    if (nota) {
      await c.query(
        `update subtask_time_logs set nota = $2 where operator_id = $1 and ended_at is null`,
        [operatorId, String(nota).slice(0, 400)]);
    }
    const cerrados = await cerrarAbiertos(c, operatorId, terminada ? 'fin' : 'pausa');
    if (!cerrados.length) { await c.query('rollback'); return { ok: true, sinTramo: true, segundos: 0 }; }

    let segundos = 0;
    const vistas = new Set();
    for (const l of cerrados) {
      segundos += Number(l.segundos) || 0;
      if (!vistas.has(l.subtask_id)) {
        vistas.add(l.subtask_id);
        await recalcular(c, l.subtask_id, { terminada: !!terminada });
      }
    }
    await c.query('commit');
    return { ok: true, segundos, terminada: !!terminada };
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally { c.release(); }
}
