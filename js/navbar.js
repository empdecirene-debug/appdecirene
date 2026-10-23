// Top navbar compartida entre las páginas de la app (intake, production, admin, etc.).
// Llamar `renderNavbar('intake')` desde cada página al iniciar.

import { getCurrentUser, getProfile, signOut } from './auth.js?v=9';
import { modulosDelRol, MODULOS, AREAS } from './cirene-data.js?v=9';
import { mountSugerencias } from './sugerencias.js?v=9';

// Qué página corresponde a cada módulo. QUIÉN ve cada módulo ya no se decide acá:
// lo declara el rol (tabla `app_roles`, pantalla Administración → Roles). El
// `roles` que quedaba en cada fila era una regla escondida en el código que el
// administrador no podía cambiar sin un deploy.
//
// El menú se agrupa por área (Comercial / Producción / Dirección): cada área es un
// botón que despliega sus páginas. El área y el orden salen de MODULOS en
// cirene-data.js, el mismo lugar que usan Inicio y la pantalla de Roles, así las
// tres muestran la misma organización. Inicio y Manual van sueltos.
const PAGES = [
  { id: 'home',         href: '/home.html',         label: 'Inicio' },
  { id: 'intake',       href: '/intake.html',       label: 'CRM' },
  { id: 'clientes',     href: '/clientes.html',     label: 'Clientes' },
  { id: 'cot',          href: '/index.html',        label: 'Cotizar' },
  { id: 'ventas',       href: '/ventas.html',       label: 'Ventas' },
  { id: 'nps',          href: '/nps.html',          label: 'NPS' },
  { id: 'production',   href: '/production.html',   label: 'Tablero de producción' },
  { id: 'metricas',     href: '/metricas.html',     label: 'Métricas' },
  { id: 'catalog',      href: '/catalog.html',      label: 'Catálogo' },
  { id: 'stock',        href: '/stock.html',        label: 'Stock' },
  { id: 'dashboard',    href: '/dashboard.html',    label: 'Dashboard' },
  { id: 'contabilidad', href: '/contabilidad.html', label: 'Contabilidad' },
  { id: 'compras',      href: '/compras.html',      label: 'Compras' },
  { id: 'admin',        href: '/admin.html',        label: 'Administración' },
  { id: 'manual',       href: '/manual.html',       label: 'Manual' },
];
const MOD = Object.fromEntries(MODULOS.map(m => [m.id, m]));

