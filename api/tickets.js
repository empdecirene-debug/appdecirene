// Sugerencias → tickets de customERP.
//
// Cada sugerencia que alguien manda con el botón 💡 se reenvía como ticket al
// ERP interno de customERP (intern.customerp.dev), que es quien mantiene esta
// app. Así el equipo de customERP la ve en su tablero de tickets sin que nadie
// la copie a mano.
//
// La tabla `suggestions` es la cola (columnas ticket_*, ver db/schema.sql):
//   · una sugerencia nueva nace 'pendiente';
//   · `enviarPendientes` la manda y la marca 'enviada' con el id del ticket;
//   · si customERP no contesta o contesta mal, queda 'error' con el motivo y se
//     reintenta sola, cada vez más espaciado (1, 2, 4… minutos, tope 6 horas).
// Nunca bloquea al usuario: guardar la sugerencia no espera al envío.
//
// Configuración (variables de Railway):
//   CUSTOMERP_TICKETS_TOKEN  la clave que da customERP para esta app. Sin ella
//                            no se envía nada (las sugerencias esperan).
//   CUSTOMERP_TICKETS_URL    opcional; por defecto la entrada de tickets de intern.
//
// Del lado de customERP: POST /api/tickets/entrante con Authorization: Bearer
// <token>. El `origen` del ticket lo pone customERP según la clave, no esta app.
// `ref` (el id de la sugerencia) hace que un reintento no duplique el ticket.

import { q } from './db.js';

const URL_TICKETS = process.env.CUSTOMERP_TICKETS_URL || 'https://intern.customerp.dev/api/tickets/entrante';
const TOKEN = process.env.CUSTOMERP_TICKETS_TOKEN || '';
const MAX_INTENTOS = 30;
const CATEGORIA = { mejora: 'Idea', error: 'Error', duda: 'Duda', otro: 'Otro' };

export const ticketsActivos = () => !!TOKEN;

// Dirección pública de esta app, para que los adjuntos se puedan abrir desde customERP.
function urlPublica() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN;
  return '';
}

export function armarTicket(s) {
  const primera = String(s.texto || '').trim().split('\n')[0].trim();
  const titulo = `[${CATEGORIA[s.categoria] || 'Sugerencia'}] ${primera}`.slice(0, 160);
  const base = urlPublica();
  const adjuntos = (Array.isArray(s.adjuntos) ? s.adjuntos : [])
    .map(a => a?.url ? (a.url.startsWith('http') ? a.url : base + a.url) : null).filter(Boolean);
  const detalle = [
    String(s.texto || '').trim(),
    adjuntos.length ? 'Adjuntos:\n' + adjuntos.join('\n') : '',
    `— ${s.user_label || 'Alguien'} · De Cirene${s.pagina ? ' · pantalla ' + s.pagina : ''}`,
  ].filter(Boolean).join('\n\n').slice(0, 4000);
  return { titulo, detalle, autor: String(s.user_label || '').slice(0, 120), pagina: String(s.pagina || '').slice(0, 255), ref: s.id };
}

let enCurso = false;

export async function enviarPendientes({ forzar = false } = {}) {
  if (!TOKEN || enCurso) return { enviadas: 0, errores: 0, activo: !!TOKEN };
  enCurso = true;
  let enviadas = 0, errores = 0;
  try {
    // Espera exponencial por sugerencia: 1, 2, 4… minutos, con tope de 6 horas.
    const { rows } = await q(
      `select * from suggestions
        where ticket_estado <> 'enviada' and ticket_intentos < $1
          and ($2 or ticket_ultimo_intento is null
               or ticket_ultimo_intento < now() - least(power(2, ticket_intentos), 360) * interval '1 minute')
        order by created_at limit 20`, [MAX_INTENTOS, forzar]);
    for (const s of rows) {
      let estado = 'error', id = null, motivo = null;
      try {
        const r = await fetch(URL_TICKETS, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
          body: JSON.stringify(armarTicket(s)),
          signal: AbortSignal.timeout(15000),
        });
        const j = await r.json().catch(() => null);
        if (r.ok) { estado = 'enviada'; id = j?.data?.id != null ? String(j.data.id) : null; }
        else motivo = `customERP contestó ${r.status}${j?.error ? ': ' + j.error : ''}`;
      } catch (e) {
        motivo = 'No se pudo conectar con customERP: ' + (e.name === 'TimeoutError' ? 'no contestó a tiempo' : e.message);
      }
      await q(
        `update suggestions set ticket_estado = $1, ticket_id = coalesce($2, ticket_id), ticket_error = $3,
           ticket_intentos = ticket_intentos + 1, ticket_ultimo_intento = now(),
           ticket_enviado_at = case when $1 = 'enviada' then now() else ticket_enviado_at end
         where id = $4`, [estado, id, motivo, s.id]);
      if (estado === 'enviada') enviadas++; else { errores++; console.warn('[tickets]', s.id, motivo); }
    }
  } catch (e) {
    console.error('[tickets] no pude revisar la cola:', e.message);
  } finally { enCurso = false; }
  return { enviadas, errores, activo: true };
}

// Revisa la cola cada minuto. La llama server.js después de migrar.
export function arrancarEnvio() {
  if (!TOKEN) { console.log('[tickets] sin CUSTOMERP_TICKETS_TOKEN: las sugerencias esperan en cola.'); return; }
  console.log('[tickets] reenviando sugerencias a', URL_TICKETS);
  enviarPendientes();
  setInterval(() => enviarPendientes(), 60_000).unref();
}
