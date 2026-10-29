// Datenmodell und alle Operationen, die Daten verändern.
//
// Gespeichert wird je Datensatz das Objekt wie bisher, dazu "_t": je Feld der Zeitstempel der letzten Änderung
// (hybride Uhr aus js/sync-core.js). So lassen sich Stände verschiedener Geräte Feld für Feld zusammenführen.
// raw = gespeicherte Datensätze (auch gelöschte), state = daraus abgeleitete Sicht für die Oberfläche.
// Gelöschte Gerichte kommen in den Papierkorb ("deleted" = Zeitpunkt), nach 30 Tagen werden sie endgültig entfernt.
// Ist das Gerät in einer Sammlung, kommt jede Änderung zusätzlich in die Warteschlange "queue" (siehe js/sync.js).
// Alles wird zuerst in IndexedDB gespeichert und erst danach im Speicher übernommen.

import * as db from './db.js';
import { makeClock, mergeRec, keyOf, splitKey, tsMs } from './sync-core.js';
import { uuid, todayYMD, isYMD, cleanName, capFirst, nameKey } from './util.js';

export const DEFAULT_METHODS = [
  { id: 'herd', name: 'Herd', icon: '🍳' },
  { id: 'ofen', name: 'Ofen', icon: '🔥' },
  { id: 'heissluft', name: 'Heißluftfritteuse', icon: '💨' },
  { id: 'mikrowelle', name: 'Mikrowelle', icon: '⚡' },
  { id: 'ohne', name: 'ohne Kochen', icon: '🥗' },
];

export const EFFORT = {
  1: 'Kaufen & aufwärmen',
  2: 'Mittlerer Aufwand',
  3: 'Größerer eigener Aufwand',
};

export const DIETS = [
  ['vegan', 'Vegan'],
  ['vegetarisch', 'Vegetarisch'],
];

// Ja/Nein-Optionen eines Gerichts (Reihenfolge wie im Formular)
export const OPTIONS = [
  ['quick', 'Blitzgericht'],
  ['mealPrep', 'Fürs Vorkochen geeignet'],
  ['cold', 'Kaltes Gericht'],
  ['meatOptional', 'Fleisch ergänzbar'],
];
export const DIET_LABEL = Object.fromEntries(DIETS);

export const TRASH_DAYS = 30;
const DAY = 86400000;

// Datensatz-Art (Schlüssel beim Abgleich) -> Speicher in IndexedDB
const STORES = { dish: 'dishes', ing: 'ingredients', method: 'methods', cook: 'cooks', photo: 'photostate', info: 'shared' };
const KIND_OF = Object.fromEntries(Object.entries(STORES).map(([k, s]) => [s, k]));
const SYNC_STORES = Object.values(STORES);
// Felder, die nur auf diesem Gerät gelten (abgeleitet oder Verwaltung) und nicht abgeglichen werden
const LOCAL_FIELDS = {
  dishes: ['id', '_t', 'lastCooked', 'cookCount', 'updatedAt'],
  cooks: ['id', '_t', 'dishId', 'day', 'ts'],
};
const localFields = store => LOCAL_FIELDS[store] || ['id', '_t', 'updatedAt'];

const raw = Object.fromEntries(SYNC_STORES.map(s => [s, new Map()]));

export const state = {
  dishes: new Map(),      // Gericht-ID -> Gericht ohne gelöschte, mit abgeleiteten Feldern
  trash: new Map(),       // Gericht-ID -> gelöschtes Gericht („Zuletzt gelöscht“)
  ingredients: new Map(), // ohne gelöschte, außer sie werden noch verwendet
  methods: new Map(),
  thumbs: new Map(),      // Gericht-ID -> Object-URL des kleinen Vorschaubilds
  cooks: new Map(),       // Gericht-ID -> Map(Tag -> Kochtag-Eintrag), auch gelöschte Tage
  queue: new Map(),       // Schlüssel -> { key, rev, upload }: Änderungen, die noch zum Server müssen
  meta: {},
};
const thumbVer = new Map(); // Gericht-ID -> Version des gespeicherten Vorschaubilds

// js/sync.js meldet sich hier an (keine gegenseitigen Importe): changed = neue Einträge in der Warteschlange,
// fetchPhoto(id, ver, size) = Foto vom Server holen.
const hooks = { changed: () => {}, fetchPhoto: null };
export const setSyncHooks = h => Object.assign(hooks, h);

// ---------- Uhr ----------

let clock = null;
// Zeit des Servers, soweit bekannt (Abweichung der Geräte-Uhr wird beim Verbinden gemessen)
export const syncNow = () => Date.now() + (state.meta.syncOffset || 0);
const stampISO = () => new Date(syncNow()).toISOString();
const isoOfTs = ts => (ts ? new Date(tsMs(ts)).toISOString() : null);

function startClock(seeLocal) {
  clock = makeClock(state.meta.node, syncNow);
  if (!seeLocal) return;
  for (const m of Object.values(raw)) for (const r of m.values()) for (const ts of Object.values(r._t || {})) clock.see(ts);
}

// ---------- Laden ----------

