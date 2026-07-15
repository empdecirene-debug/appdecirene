// Top navbar compartida entre las páginas de la app (intake, production, admin, etc.).
// Llamar `renderNavbar('intake')` desde cada página al iniciar.

import { getCurrentUser, getProfile, signOut } from './auth.js?v=3';

const PAGES = [
  { id: 'home',             href: '/home.html',              label: 'Inicio',     roles: 'all' },
  { id: 'intake',           href: '/intake.html',            label: 'CRM',        roles: 'all' },
  { id: 'clientes',         href: '/clientes.html',          label: 'Clientes',   roles: 'all' },
  { id: 'cot',              href: '/index.html',             label: 'Cotizar',    roles: 'all' },
  { id: 'production',       href: '/production.html',        label: 'Producción', roles: 'all' },
  { id: 'catalog',          href: '/catalog.html',           label: 'Catálogo',   roles: 'all' },
  { id: 'ventas',           href: '/ventas.html',            label: 'Ventas',     roles: 'all' },
  { id: 'contabilidad',     href: '/contabilidad.html',      label: 'Contabilidad', roles: 'admin' },
  { id: 'admin',            href: '/admin.html',             label: 'Admin',      roles: 'admin' },
];

// Lockup de marca: isotipo (mano+brote, blanco) + wordmark. El isotipo queda
// siempre visible; el wordmark se oculta en mobile.
const LOGO_DESKTOP = `<img class="gn-mark" src="/assets/logo-mark.png" alt="De Cirene"><span class="gn-logo gn-logo-desktop">De&nbsp;C&#x0268;rene</span>`;
const LOGO_MOBILE  = ``;

const STYLE = `
.cirene-nav { position: sticky; top: 0; z-index: 90; background: #0A0A0A;
  padding: 10px 18px; display: flex; gap: 12px; align-items: center; box-shadow: 0 2px 12px rgba(0, 0, 0,.22);
  font-family: 'Public Sans', system-ui, sans-serif; }
.cirene-nav .gn-brand { color: #fff; margin-right: 14px; display: inline-flex; align-items: center; gap: 9px; text-decoration: none; }
.cirene-nav .gn-mark { height: 28px; width: 28px; display: block; }
.cirene-nav .gn-logo { display: block; color: #fff; font-family: 'Raleway','Public Sans',system-ui,sans-serif;
  font-weight: 700; font-size: 17px; letter-spacing: .14em; text-transform: uppercase; line-height: 28px; }
.cirene-nav .gn-tabs { display: flex; gap: 4px; background: rgba(255,255,255,.14); padding: 3px; border-radius: 10px; }
.cirene-nav .gn-tab { padding: 6px 14px; border-radius: 7px; color: #fff; font-weight: 600; font-size: 13px;
  text-decoration: none; transition: all .15s; }
.cirene-nav .gn-tab.active { background: #fff; color: #0A0A0A; }
.cirene-nav .gn-tab:not(.active):hover { background: rgba(255,255,255,.12); }
.cirene-nav .gn-spacer { flex: 1; }
.cirene-nav .gn-user { display: flex; align-items: center; gap: 10px; color: #fff; font-size: 12px; }
.cirene-nav .gn-user .gn-dot { width: 8px; height: 8px; border-radius: 50%; background: #888888; }
.cirene-nav .gn-out { background: rgba(255,255,255,.18); color: #fff; border: none; padding: 5px 10px;
  border-radius: 6px; font-size: 11px; font-weight: 600; cursor: pointer; }
.cirene-nav .gn-out:hover { background: rgba(255,255,255,.28); }
@media (max-width: 640px) {
  .cirene-nav { padding: 8px 10px; gap: 6px; flex-wrap: wrap; }
  .cirene-nav .gn-tab { padding: 5px 9px; font-size: 11px; }
  .cirene-nav .gn-user { font-size: 11px; }
  .cirene-nav .gn-user .gn-name { display: none; }
  .cirene-nav .gn-logo-desktop { display: none; }
  .cirene-nav .gn-logo-mobile  { display: block; height: 26px; }
}
`;

function injectStyle() {
  if (document.getElementById('cirene-nav-style')) return;
  const s = document.createElement('style');
  s.id = 'cirene-nav-style';
  s.textContent = STYLE;
  document.head.appendChild(s);
}

// Token monotónico: si dos renderNavbar arrancan en paralelo (típico cuando `render()`
// se ejecuta varias veces seguidas en una página SPA), abortamos el viejo apenas
// detectamos que se inició uno nuevo. Evita que se aculen 2 navbars uno sobre otro.
let _navToken = 0;

export async function renderNavbar(activeId) {
  const myToken = ++_navToken;
  injectStyle();

  const user = await getCurrentUser().catch(() => null);
  if (myToken !== _navToken) return;
  const profile = user ? await getProfile().catch(() => null) : null;
  if (myToken !== _navToken) return;
  const admin = profile ? ['admin','director','ceo'].includes(profile.role) : false;

  const visiblePages = PAGES.filter(p => p.roles === 'all' || (p.roles === 'admin' && admin));

  const html = `
    <nav class="cirene-nav">
      <a class="gn-brand" href="/" title="De Cirene">${LOGO_DESKTOP}${LOGO_MOBILE}</a>
      <div class="gn-tabs">
        ${visiblePages.map(p => `<a class="gn-tab ${p.id === activeId ? 'active' : ''}" href="${p.href}">${p.label}</a>`).join('')}
      </div>
      <div class="gn-spacer"></div>
      <div class="gn-user">
        ${user ? `
          <span class="gn-dot"></span>
          <span class="gn-name">${profile?.full_name || user.email}</span>
          <button class="gn-out" id="gn-out-btn">Salir</button>
        ` : `
          <a href="/login.html" style="color:#fff;text-decoration:none;font-weight:600;">Iniciar sesión</a>
        `}
      </div>
    </nav>
  `;

  // Limpieza defensiva: si por carrera previa quedaron 2+ navbars en el DOM, los matamos a todos.
  document.querySelectorAll('.cirene-nav').forEach(e => e.remove());

  const mount = document.getElementById('navbar-mount');
  if (mount) {
    mount.innerHTML = html;
  } else {
    const wrap = document.createElement('div');
    wrap.innerHTML = html.trim();
    document.body.insertBefore(wrap.firstElementChild, document.body.firstChild);
  }

  const out = document.getElementById('gn-out-btn');
  if (out) out.onclick = async () => {
    await signOut();
    location.href = '/login.html';
  };
}
