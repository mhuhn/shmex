import { store, uid, COLLECTIONS } from './store.js';
import { isValidScriptUrl } from './api.js';
import { getPosition, distance, formatDistance, nearbyPlaces, cachedPlaces } from './geo.js';
import { addPhoto, photoUrl, processQueue, forgetPhoto, copyPhoto } from './photos.js';
import { BUILD_TIME } from './version.js';
import {
  esc, stars, starInput, scaleInput, initials, todayIso, fmtDate, fmtNum, toast, icons,
  openSheet, closeSheet, sheetOpen,
} from './ui.js';

const AUTO_RADIUS = 200;
const AMOUNT_LABELS = { 1: 'wenig', 5: 'reichlich', 6: 'zu viel' };
const VALUE_LABELS = { 1: 'teuer', 5: 'top' };
const OSM_RADIUS = 500;
const README_URL = 'https://github.com/mhuhn/shmex#einrichtung';
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const $content = document.getElementById('content');
const $title = document.getElementById('title');
const $back = document.getElementById('backBtn');
const $tabbar = document.getElementById('tabbar');
const $done = document.getElementById('doneBtn');
const $cancel = document.getElementById('cancelBtn');

const state = {
  view: null,
  params: {},
  stack: [],
  tab: 'here',
  pos: null,
  posError: '',
  locating: false,
  places: null,
  placesLoading: false,
  placesError: '',
  pickTouched: false,
  current: null,
  pendingLocs: {},
  list: { q: '', sort: 'recent', min: 0 },
  pendingRender: false,
};

const thumbCache = new Map();

// ---------------------------------------------------------------- Navigation

function go(view, params = {}, { replace = false } = {}) {
  if (state.view === 'visit' && view !== 'visit') commitSession();
  if (!replace && state.view) state.stack.push({ view: state.view, params: state.params, scroll: $content.scrollTop });
  state.view = view;
  state.params = params;
  render();
  $content.scrollTop = 0;
}

function back() {
  if (state.view === 'visit') commitSession();
  const prev = state.stack.pop();
  if (!prev) return;
  state.view = prev.view;
  state.params = prev.params;
  render();
  $content.scrollTop = prev.scroll || 0;
}

function switchTab(tab) {
  if (state.view === 'visit') commitSession();
  closeSheet();
  state.tab = tab;
  state.stack = [];
  state.view = null;
  if (tab === 'here') {
    if (state.current && resolveLoc(state.current)) go('location', { locId: state.current });
    else go('pick');
  } else {
    go(tab);
  }
}

function render() {
  const view = VIEWS[state.view];
  if (!view) return;
  const out = view(state.params);
  state.pendingRender = false;
  $title.textContent = out.title;
  $back.hidden = state.stack.length === 0 || !!out.done;
  $done.hidden = !out.done;
  $cancel.hidden = !out.done;
  if (state.view === 'visit' && !store.session) startSession(state.params);
  const setup = state.view === 'setup';
  $tabbar.hidden = setup;
  document.body.classList.toggle('no-tabs', setup);
  for (const b of $tabbar.querySelectorAll('[data-tab]')) b.classList.toggle('active', b.dataset.tab === state.tab);
  $content.innerHTML = out.html;
  if (out.after) out.after();
  loadThumbs($content);
}

// Re-Render bei Datenänderung, aber nicht mitten in einer Eingabe.
function scheduleRender() {
  const a = document.activeElement;
  if (a && $content.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) {
    state.pendingRender = true;
    return;
  }
  render();
}

// ---------------------------------------------------------------- Daten-Helfer

function resolveLoc(id) {
  return store.get('locations', id) || state.pendingLocs[id] || null;
}

function isSaved(id) {
  return !!store.get('locations', id);
}

function ensureLocation(data, locId) {
  if (data.locations.some((l) => l.id === locId && !l.deleted)) return locId;
  const p = state.pendingLocs[locId];
  if (!p) throw new Error('Location fehlt');
  store.put(data, 'locations', { ...p, createdAt: Date.now() });
  delete state.pendingLocs[locId];
  return locId;
}

function ensureVisit(data, params) {
  const existing = data.visits.find((v) => v.id === params.visitId && !v.deleted);
  if (existing) return existing;
  ensureLocation(data, params.locId);
  return store.put(data, 'visits', {
    id: params.visitId, locationId: params.locId, date: params.date || todayIso(),
    personIds: [], rating: null, comment: '', createdAt: Date.now(),
  });
}

function visitPersonIds(visit) {
  const ids = new Set(visit.personIds || []);
  for (const d of store.dishesOf(visit.id)) ids.add(d.personId);
  return [...ids].filter((id) => store.get('people', id));
}

function locRating(locId) {
  const visits = store.visitsOf(locId);
  const vr = visits.map((v) => v.rating).filter(Boolean);
  if (vr.length) return { value: vr.reduce((a, b) => a + b, 0) / vr.length, count: vr.length };
  const dr = store.dishesAt(locId).map((d) => d.rating).filter(Boolean);
  if (dr.length) return { value: dr.reduce((a, b) => a + b, 0) / dr.length, count: 0 };
  return { value: 0, count: 0 };
}

function personName(id) {
  const p = store.get('people', id);
  return p ? p.name : 'Unbekannt';
}

function deletePhotosOf(dishes) {
  for (const d of dishes) if (d.photoId || d.photoFileId) forgetPhoto(d.photoId, d.photoFileId);
}

function locDistance(loc) {
  return state.pos && loc ? distance(state.pos, loc) : null;
}

// ---------------------------------------------------------------- Bearbeitungssitzung (Besuch)
// Jede Änderung wird sofort gespeichert. Damit „Abbrechen“ möglich ist, merkt sich die Sitzung den
// Ausgangsstand und stellt die betroffenen Einträge beim Abbrechen wieder her.

function startSession(params) {
  store.session = {
    params,
    snap: JSON.parse(JSON.stringify(store.data)),
    pending: state.pendingLocs[params.locId] ? { ...state.pendingLocs[params.locId] } : null,
    photoDeletes: [],
  };
}

function sessionIds(data, params) {
  return {
    locations: new Set([params.locId]),
    visits: new Set([params.visitId]),
    dishes: new Set(data.dishes.filter((d) => d.visitId === params.visitId).map((d) => d.id)),
    people: new Set(data.people.map((p) => p.id)),
  };
}

// Liste der Einträge, die sich seit Beginn der Sitzung geändert haben: [collection, id, alt, neu]
function sessionChanges() {
  const s = store.session;
  if (!s) return [];
  const a = sessionIds(s.snap, s.params);
  const b = sessionIds(store.data, s.params);
  const out = [];
  for (const c of COLLECTIONS) {
    for (const id of new Set([...a[c], ...b[c]])) {
      const old = s.snap[c].find((x) => x.id === id) || null;
      const cur = store.data[c].find((x) => x.id === id) || null;
      if (JSON.stringify(old) !== JSON.stringify(cur)) out.push([c, id, old, cur]);
    }
  }
  return out;
}

function commitSession() {
  const s = store.session;
  if (!s) return;
  store.session = null;
  for (const p of s.photoDeletes) forgetPhoto(p.photoId, p.photoFileId, { now: true });
}