export async function load() {
  const names = [...SYNC_STORES, 'thumbs', 'queue', 'meta'];
  const all = Object.fromEntries(names.map((n, i) => [n, i]));
  const data = await Promise.all(names.map(db.getAll));
  for (const s of SYNC_STORES) raw[s] = new Map(data[all[s]].map(r => [r.id, r]));
  state.queue = new Map(data[all.queue].map(q => [q.key, q]));
  state.meta = Object.fromEntries(data[all.meta].map(m => [m.key, m.value]));
  for (const url of state.thumbs.values()) URL.revokeObjectURL(url);
  state.thumbs = new Map();
  thumbVer.clear();
  for (const t of data[all.thumbs]) setThumb(t.id, t);
  if (!state.meta.node) await setMeta({ node: randomNode() });
  if (!state.meta.firstUse) await setMeta({ firstUse: new Date().toISOString() });
  startClock(true);
  // Neue Geräte bekommen die üblichen Zubereitungsarten – nicht in einer Sammlung, die bringt ihre eigenen mit
  if (!raw.methods.size && state.meta.deviceType !== 'synced') {
    const now = stampISO();
    const defaults = DEFAULT_METHODS.map((m, i) => ({ ...m, order: i, createdAt: now }));
    await db.write(['methods'], s => defaults.forEach(m => s.methods.put(m)));
    defaults.forEach(m => raw.methods.set(m.id, m));
  }
  await removeGrillOnce();
  await migrateCooksOnce();
  await migratePhotosOnce();
  await purgeLocalTrash();
  rebuild();
}

function randomNode() {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  return [...crypto.getRandomValues(new Uint8Array(8))].map(b => chars[b % 36]).join('');
}

// Einmalig (Version 1.4.0): Zubereitungsart "Grill" entfernen – nur wenn kein Gericht sie nutzt.
async function removeGrillOnce() {
  if (state.meta.grillRemoved) return;
  const remove = raw.methods.has('grill') && ![...raw.dishes.values()].some(d => (d.methodIds || []).includes('grill'));
  await db.write(['methods', 'meta'], s => {
    if (remove) s.methods.delete('grill');
    putMeta(s.meta, { grillRemoved: true });
  });
  if (remove) raw.methods.delete('grill');
  state.meta.grillRemoved = true;
}

// Einmalig (Version 1.5.0): Kochtage als eigene Einträge. Der bisherige letzte Kochtag wird der erste Eintrag,
// die Gesamtzahl bleibt gleich (frühere Male ohne Datum zählen als cookCountBase).
async function migrateCooksOnce() {
  if (state.meta.cooksMigrated) return;
  const ts = stampISO();
  const recs = [];
  const dishes = [];
  for (const d of raw.dishes.values()) {
    if (d.cookCountBase !== undefined) continue;
    const day = isYMD(d.lastCooked) ? d.lastCooked : null;
    const count = Number.isInteger(d.cookCount) && d.cookCount > 0 ? d.cookCount : 0;
    const base = Math.max(0, count - (day ? 1 : 0));
    if (day) recs.push({ id: cookKey(d.id, day), dishId: d.id, day, deleted: false, ts });
    dishes.push({ ...d, cookCountBase: base });
  }
  await db.write(['cooks', 'dishes', 'meta'], s => {
    recs.forEach(r => s.cooks.put(r));
    dishes.forEach(d => s.dishes.put(d));
    putMeta(s.meta, { cooksMigrated: true });
  });
  recs.forEach(r => raw.cooks.set(r.id, r));
  dishes.forEach(d => raw.dishes.set(d.id, d));
  state.meta.cooksMigrated = true;
}

// Einmalig (Version 2.0.0): Jedes Foto bekommt eine Versionsnummer, damit Geräte wissen, welches Foto aktuell ist.
async function migratePhotosOnce() {
  if (state.meta.photosMigrated) return;
  const [photos, thumbs] = await Promise.all([db.getAll('photos'), db.getAll('thumbs')]);
  const ver = new Map();
  for (const r of [...photos, ...thumbs]) if (!r.ver && !ver.has(r.id)) ver.set(r.id, raw.photostate.get(r.id)?.v || uuid());
  await db.write(['photos', 'thumbs', 'photostate', 'meta'], s => {
    for (const r of photos) if (!r.ver) s.photos.put({ ...r, ver: ver.get(r.id) });
    for (const r of thumbs) if (!r.ver) s.thumbs.put({ ...r, ver: ver.get(r.id) });
    for (const [id, v] of ver) if (!raw.photostate.has(id)) s.photostate.put({ id, v });
    putMeta(s.meta, { photosMigrated: true });
  });
  for (const [id, v] of ver) {
    if (!raw.photostate.has(id)) raw.photostate.set(id, { id, v });
    thumbVer.set(id, v);
  }
  state.meta.photosMigrated = true;
}

// Ohne Sammlung leert das Gerät seinen Papierkorb selbst (in einer Sammlung macht das der Server)
async function purgeLocalTrash() {
  if (state.meta.deviceType === 'synced') return;
  const cutoff = Date.now() - TRASH_DAYS * DAY;
  const old = [...raw.dishes.values()].filter(d => d.deleted && Date.parse(d.deleted) < cutoff);
  if (!old.length) return;
  const cooks = [...raw.cooks.values()].filter(c => old.some(d => d.id === c.dishId));
  await db.write(['dishes', 'cooks', 'photos', 'thumbs', 'photostate'], s => {
    for (const d of old) ['dishes', 'photos', 'thumbs', 'photostate'].forEach(n => s[n].delete(d.id));
    cooks.forEach(c => s.cooks.delete(c.id));
  });
  for (const d of old) {
    raw.dishes.delete(d.id);
    raw.photostate.delete(d.id);
    setThumb(d.id, null);
  }
  cooks.forEach(c => raw.cooks.delete(c.id));
}

// ---------- Sicht für die Oberfläche ----------

