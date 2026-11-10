// Datenhaltung: lokale Kopie in localStorage, Abgleich mit der Datei im Google Drive.
import { Api, ApiError } from './api.js';

const CFG_KEY = 'shmex.config';
const DATA_KEY = 'shmex.data';
export const COLLECTIONS = ['people', 'locations', 'visits', 'dishes'];

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export function emptyData() {
  return { schema: 1, rev: 0, people: [], locations: [], visits: [], dishes: [] };
}

// Zusammenführen pro Eintrag: der jeweils zuletzt geänderte gewinnt (auch Löschungen).
export function mergeData(local, server) {
  const out = { ...emptyData(), ...(server || {}) };
  for (const c of COLLECTIONS) {
    const map = new Map();
    for (const item of (server && server[c]) || []) map.set(item.id, item);
    for (const item of (local && local[c]) || []) {
      const ex = map.get(item.id);
      if (!ex || (item.updatedAt || 0) > (ex.updatedAt || 0)) map.set(item.id, item);
    }
    out[c] = [...map.values()];
  }
  return out;
}

function readJson(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch (e) {
    return fallback;
  }
}

class Store extends EventTarget {
  constructor() {
    super();
    this.config = readJson(CFG_KEY, null);
    const saved = readJson(DATA_KEY, null);
    this.data = (saved && saved.data) || emptyData();
    this.rev = (saved && saved.rev) || 0;
    this.dirty = !!(saved && saved.dirty);
    this.pendingPhotoDeletes = (saved && saved.pendingPhotoDeletes) || [];
    this.status = 'idle';
    this.lastError = '';
    this.changeSeq = 0;
    this.syncing = false;
    this.syncAgain = false;
    this.timer = null;
    this.loaded = !!saved;
    this.api = this.config ? new Api(this.config.url, this.config.key) : null;

    window.addEventListener('online', () => this.sync());
    window.addEventListener('offline', () => this.setStatus('offline'));
  }

  get configured() { return !!(this.config && this.config.url && this.config.key); }

  saveLocal() {
    try {
      localStorage.setItem(DATA_KEY, JSON.stringify({
        data: this.data, rev: this.rev, dirty: this.dirty, pendingPhotoDeletes: this.pendingPhotoDeletes,
      }));
    } catch (e) {
      console.warn('Lokale Kopie konnte nicht gespeichert werden', e);
    }
  }

  setStatus(status, error = '') {
    this.status = status;
    this.lastError = error;
    this.dispatchEvent(new Event('status'));
  }

  emitChange() { this.dispatchEvent(new Event('change')); }

  // Erstverbindung: prüfen, laden oder neuen leeren Datensatz anlegen.
  async connect(url, key) {
    const api = new Api(url, key);
    await api.ping();
    const res = await api.load();
    this.config = { url: api.url, key: api.key };
    localStorage.setItem(CFG_KEY, JSON.stringify(this.config));
    this.api = api;
    this.pendingPhotoDeletes = [];
    let created = false;
    if (res.exists) {
      this.data = { ...emptyData(), ...res.data };
      this.rev = res.data.rev || 0;
      this.dirty = false;
    } else {
      this.data = emptyData();
      this.rev = 0;
      this.dirty = true;
      created = true;
    }
    this.loaded = true;
    this.saveLocal();
    this.emitChange();
    if (created) await this.sync();
    else this.setStatus('idle');
    return { created };
  }

  disconnect() {
    localStorage.removeItem(CFG_KEY);
    localStorage.removeItem(DATA_KEY);
    this.config = null;
    this.api = null;
    this.data = emptyData();
    this.rev = 0;
    this.dirty = false;
    this.loaded = false;
  }