function cancelSession() {
  const s = store.session;
  if (!s) return;
  const changes = sessionChanges();
  store.session = null;
  if (changes.length) {
    const oldPhotos = new Set(s.snap.dishes.map((d) => d.photoId).filter(Boolean));
    const now = Date.now();
    // Fotos, die erst in dieser Sitzung dazukamen, wieder entfernen.
    for (const [c, , old, cur] of changes) {
      if (c === 'dishes' && cur && cur.photoId && !oldPhotos.has(cur.photoId) && (!old || old.photoId !== cur.photoId)) {
        forgetPhoto(cur.photoId, cur.photoFileId, { now: true });
      }
    }
    store.update((data) => {
      for (const [c, id, old] of changes) {
        const i = data[c].findIndex((x) => x.id === id);
        const restored = old ? { ...old, updatedAt: now } : null;
        if (restored) {
          if (i >= 0) data[c][i] = restored; else data[c].push(restored);
        } else if (i >= 0) {
          data[c][i] = { ...data[c][i], deleted: true, updatedAt: now };
        }
      }
    });
    if (s.pending) state.pendingLocs[s.params.locId] = s.pending;
  }
}

// ---------------------------------------------------------------- Position & Auswahl

async function locate() {
  state.locating = true;
  state.posError = '';
  if (state.view === 'pick') render();
  try {
    const pos = await getPosition();
    state.pos = { ...pos, source: 'gps' };
  } catch (err) {
    state.posError = err.message;
  }
  state.locating = false;
  afterPosition();
}

function afterPosition() {
  if (state.pos && !state.pickTouched && state.view === 'pick' && tryAutoPick()) {
    loadPlaces();
    return;
  }
  if (state.pos) loadPlaces();
  if (state.view === 'pick') render();
}

// Gibt es gespeicherte Erfahrungen im Umkreis von 200 m, wird die nächstgelegene Location gewählt.
function tryAutoPick() {
  if (!state.pos) return false;
  let best = null;
  for (const loc of store.locations()) {
    if (!store.visitsOf(loc.id).length) continue;
    const d = distance(state.pos, loc);
    if (d <= AUTO_RADIUS && (!best || d < best.d)) best = { loc, d };
  }
  if (!best) return false;
  state.current = best.loc.id;
  go('location', { locId: best.loc.id, auto: true, autoDistance: best.d }, { replace: true });
  return true;
}

async function loadPlaces() {
  if (!state.pos) return;
  const cached = cachedPlaces(state.pos, OSM_RADIUS);
  state.places = cached;
  state.placesLoading = !cached;
  state.placesRefreshing = !!cached;
  state.placesError = '';
  if (state.view === 'pick') renderPickResults();
  const pos = state.pos;
  try {
    const places = await nearbyPlaces(pos, OSM_RADIUS);
    if (state.pos === pos) state.places = places;
  } catch (err) {
    if (!cached) { state.places = null; state.placesError = err.message; }
  }
  state.placesRefreshing = false;
  state.placesLoading = false;
  if (state.view === 'pick') renderPickResults();
}

function choosePending(p) {
  const existing = p.osmId && store.locations().find((l) => l.osmId === p.osmId);
  if (existing) return existing.id;
  const id = uid();
  state.pendingLocs[id] = { id, ...p };
  return id;
}

function openLocationFromPick(locId) {
  state.current = locId;
  state.pickTouched = true;
  go('location', { locId });
}

// ---------------------------------------------------------------- Karte

function openMapSheet({ title, center, zoom, markers = [], onPick }) {
  if (!window.L) {
    toast('Karte kann gerade nicht geladen werden (offline?)');
    return;
  }
  const c = center || { lat: 51.16, lon: 10.45 };
  openSheet({
    title,
    cancel: true,
    body: `<div class="map-wrap"><div class="map" id="mapEl"></div><div class="crosshair">${icons.pin}</div></div>
      <p class="muted small" style="margin-top:10px">Karte verschieben, bis die Nadel an der richtigen Stelle steht.</p>
      <div class="spacer"></div>
      <button type="button" class="btn block" data-map-ok>Position übernehmen</button>`,
    onMount(sheet) {
      const map = window.L.map(sheet.el.querySelector('#mapEl')).setView([c.lat, c.lon], zoom || (center ? 17 : 6));
      window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '© OpenStreetMap-Mitwirkende',
      }).addTo(map);
      for (const m of markers) {
        window.L.circleMarker([m.lat, m.lon], { radius: 6, color: '#3B2A3A', weight: 2, fillColor: '#A9C8F2', fillOpacity: 1 })
          .addTo(map).bindTooltip(m.name);
      }
      setTimeout(() => map.invalidateSize(), 260);
      sheet.el.querySelector('[data-map-ok]').onclick = () => {
        const p = map.getCenter();
        sheet.close();
        onPick({ lat: p.lat, lon: p.lng });
      };
      sheet.onClose = () => map.remove();
    },
  });
}

// ---------------------------------------------------------------- Views

const VIEWS = {};

VIEWS.setup = () => ({
  title: 'shmex',
  html: `<div class="stack">
    <h1>Willkommen bei shmex</h1>
    <p>shmex merkt sich, was wem wo geschmeckt hat. Daten und Fotos liegen in deinem Google Drive.</p>
    <div class="card stack">
      <p class="small">Dafür richtest du einmalig ein kleines Google Apps Script ein, das in deinen Drive-Ordner schreibt.
      Den Freigabelink des Ordners trägst du dort ein. Die Anleitung steht im <a href="${README_URL}" target="_blank" rel="noopener">README</a>.</p>
      <label class="field">Web-App-URL des Apps Scripts
        <input type="url" id="setupUrl" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(store.config ? store.config.url : '')}">
      </label>
      <label class="field">Zugangsschlüssel
        <input type="password" id="setupKey" autocomplete="off" autocapitalize="off" spellcheck="false">
      </label>
      <div id="setupMsg"></div>
      <button type="button" class="btn block" data-action="connect">Verbinden</button>
    </div>
  </div>`,
});

VIEWS.pick = () => {
  let posHtml;
  if (state.locating) {
    posHtml = `<div class="center"><div class="spinner"></div><p class="muted">Position wird ermittelt …</p></div>`;
  } else if (state.pos) {
    const txt = state.pos.source === 'map' ? 'Position auf der Karte gesetzt' : `Position gefunden (± ${state.pos.accuracy} m)`;
    posHtml = `<div class="row"><p class="grow small muted">${esc(txt)}</p></div>
      <div class="row wrap">
        <button type="button" class="btn secondary small" data-action="mapCorrect">${icons.map}Auf Karte korrigieren</button>
        <button type="button" class="btn ghost small" data-action="relocate">${icons.locate}Neu orten</button>
      </div>`;
  } else {
    posHtml = `<div class="banner warn">${esc(state.posError || 'Keine Position')}</div>
      <div class="row wrap">
        <button type="button" class="btn secondary small" data-action="mapCorrect">${icons.map}Auf Karte setzen</button>
        <button type="button" class="btn ghost small" data-action="relocate">${icons.locate}Erneut versuchen</button>
      </div>`;
  }
  return {
    title: 'Wo seid ihr?',
    html: `<div class="card stack">${posHtml}</div>
      <div class="card stack">
        <label class="field">Nicht in der Liste? Eigenen Namen eintragen
          <div class="row"><input type="text" id="customName" class="grow" placeholder="z. B. Pizzawagen am Markt" enterkeyhint="done">
          <button type="button" class="btn small" data-action="createCustom">Anlegen</button></div>
        </label>
      </div>
      <div id="pickResults"></div>`,
    after: renderPickResults,
  };
};