// Zusammengeführte Zutaten zeigen auf ihr Ziel ("replacedBy"); ein Gericht mit der alten Zutat zeigt das Ziel.
function resolver() {
  return id => {
    let cur = id;
    for (let i = 0; i < 20; i++) {
      const next = raw.ingredients.get(cur)?.replacedBy;
      if (!next || !raw.ingredients.has(next)) break;
      cur = next;
    }
    return cur;
  };
}

const viewOf = obj => {
  const v = { ...obj };
  delete v._t;
  return v;
};

// Zeitpunkt der letzten Änderung eines Datensatzes (aus den Zeitstempeln, sonst wie früher gespeichert)
function lastChange(obj) {
  const ts = Object.values(obj._t || {}).sort().pop();
  return ts ? isoOfTs(ts) : obj.updatedAt || obj.createdAt || null;
}

function rebuild() {
  const resolve = resolver();
  const cooks = new Map();
  for (const c of raw.cooks.values()) {
    if (c.purged) continue;
    if (!cooks.has(c.dishId)) cooks.set(c.dishId, new Map());
    cooks.get(c.dishId).set(c.day, c);
  }
  const dishes = new Map();
  const trash = new Map();
  for (const d of raw.dishes.values()) {
    if (d.purged) continue;
    const ingredientIds = [];
    for (const x of d.ingredientIds || []) {
      const y = resolve(x);
      if (!ingredientIds.includes(y)) ingredientIds.push(y);
    }
    const view = {
      ...viewOf(d),
      ingredientIds,
      methodIds: [...(d.methodIds || [])],
      tags: [...(d.tags || [])],
      updatedAt: lastChange(d),
    };
    Object.assign(view, derivedCookFields(view, cooks.get(d.id)));
    (d.deleted ? trash : dishes).set(d.id, view);
  }
  const usedIngs = new Set();
  const usedMethods = new Set();
  for (const d of [...dishes.values(), ...trash.values()]) {
    d.ingredientIds.forEach(id => usedIngs.add(id));
    d.methodIds.forEach(id => usedMethods.add(id));
  }
  state.ingredients = new Map([...raw.ingredients.values()]
    .filter(i => (!i.deleted && !i.replacedBy) || usedIngs.has(i.id)).map(i => [i.id, viewOf(i)]));
  state.methods = new Map([...raw.methods.values()].filter(m => !m.deleted || usedMethods.has(m.id)).map(m => [m.id, viewOf(m)]));
  state.dishes = dishes;
  state.trash = trash;
  state.cooks = cooks;
}

const blobUrl = rec => URL.createObjectURL(new Blob([rec.data], { type: rec.type || 'image/jpeg' }));

function setThumb(id, rec) {
  if (state.thumbs.has(id)) URL.revokeObjectURL(state.thumbs.get(id));
  if (rec) {
    state.thumbs.set(id, blobUrl(rec));
    thumbVer.set(id, rec.ver || null);
  } else {
    state.thumbs.delete(id);
    thumbVer.delete(id);
  }
}

// Großes Foto: aus dem Speicher, sonst – in einer Sammlung – vom Server (danach zwischengespeichert).
// Ohne Verbindung bleibt es beim gespeicherten (notfalls älteren) Foto.
export async function fullPhoto(id) {
  const want = raw.photostate.get(id)?.v;
  const rec = await db.get('photos', id);
  if (rec && (!want || rec.ver === want)) return rec;
  if (want && hooks.fetchPhoto) {
    const got = await hooks.fetchPhoto(id, want, 'full').catch(() => null);
    if (got) return got;
  }
  return rec || null;
}

export async function photoUrl(id) {
  const rec = await fullPhoto(id);
  return rec ? blobUrl(rec) : null;
}

// ---------- Meta ----------

export const canEdit = () => !!state.meta.deviceType && state.meta.deviceType !== 'reader';
export const isSynced = () => state.meta.deviceType === 'synced' && !!state.meta.sync;

function putMeta(store, obj) {
  for (const [key, value] of Object.entries(obj)) store.put({ key, value });
}

export async function setMeta(obj) {
  await db.write(['meta'], s => putMeta(s.meta, obj));
  Object.assign(state.meta, obj);
}

// ---------- Speichern ----------

// Vergibt Zeitstempel für alle Felder, die sich gegenüber prev geändert haben. Entfernte Felder werden null.
function stamp(store, prev, next) {
  const skip = localFields(store);
  const t = { ...(prev?._t || {}) };
  for (const k of new Set([...Object.keys(prev || {}), ...Object.keys(next)])) {
    if (skip.includes(k)) continue;
    if (next[k] === undefined) next[k] = null;
    const before = prev?.[k];
    if (before === undefined || JSON.stringify(before) !== JSON.stringify(next[k])) t[k] = clock.next();
  }
  next._t = t;
  return next;
}

// Abgeglichene Felder eines Datensatzes { key, f, t }
function toRec(store, obj) {
  const skip = localFields(store);
  const f = {};
  for (const [k, v] of Object.entries(obj)) if (!skip.includes(k) && v !== undefined) f[k] = v;
  const t = {};
  for (const [k, ts] of Object.entries(obj._t || {})) if (k in f) t[k] = ts;
  return { key: keyOf(KIND_OF[store], obj.id), f, t };
}

function fromRec(store, id, f, t, prev) {
  const obj = { ...f, id, _t: t };
  if (store === 'cooks') {
    const i = id.lastIndexOf('|');
    obj.dishId = id.slice(0, i);
    obj.day = id.slice(i + 1);
    obj.ts = isoOfTs(t.deleted) || prev?.ts || stampISO();
  }
  return obj;
}

