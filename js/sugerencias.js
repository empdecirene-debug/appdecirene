// Botón de SUGERENCIAS: fijo abajo a la derecha, en toda la app.
//
// Lo monta `renderNavbar` (js/navbar.js), así que aparece solo en cada página sin
// tener que tocar los 13 HTML. El login y la pantalla del taller no llaman a la
// navbar, así que ahí no aparece — y está bien: el operario tiene su propio canal.
//
// Se pueden adjuntar fotos: en un taller, "el botón no anda" se explica mucho
// mejor con una captura o una foto de la pantalla que con un texto.

import * as data from './cirene-data.js?v=7';

const ESTILO = `
.cirene-sug-btn { position: fixed; right: 18px; bottom: 18px; z-index: 120;
  display: inline-flex; align-items: center; gap: 8px; padding: 11px 16px;
  border: none; border-radius: 999px; background: #0A0A0A; color: #fff;
  font-family: 'Public Sans', system-ui, sans-serif; font-size: 13px; font-weight: 700;
  cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.28); }
.cirene-sug-btn:hover { background: #262626; }
.cirene-sug-btn .ico { font-size: 15px; line-height: 1; }
@media (max-width: 640px) {
  .cirene-sug-btn { right: 12px; bottom: 12px; padding: 11px 13px; }
  .cirene-sug-btn .txt { display: none; }
}
.cirene-sug-ov { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 130;
  display: none; align-items: flex-start; justify-content: center; padding: 30px 16px; overflow: auto; }
.cirene-sug-ov.show { display: flex; }
.cirene-sug-modal { background: #fff; border-radius: 16px; width: 100%; max-width: 520px;
  padding: 22px 24px; font-family: 'Public Sans', system-ui, sans-serif; color: #14161A; }
.cirene-sug-modal h2 { font-family: 'Raleway','Public Sans',sans-serif; font-size: 18px; margin: 0 0 4px; }
.cirene-sug-modal .sub { font-size: 12.5px; color: #5A5F66; margin-bottom: 16px; line-height: 1.5; }
.cirene-sug-modal label { display: block; font-size: 11px; font-weight: 700; text-transform: uppercase;
  letter-spacing: .04em; color: #5A5F66; margin: 12px 0 5px; }
.cirene-sug-modal select, .cirene-sug-modal textarea { width: 100%; padding: 10px 12px;
  border: 1px solid #E2E2E0; border-radius: 8px; font: inherit; font-size: 14px; color: #14161A; background: #fff; }
.cirene-sug-modal textarea { min-height: 110px; resize: vertical; line-height: 1.5; }
.cirene-sug-modal select:focus, .cirene-sug-modal textarea:focus { outline: none; border-color: #0A0A0A;
  box-shadow: 0 0 0 3px rgba(0,0,0,.1); }
.cirene-sug-fotos { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.cirene-sug-fotos .f { position: relative; }
.cirene-sug-fotos img { width: 62px; height: 62px; object-fit: cover; border-radius: 8px;
  border: 1px solid #E2E2E0; display: block; }
.cirene-sug-fotos .arch { display: inline-flex; align-items: center; padding: 8px 10px; font-size: 12px;
  border: 1px solid #E2E2E0; border-radius: 8px; background: #FAFAFA; }
.cirene-sug-fotos .x { position: absolute; top: -7px; right: -7px; width: 20px; height: 20px; padding: 0;
  border: none; border-radius: 50%; background: #A33A3A; color: #fff; font-size: 13px; line-height: 18px; cursor: pointer; }
.cirene-sug-acts { display: flex; gap: 8px; align-items: center; margin-top: 18px; flex-wrap: wrap; }
.cirene-sug-acts button { padding: 9px 15px; border-radius: 8px; border: 1px solid #CFCFCC;
  background: #fff; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
.cirene-sug-acts button.primary { background: #0A0A0A; color: #fff; border-color: #0A0A0A; }
.cirene-sug-acts button:disabled { opacity: .5; cursor: default; }
.cirene-sug-msg { font-size: 12.5px; margin-top: 10px; line-height: 1.5; }
.cirene-sug-msg.ok { color: #085041; } .cirene-sug-msg.err { color: #791F1F; }
`;

let montado = false;

// El nombre de la pantalla desde donde se escribió. Es la mitad del valor de una
// sugerencia: sin saber dónde estaba la persona, "no me deja guardar" no se puede
// reproducir.
function paginaActual() {
  const f = (location.pathname.split('/').pop() || 'index.html').replace('.html', '');
  const nombres = {
    index: 'Cotizador', home: 'Inicio', intake: 'CRM', clientes: 'Clientes',
    production: 'Producción', metricas: 'Métricas', catalog: 'Catálogo',
    compras: 'Compras', stock: 'Stock', ventas: 'Ventas', nps: 'NPS',
    contabilidad: 'Contabilidad', dashboard: 'Dashboard', admin: 'Administración',
    manual: 'Manual', diagrama: 'Diagrama', taller: 'Taller',
  };
  return nombres[f] || f || 'Inicio';
}

