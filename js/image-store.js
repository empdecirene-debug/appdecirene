// Acceso compartido a IndexedDB para imágenes del catálogo.
// El cotizador (index.html) guarda imágenes acá (DB `cirene_db_v1`, store `images`)
// y este módulo permite leerlas y escribirlas desde catalog.html sin duplicar
// la lógica. Mismo DB_NAME y STORE → ambas páginas comparten datos.

const DB_NAME = 'cirene_db_v1';
const DB_STORE = 'images';
let _db = null;

function open() {
  return new Promise((resolve, reject) => {
    if (_db) { resolve(_db); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE);
      }
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror = e => reject(e.target.error);
  });
}

const _cache = {};

export async function getImage(key) {
  if (!key) return null;
  if (_cache[key]) return _cache[key];
  const db = await open();
  return new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const r = tx.objectStore(DB_STORE).get(key);
    r.onsuccess = () => { if (r.result) _cache[key] = r.result; res(r.result || null); };
    r.onerror = () => rej(r.error);
  });
}

export async function setImage(key, dataUrl) {
  _cache[key] = dataUrl;
  const db = await open();
  return new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    const r = tx.objectStore(DB_STORE).put(dataUrl, key);
    r.onsuccess = () => res(true);
    r.onerror = () => rej(r.error);
  });
}

export async function delImage(key) {
  if (!key) return;
  delete _cache[key];
  const db = await open();
  return new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    const r = tx.objectStore(DB_STORE).delete(key);
    r.onsuccess = () => res(true);
    r.onerror = () => rej(r.error);
  });
}

// Comprime un File a dataURL, manteniendo transparencia si es PNG.
// Mismo algoritmo que index.html para que el output sea consistente.
export function compressImage(file, maxDim = 800, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    const isPng = file && (file.type === 'image/png' || /\.png$/i.test(file.name || ''));
    r.onload = ev => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
          else { w = Math.round(w * maxDim / h); h = maxDim; }
        }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        if (isPng) {
          ctx.drawImage(img, 0, 0, w, h);
          const png = c.toDataURL('image/png');
          if (png.length < 600 * 1024) return resolve(png);
          ctx.globalCompositeOperation = 'destination-over';
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, w, h);
          ctx.globalCompositeOperation = 'source-over';
          resolve(c.toDataURL('image/jpeg', quality));
        } else {
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          resolve(c.toDataURL('image/jpeg', quality));
        }
      };
      img.onerror = () => reject(new Error('Bad image'));
      img.src = ev.target.result;
    };
    r.onerror = () => reject(new Error('Read error'));
    r.readAsDataURL(file);
  });
}

// Convierte una dataURL a base64 sin prefijo (lo que Odoo espera en image_1920).
export function dataUrlToBase64(dataUrl) {
  if (!dataUrl) return null;
  const idx = dataUrl.indexOf(',');
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}
