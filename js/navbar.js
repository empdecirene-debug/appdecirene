// Top navbar compartida entre las páginas de la app (intake, production, admin, etc.).
// Llamar `renderNavbar('intake')` desde cada página al iniciar.

import { getCurrentUser, getProfile, signOut } from './auth.js?v=8';
import { modulosDelRol } from './cirene-data.js?v=8';
import { mountSugerencias } from './sugerencias.js?v=8';

// Qué tab corresponde a cada módulo. QUIÉN ve cada módulo ya no se decide acá:
// lo declara el rol (tabla `app_roles`, pantalla Administración → Roles). El
// `roles` que quedaba en cada fila era una regla escondida en el código que el
// administrador no podía cambiar sin un deploy.
const PAGES = [
  { id: 'home',         href: '/home.html',         label: 'Inicio' },
  { id: 'intake',       href: '/intake.html',       label: 'CRM' },
  { id: 'clientes',     href: '/clientes.html',     label: 'Clientes' },
  { id: 'cot',          href: '/index.html',        label: 'Cotizar' },
  { id: 'production',   href: '/production.html',   label: 'Producción' },
  { id: 'metricas',     href: '/metricas.html',     label: 'Métricas' },
  { id: 'catalog',      href: '/catalog.html',      label: 'Catálogo' },
  { id: 'compras',      href: '/compras.html',      label: 'Compras' },
  { id: 'stock',        href: '/stock.html',        label: 'Stock' },
  { id: 'ventas',       href: '/ventas.html',       label: 'Ventas' },
  { id: 'nps',          href: '/nps.html',          label: 'NPS' },
  { id: 'contabilidad', href: '/contabilidad.html', label: 'Contabilidad' },
  { id: 'dashboard',    href: '/dashboard.html',    label: 'Dashboard' },
  { id: 'admin',        href: '/admin.html',        label: 'Admin' },
  { id: 'manual',       href: '/manual.html',       label: 'Manual' },
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
.cirene-nav .gn-tabs { display: flex; flex-wrap: wrap; gap: 4px; background: rgba(255,255,255,.14); padding: 3px; border-radius: 10px; }
.cirene-nav .gn-tab { padding: 6px 11px; border-radius: 7px; color: #fff; font-weight: 600; font-size: 12.5px;
  white-space: nowrap; text-decoration: none; transition: all .15s; }
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

  // Los módulos salen del rol. Si la consulta falla (red, esquema viejo),
  // `modulosDelRol` ya devuelve un mínimo seguro en vez de tirar.
  const modulos = profile ? await modulosDelRol(profile.role).catch(() => ['home']) : [];
  if (myToken !== _navToken) return;

  const visiblePages = PAGES.filter(p => modulos.includes(p.id));

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

  // El botón de sugerencias se monta acá y no en cada página: así aparece en
  // todas sin repetir el mismo import trece veces (y no se olvida en la nueva).
  if (user) { try { mountSugerencias(); } catch (e) { console.warn('[sugerencias]', e.message); } }
}
