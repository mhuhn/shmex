// Spricht mit der Apps-Script-Brücke im Google Drive des Nutzers.
// Alle Aufrufe sind POST mit text/plain, damit der Browser keinen CORS-Preflight schickt.

export class ApiError extends Error {
  constructor(message, code, payload) {
    super(message);
    this.code = code;
    this.payload = payload;
  }
}

export function isValidScriptUrl(url) {
  return /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec\/?$/.test(String(url || '').trim());
}

export class Api {
  constructor(url, key) {
    this.url = String(url || '').trim();
    this.key = String(key || '');
  }

  async call(action, payload = {}, { timeout = 30000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        body: JSON.stringify({ ...payload, action, key: this.key }),
        redirect: 'follow',
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new ApiError(err.name === 'AbortError' ? 'Zeitüberschreitung beim Speicher' : 'Keine Verbindung zum Speicher', 'network');
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new ApiError('Speicher antwortet mit Fehler ' + res.status, 'http');
    let json;
    try {
      json = await res.json();
    } catch (err) {
      throw new ApiError('Antwort ist kein JSON. Ist die Web-App mit Zugriff „Jeder“ bereitgestellt?', 'format');
    }
    if (!json.ok) throw new ApiError(json.error || 'Unbekannter Fehler', json.code || 'server', json);
    return json;
  }

  ping() { return this.call('ping'); }
  load() { return this.call('load'); }
  save(data, baseRev) { return this.call('save', { data, baseRev }, { timeout: 45000 }); }
  uploadPhoto(photoId, base64) { return this.call('uploadPhoto', { photoId, base64, mime: 'image/jpeg' }, { timeout: 60000 }); }
  getPhoto(fileId) { return this.call('getPhoto', { fileId }, { timeout: 45000 }); }
  deletePhoto(fileId) { return this.call('deletePhoto', { fileId }); }
}
