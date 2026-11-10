// Fotos: auf max. 100 kB verkleinern, lokal in IndexedDB zwischenspeichern, ins Drive hochladen.
import { store, uid } from './store.js';

const DB_NAME = 'shmex-photos';
const STORE = 'photos';
export const MAX_PHOTO_BYTES = 100 * 1024;

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
  });
}
const getRec = (id) => tx('readonly', (s) => s.get(id));
const putRec = (rec) => tx('readwrite', (s) => s.put(rec));
const delRec = (id) => tx('readwrite', (s) => s.delete(id));
const allRecs = () => tx('readonly', (s) => s.getAll());

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Bild konnte nicht gelesen werden')); };
    img.src = url;
  });
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// Verkleinert so lange (erst Qualität, dann Größe), bis das JPEG unter 100 kB liegt.
export async function compress(file) {
  const img = await loadImage(file);
  let maxDim = 1280;
  let quality = 0.8;
  let blob = null;
  for (let i = 0; i < 16; i++) {
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    blob = await canvasToBlob(canvas, quality);
    if (blob && blob.size <= MAX_PHOTO_BYTES) break;
    if (quality > 0.55) quality -= 0.1;
    else { maxDim = Math.round(maxDim * 0.8); quality = 0.72; }
  }
  if (!blob || blob.size > MAX_PHOTO_BYTES) throw new Error('Foto ließ sich nicht klein genug machen');
  return blobToBase64(blob);
}

export async function addPhoto(file) {
  const base64 = await compress(file);
  const id = uid();
  await putRec({ id, base64, pending: true, createdAt: Date.now() });
  return id; // Upload startet, sobald das Gericht das Foto referenziert (processQueue).
}

let processing = false;
export async function processQueue() {
  if (processing || !store.api || !navigator.onLine) return;
  processing = true;
  try {
    const pending = (await allRecs()).filter((r) => r.pending);
    for (const rec of pending) {
      const isUsed = () => store.live('dishes').some((d) => d.photoId === rec.id);
      if (!isUsed()) {
        // Noch keinem Gericht zugeordnet: kurz warten, verwaiste alte Fotos verwerfen.
        if (Date.now() - (rec.createdAt || 0) > 10 * 60 * 1000) await delRec(rec.id);
        continue;
      }
      const res = await store.api.uploadPhoto(rec.id, rec.base64);
      if (isUsed()) {
        store.update((data) => {
          for (const d of data.dishes) {
            if (d.photoId === rec.id && d.photoFileId !== res.fileId) {
              d.photoFileId = res.fileId;
              d.updatedAt = Date.now();
            }
          }
        });
      } else {
        // Gericht wurde gelöscht, bevor das Foto oben war.
        await store.api.deletePhoto(res.fileId).catch(() => {});
      }
      await putRec({ ...rec, pending: false });
    }
  } catch (err) {
    console.warn('Foto-Upload später erneut', err);
  } finally {
    processing = false;
  }
}

const inflight = new Map();
export async function photoUrl(dish) {
  if (!dish || !dish.photoId) return null;
  const rec = await getRec(dish.photoId).catch(() => null);
  if (rec) return 'data:image/jpeg;base64,' + rec.base64;
  if (!dish.photoFileId || !store.api || !navigator.onLine) return null;
  if (!inflight.has(dish.photoId)) {
    inflight.set(dish.photoId, (async () => {
      try {
        const res = await store.api.getPhoto(dish.photoFileId);
        await putRec({ id: dish.photoId, base64: res.base64, pending: false, createdAt: Date.now() });
        return 'data:image/jpeg;base64,' + res.base64;
      } catch (err) {
        return null;
      } finally {
        setTimeout(() => inflight.delete(dish.photoId), 0);
      }
    })());
  }
  return inflight.get(dish.photoId);
}

// Foto eines Gerichts entfernen: lokal löschen, im Drive in den Papierkorb.
export async function forgetPhoto(photoId, photoFileId) {
  if (photoFileId) store.queuePhotoDelete(photoFileId);
  if (photoId) await delRec(photoId).catch(() => {});
}
