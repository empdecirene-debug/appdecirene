// js/gantt-pdf.js — (#14) Generador de Gantt diario de producción en PDF.
//
// Asume jsPDF UMD cargado en la página (production.html lo trae por CDN →
// window.jspdf.jsPDF).
//
// Entrada:
//   {
//     fecha:     'YYYY-MM-DD',
//     startHour: 8,
//     endHour:   18,
//     dias:      1 | 2,                 // (#T8.c) jornadas consecutivas
//     title:     'Plan diario' | null,
//     tasks: [
//       { id, label, operario, startMin, durationMin, tipo, color }
//       // startMin = minutos desde startHour del día 1.
//       // Si startMin > (endHour-startHour)*60 → cae en el día 2.
//       // tipo  = nombre del tipo de estampe (para la leyenda)
//       // color = hex del bloque
//     ],
//     legend: [ { nombre, color } ]
//   }
//
// (#T8.d) Tamaños subidos para legibilidad a distancia / impreso.

const SLOT_MINUTES = 15;
const GLIDE_AZUL = '#0A0A0A';

// Paleta para tipos de estampe — tonos diferenciables, alineados a la marca.
export const ESTAMPE_PALETTE = [
  '#0A0A0A', // azul De Cirene
  '#0E9F6E', // verde
  '#E8830C', // naranja
  '#7C3AED', // violeta
  '#C62828', // rojo
  '#0891B2', // cian
  '#B7791F', // mostaza
];

function hexToRgb(hex) {
  if (!hex) return [0, 0, 0];
  let h = String(hex).replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  return [
    parseInt(h.substr(0, 2), 16) || 0,
    parseInt(h.substr(2, 2), 16) || 0,
    parseInt(h.substr(4, 2), 16) || 0,
  ];
}

function textOn(hex) {
  const [r, g, b] = hexToRgb(hex);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? [30, 30, 30] : [255, 255, 255];
}

function _fechaPlus(fecha, plus) {
  const d = new Date(fecha + 'T12:00:00');
  d.setDate(d.getDate() + plus);
  return d.toISOString().slice(0, 10);
}