// Speichert Datensätze und Fotos in EINER Transaktion und baut danach die Sicht neu auf.
// puts: [{ store, obj }], dels: [{ store, id }] (nur zum endgültigen Entfernen), blobs: [{ store, id, rec? }].
// queue: in die Warteschlange stellen (nur in einer Sammlung; nicht bei Änderungen, die vom Server kommen).
// uploads: Schlüssel von Fotos, die erst noch hochgeladen werden müssen.
async function commit({ puts = [], dels = [], blobs = [], uploads = new Set(), meta = {}, queue = true } = {}) {
  const q = new Map();
  if (queue && isSynced()) {
    for (const { store, obj } of puts) {
      const key = keyOf(KIND_OF[store], obj.id);
      const old = q.get(key) || state.queue.get(key);
      const upload = store === 'photostate' && !!obj.v && (uploads.has(key) || !!old?.upload);
      q.set(key, { key, rev: (old?.rev || 0) + 1, upload });
    }
  }
  const qdels = dels.map(d => keyOf(KIND_OF[d.store], d.id)).filter(k => state.queue.has(k));
  const stores = new Set(['meta']);
  for (const x of [...puts, ...dels, ...blobs]) stores.add(x.store);
  if (q.size || qdels.length) stores.add('queue');
  const patch = { dataStand: stampISO(), ...meta };
  await db.write([...stores], s => {
    for (const { store, obj } of puts) s[store].put(obj);
    for (const { store, id } of dels) s[store].delete(id);
    for (const b of blobs) b.rec ? s[b.store].put(b.rec) : s[b.store].delete(b.id);
    for (const e of q.values()) s.queue.put(e);
    qdels.forEach(k => s.queue.delete(k));
    putMeta(s.meta, patch);
  });
  for (const { store, obj } of puts) raw[store].set(obj.id, obj);
  for (const { store, id } of dels) raw[store].delete(id);
  for (const b of blobs) if (b.store === 'thumbs') setThumb(b.id, b.rec || null);
  for (const e of q.values()) state.queue.set(e.key, e);
  qdels.forEach(k => state.queue.delete(k));
  Object.assign(state.meta, patch);
  rebuild();
  if (q.size) hooks.changed();
}

const put = (store, prev, next) => ({ store, obj: stamp(store, prev, next) });

// Alle Änderungen laufen streng nacheinander: Jede rechnet mit dem Stand, den die vorige gespeichert hat.
// Sonst könnte eine Änderung vom Server, die während des Speicherns ankommt, eine eigene überschreiben.
// Nur die öffentlichen Funktionen laufen hierüber, untereinander rufen sie sich darin nicht auf.
let lock = Promise.resolve();
function serial(fn) {
  const run = lock.then(fn);
  lock = run.catch(() => {});
  return run;
}

// ---------- Lesen ----------

export const dishList = () => [...state.dishes.values()];
export const ingName = id => state.ingredients.get(id)?.name ?? raw.ingredients.get(id)?.name ?? '?';
export const trashList = () => [...state.trash.values()].sort((a, b) => String(b.deleted).localeCompare(String(a.deleted)));

export function methodList() {
  return [...state.methods.values()].sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.name.localeCompare(b.name, 'de'));
}

export function ingredientUsage() {
  const m = new Map();
  for (const d of state.dishes.values()) for (const id of d.ingredientIds) m.set(id, (m.get(id) || 0) + 1);
  return m;
}

export function methodUsage() {
  const m = new Map();
  for (const d of state.dishes.values()) for (const id of d.methodIds) m.set(id, (m.get(id) || 0) + 1);
  return m;
}

export function findIngredient(name) {
  const k = nameKey(name);
  for (const i of state.ingredients.values()) if (nameKey(i.name) === k) return i;
  return null;
}

export function findDishByName(name, exceptId) {
  const k = nameKey(name);
  for (const d of state.dishes.values()) if (d.id !== exceptId && nameKey(d.name) === k) return d;
  return null;
}

// Alle Tags in der zuerst verwendeten Schreibweise, mit Häufigkeit
export function tagUsage() {
  const m = new Map();
  for (const d of state.dishes.values()) {
    for (const t of d.tags || []) {
      const k = nameKey(t);
      const e = m.get(k) || { name: t, count: 0 };
      e.count++;
      m.set(k, e);
    }
  }
  return [...m.values()];
}

// Neue Tags übernehmen die Schreibweise vorhandener Tags
export function normalizeTags(tags) {
  const known = new Map(tagUsage().map(t => [nameKey(t.name), t.name]));
  const out = [];
  const seen = new Set();
  for (const r of tags || []) {
    const t = cleanName(r);
    const k = nameKey(t);
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push(known.get(k) || t);
  }
  return out;
}

// Vorlage für ein neues Gericht. Spätere Felder (Mengen, Schritte, Nährwerte …) können ergänzt werden.
export function blankDish() {
  return {
    id: uuid(),
    name: '',
    ingredientIds: [],
    methodIds: [],
    effort: null,
    diet: null,
    quick: false,        // Blitzgericht
    mealPrep: false,     // fürs Vorkochen geeignet
    cold: false,         // kaltes Gericht
    meatOptional: false, // Fleisch kann extra ergänzt werden
    favorite: false,
    tags: [],
    note: '',
    link: '',
    lastCooked: null,    // abgeleitet aus den Kochtagen
    cookCount: 0,        // abgeleitet: cookCountBase + Zahl der Kochtage
    cookCountBase: 0,    // frühere Male ohne Datum (aus der Zeit vor 1.5.0)
    createdAt: null,
    updatedAt: null,
  };
}

// ---------- Gerichte ändern ----------

