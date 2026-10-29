// Gemeinsame Regeln für den Abgleich: Zeitstempel (hybride Uhr) und Zusammenführen von Datensätzen.
// Wird von der App und vom Server (server/src) genutzt, damit beide Seiten genau gleich rechnen.
// Ohne Abhängigkeiten, ohne Zugriff auf Browser oder Datenbank.

export const PROTO = 1; // Version des Abgleich-Protokolls (steht in jeder Server-Adresse: /api/1/…)

// ---------- Hybride Uhr ----------
// Zeitstempel "MMMMMMMMMMMMMMM-ZZZZ-GGGGGGGG": Millisekunden (15 Stellen), Zähler (4 Stellen), Gerät (8 Zeichen).
// Als Text sortierbar. Die Uhr läuft nie rückwärts und bleibt nie hinter einem gesehenen Zeitstempel zurück.
// So stimmt die Reihenfolge auch dann, wenn eine Geräte-Uhr etwas falsch geht.

export const TS_RE = /^\d{15}-\d{4}-[0-9a-z]{8}$/;
export const NODE_RE = /^[0-9a-z]{8}$/;
export const tsMs = ts => (ts ? Number(ts.slice(0, 15)) : 0);
const fmt = (ms, n, node) => `${String(ms).padStart(15, '0')}-${String(n).padStart(4, '0')}-${node}`;

export function makeClock(node, now = () => Date.now()) {
  if (!NODE_RE.test(node)) throw new Error('Ungültige Geräte-Kennung für die Uhr');
  let ms = 0;
  let n = 0;
  return {
    node,
    next() {
      const t = Math.floor(now());
      if (t > ms) {
        ms = t;
        n = 0;
      } else if (++n > 9999) {
        ms++;
        n = 0;
      }
      return fmt(ms, n, node);
    },
    // Einen fremden Zeitstempel gesehen: Die nächsten eigenen liegen danach.
    see(ts) {
      if (typeof ts !== 'string' || !TS_RE.test(ts)) return;
      const rm = tsMs(ts);
      const rn = Number(ts.slice(16, 20));
      if (rm > ms || (rm === ms && rn > n)) {
        ms = rm;
        n = rn;
      }
    },
  };
}

// ---------- Datensätze ----------
// Schlüssel "Art:ID", z. B. "dish:…", "cook:Gericht-ID|JJJJ-MM-TT", "photo:Gericht-ID", "info:export".
// Inhalt { f: { Feld: Wert }, t: { Feld: Zeitstempel } }.

export const KINDS = ['dish', 'ing', 'method', 'cook', 'photo', 'info'];
// IDs dürfen fast alles enthalten (importierte Gerichte haben beliebige IDs), nur keine Steuerzeichen
// eslint-disable-next-line no-control-regex
export const KEY_RE = /^(dish|ing|method|cook|photo|info):[^\u0000-\u001f]{1,200}$/;
export const MAX_FIELDS = 60;
export const MAX_REC_BYTES = 64 * 1024;

