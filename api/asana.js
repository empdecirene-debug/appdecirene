// Importación desde Asana.
//
// De Cirene trabajaba con dos proyectos de Asana y los exporta como CSV:
//
//   · "Presupuestos Herreria"   → el CRM: cada tarea es una consulta (intake_cards)
//   · "Herreria Operativa 2026" → producción: cada tarea es un trabajo (production_cards)
//
// Una tarea que está en los dos proyectos (mismo Task ID) es un lead ganado: la
// consulta queda en "Lead ganado" y apunta a su trabajo, como si se hubiera
// ganado desde el CRM (venta incluida, ver `winLead` en js/cirene-data.js).
//
// `importarAsana` REEMPLAZA todo el movimiento: primero guarda un respaldo de lo
// que hay, después vacía (lo mismo que "Reiniciar todo") y carga los CSV, todo en
// UNA transacción. Con `soloVer` hace lo mismo y al final deshace: así la pantalla
// muestra exactamente qué va a pasar antes de confirmar.
//
// Lo que NO se importa, a propósito:
//   · la sección "Stock" de Operativa: son productos terminados, y el stock del
//     ERP es de materiales. Se devuelve la lista para mostrarla.
//   · cotizaciones, cobros y cuentas a cobrar: Asana tiene el precio pero no las
//     líneas de costo de un presupuesto del cotizador ni los montos cobrados.
//     Inventarlos ensuciaría Contabilidad. El estado de pago (SI/NO/SEÑA) sí
//     queda en la tarjeta.

import fs from 'node:fs';
import path from 'node:path';
import { pool } from './db.js';
import { vaciar, TABLAS_MOVIMIENTO } from './demo.js';
import { normalizePhoneUY } from '../js/phone-normalizer.js';

/* ── CSV ──────────────────────────────────────────────────────────────────────
   RFC 4180: comillas dobles, "" como escape y saltos de línea dentro de un campo
   (las notas de Asana los tienen siempre). */
export function leerCSV(texto) {
  const s = String(texto || '').replace(/^﻿/, '');
  const filas = [];
  let fila = [], campo = '', comillas = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (comillas) {
      if (ch === '"') {
        if (s[i + 1] === '"') { campo += '"'; i++; }
        else comillas = false;
      } else campo += ch;
    } else if (ch === '"') comillas = true;
    else if (ch === ',') { fila.push(campo); campo = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      fila.push(campo); campo = '';
      if (fila.length > 1 || fila[0] !== '') filas.push(fila);
      fila = [];
    } else campo += ch;
  }
  if (campo !== '' || fila.length) { fila.push(campo); filas.push(fila); }
  if (!filas.length) return [];

  // Asana repite columnas ("Vendedor" aparece dos veces): de cada nombre se queda
  // con el primer valor no vacío.
  const cab = filas[0].map(h => h.trim());
  return filas.slice(1).map(f => {
    const o = {};
    cab.forEach((h, i) => { const v = (f[i] ?? '').trim(); if (!(h in o) || (!o[h] && v)) o[h] = v; });
    return o;
  });
}

/* ── Números ──────────────────────────────────────────────────────────────────
   Llegan como los escribió cada uno: "18.000", "7.535,25", "4.550", "$320/mt",
   "3.600", "-". Devuelve null si no es un número. */