function renderPickResults() {
  const host = document.getElementById('pickResults');
  if (!host) return;
  const pos = state.pos;
  let html = '';
  const saved = pos
    ? store.locations().map((l) => ({ l, d: distance(pos, l) })).filter((x) => x.d <= OSM_RADIUS).sort((a, b) => a.d - b.d)
    : [];
  const savedOsm = new Set(store.locations().map((l) => l.osmId).filter(Boolean));
  const osm = (state.places || []).filter((p) => !savedOsm.has(p.osmId));
  if (saved.length || osm.length > 6) {
    html += `<div class="spacer"></div><input type="search" id="pickFilter" placeholder="Liste filtern" aria-label="Liste filtern" value="${esc(state.filter || '')}">`;
  }
  if (saved.length) {
    html += `<h2>Schon eingetragen</h2><div class="list">${saved.map(({ l, d }) => {
      const r = locRating(l.id);
      return `<button type="button" class="list-item" data-action="pickSaved" data-id="${esc(l.id)}" data-name="${esc(l.name.toLowerCase())}">
        <div class="grow"><div class="title">${esc(l.name)} <span class="badge visited">besucht</span></div>
        <div class="sub">${r.value ? stars(r.value) : ''} ${esc(l.kind || '')}</div></div>
        <span class="dist">${formatDistance(d)}</span>${icons.chev}</button>`;
    }).join('')}</div>`;
  }
  if (pos) {
    html += `<h2>In der Nähe (${OSM_RADIUS} m)</h2>`;
    if (state.placesLoading) {
      html += `<div class="center"><div class="spinner"></div><p class="muted small">Lokale aus OpenStreetMap werden geladen …</p></div>`;
    } else if (state.placesError) {
      html += `<div class="banner error">${esc(state.placesError)}</div><div class="spacer"></div>
        <button type="button" class="btn secondary small" data-action="reloadPlaces">Nochmal versuchen</button>`;
    } else if (!osm.length) {
      html += `<p class="empty">Keine ${saved.length ? 'weiteren ' : ''}Lokale in OpenStreetMap gefunden. Trag oben einfach einen eigenen Namen ein.</p>`;
    } else {
      html += `<div class="list">${osm.map((p) => `<button type="button" class="list-item" data-action="pickOsm" data-id="${esc(p.osmId)}" data-name="${esc(p.name.toLowerCase())}">
        <div class="grow"><div class="title">${esc(p.name)}</div><div class="sub">${esc([p.kind, p.address].filter(Boolean).join(' · ') || 'OpenStreetMap')}</div></div>
        <span class="dist">${formatDistance(p.distance)}</span>${icons.chev}</button>`).join('')}</div>
        <p class="muted small" style="margin-top:8px">${state.placesRefreshing ? 'Liste wird aktualisiert … · ' : ''}Daten © OpenStreetMap-Mitwirkende</p>`;
    }
  }
  host.innerHTML = html;
  applyPickFilter();
}

function applyPickFilter() {
  const q = (state.filter || '').trim().toLowerCase();
  for (const el of $content.querySelectorAll('#pickResults [data-name]')) {
    el.hidden = !!q && !el.dataset.name.includes(q);
  }
}

VIEWS.location = (params) => {
  const loc = resolveLoc(params.locId);
  if (!loc) return { title: 'Nicht gefunden', html: '<p class="empty">Diese Location gibt es nicht mehr.</p>' };
  const saved = isSaved(loc.id);
  const visits = saved ? store.visitsOf(loc.id) : [];
  const dishes = saved ? store.dishesAt(loc.id) : [];
  const r = locRating(loc.id);
  const today = visits.find((v) => v.date === todayIso());
  const visitDate = new Map(visits.map((v) => [v.id, v.date]));
  const d = locDistance(loc);

  let html = '';
  if (params.auto) {
    html += `<div class="banner"><div class="grow">Automatisch erkannt${params.autoDistance != null ? ' – ' + formatDistance(params.autoDistance) + ' entfernt' : ''}.</div>
      <button type="button" class="btn small secondary" data-action="chooseOther">Andere wählen</button></div><div class="spacer"></div>`;
  } else if (state.tab === 'here' && !state.stack.length) {
    html += `<div class="row" style="justify-content:flex-end;margin:-6px 0 6px"><button type="button" class="btn ghost small" data-action="chooseOther">Andere Location wählen</button></div>`;
  }
  html += `<div class="card stack">
    <div><h1>${esc(loc.name)}</h1>
    <div class="meta">${loc.kind ? `<span>${esc(loc.kind)}</span>` : ''}${loc.address ? `<span>${esc(loc.address)}</span>` : ''}${d != null ? `<span>${formatDistance(d)} von hier</span>` : ''}</div></div>
    ${r.value ? `<div class="row">${stars(r.value, 'Besuchswertung')}<span class="small muted">Ø ${fmtNum(r.value)}${r.count ? ` aus ${r.count} Besuchswertung${r.count > 1 ? 'en' : ''}` : ' (Gerichte)'}</span></div>` : ''}
    ${saved ? '' : '<p class="small muted">Wird gespeichert, sobald du etwas einträgst.</p>'}
    <button type="button" class="btn block" data-action="openToday">${icons.plus}${today ? 'Heutigen Besuch bearbeiten' : 'Heutigen Besuch eintragen'}</button>
  </div>`;

  html += '<h2>Wer mag was</h2>';
  if (!dishes.length) {
    html += '<p class="empty">Noch keine Gerichte eingetragen.</p>';
  } else {
    const byPerson = new Map();
    for (const dish of dishes) {
      const key = store.get('people', dish.personId) ? dish.personId : '_';
      if (!byPerson.has(key)) byPerson.set(key, []);
      byPerson.get(key).push(dish);
    }
    const keys = [...byPerson.keys()].sort((a, b) => personName(a).localeCompare(personName(b), 'de'));
    for (const pid of keys) {
      const list = byPerson.get(pid).sort((a, b) => (b.rating || 0) - (a.rating || 0)
        || (visitDate.get(b.visitId) || '').localeCompare(visitDate.get(a.visitId) || ''));
      const name = pid === '_' ? 'Ohne Person' : personName(pid);
      html += `<div class="card person-block"><h3><span class="avatar">${initials(name)}</span>${esc(name)}</h3>
        ${list.map((dish) => dishRow(dish, visitDate.get(dish.visitId))).join('')}</div>`;
    }
  }

  if (visits.length) {
    html += `<h2>Besuche</h2><div class="list">${visits.map((v) => {
      const pc = visitPersonIds(v).length;
      const dc = store.dishesOf(v.id).length;
      return `<button type="button" class="list-item" data-action="openVisit" data-id="${esc(v.id)}">
        <div class="grow"><div class="title">${esc(fmtDate(v.date))} ${stars(v.rating, 'Besuch')}</div>
        <div class="sub">${pc} Person${pc === 1 ? '' : 'en'} · ${dc} Gericht${dc === 1 ? '' : 'e'}${v.comment ? ' · ' + esc(v.comment) : ''}</div></div>${icons.chev}</button>`;
    }).join('')}</div>`;
  }

  html += `<h2>Location</h2><div class="row wrap">
    <button type="button" class="btn secondary small" data-action="renameLoc">${icons.edit}Name ändern</button>
    <button type="button" class="btn secondary small" data-action="moveLoc">${icons.map}Position korrigieren</button>
    ${saved ? `<button type="button" class="btn danger small" data-action="deleteLoc">${icons.trash}Löschen</button>` : ''}
  </div>`;
  return { title: loc.name, html };
};