// Felder, die das Formular nicht bearbeitet (sie bleiben beim Speichern, wie sie gerade sind)
const NOT_IN_FORM = [...LOCAL_FIELDS.dishes, 'createdAt', 'deleted', 'purged', 'cookCountBase'];
const content = (store, obj) => JSON.stringify(Object.entries(toRec(store, obj).f).sort(([a], [b]) => a.localeCompare(b)));

// ingredients: [{ id } | { name }] – unbekannte Namen werden als neue Zutat angelegt.
// photo: undefined = unverändert, null = entfernen, { full: Blob, thumb: Blob } = neu
// orig: das Gericht, wie es beim Öffnen des Formulars aussah. Übernommen werden nur Angaben, die im Formular
// geändert wurden – so überschreibt Speichern keine Änderung, die inzwischen von einem anderen Gerät kam.
// Ergebnis: { dish, changed } – ohne echte Änderung wird nichts gespeichert.
async function saveDishNow(draft, ingredients, photo, orig = null) {
  const now = stampISO();
  const prev = raw.dishes.get(draft.id);
  const newIngs = [];
  const ids = [];
  for (const it of ingredients) {
    let id = it.id && state.ingredients.has(it.id) ? it.id : null;
    if (!id) {
      const found = findIngredient(it.name) || newIngs.find(n => nameKey(n.name) === nameKey(it.name));
      if (found) id = found.id;
      else {
        const ing = { id: uuid(), name: capFirst(cleanName(it.name)), createdAt: now };
        newIngs.push(ing);
        id = ing.id;
      }
    }
    if (!ids.includes(id)) ids.push(id);
  }
  const form = { ...draft, name: cleanName(draft.name), ingredientIds: ids, tags: normalizeTags(draft.tags) };
  const next = prev ? { ...prev } : { id: draft.id, createdAt: now, deleted: null, cookCountBase: 0 };
  for (const [k, v] of Object.entries(form)) {
    if (NOT_IN_FORM.includes(k)) continue;
    if (!prev || !orig || JSON.stringify(v) !== JSON.stringify(orig[k])) next[k] = v;
  }
  const dishChanged = !prev || content('dishes', prev) !== content('dishes', next);
  if (!dishChanged && photo === undefined && !newIngs.length) {
    return { dish: state.dishes.get(draft.id) || state.trash.get(draft.id), changed: false };
  }
  const puts = newIngs.map(i => put('ingredients', null, i));
  if (dishChanged) puts.push(put('dishes', prev, next));
  const blobs = [];
  const uploads = new Set();
  if (photo !== undefined) {
    const v = photo ? uuid() : null;
    if (photo) {
      const [full, thumb] = await Promise.all([photo.full.arrayBuffer(), photo.thumb.arrayBuffer()]);
      blobs.push({ store: 'photos', id: draft.id, rec: { id: draft.id, data: full, type: 'image/jpeg', ver: v } });
      blobs.push({ store: 'thumbs', id: draft.id, rec: { id: draft.id, data: thumb, type: 'image/jpeg', ver: v } });
      uploads.add(keyOf('photo', draft.id));
    } else {
      blobs.push({ store: 'photos', id: draft.id }, { store: 'thumbs', id: draft.id });
    }
    const ps = raw.photostate.get(draft.id);
    puts.push(put('photostate', ps, { ...ps, id: draft.id, v }));
  }
  await commit({ puts, blobs, uploads });
  return { dish: state.dishes.get(draft.id) || state.trash.get(draft.id), changed: true };
}

async function patchDish(id, fields) {
  const prev = raw.dishes.get(id);
  if (!prev || prev.purged) throw new Error('Dieses Gericht gibt es nicht mehr.');
  await commit({ puts: [put('dishes', prev, { ...prev, ...fields })] });
}

export const setFavorite = (id, favorite) => serial(() => patchDish(id, { favorite }));

// Löschen legt das Gericht in den Papierkorb. Gibt eine Rückgängig-Funktion zurück.
async function deleteDishNow(id) {
  await patchDish(id, { deleted: stampISO() });
  return () => restoreDish(id);
}

export const restoreDish = id => serial(() => patchDish(id, { deleted: null }));

// ---------- Kochtage ----------
// Jeder Kochtag ist ein eigener Eintrag { id: "Gericht-ID|JJJJ-MM-TT", dishId, day, deleted, ts }.
// Gelöschte Tage bleiben mit deleted: true stehen, damit der Abgleich sie zusammenführen kann.
// lastCooked und cookCount im Gericht werden daraus abgeleitet.

export const cookKey = (dishId, day) => `${dishId}|${day}`;

const activeDays = cooks => (cooks ? [...cooks.values()].filter(c => !c.deleted).map(c => c.day).sort() : []);

function derivedCookFields(dish, cooks = state.cooks.get(dish.id)) {
  const days = activeDays(cooks);
  return { lastCooked: days.length ? days[days.length - 1] : null, cookCount: (dish.cookCountBase || 0) + days.length };
}

// Eingetragene Kochtage eines Gerichts, neuester zuerst
export const cookDays = dishId => activeDays(state.cooks.get(dishId)).reverse();

async function writeCooks(dishId, days, deleted) {
  const ts = stampISO();
  await commit({
    puts: days.map(day => {
      const id = cookKey(dishId, day);
      const prev = raw.cooks.get(id);
      return put('cooks', prev, { ...prev, id, dishId, day, deleted, ts });
    }),
  });
}

