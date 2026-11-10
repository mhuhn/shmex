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

  // Bei „keine Verbindung“: herausfinden, ob das Script überhaupt öffentlich erreichbar ist.
  async diagnose() {
    if (!navigator.onLine) return 'offline';
    try {
      const res = await fetch(this.url, { method: 'GET', redirect: 'follow' });
      const text = await res.text();
      return text.includes('shmex-Brücke') ? 'post-failed' : 'unexpected';
    } catch (err) {
      return 'unreachable';
    }
  }

  async ping() {
    try {
      return await this.call('ping');
    } catch (err) {
      if (err.code !== 'network') throw err;
      const messages = {
        offline: 'Kein Internet. Bitte mit Netz erneut versuchen.',
        unreachable: 'Das Apps Script ist nicht öffentlich erreichbar. Meist ist die Web-App mit „Zugriff: Jeder mit Google-Konto“ statt „Jeder“ bereitgestellt. Test: Die URL in Safari öffnen, dort muss „shmex-Brücke läuft“ stehen.',
        'post-failed': 'Das Apps Script ist erreichbar, bricht beim Verbinden aber ab. Meist fehlt die Drive-Berechtigung oder FOLDER_URL stimmt nicht. Fehlermeldung in Apps Script unter „Ausführungen“ ansehen, korrigieren und eine neue Version bereitstellen.',
        unexpected: 'Unter der URL läuft nicht die shmex-Brücke. Wurde nach dem Einfügen des Codes eine neue Version bereitgestellt?',
      };
      throw new ApiError(messages[await this.diagnose()], 'network');
    }
  }
  load() { return this.call('load'); }
  save(data, baseRev) { return this.call('save', { data, baseRev }, { timeout: 45000 }); }
  uploadPhoto(photoId, base64) { return this.call('uploadPhoto', { photoId, base64, mime: 'image/jpeg' }, { timeout: 60000 }); }
  getPhoto(fileId) { return this.call('getPhoto', { fileId }, { timeout: 45000 }); }
  deletePhoto(fileId) { return this.call('deletePhoto', { fileId }); }
}
