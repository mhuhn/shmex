/**
 * shmex – Brücke zwischen der shmex-App und deinem Google Drive.
 *
 * Einrichtung (einmalig), siehe README.md im Repo:
 *  1. Unter https://script.google.com ein neues Projekt anlegen und diesen Code einfügen.
 *  2. Unten FOLDER_URL (Freigabelink deines Drive-Ordners) und ACCESS_KEY (selbst ausgedacht) eintragen.
 *  3. Bereitstellen → Neue Bereitstellung → Typ „Web-App“
 *       Ausführen als: Ich
 *       Zugriff: Jeder
 *  4. Die angezeigte Web-App-URL (endet auf /exec) und den ACCESS_KEY in der App eingeben.
 *
 * Wichtig: Nach jeder Änderung an diesem Code eine NEUE Version bereitstellen
 * (Bereitstellungen verwalten → Bearbeiten → Version: Neue Version), sonst läuft weiter der alte Code.
 */

// Freigabelink des Google-Drive-Ordners, in dem shmex seine Daten ablegt.
// Leer lassen, dann legt das Script in deinem Drive einen Ordner „shmex“ an.
const FOLDER_URL = '';

// Selbst ausgedachter Zugangsschlüssel. Dieselbe Zeichenfolge gibst du in der App ein.
// Bitte unbedingt ändern – wer URL und Schlüssel kennt, kann die Daten lesen und ändern.
const ACCESS_KEY = 'BITTE-AENDERN';

const DATA_FILE = 'shmex-daten.json';
const PHOTO_FOLDER = 'shmex-fotos';
const MAX_PHOTO_BYTES = 150 * 1024;

function doGet() {
  return ContentService.createTextOutput('shmex-Brücke läuft. Diese URL in der shmex-App eintragen.');
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return out_({ ok: false, error: 'Ungültige Anfrage' });
  }
  try {
    if (!ACCESS_KEY || ACCESS_KEY === 'BITTE-AENDERN') {
      return out_({ ok: false, code: 'setup', error: 'Im Apps Script ist noch kein eigener ACCESS_KEY eingetragen.' });
    }
    if (body.key !== ACCESS_KEY) {
      return out_({ ok: false, code: 'auth', error: 'Falscher Zugangsschlüssel' });
    }
    switch (body.action) {
      case 'ping':
        return out_({ ok: true, folder: folder_().getName() });
      case 'load':
        return out_(load_());
      case 'save':
        return out_(save_(body));
      case 'uploadPhoto':
        return out_(uploadPhoto_(body));
      case 'getPhoto':
        return out_(getPhoto_(body));
      case 'deletePhoto':
        return out_(deletePhoto_(body));
      default:
        return out_({ ok: false, error: 'Unbekannte Aktion: ' + body.action });
    }
  } catch (err) {
    return out_({ ok: false, error: String((err && err.message) || err) });
  }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function folder_() {
  const url = String(FOLDER_URL || '').trim();
  if (url) {
    const m = url.match(/folders\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/) || url.match(/^([a-zA-Z0-9_-]{20,})$/);
    if (!m) throw new Error('FOLDER_URL ist kein gültiger Drive-Ordner-Link.');
    return DriveApp.getFolderById(m[1]);
  }
  const it = DriveApp.getRootFolder().getFoldersByName('shmex');
  return it.hasNext() ? it.next() : DriveApp.getRootFolder().createFolder('shmex');
}

function photoFolder_() {
  const parent = folder_();
  const it = parent.getFoldersByName(PHOTO_FOLDER);
  return it.hasNext() ? it.next() : parent.createFolder(PHOTO_FOLDER);
}

function dataFile_() {
  const it = folder_().getFilesByName(DATA_FILE);
  return it.hasNext() ? it.next() : null;
}

function readData_() {
  const f = dataFile_();
  if (!f) return null;
  const text = f.getBlob().getDataAsString('UTF-8');
  return text ? JSON.parse(text) : null;
}

function load_() {
  const data = readData_();
  return data ? { ok: true, exists: true, data: data } : { ok: true, exists: false };
}

function save_(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const current = readData_();
    const currentRev = current ? Number(current.rev || 0) : 0;
    if (Number(body.baseRev || 0) !== currentRev) {
      return { ok: false, code: 'conflict', data: current };
    }
    const data = body.data || {};
    data.rev = currentRev + 1;
    data.savedAt = new Date().toISOString();
    const json = JSON.stringify(data);
    const f = dataFile_();
    if (f) {
      f.setContent(json);
    } else {
      folder_().createFile(DATA_FILE, json, 'application/json');
    }
    return { ok: true, rev: data.rev };
  } finally {
    lock.releaseLock();
  }
}

function uploadPhoto_(body) {
  const bytes = Utilities.base64Decode(String(body.base64 || ''));
  if (!bytes.length) throw new Error('Leeres Foto');
  if (bytes.length > MAX_PHOTO_BYTES) throw new Error('Foto zu groß');
  const name = String(body.photoId || Utilities.getUuid()).replace(/[^a-zA-Z0-9_-]/g, '') + '.jpg';
  const folder = photoFolder_();
  const existing = folder.getFilesByName(name);
  if (existing.hasNext()) return { ok: true, fileId: existing.next().getId() };
  const file = folder.createFile(Utilities.newBlob(bytes, 'image/jpeg', name));
  return { ok: true, fileId: file.getId() };
}

function ownPhoto_(fileId) {
  const file = DriveApp.getFileById(String(fileId));
  const folderId = photoFolder_().getId();
  const parents = file.getParents();
  while (parents.hasNext()) {
    if (parents.next().getId() === folderId) return file;
  }
  throw new Error('Foto gehört nicht zu shmex');
}

function getPhoto_(body) {
  const file = ownPhoto_(body.fileId);
  const blob = file.getBlob();
  return { ok: true, mime: blob.getContentType() || 'image/jpeg', base64: Utilities.base64Encode(blob.getBytes()) };
}

function deletePhoto_(body) {
  try {
    ownPhoto_(body.fileId).setTrashed(true);
  } catch (err) {
    // Schon gelöscht oder nicht vorhanden – für die App kein Fehler.
  }
  return { ok: true };
}