export const keyOf = (kind, id) => `${kind}:${id}`;
export function splitKey(key) {
  const i = key.indexOf(':');
  return [key.slice(0, i), key.slice(i + 1)];
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

// Führt einen fremden Stand in einen eigenen zusammen: Pro Feld gewinnt der spätere Zeitstempel.
// Bei Gleichstand (kommt praktisch nicht vor) gewinnt der größere Wert als Text – so rechnen alle gleich.
// Felder, die nur im eigenen Stand stehen, bleiben erhalten. Ergebnis: { f, t, changed }.
export function mergeRec(local, remote) {
  const f = { ...(local?.f || {}) };
  const t = { ...(local?.t || {}) };
  let changed = false;
  for (const k of Object.keys(remote.f || {})) {
    const rv = remote.f[k];
    const rt = remote.t?.[k] || '';
    const lt = t[k] || '';
    const wins = !(k in f) || rt > lt || (rt === lt && JSON.stringify(rv) > JSON.stringify(f[k]));
    if (!wins) continue;
    if (rt !== lt || !same(rv, f[k]) || !(k in f)) changed = true;
    f[k] = rv;
    if (rt) t[k] = rt;
    else delete t[k];
  }
  return { f, t, changed };
}

// Prüft einen Datensatz { key, f, t } von außen. Ergebnis: Fehlertext oder null.
export function checkRec(rec, { needTs = true } = {}) {
  if (!isObj(rec) || typeof rec.key !== 'string' || !KEY_RE.test(rec.key)) return 'Schlüssel ungültig';
  if (!isObj(rec.f)) return 'Felder fehlen';
  const fields = Object.keys(rec.f);
  if (fields.length > MAX_FIELDS) return 'zu viele Felder';
  if (needTs) {
    if (!isObj(rec.t)) return 'Zeitstempel fehlen';
    for (const [k, ts] of Object.entries(rec.t)) {
      if (!(k in rec.f)) return 'Zeitstempel ohne Feld';
      if (typeof ts !== 'string' || !TS_RE.test(ts)) return 'Zeitstempel ungültig';
    }
  }
  if (JSON.stringify(rec).length > MAX_REC_BYTES) return 'Datensatz zu groß';
  return null;
}

// ---------- Datensätze vom Server prüfen (seit 2.0.2) ----------
// Die App übernimmt nicht blind, was der Server schickt: Ein fehlerhafter Datensatz (eine Zahl, wo eine Liste stehen
// muss, ein Kochtag ohne Datum …) darf die App weder lahmlegen noch Text einschleusen. Felder mit falscher Art
// werden weggelassen (null ist immer erlaubt: entfernte Felder werden null), unbekannte Felder bleiben unverändert.

const isStr = v => typeof v === 'string';
const isBool = v => typeof v === 'boolean';
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isStrList = v => Array.isArray(v) && v.every(isStr);
const isVersion = v => isStr(v) && /^[\w-]{1,64}$/.test(v); // Foto-Version steckt in einer Server-Adresse

const FIELD_TYPES = {
  dish: {
    name: isStr, ingredientIds: isStrList, methodIds: isStrList, tags: isStrList, note: isStr, link: isStr, diet: isStr,
    effort: isNum, cookCountBase: isNum, quick: isBool, mealPrep: isBool, cold: isBool, meatOptional: isBool,
    favorite: isBool, createdAt: isStr, deleted: isStr, purged: isBool,
  },
  ing: { name: isStr, replacedBy: isStr, createdAt: isStr, deleted: isStr, purged: isBool },
  method: { name: isStr, icon: isStr, order: isNum, createdAt: isStr, deleted: isStr, purged: isBool },
  cook: { deleted: isBool, purged: isBool },
  photo: { v: isVersion, purged: isBool },
  info: { at: isStr, by: isStr, purged: isBool },
};

export const COOK_ID_RE = /^.+\|\d{4}-\d{2}-\d{2}$/; // Kochtag: "Gericht-ID|JJJJ-MM-TT"

// Ergebnis: bereinigter Datensatz { key, f, t } oder null (ganz verwerfen)
export function cleanRec(rec) {
  if (!isObj(rec) || !isStr(rec.key) || !KEY_RE.test(rec.key) || !isObj(rec.f)) return null;
  const [kind, id] = splitKey(rec.key);
  if (kind === 'cook' && !COOK_ID_RE.test(id)) return null;
  const types = FIELD_TYPES[kind] || {};
  const times = isObj(rec.t) ? rec.t : {};
  const f = {};
  const t = {};
  for (const [k, v] of Object.entries(rec.f)) {
    if (k === '__proto__') continue;
    if (v !== null && Object.prototype.hasOwnProperty.call(types, k) && !types[k](v)) continue;
    f[k] = v;
    if (isStr(times[k]) && TS_RE.test(times[k])) t[k] = times[k];
  }
  return { key: rec.key, f, t };
}