export function numero(txt) {
  let s = String(txt ?? '').trim().replace(/^\$\s*/, '').replace(/\s*\/\s*(mt|m|u|un)\.?$/i, '').replace(/\s+/g, '');
  if (!s || s === '-') return null;
  if (!/^\d[\d.,]*$/.test(s)) return null;
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// "1", "27", "4.20 mts", "12,20 metros", "8 mts". `conUnidad` = la cantidad es una
// medida (metros), y entonces el precio de esa fila ya es el total de la línea.
function cantidad(txt) {
  const s = String(txt ?? '').trim();
  if (!s) return { ok: true, n: null, conUnidad: false };
  const m = s.match(/^(\d+(?:[.,]\d+)?)\s*(mts?|metros?|m|ml|u|un|uds?|unidades?|pares?)?\.?$/i);
  if (!m) return { ok: false };
  const n = numero(m[1]);
  const unidad = (m[2] || '').toLowerCase();
  return { ok: n !== null, n, conUnidad: /^(m|mts?|metros?|ml)$/.test(unidad) };
}

const sinTildes = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const clave = (s) => sinTildes(s).toLowerCase().replace(/\s+/g, ' ').trim();

/* ── La tabla de las notas ────────────────────────────────────────────────────
   La plantilla de Asana arma una tabla y el CSV la aplana: primero los títulos
   de columna, uno por renglón, y después cada celda en un renglón (las vacías
   también). Hay dos plantillas: la vieja de 5 columnas y la nueva de 7.

   El aplanado no es prolijo, y con los CSV reales pasan tres cosas:
     · entre una fila y la siguiente puede sobrar un renglón vacío → cada fila
       arranca en el próximo renglón con texto;
     · una celda (vacía o con un salto de línea adentro) puede ocupar dos o tres
       renglones y correr la fila → se prueban Medidas de 1 a 3 renglones y Precio
       de 1 a 2, y gana la combinación que más números pone donde van números;
     · las celdas vacías del final de la tabla a veces no vienen → se completan.
   Si ninguna combinación cierra, se terminó la tabla y lo que sigue es texto libre. */
const TITULOS = {
  'producto y material': 'producto', 'medidas': 'medidas', 'cantidad': 'cantidad', 'precio': 'precio',
  'costo materiales': 'costo_mat', 'costo mo': 'costo_mo', 'costo mano de obra': 'costo_mo',
  'especificaciones': 'espec',
};

export function leerNotas(notas) {
  const lin = String(notas || '').replace(/\r/g, '').split('\n');
  let i = 0;
  while (i < lin.length && !lin[i].trim()) i++;
  const cols = [];
  while (i < lin.length && TITULOS[clave(lin[i])]) { cols.push(TITULOS[clave(lin[i])]); i++; }
  if (cols.length < 4 || cols[0] !== 'producto') return { lineas: [], texto: String(notas || '').trim() };

  const lineas = [];
  const N = cols.length;
  const iMed = cols.indexOf('medidas'), iPre = cols.indexOf('precio');
  const vacio = (s) => !s || s === '-';
  const esNum = (s) => numero(s) !== null;

  // Arma la fila que empieza en `desde` con Medidas de `sm` renglones y Precio de
  // `sp`. Devuelve null si no cierra, o la fila con su puntaje.
  function armarFila(desde, sm, sp) {
    const celdas = [];
    let k = desde, precioTxt = '', aparte = '', extraTexto = 0, extraVacio = 0;
    for (let c = 0; c < N; c++) {
      const span = c === iMed ? sm : c === iPre ? sp : 1;
      const trozo = lin.slice(k, k + span).map(x => (x ?? '').trim());
      if (c === iPre) { precioTxt = trozo[0] || ''; aparte = trozo.slice(1).join(' '); }
      for (const x of trozo.slice(1)) x ? extraTexto++ : extraVacio++;
      celdas.push(trozo.filter(Boolean).join(' '));
      k += span;
    }
    const f = Object.fromEntries(cols.map((c, j) => [c, celdas[j]]));
    if (!f.producto || esNum(f.producto)) return null;
    const cant = cantidad(f.cantidad);
    if (!cant.ok) return null;
    // Un precio en dos renglones solo si el segundo es una aclaración: "($7.500 c/u)".
    if (sp > 1 && (!aparte || esNum(aparte))) return null;
    let precio = vacio(precioTxt) ? null : numero(precioTxt);
    if (!vacio(precioTxt) && precio === null) return null;
    const cu = aparte.match(/\$?\s*([\d.,]+)\s*c\/u/i);
    if (cu && numero(cu[1]) !== null) precio = numero(cu[1]);
    for (const c of ['costo_mat', 'costo_mo']) if (f[c] && !vacio(f[c]) && !esNum(f[c])) return null;
    const numeros = (cant.n !== null) + (precio !== null)
      + !!(f.costo_mat && esNum(f.costo_mat)) + !!(f.costo_mo && esNum(f.costo_mo));
    // Una fila sin ningún número es el texto libre que sigue a la tabla.
    if (!numeros) return null;
    // Estirar una celda sobre renglones vacíos es lo normal (celda vacía de dos
    // renglones); estirarla sobre renglones con texto, mucho menos.
    const puntos = (cant.n !== null ? 2 : 0) + (precio !== null ? 2 : 0)
      + (f.costo_mat && esNum(f.costo_mat) ? 1 : 0) + (f.costo_mo && esNum(f.costo_mo) ? 1 : 0)
      - (f.espec && esNum(f.espec) ? 1 : 0)          // un número en Especificaciones = fila corrida
      - 0.5 * extraTexto - 0.1 * extraVacio
      - (precio > 0 && precio < 10 && cant.n === null ? 1.5 : 0);   // "$1" suelto = era la cantidad
    return { f, cant, precio, puntos, hasta: k };
  }
  function mejorFila(desde) {
    let mejor = null;
    for (const sm of iMed >= 0 ? [1, 2, 3, 4] : [1]) for (const sp of [1, 2]) {
      const f = armarFila(desde, sm, sp);
      if (f && (!mejor || f.puntos > mejor.puntos)) mejor = f;
    }
    return mejor;
  }

  while (i < lin.length) {
    while (i < lin.length && !lin[i].trim()) i++;
    if (i >= lin.length) break;
    let fila = mejorFila(i);
    // Unas Especificaciones de varios renglones dejan texto suelto antes de la
    // próxima fila: si salteando uno o dos renglones aparece una fila con
    // cantidad y precio, esos renglones eran de la fila anterior.
    if (!fila && lineas.length) {
      for (const salto of [1, 2]) {
        const f = mejorFila(i + salto);
        if (f && f.cant.n !== null && f.precio !== null) {
          const ant = lineas[lineas.length - 1];
          ant.comentarios_produccion = [ant.comentarios_produccion, ...lin.slice(i, i + salto).map(x => x.trim())].filter(Boolean).join(' ');
          i += salto; fila = f; break;
        }
      }
    }
    if (!fila) break;
    i = fila.hasta;
    const { f, cant, precio } = fila;
    const cMat = numero(f.costo_mat), cMo = numero(f.costo_mo);
    // Si la cantidad es una medida ("8 mts"), el precio ya es el de la línea.
    const n = cant.conUnidad || !cant.n ? 1 : cant.n;
    const medidas = [f.medidas, cant.conUnidad ? f.cantidad : ''].filter(Boolean).join(' · ');
    lineas.push({
      producto: f.producto || '(sin nombre)',
      medidas: medidas || null,
      cantidad: n,
      precio: precio ?? 0,
      costo_materiales: cMat,
      costo_mo: cMo,
      comentarios_produccion: f.espec || null,
    });
  }
  const texto = lin.slice(i).join('\n').replace(/^\s+|\s+$/g, '');
  return { lineas, texto };
}

/* ── Nombre de la tarea ───────────────────────────────────────────────────────
   "Lorena Vázquez (ESPEJO)" → cliente + producto. Algunas viejas van al revés:
   "Caballerizas (Cireneos)". Todo lo de Cireneos es el mismo cliente interno. */
// Tareas viejas escritas al revés, "Producto (Cliente)": arrancan con el producto.
const EMPIEZA_CON_PRODUCTO = /^(rejas?|puertas?|puertitas?|port[oó]n(es)?|muestras?|carteles?|caballerizas?|arreglos?)\b/i;

export function partirNombre(nombre) {
  const s = String(nombre || '').replace(/\s+/g, ' ').trim();
  const m = s.match(/^(.*?)\s*\((.+)\)\s*$/);
  let cliente = m ? m[1].trim() : s, producto = m ? m[2].trim() : '';
  let conParentesis = !!m;
  if (m && /^cireneos?$/i.test(producto)) { producto = cliente; cliente = 'Cireneos'; }
  else if (m && /^(x?\d)/i.test(producto)) {
    // "Puertas (2 presupuestos)", "Puertitas … (x2)": entre paréntesis no hay cliente.
    conParentesis = false;
  } else if (m && EMPIEZA_CON_PRODUCTO.test(cliente)) {
    [cliente, producto] = [producto, cliente];
  }
  if (/^cireneos?\b/i.test(cliente)) cliente = 'Cireneos';
  cliente = cliente.replace(/[\s\-–\/,]+$/, '').trim();
  return { cliente, producto, conParentesis };
}

// Las plantillas de Asana se exportan como una tarea más.
const esPlantilla = (t) => /^\[converted to template\]/i.test(t['Name'] || '');

const fechaTs = (d) => (d ? `${d}T12:00:00-03:00` : null);

/* ── Etapas ──────────────────────────────────────────────────────────────────── */
function etapaCRM(t, ganado) {
  if (ganado) return 'lead_ganado';
  const sec = clave(t['Section/Column']);
  const seg = clave(t['Seguimiento']);
  if (sec === 'mensaje entrante') return 'mensaje_entrante';
  if (sec === 'a presupuestar') return 'a_presupuestar';
  if (sec.startsWith('mas informacion')) return 'necesita_info';
  if (sec === 'rechazado') return 'rechazado';
  if (sec === 'en seguimiento') return 'en_seguimiento';
  if (sec === 'aprobado') return 'aceptado';
  // "Presupuestado" en Asana es una sola columna; el ERP la abre según el seguimiento.
  if (seg.includes('rechazado')) return 'rechazado';
  if (seg.includes('seguimiento')) return 'en_seguimiento';
  if (seg.includes('aceptado')) return 'aceptado';
  if (seg.includes('enviado')) return 'enviado';
  return 'presupuestado';
}
const ESTADO_LEAD = {
  mensaje_entrante: 'abierta', a_presupuestar: 'abierta', necesita_info: 'abierta',
  presupuestado: 'cotizada', enviado: 'cotizada', en_seguimiento: 'cotizada',
  aceptado: 'aceptada', lead_ganado: 'aceptada', rechazado: 'rechazada',
};
const ETAPA_PROD = {
  'procesar': 'procesar', 'falta llegar': 'falta_llegar', 'a producir': 'a_producir',
  'colocacion': 'colocacion', 'a entregar': 'a_entregar', 'entregado': 'entregado',
};
const SECCIONES = new Set([...Object.keys(ETAPA_PROD), 'stock']);

/* ── Armado: de los dos CSV a lo que se va a insertar ─────────────────────────
   Puro (sin base de datos): así se puede probar y mostrar antes de tocar nada. */
export function armar({ presupuestos = '', operativa = '' }) {
  const pres = leerCSV(presupuestos).filter(t => t['Task ID'] && !esPlantilla(t));
  const oper = leerCSV(operativa).filter(t => t['Task ID'] && !esPlantilla(t));
  const avisos = [];

  // Nombre de cada vendedor: Asana a veces trae la persona y a veces solo el mail.
  const nombreDe = {};
  for (const t of [...pres, ...oper]) {
    const mail = (t['Assignee Email'] || '').toLowerCase();
    if (mail && t['Assignee'] && !t['Assignee'].includes('@')) nombreDe[mail] = t['Assignee'];
  }
  const vendedor = (t) => {
    const mail = (t['Vendedor'] || t['Assignee Email'] || '').toLowerCase();
    if (!mail) return { nombre: null, mail: null };
    return { nombre: nombreDe[mail] || mail.split('@')[0].replace(/\.cireneos$/, ''), mail };
  };

  // ── Clientes: uno por teléfono; sin teléfono, uno por nombre ──
  const clientes = [];
  const porTel = new Map(), porNombre = new Map();
  function cliente(t) {
    const { cliente: nombre, conParentesis } = partirNombre(t['Name']);
    const interno = nombre === 'Cireneos' || clave(t['Cliente']) === 'cireneos' || clave(t['Forma de Pago']) === 'compra interna';
    // El cliente interno no se queda con un teléfono: en esas tareas es el de
    // quien pidió el trabajo, y le robaría las consultas de esa persona.
    const tel = interno ? null : normalizePhoneUY(String(t['Telefono'] || '').replace(/^'/, ''));
    // Sin paréntesis ni teléfono, el "nombre" suele ser el producto ("rejas",
    // "fogoneros"): no se inventa un cliente con eso.
    if (!conParentesis && !tel && !interno) return null;
    const kN = clave(interno ? 'Cireneos' : nombre);
    let c = (tel && porTel.get(tel)) || porNombre.get(kN);
    if (!c) {
      c = { key: 'c' + clientes.length, nombre: interno ? 'Cireneos' : nombre, telefono: t['Telefono']?.replace(/^'/, '') || null,
            telefono_e164: tel, direccion: t['Dirección'] || null, es_interno: interno,
            vendedor: vendedor(t).nombre, creado: t['Created At'] };
      clientes.push(c);
    } else {
      if (!c.telefono_e164 && tel && !porTel.has(tel)) { c.telefono_e164 = tel; c.telefono = t['Telefono']?.replace(/^'/, ''); }
      if (!c.direccion && t['Dirección']) c.direccion = t['Dirección'];
      if (t['Created At'] && t['Created At'] < c.creado) c.creado = t['Created At'];
    }
    if (c.telefono_e164) porTel.set(c.telefono_e164, c);
    porNombre.set(kN, c);
    return c;
  }

  // ── Producción ──
  const idsOper = new Map(oper.filter(t => !t['Parent task']).map(t => [t['Task ID'], t]));
  const trabajos = [], stock = [], subtareas = [];
  const porNombreOper = new Map();
  for (const t of oper) {
    if (t['Parent task']) continue;
    const sec = clave(t['Section/Column']);
    if (sec === 'stock') {
      const { lineas } = leerNotas(t['Notes']);
      const nums = String(t['Notes'] || '').split('\n').map(numero).filter(x => x !== null);
      stock.push({ producto: t['Name'], actual: nums[0] ?? null, minimo: nums[1] ?? null, lineas: lineas.length });
      continue;
    }
    const { producto } = partirNombre(t['Name']);
    const { lineas, texto } = leerNotas(t['Notes']);
    const total = lineas.reduce((s, l) => s + l.cantidad * l.precio, 0);
    const costo = lineas.reduce((s, l) => s + (l.cantidad * ((l.costo_materiales || 0) + (l.costo_mo || 0))), 0);
    // Asana no dice si el precio era por unidad o por el total de la fila. Se toma
    // por unidad (es lo que pasa casi siempre), pero los montos grandes se avisan.
    for (const l of lineas) {
      if (l.cantidad > 1 && l.cantidad * l.precio >= 50000) {
        avisos.push(`Revisar "${t['Name']}": ${l.cantidad} × $${l.precio.toLocaleString('es-UY')} = $${(l.cantidad * l.precio).toLocaleString('es-UY')}. Se tomó el precio como unitario; si era el total, corregilo en la tarjeta.`);
      }
    }
    const etapa = ETAPA_PROD[sec] || 'procesar';
    if (!ETAPA_PROD[sec]) avisos.push(`"${t['Name']}": columna "${t['Section/Column']}" desconocida, va a Procesar.`);
    const pago = clave(t['PAGO']).toUpperCase();
    const v = vendedor(t);
    const insumo = t['Estado del insumo'] && !SECCIONES.has(clave(t['Estado del insumo'])) ? t['Estado del insumo'] : null;
    const tr = {
      id: 'pr-' + t['Task ID'], taskId: t['Task ID'], nombre: t['Name'], cliente: cliente(t),
      clienteNombre: partirNombre(t['Name']).cliente,
      telefono: normalizePhoneUY(String(t['Telefono'] || '').replace(/^'/, '')),
      direccion: t['Dirección'] || null, vendedor: v.nombre, vendedorMail: v.mail,
      descripcion: [producto || t['Name'], texto].filter(Boolean).join('\n\n'),
      lineas, total: Math.round(total * 100) / 100, costo: Math.round(costo * 100) / 100,
      etapa, estado_pago: pago === 'SI' || pago === 'NO' || pago === 'SENA' ? (pago === 'SENA' ? 'SEÑA' : pago) : null,
      contabilidad: clave(t['Contabilidad']) === 'agregado' ? 'Agregado' : null,
      entrega: t['Entrega'] || null, metodo_pago: t['Forma de Pago'] || null, estado_insumo: insumo,
      due_date: t['Due Date'] || null, production_date: t['Start Date'] || null,
      creado: t['Created At'], modificado: t['Last Modified'] || t['Created At'], completado: t['Completed At'] || null,
      interno: !!(cliente(t)?.es_interno),
    };
    trabajos.push(tr);
    porNombreOper.set(t['Name'].trim(), tr);
  }
  // Subtareas de Asana: se enganchan al trabajo por el NOMBRE del padre (es lo que trae el CSV).
  for (const t of oper) {
    if (!t['Parent task']) continue;
    const padre = porNombreOper.get(t['Parent task'].trim());
    if (!padre) { avisos.push(`Subtarea "${t['Name']}" sin trabajo padre ("${t['Parent task']}").`); continue; }
    subtareas.push({ card: padre.id, nombre: t['Name'], terminada: !!t['Completed At'], fin: t['Completed At'] || null });
  }

  // ── CRM ──
  const leads = [];
  let subtareasCRM = 0;
  const vistos = new Set();
  for (const t of pres) {
    if (t['Parent task']) { subtareasCRM++; continue; }
    if (vistos.has(t['Task ID'])) continue;   // la misma tarea en dos columnas
    vistos.add(t['Task ID']);
    const trabajo = idsOper.has(t['Task ID']) ? trabajos.find(x => x.taskId === t['Task ID']) : null;
    const etapa = etapaCRM(t, !!trabajo);
    const { cliente: cliNombre, producto } = partirNombre(t['Name']);
    const { lineas, texto } = leerNotas(t['Notes']);
    const resumenLineas = lineas.map(l => [l.producto, l.medidas, l.cantidad > 1 ? `×${l.cantidad}` : '', l.precio ? `$${l.precio}` : '']
      .filter(Boolean).join(' · ')).join('\n');
    const v = vendedor(t);
    leads.push({
      id: 'in-' + t['Task ID'], taskId: t['Task ID'], cliente: cliente(t), clienteNombre: cliNombre || t['Name'],
      telefono: normalizePhoneUY(String(t['Telefono'] || '').replace(/^'/, '')),
      vendedor: v.nombre, vendedorMail: v.mail,
      descripcion: [producto || (cliNombre ? '' : t['Name']), resumenLineas, texto].filter(Boolean).join('\n\n') || t['Name'],
      etapa, estado: ESTADO_LEAD[etapa], target_date: t['Due Date'] || null,
      creado: t['Created At'], modificado: t['Last Modified'] || t['Created At'],
      trabajo: trabajo?.id || null, ganado: trabajo ? (trabajo.creado || t['Last Modified']) : null,
    });
  }
  // Ganado en el CRM sin presupuesto anterior: el trabajo igual queda (source 'manual').

  const sinPrecio = trabajos.filter(x => !x.total && !x.interno).length;
  return { clientes, leads, trabajos, subtareas, stock, avisos, subtareasCRM, sinPrecio };
}

/* ── Respaldo de lo que se va a borrar ────────────────────────────────────────
   Se guarda en el volumen, FUERA de /data/adjuntos (eso se sirve público). */
export const DIR_RESPALDOS = path.join(path.dirname(process.env.ADJUNTOS_DIR || '/data/adjuntos'), 'respaldos');

async function respaldar(c, tablas) {
  const datos = {};
  for (const t of tablas) {
    try { datos[t] = (await c.query(`select * from "${t}"`)).rows; } catch { /* tabla que no existe */ }
  }
  return datos;
}

/* ── Importar ─────────────────────────────────────────────────────────────── */
export async function importarAsana(textos, { soloVer = false, uid = null } = {}) {
  const plan = armar(textos);
  if (!plan.trabajos.length && !plan.leads.length) {
    throw new Error('Los archivos no tienen tareas de Asana. ¿Son los CSV exportados de "Presupuestos Herreria" y "Herreria Operativa"?');
  }
  const c = await pool.connect();
  const cargados = {};
  const sumar = (k, n = 1) => { cargados[k] = (cargados[k] || 0) + n; };
  try {
    await c.query('begin');

    // Lo que hay hoy: para el respaldo y para mostrar qué se borra.
    const antes = await respaldar(c, TABLAS_MOVIMIENTO);
    const aBorrar = Object.fromEntries(Object.entries(antes).filter(([, v]) => v.length).map(([k, v]) => [k, v.length]));

    await vaciar(c, 'operativo');

    // Vendedores que ya son usuarios de la app: se enlazan.
    const { rows: usuarios } = await c.query(`select id, lower(email) email from app_users`);
    const uidDe = Object.fromEntries(usuarios.map(u => [u.email, u.id]));

    // Clientes
    const idCliente = new Map();
    for (const cl of plan.clientes) {
      const r = await c.query(
        `insert into clients (nombre, telefono, telefono_e164, direccion, es_interno, vendedor, origen, activo, created_at)
         values ($1,$2,$3,$4,$5,$6,'import',true,$7) returning id`,
        [cl.nombre, cl.telefono, cl.telefono_e164, cl.direccion, cl.es_interno, cl.vendedor, fechaTs(cl.creado) || new Date()]);
      idCliente.set(cl.key, r.rows[0].id);
      sumar('clientes');
    }

    // Leads (primero: los trabajos los referencian)
    for (const l of plan.leads) {
      await c.query(
        `insert into intake_cards (id, vendor, vendor_user_id, client_query, client_phone_e164, description,
           target_date, urgency, stage_key, status, client_id, won_at, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,'normal',$8,$9,$10,$11,$12,$13)`,
        [l.id, l.vendedor || 'Sin asignar', uidDe[l.vendedorMail] || null, l.clienteNombre, l.telefono,
         l.descripcion, l.target_date, l.etapa, l.estado, l.cliente ? idCliente.get(l.cliente.key) : null,
         fechaTs(l.ganado), fechaTs(l.creado) || new Date(), fechaTs(l.modificado) || new Date()]);
      sumar('consultas');
    }
    const leadDe = new Map(plan.leads.filter(l => l.trabajo).map(l => [l.trabajo, l]));

    // Trabajos + su venta
    for (const t of plan.trabajos) {
      const lead = leadDe.get(t.id);
      const cid = t.cliente ? idCliente.get(t.cliente.key) : null;
      const vUid = uidDe[t.vendedorMail] || null;
      const lineas = t.lineas.map(l => ({ ...l, precio: l.precio }));
      await c.query(
        `insert into production_cards (id, source, vendor, vendor_user_id, intake_card_id, client_id,
           client_name, client_phone_e164, direccion, description, product_lines, total_venta, costo_estimado,
           billing_month, estado_pago, contabilidad, entrega, metodo_pago, estado_insumo,
           stage_key, priority, due_date, fecha_solicitada_cliente, production_date,
           fecha_real_fin, completed_at, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'normal',$21,$21,$22,$23,$24,$25,$26)`,
        [t.id, lead ? 'intake' : 'manual', t.vendedor, vUid, lead?.id || null, cid,
         t.clienteNombre, t.telefono, t.direccion, t.descripcion, JSON.stringify(lineas), t.total, t.costo,
         (t.creado || '').slice(0, 7) || null, t.estado_pago, t.contabilidad, t.entrega, t.metodo_pago, t.estado_insumo,
         t.etapa, t.due_date, t.production_date,
         t.etapa === 'entregado' ? t.completado : null, t.etapa === 'entregado' ? fechaTs(t.completado) : null,
         fechaTs(t.creado) || new Date(), fechaTs(t.modificado) || new Date()]);
      sumar('trabajos');

      // La venta, como la crea winLead: una por trabajo con precio.
      if (t.total > 0) {
        const v = await c.query(
          `insert into sales (intake_card_id, production_card_id, client_id, cliente_nombre, vendedor, vendedor_user_id,
             monto, fecha, billing_month, estado)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
          [lead?.id || null, t.id, cid, t.clienteNombre, t.vendedor, vUid, t.total,
           t.creado || new Date().toISOString().slice(0, 10), (t.creado || '').slice(0, 7) || null,
           t.etapa === 'entregado' ? 'entregada' : 'confirmada']);
        await c.query(`update production_cards set sale_id = $1 where id = $2`, [v.rows[0].id, t.id]);
        if (lead) await c.query(`update intake_cards set sale_id = $1 where id = $2`, [v.rows[0].id, lead.id]);
        sumar('ventas');
      }
      if (lead) await c.query(`update intake_cards set resulting_production_card_id = $1 where id = $2`, [t.id, lead.id]);
    }

    let orden = 0;
    for (const s of plan.subtareas) {
      await c.query(
        `insert into production_subtasks (card_id, nombre, display_order, estado, finished_at)
         values ($1,$2,$3,$4,$5)`,
        [s.card, s.nombre, (orden++) * 10, s.terminada ? 'terminada' : 'pendiente', fechaTs(s.fin)]);
      sumar('subtareas');
    }

    let respaldo = null;
    if (soloVer) {
      await c.query('rollback');
    } else {
      // El respaldo se escribe antes del commit: si no se puede guardar, no se borra nada.
      fs.mkdirSync(DIR_RESPALDOS, { recursive: true });
      respaldo = 'antes-de-importar-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      fs.writeFileSync(path.join(DIR_RESPALDOS, respaldo), JSON.stringify({ fecha: new Date().toISOString(), uid, tablas: antes }));
      await c.query('commit');
    }
    return {
      soloVer, respaldo, borra: aBorrar, carga: cargados,
      stock: plan.stock, avisos: plan.avisos, sinPrecio: plan.sinPrecio, subtareasCRM: plan.subtareasCRM,
    };
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally { c.release(); }
}
