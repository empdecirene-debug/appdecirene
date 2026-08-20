// Traduce el descriptor de consulta que manda el cliente (js/supa.js) a SQL.
//
// El frontend sigue escribiendo el mismo código que con Supabase:
//   supa.from('quotes').select('*').eq('id', x).single()
// El cliente lo serializa a { tabla, accion, columnas, filtros, orden, limite, single }
// y acá lo convertimos a SQL.
//
// SEGURIDAD — dos reglas que no se rompen nunca:
//   1. Los VALORES van siempre como parámetros ($1, $2…). Jamás interpolados.
//   2. Los IDENTIFICADORES (tabla, columnas) se validan contra el catálogo real de
//      Postgres antes de tocar el string. Lo que no está en el catálogo, no entra.
// Sin esas dos, un endpoint de consulta genérica sería una inyección SQL servida.

import { tablaPermitida, columnaPermitida, columnasDe } from './registry.js';

// Operadores soportados = los que realmente usa la app (los conté sobre el código).
const OPS = {
  eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=',
  like: 'like', ilike: 'ilike',
};

class ErrorConsulta extends Error {
  constructor(msg, code = 'BAD_QUERY') { super(msg); this.code = code; }
}

const ident = (tabla, col) => {
  if (!columnaPermitida(tabla, col)) throw new ErrorConsulta(`Columna desconocida en ${tabla}: ${col}`);
  const limpio = String(col).includes('.') ? String(col).split('.').pop() : String(col);
  return '"' + limpio.replace(/"/g, '') + '"';
};

// select('id, nombre') → lista de columnas validadas. '*' → todas.
function listaColumnas(tabla, columnas) {
  const txt = (columnas || '*').trim();
  if (txt === '*' || txt === '') return '*';
  // Los embeds de PostgREST — select('*, workshops(name)') — no se soportan:
  // ninguna página viva de Cirene los usa (solo módulos heredados que ya no se importan).
  if (txt.includes('(')) {
    console.warn('[query] embed no soportado, devuelvo todas las columnas:', txt);
    return '*';
  }
  const cols = txt.split(',').map(s => s.trim()).filter(Boolean);
  return cols.map(c => ident(tabla, c)).join(', ');
}

function armarWhere(tabla, filtros, params) {
  if (!Array.isArray(filtros) || !filtros.length) return '';
  const partes = [];
  for (const f of filtros) {
    const { op, col, val } = f;

    if (op === 'is') {
      // .is('campo', null) / .is('campo', true)
      if (val === null) { partes.push(`${ident(tabla, col)} is null`); continue; }
      params.push(val); partes.push(`${ident(tabla, col)} is $${params.length}`); continue;
    }
    if (op === 'in') {
      const arr = Array.isArray(val) ? val : [];
      if (!arr.length) { partes.push('false'); continue; }
      params.push(arr); partes.push(`${ident(tabla, col)} = any($${params.length})`); continue;
    }
    if (op === 'contains') {
      // .contains(col, valor) sobre jsonb/array
      params.push(JSON.stringify(val)); partes.push(`${ident(tabla, col)} @> $${params.length}::jsonb`); continue;
    }
    if (op === 'not') {
      // .not(col, 'is', null) / .not(col, 'in', [...])
      const sub = f.subOp || 'eq';
      if (sub === 'is' && val === null) { partes.push(`${ident(tabla, col)} is not null`); continue; }
      if (sub === 'in') {
        const arr = Array.isArray(val) ? val : [];
        if (!arr.length) { partes.push('true'); continue; }
        params.push(arr); partes.push(`not (${ident(tabla, col)} = any($${params.length}))`); continue;
      }
      if (!OPS[sub]) throw new ErrorConsulta(`Operador no soportado en not(): ${sub}`);
      params.push(val); partes.push(`not (${ident(tabla, col)} ${OPS[sub]} $${params.length})`); continue;
    }
    if (op === 'or') {
      // .or('a.eq.1,b.eq.2') — sintaxis PostgREST
      const ramas = String(val || '').split(',').map(s => s.trim()).filter(Boolean);
      const sub = [];
      for (const r of ramas) {
        const [c, o, ...resto] = r.split('.');
        const v = resto.join('.');
        if (o === 'is') { sub.push(`${ident(tabla, c)} is ${v === 'null' ? 'null' : '$' + params.push(v)}`); continue; }
        if (!OPS[o]) throw new ErrorConsulta(`Operador no soportado en or(): ${o}`);
        params.push(v); sub.push(`${ident(tabla, c)} ${OPS[o]} $${params.length}`);
      }
      if (sub.length) partes.push('(' + sub.join(' or ') + ')');
      continue;
    }
    if (!OPS[op]) throw new ErrorConsulta(`Operador no soportado: ${op}`);
    params.push(val);
    partes.push(`${ident(tabla, col)} ${OPS[op]} $${params.length}`);
  }
  return partes.length ? ' where ' + partes.join(' and ') : '';
}

function armarOrden(tabla, orden) {
  if (!Array.isArray(orden) || !orden.length) return '';
  const partes = orden.map(o => {
    const dir = o.ascending === false ? 'desc' : 'asc';
    const nulls = o.nullsFirst === true ? ' nulls first' : o.nullsFirst === false ? ' nulls last' : '';
    return `${ident(tabla, o.col)} ${dir}${nulls}`;
  });
  return ' order by ' + partes.join(', ');
}

// Filtra un objeto de datos dejando solo columnas reales de la tabla.
function limpiarFila(tabla, fila) {
  const validas = new Set(columnasDe(tabla));
  const out = {};
  for (const [k, v] of Object.entries(fila || {})) {
    if (validas.has(k)) out[k] = v;
    else console.warn(`[query] descarto columna inexistente ${tabla}.${k}`);
  }
  if (!Object.keys(out).length) throw new ErrorConsulta(`Ninguna columna válida para ${tabla}`);
  return out;
}

export function construir(desc) {
  const { tabla, accion } = desc;
  if (!tablaPermitida(tabla)) throw new ErrorConsulta(`Tabla no permitida: ${tabla}`);
  const T = '"' + tabla.replace(/"/g, '') + '"';
  const params = [];

  if (accion === 'select') {
    let sql = `select ${listaColumnas(tabla, desc.columnas)} from ${T}`;
    sql += armarWhere(tabla, desc.filtros, params);
    sql += armarOrden(tabla, desc.orden);
    if (Number.isInteger(desc.limite) && desc.limite > 0) sql += ` limit ${desc.limite}`;
    if (Number.isInteger(desc.offset) && desc.offset > 0) sql += ` offset ${desc.offset}`;
    return { sql, params };
  }

  if (accion === 'insert' || accion === 'upsert') {
    const filasCrudas = Array.isArray(desc.valores) ? desc.valores : [desc.valores];
    const filas = filasCrudas.map(f => limpiarFila(tabla, f));
    // Unión de claves: si una fila no trae una columna, va DEFAULT.
    const cols = [...new Set(filas.flatMap(f => Object.keys(f)))];
    const tuplas = filas.map(f => '(' + cols.map(c => {
      if (!(c in f)) return 'default';
      params.push(f[c]); return '$' + params.length;
    }).join(', ') + ')');
    let sql = `insert into ${T} (${cols.map(c => ident(tabla, c)).join(', ')}) values ${tuplas.join(', ')}`;
    if (accion === 'upsert') {
      const conflicto = desc.onConflict
        ? String(desc.onConflict).split(',').map(c => ident(tabla, c.trim())).join(', ')
        : ident(tabla, 'id');
      const set = cols.filter(c => c !== 'id').map(c => `${ident(tabla, c)} = excluded.${ident(tabla, c)}`);
      sql += set.length
        ? ` on conflict (${conflicto}) do update set ${set.join(', ')}`
        : ` on conflict (${conflicto}) do nothing`;
    }
    sql += ' returning *';
    return { sql, params };
  }

  if (accion === 'update') {
    const fila = limpiarFila(tabla, desc.valores);
    const sets = Object.entries(fila).map(([c, v]) => { params.push(v); return `${ident(tabla, c)} = $${params.length}`; });
    let sql = `update ${T} set ${sets.join(', ')}`;
    const where = armarWhere(tabla, desc.filtros, params);
    // Un UPDATE sin filtros reescribiría la tabla entera. No.
    if (!where) throw new ErrorConsulta('UPDATE sin filtros: bloqueado');
    sql += where + ' returning *';
    return { sql, params };
  }

  if (accion === 'delete') {
    let sql = `delete from ${T}`;
    const where = armarWhere(tabla, desc.filtros, params);
    if (!where) throw new ErrorConsulta('DELETE sin filtros: bloqueado');
    sql += where + ' returning *';
    return { sql, params };
  }

  throw new ErrorConsulta(`Acción no soportada: ${accion}`);
}

export { ErrorConsulta };