// Trägt Kochtage ein (heute oder früher, nie in der Zukunft). Gibt eine Rückgängig-Funktion zurück,
// oder null, wenn alle Tage schon eingetragen waren.
async function addCookDaysNow(dishId, days) {
  const today = todayYMD();
  const have = new Set(cookDays(dishId));
  const fresh = [...new Set(days)].filter(day => isYMD(day) && day <= today && !have.has(day));
  if (!fresh.length) return null;
  await writeCooks(dishId, fresh, false);
  return () => removeCookDays(dishId, fresh);
}

// Löscht Kochtage (als Markierung). Gibt eine Rückgängig-Funktion zurück oder null.
async function removeCookDaysNow(dishId, days) {
  const cooks = state.cooks.get(dishId);
  const gone = days.filter(day => cooks?.get(day) && !cooks.get(day).deleted);
  if (!gone.length) return null;
  await writeCooks(dishId, gone, true);
  return () => addCookDays(dishId, gone);
}

// "Heute gekocht": Rückgängig-Funktion oder null, wenn heute schon eingetragen
export const markCooked = id => addCookDays(id, [todayYMD()]);

// ---------- Zutaten ----------

// Gibt { conflict } zurück, wenn es den Namen schon gibt (dann ggf. zusammenführen).
async function renameIngredientNow(id, newName) {
  const name = cleanName(newName);
  if (!name) throw new Error('Der Name darf nicht leer sein.');
  const prev = raw.ingredients.get(id);
  if (name === prev.name) return { ok: true }; // nichts geändert
  const other = findIngredient(name);
  if (other && other.id !== id) return { conflict: other };
  await commit({ puts: [put('ingredients', prev, { ...prev, name })] });
  return { ok: true };
}

// Ersetzt Zutat fromId in allen Gerichten durch intoId. fromId bekommt den Vermerk "ersetzt durch" und gilt als
// gelöscht – so landen auch Gerichte, die ein anderes Gerät gleichzeitig mit fromId speichert, bei intoId.
// Gibt die Zahl der angepassten Gerichte zurück.
async function mergeIngredientNow(fromId, intoId) {
  const resolve = resolver();
  const puts = [];
  let n = 0;
  for (const d of raw.dishes.values()) {
    if (d.purged || !(d.ingredientIds || []).some(x => resolve(x) === fromId)) continue;
    const ids = [];
    for (const x of d.ingredientIds) {
      const y = resolve(x) === fromId ? intoId : x;
      if (!ids.includes(y)) ids.push(y);
    }
    puts.push(put('dishes', d, { ...d, ingredientIds: ids }));
    if (!d.deleted) n++;
  }
  const from = raw.ingredients.get(fromId);
  puts.push(put('ingredients', from, { ...from, replacedBy: intoId, deleted: stampISO() }));
  await commit({ puts });
  return n;
}

async function deleteIngredientNow(id) {
  if (ingredientUsage().get(id)) throw new Error('Die Zutat wird noch verwendet.');
  const prev = raw.ingredients.get(id);
  await commit({ puts: [put('ingredients', prev, { ...prev, deleted: stampISO() })] });
}

// ---------- Zubereitungsarten ----------

async function saveMethodNow({ id, name, icon }) {
  name = cleanName(name);
  if (!name) throw new Error('Der Name darf nicht leer sein.');
  const other = [...state.methods.values()].find(m => nameKey(m.name) === nameKey(name));
  if (other && other.id !== id) throw new Error(`„${other.name}“ gibt es schon.`);
  const prev = id && raw.methods.get(id);
  const order = prev ? prev.order : Math.max(0, ...[...state.methods.values()].map(m => m.order ?? 0)) + 1;
  const m = { ...prev, id: id || uuid(), name, icon: cleanName(icon) || '•', order, createdAt: prev?.createdAt || stampISO() };
  await commit({ puts: [put('methods', prev || null, m)] });
  return state.methods.get(m.id);
}

async function deleteMethodNow(id) {
  if (methodUsage().get(id)) throw new Error('Die Zubereitungsart wird noch verwendet.');
  const prev = raw.methods.get(id);
  await commit({ puts: [put('methods', prev, { ...prev, deleted: stampISO() })] });
}

// ---------- Export-Hinweis ----------
// Der letzte Export gilt für die ganze Sammlung: Exportiert ein Gerät, merken es sich alle.

export function lastExport() {
  const shared = raw.shared.get('export');
  const own = state.meta.lastExportAt;
  return shared?.at && (!own || shared.at > own) ? { at: shared.at, by: shared.by } : own ? { at: own, by: null } : null;
}

// Erinnerung, wenn der letzte Export (oder der erste Start dieser Version) länger als 30 Tage zurückliegt
export const EXPORT_REMIND_DAYS = 30;
export function exportDue(now = Date.now()) {
  if (!canEdit() || !state.dishes.size) return false;
  const since = Date.parse(lastExport()?.at || state.meta.firstUse || '');
  return !Number.isNaN(since) && now - since > EXPORT_REMIND_DAYS * DAY;
}

async function noteExportNow(at, by) {
  const prev = raw.shared.get('export');
  await commit({ puts: [put('shared', prev, { ...prev, id: 'export', at, by })], meta: { lastExportAt: at } });
}

// ---------- Import ----------

// Fotos aus einer Datei bekommen eine neue Version (Foto-Stand je Gericht)
function withPhotoVersions(data) {
  const ver = new Map();
  for (const r of [...(data.photos || []), ...(data.thumbs || [])]) if (!ver.has(r.id)) ver.set(r.id, uuid());
  return {
    ...data,
    photos: (data.photos || []).map(r => ({ ...r, ver: ver.get(r.id) })),
    thumbs: (data.thumbs || []).map(r => ({ ...r, ver: ver.get(r.id) })),
    photostate: [...ver].map(([id, v]) => ({ id, v })),
  };
}