function dishRow(dish, date) {
  const cls = dish.rating >= 4 ? ' like' : dish.rating && dish.rating <= 2 ? ' dislike' : '';
  const meta = [
    dish.amount ? (dish.amount > 5 ? 'Menge: zu viel' : `Menge ${dish.amount}/5`) : '',
    dish.value ? `Preis/Leistung ${dish.value}/5` : '',
    date ? fmtDate(date) : '',
  ].filter(Boolean).map((t) => `<span>${esc(t)}</span>`).join('');
  return `<button type="button" class="dish${cls}" data-action="editDish" data-id="${esc(dish.id)}" style="width:100%;background:none;border-left:0;border-right:0;border-bottom:0;text-align:left;">
    ${dish.photoId ? `<img class="thumb" src="${BLANK}" data-photo-dish="${esc(dish.id)}" alt="Foto von ${esc(dish.name || 'Gericht')}">` : ''}
    <div class="grow"><div class="name">${esc(dish.name || 'Gericht ohne Namen')}</div>
    ${dish.rating ? `<div>${stars(dish.rating)}</div>` : ''}
    ${meta ? `<div class="meta">${meta}</div>` : ''}
    ${dish.comment ? `<div class="comment">${esc(dish.comment)}</div>` : ''}</div></button>`;
}

VIEWS.visit = (params) => {
  const loc = resolveLoc(params.locId);
  if (!loc) return { title: 'Nicht gefunden', html: '<p class="empty">Diese Location gibt es nicht mehr.</p>' };
  const saved = store.get('visits', params.visitId);
  const v = saved || { id: params.visitId, date: params.date || todayIso(), personIds: [], rating: null, comment: '' };
  const personIds = saved ? visitPersonIds(saved) : [];
  const dishes = saved ? store.dishesOf(saved.id) : [];

  let html = `<div class="card stack">
    <label class="field">Datum<input type="date" data-bind="visitDate" value="${esc(v.date)}"></label>
  </div>
  <h2>Wer war dabei?</h2>`;
  if (!personIds.length) html += '<p class="muted small" style="margin-bottom:10px">Füge die Personen hinzu, dann pro Person die Gerichte.</p>';
  for (const pid of personIds) {
    const own = dishes.filter((d) => d.personId === pid);
    const name = personName(pid);
    html += `<div class="card"><div class="row" style="margin-bottom:${own.length ? 10 : 6}px"><span class="avatar">${initials(name)}</span><h3 class="grow">${esc(name)}</h3>
      ${own.length ? '' : `<button type="button" class="btn ghost small" data-action="removePerson" data-id="${esc(pid)}" aria-label="${esc(name)} entfernen">${icons.close}</button>`}</div>
      ${own.map((d) => `<button type="button" class="dish-btn" data-action="editDish" data-id="${esc(d.id)}">
        ${d.photoId ? `<img class="thumb" style="width:44px;height:44px" src="${BLANK}" data-photo-dish="${esc(d.id)}" alt="">` : ''}
        <div class="grow"><div style="font-weight:700">${esc(d.name || 'Gericht ohne Namen')}</div>${d.rating ? stars(d.rating) : '<span class="small muted">noch keine Wertung</span>'}</div>${icons.chev}</button>`).join('')}
      <div class="spacer"></div>
      <button type="button" class="btn secondary small" data-action="addDish" data-id="${esc(pid)}">${icons.plus}Gericht</button>
    </div>`;
  }
  html += `<div class="spacer"></div><button type="button" class="btn secondary block" data-action="addPerson">${icons.plus}Person hinzufügen</button>
    <h2>Besuch insgesamt</h2>
    <div class="card stack">
      ${starInput('visitRating', v.rating)}
      <textarea data-bind="visitComment" placeholder="Kommentar zum Besuch (optional)" aria-label="Kommentar zum Besuch">${esc(v.comment || '')}</textarea>
    </div>`;
  if (saved) html += `<div class="spacer"></div><div class="spacer"></div><button type="button" class="btn danger block" data-action="deleteVisit">${icons.trash}Besuch löschen</button>`;
  return { title: loc.name, html, done: true };
};

VIEWS.list = () => ({
  title: 'Alle Locations',
  html: `<input type="search" id="listQ" placeholder="Location oder Gericht suchen" aria-label="Suchen" value="${esc(state.list.q)}">
    <div class="spacer"></div>
    <div class="toolbar">
      <select id="listSort" aria-label="Sortierung" class="grow" style="width:auto">
        <option value="recent">Zuletzt besucht</option>
        <option value="name">Name</option>
        <option value="rating">Bewertung</option>
        <option value="distance" ${state.pos ? '' : 'disabled'}>Entfernung</option>
      </select>
      <select id="listMin" aria-label="Mindestwertung">
        <option value="0">Alle</option><option value="3">ab 3 ★</option><option value="4">ab 4 ★</option><option value="5">5 ★</option>
      </select>
    </div>
    <div id="listResults"></div>`,
  after() {
    document.getElementById('listSort').value = state.list.sort;
    document.getElementById('listMin').value = String(state.list.min);
    renderListResults();
  },
});

function renderListResults() {
  const host = document.getElementById('listResults');
  if (!host) return;
  const q = state.list.q.trim().toLowerCase();
  let rows = store.locations().map((l) => {
    const visits = store.visitsOf(l.id);
    const r = locRating(l.id);
    let match = '';
    if (q && !l.name.toLowerCase().includes(q)) {
      const dish = store.dishesAt(l.id).find((d) => (d.name || '').toLowerCase().includes(q));
      if (!dish) return null;
      match = dish.name;
    }
    return { l, visits, r, last: visits[0] ? visits[0].date : '', d: locDistance(l), match };
  }).filter(Boolean);
  if (state.list.min) rows = rows.filter((x) => x.r.value >= state.list.min - 0.25);
  const sorters = {
    recent: (a, b) => b.last.localeCompare(a.last) || a.l.name.localeCompare(b.l.name, 'de'),
    name: (a, b) => a.l.name.localeCompare(b.l.name, 'de'),
    rating: (a, b) => b.r.value - a.r.value || a.l.name.localeCompare(b.l.name, 'de'),
    distance: (a, b) => (a.d ?? Infinity) - (b.d ?? Infinity),
  };
  rows.sort(sorters[state.list.sort] || sorters.recent);
  if (!store.locations().length) {
    host.innerHTML = '<p class="empty">Noch keine Locations. Im Tab „Hier“ legst du die erste an.</p>';
    return;
  }
  if (!rows.length) {
    host.innerHTML = '<p class="empty">Nichts gefunden.</p>';
    return;
  }
  host.innerHTML = `<div class="list">${rows.map((x) => `<button type="button" class="list-item" data-action="openLoc" data-id="${esc(x.l.id)}">
    <div class="grow"><div class="title">${esc(x.l.name)}</div>
    <div class="sub">${x.r.value ? stars(x.r.value) + ' ' : ''}${x.visits.length} Besuch${x.visits.length === 1 ? '' : 'e'}${x.last ? ' · ' + esc(fmtDate(x.last)) : ''}${x.match ? ' · ' + esc(x.match) : ''}</div></div>
    ${x.d != null ? `<span class="dist">${formatDistance(x.d)}</span>` : ''}${icons.chev}</button>`).join('')}</div>`;
}