const CARET = `<svg class="gn-caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

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
/* Áreas desplegables */
.cirene-nav .gn-group { position: relative; }
.cirene-nav button.gn-tab { border: none; background: none; font-family: inherit; cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px; }
.cirene-nav .gn-cur { font-weight: 500; opacity: .7; }
.cirene-nav .gn-caret { transition: transform .15s; flex: 0 0 auto; }
.cirene-nav .gn-group.open .gn-caret { transform: rotate(180deg); }
.cirene-nav .gn-group.open > .gn-tab:not(.active) { background: rgba(255,255,255,.12); }
.cirene-nav .gn-menu { display: none; position: absolute; top: calc(100% + 8px); left: 0; z-index: 100;
  min-width: min(270px, calc(100vw - 20px)); background: #fff; border-radius: 12px; padding: 6px;
  box-shadow: 0 12px 36px rgba(0,0,0,.28); }
/* Puente invisible sobre el hueco: si no, al bajar el mouse del botón al menú se cierra. */
.cirene-nav .gn-menu::before { content: ''; position: absolute; left: 0; right: 0; top: -10px; height: 10px; }
.cirene-nav .gn-group.open .gn-menu { display: block; }
.cirene-nav .gn-item { display: block; padding: 8px 11px; border-radius: 8px; color: #14161A; text-decoration: none; }
.cirene-nav .gn-item b { display: block; font-size: 13px; font-weight: 600; }
.cirene-nav .gn-item span { display: block; font-size: 11.5px; color: #5A5F66; margin-top: 1px; }
.cirene-nav .gn-item:hover, .cirene-nav .gn-item:focus-visible { background: #F2F2F0; outline: none; }
.cirene-nav .gn-item.active { background: #0A0A0A; color: #fff; }
.cirene-nav .gn-item.active span { color: rgba(255,255,255,.7); }
.cirene-nav .gn-spacer { flex: 1; }
.cirene-nav .gn-user { display: flex; align-items: center; gap: 10px; color: #fff; font-size: 12px; }
.cirene-nav .gn-user .gn-dot { width: 8px; height: 8px; border-radius: 50%; background: #888888; }
.cirene-nav .gn-out { background: rgba(255,255,255,.18); color: #fff; border: none; padding: 5px 10px;
  border-radius: 6px; font-size: 11px; font-weight: 600; cursor: pointer; }
.cirene-nav .gn-out:hover { background: rgba(255,255,255,.28); }
@media (max-width: 640px) {
  /* Celular: arriba el logo y Salir; abajo, a todo el ancho, Inicio y las áreas.
     Manual no entra en la fila: está en Inicio, en la sección Ayuda. */
  .cirene-nav { padding: 8px 10px; gap: 8px; flex-wrap: wrap; }
  .cirene-nav .gn-brand { order: 1; margin-right: 0; }
  .cirene-nav .gn-spacer { order: 2; }
  .cirene-nav .gn-user { order: 3; }
  .cirene-nav .gn-tabs { order: 4; width: 100%; flex-wrap: nowrap; justify-content: space-between; gap: 2px; }
  .cirene-nav .gn-tab { padding: 7px 8px; font-size: 12px; }
  .cirene-nav button.gn-tab { gap: 4px; }
  .cirene-nav .gn-tabs > a.gn-tab[href="/manual.html"] { display: none; }
  .cirene-nav .gn-cur { display: none; }
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

/* ── Desplegables de área ──
   Con mouse se abren al pasar por encima; con el dedo (o el teclado), tocando el
   botón. Un toque afuera o Escape los cierra. Los escuchas del documento se
   ponen una sola vez: renderNavbar puede correr varias veces en la misma página. */
const PUEDE_HOVER = typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches;
let _escuchasDoc = false;

function cerrarGrupo(g) {
  g.classList.remove('open');
  g.querySelector('button')?.setAttribute('aria-expanded', 'false');
}

function cerrarGrupos(excepto) {
  document.querySelectorAll('.cirene-nav .gn-group.open').forEach(g => { if (g !== excepto) cerrarGrupo(g); });
}

function abrirGrupo(g) {
  cerrarGrupos(g);
  g.classList.add('open');
  g.querySelector('button')?.setAttribute('aria-expanded', 'true');
  const menu = g.querySelector('.gn-menu');
  menu.removeAttribute('style');
  // Celular: el menú va de borde a borde, fijo debajo del botón. Si quedara colgado
  // del botón, el de la derecha se sale de la pantalla y el navegador del celular,
  // en vez de cortarlo, achica toda la página para que entre.
  if (matchMedia('(max-width: 640px)').matches) {
    const abajo = g.querySelector('button').getBoundingClientRect().bottom;
    Object.assign(menu.style, { position: 'fixed', left: '10px', right: '10px', top: `${Math.round(abajo + 8)}px`, minWidth: '0' });
    return;
  }
  // Computadora con ventana angosta: se corre a la izquierda lo que sobre.
  const sobra = menu.getBoundingClientRect().right - (document.documentElement.clientWidth - 10);
  if (sobra > 0) menu.style.left = `-${Math.ceil(sobra)}px`;
}

function activarDesplegables() {
  document.querySelectorAll('.cirene-nav .gn-group').forEach(g => {
    const btn = g.querySelector('button');
    let porHover = false, timer = null;
    btn.onclick = () => {
      // Si se abrió al pasar el mouse, el clic lo deja abierto en vez de cerrarlo.
      if (g.classList.contains('open') && !porHover) cerrarGrupo(g);
      else { abrirGrupo(g); porHover = false; }
    };
    if (PUEDE_HOVER) {
      g.onmouseenter = () => { clearTimeout(timer); if (!g.classList.contains('open')) { abrirGrupo(g); porHover = true; } };
      // Cierra SOLO este: al pasar de un área a la de al lado, la nueva ya se abrió
      // y no tiene que cerrarla el temporizador de la anterior.
      g.onmouseleave = () => { timer = setTimeout(() => { if (porHover) cerrarGrupo(g); }, 220); };
    }
  });
  if (_escuchasDoc) return;
  _escuchasDoc = true;
  document.addEventListener('click', (e) => { if (!e.target.closest('.cirene-nav .gn-group')) cerrarGrupos(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const abierto = document.querySelector('.cirene-nav .gn-group.open');
    if (!abierto) return;
    cerrarGrupos();
    abierto.querySelector('button')?.focus();
  });
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
  const sueltas = visiblePages.filter(p => !MOD[p.id]?.area);
  const grupos = AREAS
    .map(a => ({ ...a, pages: visiblePages.filter(p => MOD[p.id]?.area === a.id) }))
    .filter(g => g.pages.length);

  const tab = p => `<a class="gn-tab ${p.id === activeId ? 'active' : ''}" href="${p.href}">${p.label}</a>`;
  // Un área con una sola página (p. ej. un rol que solo ve Producción) va como
  // pestaña común: un desplegable de un solo renglón es un clic de más.
  const grupo = g => {
    if (g.pages.length === 1) return tab(g.pages[0]);
    const actual = g.pages.find(p => p.id === activeId);
    return `
      <div class="gn-group" data-grupo="${g.id}">
        <button type="button" class="gn-tab ${actual ? 'active' : ''}" aria-haspopup="true" aria-expanded="false">
          ${g.label}${actual ? `<span class="gn-cur">· ${actual.label}</span>` : ''}${CARET}
        </button>
        <div class="gn-menu">
          ${g.pages.map(p => `<a class="gn-item ${p.id === activeId ? 'active' : ''}" href="${p.href}">
            <b>${p.label}</b><span>${MOD[p.id]?.desc || ''}</span></a>`).join('')}
        </div>
      </div>`;
  };

  const html = `
    <nav class="cirene-nav">
      <a class="gn-brand" href="/" title="De Cirene">${LOGO_DESKTOP}${LOGO_MOBILE}</a>
      <div class="gn-tabs">
        ${sueltas.filter(p => p.id === 'home').map(tab).join('')}
        ${grupos.map(grupo).join('')}
        ${sueltas.filter(p => p.id !== 'home').map(tab).join('')}
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

  activarDesplegables();

  const out = document.getElementById('gn-out-btn');
  if (out) out.onclick = async () => {
    await signOut();
    location.href = '/login.html';
  };

  // El botón de sugerencias se monta acá y no en cada página: así aparece en
  // todas sin repetir el mismo import trece veces (y no se olvida en la nueva).
  if (user) { try { mountSugerencias(); } catch (e) { console.warn('[sugerencias]', e.message); } }
}