const strip = obj => {
  const o = { ...obj };
  delete o._t;
  return o;
};

// Backup wiederherstellen: ersetzt den kompletten Bestand. In einer Sammlung gilt das für alle Geräte:
// Was nicht in der Datei steht, wird gelöscht (Gerichte kommen in den Papierkorb), alles andere übernommen.
// Dafür muss das Gerät vorher auf dem neuesten Stand sein (prüft die Oberfläche).
async function replaceAllNow(data, metaPatch) {
  const files = withPhotoVersions(data);
  if (!isSynced()) {
    await db.write([...db.DATA_STORES, 'meta'], s => {
      for (const n of db.DATA_STORES) s[n].clear();
      for (const n of db.DATA_STORES) (files[n] || []).forEach(rec => s[n].put(strip(rec)));
      putMeta(s.meta, metaPatch);
    });
    return load();
  }
  const now = stampISO();
  const gone = {
    dishes: d => (d.deleted ? null : { deleted: now }),
    cooks: c => (c.deleted ? null : { deleted: true }),
    photostate: p => (p.v ? { v: null } : null),
    ingredients: i => (i.deleted ? null : { deleted: now }),
    methods: m => (m.deleted ? null : { deleted: now }),
  };
  const puts = [];
  const uploads = new Set();
  for (const [store, removed] of Object.entries(gone)) {
    const incoming = new Map((files[store] || []).map(r => [r.id, r]));
    for (const prev of raw[store].values()) {
      const patch = !incoming.has(prev.id) && !prev.purged && removed(prev);
      if (patch) puts.push(put(store, prev, { ...prev, ...patch }));
    }
    for (const rec of incoming.values()) {
      const next = strip(rec);
      if (store === 'dishes') next.deleted = null;
      puts.push(put(store, raw[store].get(rec.id), next));
      if (store === 'photostate') uploads.add(keyOf('photo', rec.id));
    }
  }
  const withPhoto = new Set(files.photostate.map(p => p.id));
  const blobs = [
    ...files.photos.map(r => ({ store: 'photos', id: r.id, rec: r })),
    ...files.thumbs.map(r => ({ store: 'thumbs', id: r.id, rec: r })),
    ...[...raw.photostate.keys()].filter(id => !withPhoto.has(id)).flatMap(id => [{ store: 'photos', id }, { store: 'thumbs', id }]),
  ];
  await commit({ puts, blobs, uploads, meta: metaPatch });
}

// Fügt Gerichte (plus neue Zutaten/Zubereitungsarten und Fotos) hinzu.
async function addAllNow(data) {
  const files = withPhotoVersions(data);
  const puts = [];
  for (const store of ['ingredients', 'methods', 'dishes', 'cooks', 'photostate']) {
    for (const rec of files[store] || []) puts.push(put(store, raw[store].get(rec.id), { ...strip(rec), ...(store === 'dishes' ? { deleted: null } : {}) }));
  }
  const blobs = [...files.photos.map(r => ({ store: 'photos', id: r.id, rec: r })), ...files.thumbs.map(r => ({ store: 'thumbs', id: r.id, rec: r }))];
  await commit({ puts, blobs, uploads: new Set(files.photostate.map(p => keyOf('photo', p.id))) });
}

// ---------- Abgleich (aufgerufen von js/sync.js) ----------

// Alle Datensätze ohne Zeitstempel – der Anfangsbestand einer neuen Sammlung
export function snapshot() {
  const out = [];
  for (const store of SYNC_STORES) {
    for (const obj of raw[store].values()) {
      if (obj.purged) continue;
      const { key, f } = toRec(store, obj);
      out.push({ key, f });
    }
  }
  return out;
}

// Nach „Neue Sammlung anlegen“: Eigene Zeitstempel verwerfen (beim ersten Abgleich übernimmt das Gerät die des
// Servers), Fotos zum Hochladen vormerken und das Gerät als Teil der Sammlung speichern.
async function becomeSyncedNow(sync, offset) {
  const objs = [];
  for (const store of SYNC_STORES) for (const obj of raw[store].values()) objs.push({ store, obj: strip(obj) });
  const queue = [...raw.photostate.values()].filter(p => p.v && !p.purged).map(p => ({ key: keyOf('photo', p.id), rev: 1, upload: true }));
  const patch = { deviceType: 'synced', sync, syncCursor: 0, syncOffset: offset };
  await db.write([...SYNC_STORES, 'queue', 'meta'], s => {
    objs.forEach(({ store, obj }) => s[store].put(obj));
    s.queue.clear();
    queue.forEach(e => s.queue.put(e));
    putMeta(s.meta, patch);
  });
  objs.forEach(({ store, obj }) => raw[store].set(obj.id, obj));
  state.queue = new Map(queue.map(e => [e.key, e]));
  Object.assign(state.meta, patch);
  startClock(false);
  rebuild();
}

// Nach „Mit Code beitreten“: Die bisherige Kopie wird durch den Stand der Sammlung ersetzt.
async function joinWipeNow(sync, offset) {
  await db.write([...db.DATA_STORES, 'queue', 'meta'], s => {
    for (const n of [...db.DATA_STORES, 'queue']) s[n].clear();
    putMeta(s.meta, { deviceType: 'synced', sync, syncCursor: 0, syncOffset: offset, grillRemoved: true, cooksMigrated: true, photosMigrated: true });
  });
  await load();
}