VIEWS.settings = () => {
  const statusText = {
    idle: store.dirty ? 'Änderungen warten auf Speicherung' : 'Alles im Google Drive gespeichert',
    saving: 'Wird gespeichert …',
    offline: 'Offline – Änderungen werden gespeichert, sobald wieder Netz da ist',
    error: 'Fehler: ' + (store.lastError || 'unbekannt'),
  }[store.status];
  const people = store.people();
  const dishes = store.live('dishes');
  const url = store.config ? store.config.url : '';
  return {
    title: 'Einstellungen',
    html: `<h2 style="margin-top:0">Speicher</h2>
    <div class="card stack">
      <div class="row"><span class="sync-dot ${store.status === 'idle' && !store.dirty ? '' : store.status}"></span><p class="grow">${esc(statusText)}</p></div>
      <p class="small muted" style="word-break:break-all">Apps Script: ${esc(url.replace(/^https:\/\/script\.google\.com\/macros\/s\//, '…/').slice(0, 48))}…</p>
      <button type="button" class="btn secondary block" data-action="syncNow">Jetzt abgleichen</button>
    </div>
    <h2>Personen</h2>
    ${people.length ? `<div class="list">${people.map((p) => {
      const n = dishes.filter((d) => d.personId === p.id).length;
      return `<div class="list-item"><span class="avatar">${initials(p.name)}</span>
        <div class="grow"><div class="title">${esc(p.name)}</div><div class="sub">${n} Gericht${n === 1 ? '' : 'e'}</div></div>
        <button type="button" class="btn ghost small" data-action="renamePerson" data-id="${esc(p.id)}" aria-label="${esc(p.name)} umbenennen">${icons.edit}</button>
        ${n ? '' : `<button type="button" class="btn ghost small" data-action="deletePerson" data-id="${esc(p.id)}" aria-label="${esc(p.name)} löschen">${icons.trash}</button>`}
      </div>`;
    }).join('')}</div>` : '<p class="muted small">Personen legst du beim Eintragen eines Besuchs an.</p>'}
    <h2>Daten</h2>
    <div class="card stack">
      <p class="small muted">${store.locations().length} Locations · ${store.live('visits').length} Besuche · ${dishes.length} Gerichte · ${dishes.filter((d) => d.photoId).length} Fotos</p>
      <button type="button" class="btn secondary block" data-action="exportData">Daten als JSON exportieren</button>
      <button type="button" class="btn danger block" data-action="disconnect">Verbindung trennen</button>
    </div>
    <p class="center muted small" style="margin-top:24px">shmex 1.0</p>`,
  };
};

// ---------------------------------------------------------------- Sheets

function openPersonSheet(params) {
  const renderBody = (sheet) => {
    const visit = store.get('visits', params.visitId);
    const inVisit = new Set(visit ? visitPersonIds(visit) : []);
    const people = store.people();
    sheet.el.innerHTML = `<div class="stack">
      ${people.length ? `<p class="small muted">Antippen zum Hinzufügen oder Entfernen</p>
      <div class="chips">${people.map((p) => `<button type="button" class="chip${inVisit.has(p.id) ? ' on' : ''}" data-person="${esc(p.id)}" aria-pressed="${inVisit.has(p.id)}">${esc(p.name)}</button>`).join('')}</div>` : ''}
      <label class="field">Neue Person
        <div class="row"><input type="text" id="newPerson" class="grow" placeholder="Name" autocapitalize="words" enterkeyhint="done">
        <button type="button" class="btn small" data-new-person>Hinzufügen</button></div>
      </label>
    </div>`;
  };
  openSheet({
    title: 'Wer war dabei?',
    body: '',
    onMount(sheet) {
      renderBody(sheet);
      const addNew = () => {
        const input = sheet.el.querySelector('#newPerson');
        const name = input.value.trim().replace(/\s+/g, ' ');
        if (!name) return;
        const existing = store.people().find((p) => p.name.toLowerCase() === name.toLowerCase());
        store.update((data) => {
          const pid = existing ? existing.id : store.put(data, 'people', { id: uid(), name, createdAt: Date.now() }).id;
          const v = ensureVisit(data, params);
          v.personIds = [...new Set([...(v.personIds || []), pid])];
          v.updatedAt = Date.now();
        });
        renderBody(sheet);
        sheet.el.querySelector('#newPerson').focus();
      };
      sheet.el.addEventListener('click', (e) => {
        const chip = e.target.closest('[data-person]');
        if (chip) {
          const pid = chip.dataset.person;
          const visit = store.get('visits', params.visitId);
          const on = visit && visitPersonIds(visit).includes(pid);
          if (on && store.dishesOf(visit.id).some((d) => d.personId === pid)) {
            toast('Hat schon Gerichte – erst die Gerichte löschen');
            return;
          }
          store.update((data) => {
            const v = ensureVisit(data, params);
            const ids = new Set(v.personIds || []);
            if (on) ids.delete(pid); else ids.add(pid);
            v.personIds = [...ids];
            v.updatedAt = Date.now();
          });
          renderBody(sheet);
        }
        if (e.target.closest('[data-new-person]')) addNew();
      });
      sheet.el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.id === 'newPerson') { e.preventDefault(); addNew(); }
      });
    },
  });
}

// Vorlagen für ein neues Gericht: zuerst Gerichte anderer Personen aus diesem Besuch, dann aus früheren
// Besuchen dieser Location – ohne Gerichte, die die Person in diesem Besuch schon eingetragen hat.
function dishTemplates(visitId, personId, locId) {
  const norm = (s) => String(s || '').trim().toLowerCase();
  const seen = new Set(store.dishesOf(visitId).filter((x) => x.personId === personId).map((x) => norm(x.name)));
  const out = [];
  const visits = store.visitsOf(locId);
  const current = visits.find((v) => v.id === visitId);
  const ordered = current ? [current, ...visits.filter((v) => v.id !== visitId)] : visits;
  for (const v of ordered) {
    const own = store.dishesOf(v.id)
      .filter((x) => x.name && (v.id !== visitId || x.personId !== personId))
      .sort((a, b) => (b.rating || 0) - (a.rating || 0));
    for (const dish of own) {
      const key = norm(dish.name);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ dish, date: v.date, today: v.id === visitId });
      if (out.length >= 8) return out;
    }
  }
  return out;
}