const esc = (s) => (s ?? '').toString().replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function mountSugerencias() {
  if (montado || document.getElementById('cirene-sug-btn')) return;
  montado = true;

  const style = document.createElement('style');
  style.id = 'cirene-sug-style';
  style.textContent = ESTILO;
  document.head.appendChild(style);

  const btn = document.createElement('button');
  btn.id = 'cirene-sug-btn';
  btn.className = 'cirene-sug-btn';
  btn.type = 'button';
  btn.title = 'Enviar una sugerencia';
  btn.innerHTML = '<span class="ico">💡</span><span class="txt">Sugerencias</span>';

  const ov = document.createElement('div');
  ov.className = 'cirene-sug-ov';
  ov.id = 'cirene-sug-ov';
  ov.innerHTML = `<div class="cirene-sug-modal">
    <h2>Contanos qué mejorarías</h2>
    <div class="sub">Lo que escribas acá lo lee la administración. Podés adjuntar fotos o capturas
      de pantalla si eso lo explica mejor. Estás en <b>${esc(paginaActual())}</b>.</div>
    <label for="cirene-sug-cat">¿De qué se trata?</label>
    <select id="cirene-sug-cat">
      ${data.CATEGORIAS_SUGERENCIA.map((c) => `<option value="${c.key}">${esc(c.label)}</option>`).join('')}
    </select>
    <label for="cirene-sug-txt">Tu sugerencia</label>
    <textarea id="cirene-sug-txt" placeholder="Escribí con tus palabras. No hace falta que sea formal."></textarea>
    <label>Fotos o capturas (opcional)</label>
    <div class="cirene-sug-fotos" id="cirene-sug-fotos"></div>
    <input type="file" id="cirene-sug-file" accept="image/*,.pdf" multiple style="display:none">
    <div class="cirene-sug-acts">
      <button type="button" id="cirene-sug-add">📎 Adjuntar</button>
      <button type="button" class="primary" id="cirene-sug-send">Enviar</button>
      <button type="button" id="cirene-sug-close" style="margin-left:auto">Cerrar</button>
    </div>
    <div class="cirene-sug-msg" id="cirene-sug-msg"></div>
  </div>`;

  document.body.appendChild(btn);
  document.body.appendChild(ov);

  const $ = (id) => document.getElementById(id);
  let adjuntos = [];

  const pintarFotos = () => {
    $('cirene-sug-fotos').innerHTML = adjuntos.length
      ? adjuntos.map((f, i) => {
          const img = (f.type || '').startsWith('image/');
          const cuerpo = img
            ? `<img src="${esc(f.url)}" alt="">`
            : `<span class="arch">📄 ${esc((f.name || 'archivo').slice(0, 14))}</span>`;
          return `<div class="f">${cuerpo}<button class="x" data-i="${i}" title="Quitar">×</button></div>`;
        }).join('')
      : '<span style="font-size:12px;color:#9AA0A6">Sin fotos adjuntas.</span>';
    $('cirene-sug-fotos').querySelectorAll('[data-i]').forEach((b) => {
      b.onclick = () => { adjuntos.splice(+b.dataset.i, 1); pintarFotos(); };
    });
  };

  const abrir = () => { ov.classList.add('show'); $('cirene-sug-txt').focus(); };
  const cerrar = () => { ov.classList.remove('show'); $('cirene-sug-msg').textContent = ''; };

  btn.onclick = abrir;
  $('cirene-sug-close').onclick = cerrar;
  ov.onclick = (e) => { if (e.target === ov) cerrar(); };
  $('cirene-sug-add').onclick = () => $('cirene-sug-file').click();
  pintarFotos();

  $('cirene-sug-file').onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    const msg = $('cirene-sug-msg');
    msg.className = 'cirene-sug-msg';
    msg.textContent = 'Subiendo…';
    try {
      for (const f of files) adjuntos.push(await data.uploadSuggestionFile(f));
      msg.textContent = '';
      pintarFotos();
    } catch (err) {
      msg.className = 'cirene-sug-msg err';
      msg.textContent = 'No se pudo adjuntar: ' + (err.message || err);
    }
  };

  $('cirene-sug-send').onclick = async () => {
    const b = $('cirene-sug-send');
    const msg = $('cirene-sug-msg');
    const texto = $('cirene-sug-txt').value.trim();
    if (!texto) {
      msg.className = 'cirene-sug-msg err';
      msg.textContent = 'Escribí tu sugerencia antes de enviarla.';
      return;
    }
    b.disabled = true;
    msg.className = 'cirene-sug-msg';
    msg.textContent = 'Enviando…';
    try {
      await data.createSuggestion({
        texto, categoria: $('cirene-sug-cat').value,
        pagina: paginaActual(), adjuntos,
      });
      msg.className = 'cirene-sug-msg ok';
      msg.textContent = '¡Gracias! Tu sugerencia quedó registrada.';
      $('cirene-sug-txt').value = '';
      adjuntos = [];
      pintarFotos();
      setTimeout(cerrar, 1600);
    } catch (err) {
      msg.className = 'cirene-sug-msg err';
      msg.textContent = err.message || String(err);
    } finally { b.disabled = false; }
  };
}