  // Neueste Daten aus dem Drive holen (beim Start und beim Zurückkehren in die App).
  async pull() {
    if (!this.api) return;
    if (!navigator.onLine) { this.setStatus('offline'); return; }
    this.setStatus('saving');
    try {
      const res = await this.api.load();
      if (res.exists) {
        const server = res.data;
        if (this.dirty) {
          this.data = mergeData(this.data, server);
        } else {
          this.data = { ...emptyData(), ...server };
        }
        this.rev = server.rev || 0;
      } else {
        // Datei fehlt (z. B. gelöscht): neuen Datensatz mit dem lokalen Stand anlegen.
        this.rev = 0;
        this.dirty = true;
      }
      this.loaded = true;
      this.saveLocal();
      this.emitChange();
      this.setStatus('idle');
      if (this.dirty) await this.sync();
    } catch (err) {
      this.setStatus(err.code === 'network' ? 'offline' : 'error', err.message);
    }
  }

  // Jede Änderung läuft hierüber: lokal sichern und kurz danach ins Drive schreiben.
  update(fn) {
    fn(this.data);
    this.changeSeq++;
    this.dirty = true;
    this.saveLocal();
    this.emitChange();
    this.scheduleSync();
  }

  scheduleSync(delay = 800) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.sync(), delay);
  }

  async sync() {
    if (!this.api) return;
    if (this.syncing) { this.syncAgain = true; return; }
    if (!navigator.onLine) { if (this.dirty) this.setStatus('offline'); return; }
    this.syncing = true;
    try {
      await this.flushPhotoDeletes();
      if (this.dirty) {
        this.setStatus('saving');
        for (let attempt = 0; attempt < 4; attempt++) {
          const seq = this.changeSeq;
          const snapshot = JSON.parse(JSON.stringify({ ...this.data, rev: this.rev }));
          try {
            const res = await this.api.save(snapshot, this.rev);
            this.rev = res.rev;
            this.data.rev = res.rev;
            if (seq === this.changeSeq) this.dirty = false;
            this.saveLocal();
            break;
          } catch (err) {
            if (err.code !== 'conflict') throw err;
            // Jemand anderes hat zwischendurch gespeichert: zusammenführen und erneut speichern.
            const server = err.payload && err.payload.data;
            this.data = mergeData(this.data, server);
            this.rev = server ? server.rev || 0 : 0;
            this.saveLocal();
            this.emitChange();
          }
        }
      }
      this.setStatus(this.dirty ? 'error' : 'idle', this.dirty ? 'Speichern nach mehreren Versuchen fehlgeschlagen' : '');
    } catch (err) {
      this.setStatus(err.code === 'network' ? 'offline' : 'error', err.message);
    } finally {
      this.syncing = false;
      if (this.syncAgain) { this.syncAgain = false; this.scheduleSync(300); }
    }
  }

  queuePhotoDelete(fileId) {
    if (!fileId) return;
    this.pendingPhotoDeletes.push(fileId);
    this.saveLocal();
  }

  async flushPhotoDeletes() {
    while (this.pendingPhotoDeletes.length) {
      await this.api.deletePhoto(this.pendingPhotoDeletes[0]);
      this.pendingPhotoDeletes.shift();
      this.saveLocal();
    }
  }

  // ---------- Abfragen (gelöschte Einträge ausblenden) ----------
  live(c) { return (this.data[c] || []).filter((x) => !x.deleted); }
  get(c, id) { return (this.data[c] || []).find((x) => x.id === id && !x.deleted) || null; }
  people() { return this.live('people').sort((a, b) => a.name.localeCompare(b.name, 'de')); }
  locations() { return this.live('locations'); }
  visitsOf(locationId) {
    return this.live('visits').filter((v) => v.locationId === locationId)
      .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));
  }
  dishesOf(visitId) { return this.live('dishes').filter((d) => d.visitId === visitId); }
  dishesAt(locationId) {
    const visitIds = new Set(this.visitsOf(locationId).map((v) => v.id));
    return this.live('dishes').filter((d) => visitIds.has(d.visitId));
  }

  // ---------- Schreiben ----------
  put(data, c, obj) {
    obj.updatedAt = Date.now();
    const list = data[c];
    const i = list.findIndex((x) => x.id === obj.id);
    if (i >= 0) list[i] = obj; else list.push(obj);
    return obj;
  }

  remove(data, c, id) {
    const item = data[c].find((x) => x.id === id);
    if (item) { item.deleted = true; item.updatedAt = Date.now(); }
  }
}

export const store = new Store();
export { ApiError };