function openDishSheet({ dishId, personId, params }) {
  const existing = dishId ? store.get('dishes', dishId) : null;
  const d = existing ? { ...existing } : {
    id: uid(), visitId: params.visitId, personId, name: '', rating: null, amount: null, value: null,
    comment: '', photoId: null, photoFileId: null, createdAt: Date.now(),
  };
  const visitParams = existing
    ? { visitId: existing.visitId, locId: (store.get('visits', existing.visitId) || {}).locationId }
    : params;
  const visit = store.get('visits', d.visitId);
  const suggestions = [...new Set(store.dishesAt(visitParams.locId).map((x) => x.name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
  const templates = existing ? [] : dishTemplates(d.visitId, d.personId, visitParams.locId);
  let timer = null;

  const commit = () => {
    clearTimeout(timer);
    timer = null;
    store.update((data) => {
      const v = ensureVisit(data, visitParams);
      if (!(v.personIds || []).includes(d.personId)) v.personIds = [...(v.personIds || []), d.personId];
      const cur = data.dishes.find((x) => x.id === d.id);
      // Foto-Kennungen aus dem Speicher übernehmen (Upload kann zwischendurch fertig geworden sein).
      if (cur && cur.photoId === d.photoId && cur.photoFileId) d.photoFileId = cur.photoFileId;
      store.put(data, 'dishes', { ...d });
    });
  };
  const commitSoon = () => { clearTimeout(timer); timer = setTimeout(commit, 450); };

  openSheet({
    title: `Gericht für ${personName(d.personId)}`,
    body: `<div class="stack">
      ${visit ? `<p class="small muted">Besuch am ${esc(fmtDate(visit.date))}</p>` : ''}
      ${templates.length ? `<div class="field" id="templates">Vorlage übernehmen <span class="small muted" style="font-weight:400">(danach alles anpassbar)</span>
        <div>${templates.map((t, i) => `<button type="button" class="dish-btn" data-template="${i}">
          <div class="grow"><div style="font-weight:700;color:var(--ink)">${esc(t.dish.name)}</div>
          <div class="small muted">${esc(personName(t.dish.personId))}${t.today ? ' · heute' : ' · ' + esc(fmtDate(t.date))}${t.dish.photoId ? ' · mit Foto' : ''}</div></div>
          ${t.dish.rating ? stars(t.dish.rating) : ''}</button>`).join('')}</div></div>` : ''}
      <label class="field">Gericht
        <input type="text" id="dishName" list="dishSuggest" value="${esc(d.name)}" placeholder="z. B. Pizza Funghi" autocapitalize="sentences" enterkeyhint="done">
        <datalist id="dishSuggest">${suggestions.map((s) => `<option value="${esc(s)}"></option>`).join('')}</datalist>
      </label>
      <div class="field">Gesamtwertung <span class="small muted" style="font-weight:400">(optional, nochmal tippen zum Entfernen)</span>
        <div id="ratingWrap">${starInput('rating', d.rating)}</div></div>
      <div class="field">Menge<div id="amountWrap">${scaleInput('amount', d.amount, AMOUNT_LABELS, 'Menge', 6)}</div></div>
      <div class="field">Preis/Leistung<div id="valueWrap">${scaleInput('value', d.value, VALUE_LABELS, 'Preis/Leistung')}</div></div>
      <label class="field">Kommentar<textarea id="dishComment" placeholder="optional, z. B. „zu scharf“ oder „ohne Zwiebeln bestellen“">${esc(d.comment || '')}</textarea></label>
      <div class="field">Foto
        <div id="photoBox"></div>
        <div class="row wrap">
          <label class="btn secondary small">${icons.camera}<span id="photoBtnText">${d.photoId ? 'Anderes Foto' : 'Foto hinzufügen'}</span>
            <input type="file" accept="image/*" id="photoInput" class="sr-only"></label>
          <button type="button" class="btn ghost small" id="photoRemove" ${d.photoId ? '' : 'hidden'}>Foto entfernen</button>
        </div>
      </div>
      ${existing ? `<div class="spacer"></div><button type="button" class="btn danger block" id="dishDelete">${icons.trash}Gericht löschen</button>` : ''}
    </div>`,
    onMount(sheet) {
      const el = sheet.el;
      const showPhoto = async () => {
        const box = el.querySelector('#photoBox');
        el.querySelector('#photoRemove').hidden = !d.photoId;
        el.querySelector('#photoBtnText').textContent = d.photoId ? 'Anderes Foto' : 'Foto hinzufügen';
        if (!d.photoId) { box.innerHTML = ''; return; }
        box.innerHTML = '<p class="small muted">Foto wird geladen …</p>';
        const url = thumbCache.get(d.photoId) || await photoUrl(d);
        if (url) {
          thumbCache.set(d.photoId, url);
          box.innerHTML = `<img class="photo-big" src="${url}" alt="Foto von ${esc(d.name || 'Gericht')}">`;
        } else {
          box.innerHTML = `<p class="small muted">${d.photoFileId ? 'Foto kann gerade nicht geladen werden.' : 'Foto wird noch von einem anderen Gerät hochgeladen.'}</p>`;
        }
      };
      showPhoto();

      el.querySelector('#dishName').addEventListener('input', (e) => { d.name = e.target.value.trim(); commitSoon(); });
      el.querySelector('#dishName').addEventListener('change', (e) => { d.name = e.target.value.trim(); commit(); });
      el.querySelector('#dishComment').addEventListener('input', (e) => { d.comment = e.target.value; commitSoon(); });
      el.addEventListener('click', async (e) => {
        const tb = e.target.closest('[data-template]');
        if (tb) {
          const t = templates[Number(tb.dataset.template)].dish;
          Object.assign(d, { name: t.name, rating: t.rating || null, amount: t.amount || null, value: t.value || null, comment: t.comment || '' });
          el.querySelector('#dishName').value = d.name;
          el.querySelector('#dishComment').value = d.comment;
          el.querySelector('#ratingWrap').innerHTML = starInput('rating', d.rating);
          el.querySelector('#amountWrap').innerHTML = scaleInput('amount', d.amount, AMOUNT_LABELS, 'Menge', 6);
          el.querySelector('#valueWrap').innerHTML = scaleInput('value', d.value, VALUE_LABELS, 'Preis/Leistung');
          el.querySelector('#templates').innerHTML = `<p class="small muted">Vorlage „${esc(t.name)}“ von ${esc(personName(t.personId))} übernommen – alles lässt sich noch ändern.</p>`;
          commit();
          if (t.photoId && !d.photoId) {
            el.querySelector('#photoBox').innerHTML = '<p class="small muted">Foto wird übernommen …</p>';
            const id = await copyPhoto(t);
            if (id && !d.photoId) {
              d.photoId = id;
              d.photoFileId = null;
              commit();
              processQueue();
            } else if (!id) {
              toast('Foto der Vorlage konnte nicht geladen werden');
            }
            showPhoto();
          }
          return;
        }
        const b = e.target.closest('[data-field]');
        if (!b) return;
        const field = b.dataset.field;
        const val = Number(b.dataset.value);
        d[field] = d[field] === val ? null : val;
        if (field === 'rating') el.querySelector('#ratingWrap').innerHTML = starInput('rating', d.rating);
        if (field === 'amount') el.querySelector('#amountWrap').innerHTML = scaleInput('amount', d.amount, AMOUNT_LABELS, 'Menge', 6);
        if (field === 'value') el.querySelector('#valueWrap').innerHTML = scaleInput('value', d.value, VALUE_LABELS, 'Preis/Leistung');
        commit();
      });
      el.querySelector('#photoInput').addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file) return;
        el.querySelector('#photoBox').innerHTML = '<p class="small muted">Foto wird verkleinert …</p>';
        try {
          const old = { photoId: d.photoId, photoFileId: d.photoFileId };
          d.photoId = await addPhoto(file);
          d.photoFileId = null;
          commit();
          processQueue();
          if (old.photoId) forgetPhoto(old.photoId, old.photoFileId);
          thumbCache.delete(old.photoId);
        } catch (err) {
          toast(err.message);
        }
        showPhoto();
      });
      el.querySelector('#photoRemove').addEventListener('click', () => {
        if (!confirm('Foto entfernen?')) return;
        forgetPhoto(d.photoId, d.photoFileId);
        d.photoId = null;
        d.photoFileId = null;
        commit();
        showPhoto();
      });
      const del = el.querySelector('#dishDelete');
      if (del) del.addEventListener('click', () => {
        if (!confirm(`„${d.name || 'Gericht'}“ löschen?`)) return;
        clearTimeout(timer);
        deletePhotosOf([d]);
        store.update((data) => store.remove(data, 'dishes', d.id));
        sheet.onClose = null;
        sheet.close();
        toast('Gericht gelöscht');
      });
      sheet.onClose = () => { if (timer) commit(); };
    },
  });
}