// Abgleich beenden (oder Gerät wurde entfernt): Die lokale Kopie bleibt, das Gerät ist wieder für sich.
async function leaveSyncNow() {
  await db.write(['queue', 'meta'], s => {
    s.queue.clear();
    putMeta(s.meta, { deviceType: 'main', sync: null, syncCursor: 0 });
  });
  state.queue = new Map();
  Object.assign(state.meta, { deviceType: 'main', sync: null, syncCursor: 0 });
}

// Änderungen vom Server übernehmen (Feld für Feld, der spätere Zeitstempel gewinnt) und den Stand merken.
// Gibt die Gerichte zurück, deren Foto sich geändert hat.
async function applyRemoteNow(recs, cursor) {
  const touched = new Map();
  for (const rec of recs) {
    const [kind, id] = splitKey(rec.key);
    const store = STORES[kind];
    if (!store) continue;
    for (const ts of Object.values(rec.t || {})) clock.see(ts);
    const prev = touched.get(rec.key)?.obj ?? raw[store].get(id);
    const m = mergeRec(prev && toRec(store, prev), rec);
    if (m.changed) touched.set(rec.key, { store, obj: fromRec(store, id, m.f, m.t, prev) });
  }
  const puts = [];
  const dels = [];
  const blobs = [];
  const photos = [];
  for (const { store, obj } of touched.values()) {
    const dropBlobs = () => blobs.push({ store: 'photos', id: obj.id }, { store: 'thumbs', id: obj.id });
    if (obj.purged) {
      dels.push({ store, id: obj.id });
      if (store === 'dishes' || store === 'photostate') dropBlobs();
    } else {
      puts.push({ store, obj });
      if (store === 'photostate') {
        photos.push(obj.id);
        if (!obj.v) dropBlobs();
      }
    }
  }
  if (!touched.size && cursor === state.meta.syncCursor) return photos;
  await commit({ puts, dels, blobs, queue: false, meta: cursor == null ? {} : { syncCursor: cursor } });
  return photos;
}

// Warteschlange: die nächsten Einträge mit dem aktuellen Stand ihres Datensatzes
export function pendingBatch(max = 100) {
  const out = [];
  for (const e of state.queue.values()) {
    const [kind, id] = splitKey(e.key);
    const obj = raw[STORES[kind]]?.get(id);
    out.push(obj ? { ...e, rec: toRec(STORES[kind], obj) } : { ...e, rec: null });
    if (out.length >= max) break;
  }
  return out;
}

// Quittung vom Server: Einträge entfernen, die seitdem nicht noch einmal geändert wurden
async function settleQueueNow(revs) {
  const done = revs.filter(([key, rev]) => state.queue.get(key)?.rev === rev).map(([key]) => key);
  if (!done.length) return;
  await db.write(['queue'], s => done.forEach(k => s.queue.delete(k)));
  done.forEach(k => state.queue.delete(k));
}

async function markUploadedNow(key, rev) {
  const e = state.queue.get(key);
  if (!e || e.rev !== rev) return;
  const next = { ...e, upload: false };
  await db.write(['queue'], s => s.queue.put(next));
  state.queue.set(key, next);
}

export const photoVersion = id => raw.photostate.get(id)?.v || null;
export const thumbVersion = id => thumbVer.get(id) || null;
export const photoIds = () => [...raw.photostate.values()].filter(p => p.v && !p.purged).map(p => p.id);
export const localPhoto = (id, size) => db.get(size === 'thumb' ? 'thumbs' : 'photos', id);

// Foto vom Server speichern – nur, wenn es noch die aktuelle Version ist. Ergebnis: der gespeicherte Eintrag.
async function storeRemotePhotoNow(id, ver, size, data, type) {
  if (photoVersion(id) !== ver) return null;
  const rec = { id, data, type: type || 'image/jpeg', ver };
  await db.write([size === 'thumb' ? 'thumbs' : 'photos'], s => s[size === 'thumb' ? 'thumbs' : 'photos'].put(rec));
  if (size === 'thumb') setThumb(id, rec);
  return rec;
}

// ---------- Öffentliche Änderungen (laufen nacheinander, siehe serial) ----------

export const saveDish = (...a) => serial(() => saveDishNow(...a));
export const deleteDish = (...a) => serial(() => deleteDishNow(...a));
export const addCookDays = (...a) => serial(() => addCookDaysNow(...a));
export const removeCookDays = (...a) => serial(() => removeCookDaysNow(...a));
export const renameIngredient = (...a) => serial(() => renameIngredientNow(...a));
export const mergeIngredient = (...a) => serial(() => mergeIngredientNow(...a));
export const deleteIngredient = (...a) => serial(() => deleteIngredientNow(...a));
export const saveMethod = (...a) => serial(() => saveMethodNow(...a));
export const deleteMethod = (...a) => serial(() => deleteMethodNow(...a));
export const noteExport = (...a) => serial(() => noteExportNow(...a));
export const replaceAll = (...a) => serial(() => replaceAllNow(...a));
export const addAll = (...a) => serial(() => addAllNow(...a));
export const becomeSynced = (...a) => serial(() => becomeSyncedNow(...a));
export const joinWipe = (...a) => serial(() => joinWipeNow(...a));
export const leaveSync = (...a) => serial(() => leaveSyncNow(...a));
export const applyRemote = (...a) => serial(() => applyRemoteNow(...a));
export const settleQueue = (...a) => serial(() => settleQueueNow(...a));
export const markUploaded = (...a) => serial(() => markUploadedNow(...a));
export const storeRemotePhoto = (...a) => serial(() => storeRemotePhotoNow(...a));
