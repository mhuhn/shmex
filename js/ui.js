// Kleine UI-Helfer: Escaping, Sterne, Skalen, Toast, Sheet.

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const STAR_PATH = 'M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z';

export function stars(value, label = 'Bewertung') {
  if (!value) return '';
  const v = Math.round(value);
  let html = `<span class="stars" role="img" aria-label="${esc(label)}: ${String(value).replace('.', ',')} von 5">`;
  for (let i = 1; i <= 5; i++) html += `<svg class="s${i <= v ? ' on' : ''}" viewBox="0 0 24 24" aria-hidden="true"><path d="${STAR_PATH}"/></svg>`;
  return html + '</span>';
}

export function starInput(field, value) {
  let html = `<div class="star-input" role="group" aria-label="Gesamtwertung">`;
  for (let i = 1; i <= 5; i++) {
    html += `<button type="button" class="${value && i <= value ? 'on' : ''}" data-field="${field}" data-value="${i}" aria-label="${i} Stern${i > 1 ? 'e' : ''}" aria-pressed="${value === i}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="${STAR_PATH}"/></svg></button>`;
  }
  return html + '</div>';
}

export function scaleInput(field, value, left, right, label) {
  let html = `<div class="scale" role="group" aria-label="${esc(label)}">`;
  for (let i = 1; i <= 5; i++) {
    html += `<button type="button" class="${value === i ? 'on' : ''}" data-field="${field}" data-value="${i}" aria-pressed="${value === i}">${i}</button>`;
  }
  return html + `</div><div class="scale-labels"><span>${esc(left)}</span><span>${esc(right)}</span></div>`;
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return esc(((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : '')).toUpperCase());
}

export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtNum(n) {
  return n.toLocaleString('de-DE', { maximumFractionDigits: 1, minimumFractionDigits: n % 1 ? 1 : 0 });
}

let toastTimer = null;
export function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

export const icons = {
  chev: '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  map: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14"/></svg>',
  locate: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
  camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 23s-7-7-7-12.5A7 7 0 0 1 19 10.5C19 16 12 23 12 23z"/><circle cx="12" cy="10.5" r="2.6" fill="#fff" stroke="none"/></svg>',
};

// Sheet: Dialog, der von unten hereinfährt. Nur einer gleichzeitig.
let currentSheet = null;
export function openSheet({ title, body, onMount, onClose }) {
  closeSheet();
  const host = document.getElementById('sheet');
  host.innerHTML = `<div class="sheet-panel" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="sheet-head"><h3>${esc(title)}</h3>
      <button type="button" class="btn ghost small" data-sheet-close>Fertig</button></div>
    <div class="sheet-body">${body}</div></div>`;
  host.hidden = false;
  const panel = host.firstElementChild;
  const sheet = { el: panel.querySelector('.sheet-body'), panel, onClose, close: () => closeSheet() };
  currentSheet = sheet;
  host.onclick = (e) => {
    if (e.target === host || e.target.closest('[data-sheet-close]')) closeSheet();
  };
  if (onMount) onMount(sheet);
  return sheet;
}

export function closeSheet() {
  if (!currentSheet) return;
  const s = currentSheet;
  currentSheet = null;
  const host = document.getElementById('sheet');
  host.hidden = true;
  host.innerHTML = '';
  host.onclick = null;
  if (s.onClose) s.onClose();
}

export function sheetOpen() { return !!currentSheet; }