// ---------------------------------------------------------------- Aktionen

const actions = {
  async connect(btn) {
    const url = document.getElementById('setupUrl').value.trim();
    const key = document.getElementById('setupKey').value;
    const msg = document.getElementById('setupMsg');
    if (!isValidScriptUrl(url)) {
      msg.innerHTML = '<div class="banner error">Das ist keine Apps-Script-Web-App-URL. Sie beginnt mit https://script.google.com/macros/s/ und endet auf /exec.</div>';
      return;
    }
    if (!key) { msg.innerHTML = '<div class="banner error">Bitte den Zugangsschlüssel eingeben.</div>'; return; }
    btn.disabled = true;
    btn.textContent = 'Verbinde …';
    msg.innerHTML = '';
    try {
      const { created } = await store.connect(url, key);
      toast(created ? 'Neuer leerer Datensatz im Drive angelegt' : 'Daten aus dem Drive geladen');
      startHere();
    } catch (err) {
      msg.innerHTML = `<div class="banner error">${esc(err.message)}</div>`;
      btn.disabled = false;
      btn.textContent = 'Verbinden';
    }
  },
  relocate() { locate(); },
  reloadPlaces() { loadPlaces(); },
  mapCorrect() {
    const markers = (state.places || []).slice(0, 60);
    openMapSheet({
      title: 'Position korrigieren',
      center: state.pos,
      markers,
      onPick(p) {
        state.pos = { ...p, accuracy: 0, source: 'map' };
        state.posError = '';
        state.places = null;
        render();
        loadPlaces();
      },
    });
  },
  createCustom() {
    const input = document.getElementById('customName');
    const name = input.value.trim();
    if (!name) { toast('Bitte einen Namen eingeben'); input.focus(); return; }
    const create = (pos) => openLocationFromPick(choosePending({ name, lat: pos.lat, lon: pos.lon, kind: '', address: '' }));
    if (state.pos) create(state.pos);
    else openMapSheet({ title: 'Wo ist „' + name + '“?', center: null, onPick: create });
  },
  pickSaved(el) { openLocationFromPick(el.dataset.id); },
  pickOsm(el) {
    const p = (state.places || []).find((x) => x.osmId === el.dataset.id);
    if (!p) return;
    openLocationFromPick(choosePending({ name: p.name, lat: p.lat, lon: p.lon, osmId: p.osmId, kind: p.kind, address: p.address }));
  },
  chooseOther() {
    state.pickTouched = true;
    state.current = null;
    go('pick', {}, { replace: true });
    if (!state.places && !state.placesLoading) loadPlaces();
  },
  openToday() {
    const locId = state.params.locId;
    const today = isSaved(locId) && store.visitsOf(locId).find((v) => v.date === todayIso());
    go('visit', today ? { locId, visitId: today.id } : { locId, visitId: uid(), date: todayIso() });
  },
  openVisit(el) {
    const v = store.get('visits', el.dataset.id);
    if (v) go('visit', { locId: v.locationId, visitId: v.id });
  },
  openLoc(el) { go('location', { locId: el.dataset.id }); },
  editDish(el) { openDishSheet({ dishId: el.dataset.id, params: state.params }); },
  addDish(el) { openDishSheet({ dishId: null, personId: el.dataset.id, params: state.params }); },
  addPerson() { openPersonSheet(state.params); },
  removePerson(el) {
    const params = state.params;
    store.update((data) => {
      const v = ensureVisit(data, params);
      v.personIds = (v.personIds || []).filter((id) => id !== el.dataset.id);
      v.updatedAt = Date.now();
    });
  },
  visitRating(el) {
    const val = Number(el.dataset.value);
    const params = state.params;
    const cur = store.get('visits', params.visitId);
    updateVisit(params, { rating: cur && cur.rating === val ? null : val });
  },
  deleteVisit() {
    const params = state.params;
    if (!confirm('Diesen Besuch mit allen Gerichten und Fotos löschen?')) return;
    const dishes = store.dishesOf(params.visitId);
    deletePhotosOf(dishes);
    store.update((data) => {
      for (const d of dishes) store.remove(data, 'dishes', d.id);
      store.remove(data, 'visits', params.visitId);
    });
    toast('Besuch gelöscht');
    back();
  },
  renameLoc() {
    const id = state.params.locId;
    const loc = resolveLoc(id);
    const name = prompt('Name der Location', loc.name);
    if (!name || !name.trim()) return;
    if (isSaved(id)) {
      store.update((data) => {
        const l = data.locations.find((x) => x.id === id);
        l.name = name.trim();
        l.updatedAt = Date.now();
      });
    } else {
      loc.name = name.trim();
      render();
    }
  },
  moveLoc() {
    const id = state.params.locId;
    const loc = resolveLoc(id);
    openMapSheet({
      title: 'Position korrigieren',
      center: { lat: loc.lat, lon: loc.lon },
      onPick(p) {
        if (isSaved(id)) {
          store.update((data) => {
            const l = data.locations.find((x) => x.id === id);
            l.lat = p.lat;
            l.lon = p.lon;
            l.updatedAt = Date.now();
          });
        } else {
          loc.lat = p.lat;
          loc.lon = p.lon;
          render();
        }
        toast('Position gespeichert');
      },
    });
  },
  deleteLoc() {
    const id = state.params.locId;
    const loc = resolveLoc(id);
    if (!confirm(`„${loc.name}“ mit allen Besuchen, Gerichten und Fotos löschen?`)) return;
    const visits = store.visitsOf(id);
    const dishes = store.dishesAt(id);
    deletePhotosOf(dishes);
    store.update((data) => {
      for (const d of dishes) store.remove(data, 'dishes', d.id);
      for (const v of visits) store.remove(data, 'visits', v.id);
      store.remove(data, 'locations', id);
    });
    if (state.current === id) state.current = null;
    toast('Location gelöscht');
    if (state.stack.length) back(); else switchTab(state.tab);
  },
  async syncNow(btn) {
    btn.disabled = true;
    await store.pull();
    await store.sync();
    processQueue();
    toast(store.status === 'idle' ? 'Abgeglichen' : 'Abgleich nicht möglich');
    render();
  },
  renamePerson(el) {
    const p = store.get('people', el.dataset.id);
    const name = prompt('Neuer Name', p.name);
    if (!name || !name.trim()) return;
    store.update((data) => {
      const x = data.people.find((q) => q.id === p.id);
      x.name = name.trim();
      x.updatedAt = Date.now();
    });
  },
  deletePerson(el) {
    const p = store.get('people', el.dataset.id);
    if (!confirm(`${p.name} löschen?`)) return;
    store.update((data) => {
      store.remove(data, 'people', p.id);
      for (const v of data.visits) {
        if ((v.personIds || []).includes(p.id)) {
          v.personIds = v.personIds.filter((id) => id !== p.id);
          v.updatedAt = Date.now();
        }
      }
    });
  },
  async exportData() {
    const json = JSON.stringify(store.data, null, 2);
    const name = `shmex-export-${todayIso()}.json`;
    const file = new File([json], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); } catch (e) { /* abgebrochen */ }
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },
  disconnect() {
    if (!confirm('Verbindung zum Google Drive trennen? Die Daten im Drive bleiben erhalten.')) return;
    store.disconnect();
    state.stack = [];
    state.current = null;
    go('setup', {}, { replace: true });
  },
};

