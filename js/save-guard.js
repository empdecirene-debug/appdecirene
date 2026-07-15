// js/save-guard.js
//
// (#2) Guardia universal de navegación con flush de autosaves pendientes.
//
// Reemplaza el patrón inline de window._pendingPush/_tiersPendingPush que vive
// hoy en index.html y catalog.html. Esta versión es modular y atiende a varios
// "buckets" en paralelo (una página puede tener varios autosaves: el modal de
// tarjeta, el form de OC, el campo de stock, etc).
//
// Cómo se usa:
//   import { saveGuard } from './save-guard.js?v=3';
//
//   // Cuando una operación de save arranca:
//   saveGuard.markPending('production-card');
//
//   // Cuando termina OK:
//   saveGuard.markDone('production-card');
//
//   // Cuando falla:
//   saveGuard.markError('production-card', error);
//
//   // (Opcional, recomendado) Registrar un flush handler para que beforeunload
//   // pueda forzar la persistencia del último cambio:
//   saveGuard.registerFlush('production-card', async () => {
//     // cancela timers y ejecuta el save inmediato
//     await flushPendingCard();
//   });
//
// La página puede escuchar los eventos para actualizar pills:
//   window.addEventListener('cirene:save-pending', e => updatePill('saving', e.detail.key));
//   window.addEventListener('cirene:save-done',    e => updatePill('saved',   e.detail.key));
//   window.addEventListener('cirene:save-error',   e => updatePill('error',   e.detail.key));
//
// El módulo atacha el listener beforeunload una sola vez (idempotente).

const _pending = new Set();          // keys con save en vuelo
const _flushFns = new Map();         // key → async function

function _emit(name, detail) {
  try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch {}
}

export const saveGuard = {
  markPending(key) {
    _pending.add(key);
    _emit('cirene:save-pending', { key });
  },
  markDone(key) {
    _pending.delete(key);
    _emit('cirene:save-done', { key });
  },
  markError(key, err) {
    // No removemos de _pending: si falla, sigue habiendo un cambio sin guardar
    // (la guardia debe seguir avisando). El llamador decide cuándo limpiarlo
    // (típicamente: tras un retry exitoso → markDone).
    _emit('cirene:save-error', { key, error: err && (err.message || String(err)) });
  },
  registerFlush(key, fn) {
    if (typeof fn !== 'function') throw new Error('registerFlush expects a function');
    _flushFns.set(key, fn);
  },
  unregisterFlush(key) {
    _flushFns.delete(key);
  },
  hasAnyPending() {
    return _pending.size > 0;
  },
  pendingKeys() {
    return [..._pending];
  },
  // Dispara todos los flushes registrados. Devuelve una Promise — pero el
  // beforeunload no la espera (el navegador no permite operaciones async
  // bloqueantes). Lo importante es que las requests salen disparadas en el
  // momento, y si el usuario decide quedarse, completan en background.
  flushAll() {
    return Promise.all(
      [..._flushFns.entries()].map(async ([k, fn]) => {
        try { await fn(); }
        catch (e) { console.warn('[save-guard] flush', k, 'falló:', e?.message || e); }
      })
    );
  },
};

// beforeunload — bloquea con diálogo nativo si hay pendientes y dispara los
// flushes para que el push arranque mientras el usuario decide.
let _attached = false;
function _attach() {
  if (_attached) return;
  _attached = true;
  window.addEventListener('beforeunload', (e) => {
    if (!saveGuard.hasAnyPending()) return;
    // Disparar flushes (no esperar — beforeunload no permite await).
    saveGuard.flushAll();
    // El navegador muestra un diálogo nativo genérico. El mensaje custom se
    // ignora en navegadores modernos (Chrome, Firefox), pero setear returnValue
    // activa el prompt.
    e.preventDefault();
    e.returnValue = '';
  });
}
_attach();