export function generateGanttPdf({ fecha, startHour = 8, endHour = 18, dias = 1, tasks = [], title = null, legend = [] }) {
  const jsPDFCtor = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
  if (!jsPDFCtor) throw new Error('jsPDF no está cargado.');
  const doc = new jsPDFCtor({ orientation: 'landscape', unit: 'mm', format: 'a4' });

  const PAGE_W = 297, PAGE_H = 210;
  const M = 12;
  const headerH = 30;
  const legendH = legend.length ? 11 : 0;
  const footerH = 10;

  const operarios = [...new Set(tasks.map(t => t.operario || 'Sin asignar'))];
  if (!operarios.length) operarios.push('Sin asignar');

  const chartTop = M + headerH + legendH;
  const chartBottom = PAGE_H - M - footerH;
  const chartH = chartBottom - chartTop;
  const labelColW = 46;                          // (#T8.d) más ancho para nombres legibles
  const chartLeft = M + labelColW;
  const chartW = PAGE_W - M - chartLeft;

  // (#T8.d) Filas más gruesas para mejor lectura
  const rowH = Math.max(12, Math.min(30, chartH / operarios.length));
  const usedH = rowH * operarios.length;

  // (#T8.c) Multi-día: el eje X cubre `dias` jornadas, con un gap visual.
  const horasJornada = endHour - startHour;
  const minPorJornada = horasJornada * 60;
  const totalMin = minPorJornada * dias;
  const slots = totalMin / SLOT_MINUTES;
  const gapMm = dias > 1 ? 4 : 0;                // gap visual entre días
  const usableW = chartW - gapMm * (dias - 1);
  const slotW = usableW / slots;
  // Para convertir un startMin (que cuenta jornadas continuas) a coordenada X
  // dentro del chart, hay que sumar el gap cada vez que cruzamos un día.
  const xForMin = (min) => {
    const diaIdx = Math.min(dias - 1, Math.floor(min / minPorJornada));
    const offsetMin = min - diaIdx * minPorJornada;
    const offsetSlots = offsetMin / SLOT_MINUTES;
    return chartLeft + diaIdx * (minPorJornada / SLOT_MINUTES * slotW + gapMm) + offsetSlots * slotW;
  };

  // ── Header ──────────────────────────────────────────────────────────────
  const [ar, ag, ab] = hexToRgb(GLIDE_AZUL);
  doc.setFillColor(ar, ag, ab);
  doc.rect(0, 0, PAGE_W, headerH - 4, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(20);
  doc.text(title || 'Plan diario de producción', M, 12);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(11);
  const fmtFecha = f => new Date(f + 'T12:00:00').toLocaleDateString('es-UY', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const fechaTxt = dias === 2 ? `${fmtFecha(fecha)}  y  ${fmtFecha(_fechaPlus(fecha, 1))}` : fmtFecha(fecha);
  doc.text(fechaTxt, M, 20);
  doc.text(`${startHour}:00 – ${endHour}:00  ·  ${tasks.length} tarea${tasks.length === 1 ? '' : 's'}  ·  ${operarios.length} operario${operarios.length === 1 ? '' : 's'}`,
    PAGE_W - M, 20, { align: 'right' });

  // ── Leyenda de tipos de estampe ─────────────────────────────────────────
  if (legend.length) {
    let lx = M;
    const ly = M + headerH - 7;
    doc.setFontSize(10);
    for (const lg of legend) {
      const [r, g, b] = hexToRgb(lg.color);
      doc.setFillColor(r, g, b);
      doc.roundedRect(lx, ly - 3.5, 5, 5, 0.8, 0.8, 'F');
      doc.setTextColor(60, 60, 60);
      doc.text(lg.nombre, lx + 7, ly);
      lx += 9 + doc.getTextWidth(lg.nombre) + 9;
    }
  }

  // ── Grilla ──────────────────────────────────────────────────────────────
  // Fondo zebra
  operarios.forEach((op, i) => {
    const y = chartTop + i * rowH;
    if (i % 2 === 1) {
      doc.setFillColor(246, 248, 251);
      doc.rect(M, y, labelColW + chartW, rowH, 'F');
    }
  });

  // (#T8.c) Etiqueta de cada día y separadores
  if (dias > 1) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
    doc.setTextColor(80, 80, 80);
    for (let d = 0; d < dias; d++) {
      const dayStartX = chartLeft + d * (minPorJornada / SLOT_MINUTES * slotW + gapMm);
      const dayEndX   = dayStartX + minPorJornada / SLOT_MINUTES * slotW;
      const dayLabel = `Día ${d + 1} · ${fmtFecha(_fechaPlus(fecha, d))}`;
      doc.text(dayLabel, dayStartX, chartTop - 6);
      // Separador grueso entre días
      if (d > 0) {
        doc.setDrawColor(80, 80, 80);
        doc.setLineWidth(0.6);
        doc.line(dayStartX - gapMm / 2, chartTop, dayStartX - gapMm / 2, chartTop + usedH);
      }
      // Marca de fin de día (borde derecho)
      doc.setDrawColor(150, 150, 150);
      doc.setLineWidth(0.3);
      doc.line(dayEndX, chartTop, dayEndX, chartTop + usedH);
    }
  }

  // Líneas verticales por hora + etiquetas (cada jornada)
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
  for (let d = 0; d < dias; d++) {
    for (let h = 0; h <= horasJornada; h++) {
      const x = xForMin(d * minPorJornada + h * 60);
      doc.setDrawColor(150, 150, 150);
      doc.setLineWidth(0.18);
      doc.line(x, chartTop, x, chartTop + usedH);
      doc.setTextColor(110, 110, 110);
      doc.text(`${startHour + h}:00`, x + 0.6, chartTop - 1.5);
    }
  }
  // Líneas suaves de cuartos de hora
  doc.setDrawColor(232);
  doc.setLineWidth(0.1);
  for (let d = 0; d < dias; d++) {
    const slotsJornada = minPorJornada / SLOT_MINUTES;
    for (let s = 0; s <= slotsJornada; s++) {
      if (s % 4 === 0) continue;
      const x = xForMin(d * minPorJornada + s * SLOT_MINUTES);
      doc.line(x, chartTop, x, chartTop + usedH);
    }
  }

  // Filas: separadores horizontales + etiqueta de operario.
  doc.setDrawColor(210);
  doc.setLineWidth(0.2);
  operarios.forEach((op, i) => {
    const y = chartTop + i * rowH;
    doc.line(M, y, M + labelColW + chartW, y);
    doc.setTextColor(35, 35, 35);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12);   // (#T8.d) más grande
    let name = op;
    while (doc.getTextWidth(name) > labelColW - 6 && name.length > 4) {
      name = name.slice(0, -2);
    }
    if (name !== op) name = name.slice(0, -1) + '…';
    doc.text(name, M + 2, y + rowH / 2 + 1.8);
  });
  doc.line(M, chartTop + usedH, M + labelColW + chartW, chartTop + usedH);
  doc.line(chartLeft, chartTop, chartLeft, chartTop + usedH);

  // ── Barras de tareas ────────────────────────────────────────────────────
  doc.setFont('helvetica', 'normal');
  for (const t of tasks) {
    const opIdx = operarios.indexOf(t.operario || 'Sin asignar');
    if (opIdx < 0) continue;
    const sMin = Math.max(0, t.startMin || 0);
    const dur = Math.max(SLOT_MINUTES, t.durationMin || SLOT_MINUTES);
    // (#T8.c) Si la tarea cruza el fin del día, partirla visualmente:
    // segmento 1 hasta el endHour, segmento 2 (si dias>1) desde startHour del día 2.
    const segments = [];
    let curStart = sMin, remaining = dur;
    while (remaining > 0) {
      const diaIdx = Math.floor(curStart / minPorJornada);
      if (diaIdx >= dias) break;   // pasó el rango de días
      const finJornada = (diaIdx + 1) * minPorJornada;
      const len = Math.min(remaining, finJornada - curStart);
      segments.push({ start: curStart, len });
      curStart = finJornada;
      remaining -= len;
    }
    if (!segments.length) continue;
    const color = t.color || GLIDE_AZUL;
    const [r, g, b] = hexToRgb(color);
    const [tr, tg, tb] = textOn(color);
    const y = chartTop + opIdx * rowH + 1.8;
    const h = rowH - 3.6;
    segments.forEach((seg, si) => {
      const x = xForMin(seg.start);
      const w = Math.max(2, xForMin(seg.start + seg.len) - x);
      doc.setFillColor(r, g, b);
      doc.roundedRect(x, y, w, h, 1.2, 1.2, 'F');
      doc.setTextColor(tr, tg, tb);
      doc.setFontSize(9.5);   // (#T8.d) más grande para legibilidad
      const durTxt = dur >= 60 ? `${Math.floor(dur / 60)}h${dur % 60 ? (dur % 60) + 'm' : ''}` : `${dur}m`;
      let label = si === 0 ? `${t.label || ''}  ·  ${durTxt}` : '↪ continuación';
      if (w > 16) {
        while (doc.getTextWidth(label) > w - 3 && label.length > 6) label = label.slice(0, -2);
        doc.text(label, x + 2, y + h / 2 + 1.6);
      }
    });
  }

  // ── Footer ──────────────────────────────────────────────────────────────
  doc.setDrawColor(225);
  doc.setLineWidth(0.2);
  doc.line(M, PAGE_H - M - 5, PAGE_W - M, PAGE_H - M - 5);
  doc.setTextColor(150, 150, 150);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);    // (#T8.d) footer +1
  doc.text('De Cirene · Producción', M, PAGE_H - M);
  doc.text(`Generado ${new Date().toLocaleString('es-UY')}`, PAGE_W - M, PAGE_H - M, { align: 'right' });

  return doc;
}

export function downloadGanttPdf(opts, filename) {
  const doc = generateGanttPdf(opts);
  doc.save(filename || `gantt-${opts.fecha}.pdf`);
}