function updateVisit(params, patch) {
  store.update((data) => {
    const v = ensureVisit(data, params);
    Object.assign(v, patch);
    v.updatedAt = Date.now();
  });
}

function startHere() {
  state.tab = 'here';
  state.stack = [];
  state.view = null;
  state.pickTouched = false;
  go('pick', {}, { replace: true });
  locate();
}

// ---------------------------------------------------------------- Thumbnails

function loadThumbs(root) {
  for (const img of root.querySelectorAll('[data-photo-dish]')) {
    const dish = store.get('dishes', img.dataset.photoDish);
    if (!dish || !dish.photoId) continue;
    const cached = thumbCache.get(dish.photoId);
    if (cached) { img.src = cached; continue; }
    photoUrl(dish).then((url) => {
      if (!url) return;
      thumbCache.set(dish.photoId, url);
      if (img.isConnected) img.src = url;
    });
  }
}

// ---------------------------------------------------------------- Events

$content.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action], [data-field]');
  if (!el || !$content.contains(el)) return;
  if (el.dataset.field === 'visitRating') { actions.visitRating(el); return; }
  const fn = actions[el.dataset.action];
  if (fn) fn(el, e);
});

let visitCommentTimer = null;
$content.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'pickFilter') { state.filter = t.value; applyPickFilter(); return; }
  if (t.id === 'listQ') { state.list.q = t.value; renderListResults(); return; }
  if (t.dataset.bind === 'visitComment') {
    const params = state.params;
    const value = t.value;
    clearTimeout(visitCommentTimer);
    visitCommentTimer = setTimeout(() => updateVisit(params, { comment: value }), 500);
  }
});

$content.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'listSort') { state.list.sort = t.value; renderListResults(); return; }
  if (t.id === 'listMin') { state.list.min = Number(t.value); renderListResults(); return; }
  if (t.dataset.bind === 'visitDate' && t.value) updateVisit(state.params, { date: t.value });
  if (t.dataset.bind === 'visitComment') {
    clearTimeout(visitCommentTimer);
    updateVisit(state.params, { comment: t.value });
  }
});

$content.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'customName') { e.preventDefault(); actions.createCustom(); }
});

$content.addEventListener('focusout', () => {
  setTimeout(() => {
    const a = document.activeElement;
    const typing = a && $content.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
    if (state.pendingRender && !typing) render();
  }, 0);
});

$back.addEventListener('click', () => { closeSheet(); back(); });
$tabbar.addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  if (b.dataset.tab === 'here' && state.tab === 'here' && !state.stack.length && state.view === 'pick') {
    locate();
    return;
  }
  switchTab(b.dataset.tab);
});
// ✕ oben links: Bearbeitung des Besuchs verwerfen.
$cancel.addEventListener('click', () => {
  clearTimeout(visitCommentTimer);
  const comment = $content.querySelector('[data-bind=visitComment]');
  const cur = store.get('visits', state.params.visitId);
  const typed = comment && (cur ? cur.comment || '' : '') !== comment.value;
  if ((sessionChanges().length || typed) && !confirm('Änderungen an diesem Besuch verwerfen?')) return;
  closeSheet();
  cancelSession();
  back();
  toast('Änderungen verworfen');
});

// Haken oben rechts auf Bearbeitungsscreens: offene Eingaben übernehmen und zurück.
$done.addEventListener('click', () => {
  const a = document.activeElement;
  if (a && $content.contains(a)) a.blur(); // löst „change“ aus und speichert z. B. den Kommentar
  clearTimeout(visitCommentTimer);
  const comment = $content.querySelector('[data-bind=visitComment]');
  if (comment && state.view === 'visit') {
    const cur = store.get('visits', state.params.visitId);
    if ((cur ? cur.comment || '' : '') !== comment.value) updateVisit(state.params, { comment: comment.value });
  }
  closeSheet();
  if (store.dirty) store.sync();
  back();
});

// Speicherstatus nur bei Problemen melden (Details unter Einstellungen).
let lastStatus = store.status;
store.addEventListener('status', () => {
  const s = store.status;
  if (s !== lastStatus) {
    if (s === 'error') toast('Speichern fehlgeschlagen – Details unter Einstellungen');
    if (s === 'offline' && store.dirty) toast('Offline – Änderungen werden später gespeichert');
  }
  lastStatus = s;
  if (state.view === 'settings') scheduleRender();
});

store.addEventListener('change', () => {
  if (state.view === 'pick') {
    if (!state.pickTouched && tryAutoPick()) return;
    renderPickResults();
    return;
  }
  if (state.view !== 'setup') scheduleRender();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !store.configured) return;
  if (store.dirty) store.sync(); else store.pull();
  processQueue();
});
window.addEventListener('online', () => processQueue());

// ---------------------------------------------------------------- Update-Anzeige

// Zeigt links in der Tableiste, wie viele Minuten der Commit dieser App-Version her ist (nur die ersten 30 min).
function updateBuildAge() {
  const el = document.getElementById('buildAge');
  const t = Date.parse(BUILD_TIME);
  const min = Math.max(0, Math.floor((Date.now() - t) / 60000));
  const show = isFinite(t) && min < 30;
  el.hidden = !show;
  if (show) {
    // Frisch: dunkelgrau, mit zunehmendem Alter heller, bei 30 min fast so hell wie der Hintergrund.
    const f = Math.min(1, (Date.now() - t) / (30 * 60000));
    const mix = (a, b) => Math.round(a + (b - a) * f);
    el.style.color = `rgb(${mix(64, 238)}, ${mix(68, 240)}, ${mix(76, 243)})`;
    el.textContent = min + ' min';
    el.title = 'Diese App-Version wurde vor ' + min + ' Minuten veröffentlicht';
  }
}
updateBuildAge();
setInterval(updateBuildAge, 20000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') updateBuildAge(); });

// ---------------------------------------------------------------- Start

if ('serviceWorker' in navigator) {
  // Neue Version aktiv geworden: einmal neu laden, damit alle Dateien zusammenpassen.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    // Nicht mitten in einer Bearbeitung neu laden, sondern sobald sie abgeschlossen ist.
    const tryReload = () => {
      if (state.view === 'visit' || sheetOpen()) setTimeout(tryReload, 2000);
      else location.reload();
    };
    tryReload();
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
    .then((reg) => {
      reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    })
    .catch(() => {});
}

if (!store.configured) {
  state.tab = 'here';
  go('setup', {}, { replace: true });
} else {
  startHere();
  store.pull().then(() => processQueue());
}
