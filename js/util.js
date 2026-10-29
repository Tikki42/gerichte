// Kleine Hilfsfunktionen ohne Abhängigkeiten.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------- Text ----------

export const cleanName = s => String(s ?? '').replace(/\s+/g, ' ').trim();
export const capFirst = s => (s ? s.charAt(0).toLocaleUpperCase('de-DE') + s.slice(1) : s);
// Schlüssel für Namensvergleiche: Groß-/Kleinschreibung und Leerzeichen egal
export const nameKey = s => cleanName(s).toLocaleLowerCase('de-DE');
// Für die Suche zusätzlich Akzente/Umlaute vereinfachen ("hahnchen" findet "Hähnchen")
export const fold = s => String(s ?? '').toLocaleLowerCase('de-DE').normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss');

export const byName = (a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' });

// ---------- Datum ----------

export const nowISO = () => new Date().toISOString();
const pad = n => String(n).padStart(2, '0');
export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayYMD = () => ymd(new Date());
export const isYMD = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

function parseYMD(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Tag um n Tage verschieben (negativ = zurück), Ergebnis "JJJJ-MM-TT"
export function addDaysYMD(dateYMD, n) {
  const d = parseYMD(dateYMD);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
export const weekdayShort = dateYMD => WEEKDAYS[parseYMD(dateYMD).getDay()];

export function daysSince(dateYMD) {
  if (!dateYMD) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((today - parseYMD(dateYMD)) / 86400000);
}

export function relDays(dateYMD) {
  const d = daysSince(dateYMD);
  if (d === null) return 'noch nie';
  if (d <= 0) return 'heute';
  if (d === 1) return 'gestern';
  if (d < 14) return `vor ${d} Tagen`;
  if (d < 60) return `vor ${Math.round(d / 7)} Wochen`;
  if (d < 365) return `vor ${Math.round(d / 30)} Monaten`;
  const y = Math.round(d / 365);
  return y === 1 ? 'vor einem Jahr' : `vor ${y} Jahren`;
}

const toDate = v => (v instanceof Date ? v : isYMD(v) ? parseYMD(v) : new Date(v));

// "24.10." (mit Jahr, falls nicht das aktuelle)
export function fmtShort(v) {
  if (!v) return '–';
  const d = toDate(v);
  const s = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.`;
  return d.getFullYear() === new Date().getFullYear() ? s : s + d.getFullYear();
}
export function fmtDate(v) {
  if (!v) return '–';
  const d = toDate(v);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}
export function fmtDateTime(v) {
  if (!v) return '–';
  const d = toDate(v);
  return `${fmtDate(d)}, ${pad(d.getHours())}:${pad(d.getMinutes())} Uhr`;
}

export function fmtBytes(n) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------- Binärdaten ----------

export function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// "data:image/jpeg;base64,..." -> { type, buf } ; wirft bei ungültigen Daten
export function dataUrlToBuf(url) {
  const m = /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(url || '');
  if (!m) throw new Error('kein gültiges Bild');
  const bin = atob(m[2].replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (bytes.length < 100) throw new Error('Bild ist leer');
  return { type: m[1].toLowerCase(), buf: bytes.buffer };
}

export const isStandalone = () =>
  window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;

export function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
export function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* egal */ }
}
