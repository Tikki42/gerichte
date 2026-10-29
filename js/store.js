// Datenmodell und alle Operationen, die Daten verändern.
// Alles wird zuerst in IndexedDB gespeichert und erst danach im Speicher (state) übernommen.

import * as db from './db.js';
import { uuid, nowISO, todayYMD, isYMD, cleanName, capFirst, nameKey } from './util.js';

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

export const state = {
  dishes: new Map(),
  ingredients: new Map(),
  methods: new Map(),
  thumbs: new Map(), // Gericht-ID -> Object-URL des kleinen Vorschaubilds
  cooks: new Map(),  // Gericht-ID -> Map(Tag -> Kochtag-Eintrag), auch gelöschte Tage
  meta: {},
};

// ---------- Laden ----------

export async function load() {
  const [dishes, ingredients, methods, thumbs, cooks, meta] = await Promise.all(
    ['dishes', 'ingredients', 'methods', 'thumbs', 'cooks', 'meta'].map(db.getAll));
  for (const url of state.thumbs.values()) URL.revokeObjectURL(url);
  state.dishes = new Map(dishes.map(d => [d.id, d]));
  state.ingredients = new Map(ingredients.map(i => [i.id, i]));
  state.methods = new Map(methods.map(m => [m.id, m]));
  state.thumbs = new Map(thumbs.map(t => [t.id, blobUrl(t)]));
  state.cooks = groupCooks(cooks);
  state.meta = Object.fromEntries(meta.map(m => [m.key, m.value]));
  if (!methods.length) {
    const now = nowISO();
    const defaults = DEFAULT_METHODS.map((m, i) => ({ ...m, order: i, createdAt: now, updatedAt: now }));
    await db.write(['methods'], s => defaults.forEach(m => s.methods.put(m)));
    state.methods = new Map(defaults.map(m => [m.id, m]));
  }
  await removeGrillOnce();
  await migrateCooksOnce();
  // "zuletzt gekocht" und Anzahl immer passend zu den Kochtagen
  for (const d of state.dishes.values()) if (d.cookCountBase !== undefined) Object.assign(d, derivedCookFields(d));
}

// Einmalig (Version 1.4.0): Zubereitungsart "Grill" aus dem Bestand entfernen – nur wenn kein Gericht sie nutzt.
// Auf dem Hauptgerät zählt das als Änderung, damit der nächste Export sie auch beim Lesegerät entfernt.
async function removeGrillOnce() {
  if (state.meta.grillRemoved) return;
  const remove = state.methods.has('grill') && ![...state.dishes.values()].some(d => d.methodIds.includes('grill'));
  const patch = { grillRemoved: true, ...(remove && isMain() ? changeMeta(true) : {}) };
  await db.write(['methods', 'meta'], s => {
    if (remove) s.methods.delete('grill');
    putMeta(s.meta, patch);
  });
  if (remove) state.methods.delete('grill');
  Object.assign(state.meta, patch);
}

// Einmalig (Version 1.5.0): Kochtage als eigene Einträge. Der bisherige letzte Kochtag wird der erste Eintrag,
// die Gesamtzahl bleibt gleich (frühere Male ohne Datum zählen als cookCountBase). Zählt nicht für den Export-Hinweis.
async function migrateCooksOnce() {
  if (state.meta.cooksMigrated) return;
  const ts = nowISO();
  const recs = [];
  const dishes = [];
  for (const d of state.dishes.values()) {
    if (d.cookCountBase !== undefined) continue;
    const day = isYMD(d.lastCooked) ? d.lastCooked : null;
    const count = Number.isInteger(d.cookCount) && d.cookCount > 0 ? d.cookCount : 0;
    const base = Math.max(0, count - (day ? 1 : 0));
    if (day) recs.push({ id: cookKey(d.id, day), dishId: d.id, day, deleted: false, ts });
    dishes.push({ ...d, cookCountBase: base, lastCooked: day, cookCount: base + (day ? 1 : 0) });
  }
  await db.write(['cooks', 'dishes', 'meta'], s => {
    recs.forEach(r => s.cooks.put(r));
    dishes.forEach(d => s.dishes.put(d));
    putMeta(s.meta, { cooksMigrated: true });
  });
  for (const r of recs) {
    if (!state.cooks.has(r.dishId)) state.cooks.set(r.dishId, new Map());
    state.cooks.get(r.dishId).set(r.day, r);
  }
  dishes.forEach(d => state.dishes.set(d.id, d));
  state.meta.cooksMigrated = true;
}

function groupCooks(recs) {
  const m = new Map();
  for (const c of recs) {
    if (!m.has(c.dishId)) m.set(c.dishId, new Map());
    m.get(c.dishId).set(c.day, c);
  }
  return m;
}

const blobUrl = rec => URL.createObjectURL(new Blob([rec.data], { type: rec.type || 'image/jpeg' }));

function setThumb(id, rec) {
  if (state.thumbs.has(id)) URL.revokeObjectURL(state.thumbs.get(id));
  if (rec) state.thumbs.set(id, blobUrl(rec));
  else state.thumbs.delete(id);
}

export async function photoUrl(id) {
  const rec = await db.get('photos', id);
  return rec ? blobUrl(rec) : null;
}

// ---------- Meta ----------

export const isMain = () => state.meta.deviceType === 'main';

function putMeta(store, obj) {
  for (const [key, value] of Object.entries(obj)) store.put({ key, value });
}

export async function setMeta(obj) {
  await db.write(['meta'], s => putMeta(s.meta, obj));
  Object.assign(state.meta, obj);
}

// Meta-Werte nach einer Änderung. "Heute gekocht" zählt nicht für den Export-Hinweis.
function changeMeta(countsForExport, n = 1) {
  return {
    dataStand: nowISO(),
    changesSinceExport: (state.meta.changesSinceExport || 0) + (countsForExport ? n : 0),
  };
}

// ---------- Lesen ----------

export const dishList = () => [...state.dishes.values()];
export const ingName = id => state.ingredients.get(id)?.name ?? '?';

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
  for (const raw of tags || []) {
    const t = cleanName(raw);
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

// Inhalt zweier Gerichte vergleichen (ohne Änderungszeitpunkt)
const contentKey = d => JSON.stringify(Object.keys(d).filter(k => k !== 'updatedAt').sort().map(k => [k, d[k]]));

// ingredients: [{ id } | { name }] – unbekannte Namen werden als neue Zutat angelegt.
// photo: undefined = unverändert, null = entfernen, { full: Blob, thumb: Blob } = neu
// Ergebnis: { dish, changed } – ohne echte Änderung wird nichts gespeichert und nichts gezählt.
export async function saveDish(draft, ingredients, photo) {
  const now = nowISO();
  const prev = state.dishes.get(draft.id);
  const newIngs = [];
  const ids = [];
  for (const it of ingredients) {
    let id = it.id && state.ingredients.has(it.id) ? it.id : null;
    if (!id) {
      const found = findIngredient(it.name) || newIngs.find(n => nameKey(n.name) === nameKey(it.name));
      if (found) id = found.id;
      else {
        const ing = { id: uuid(), name: capFirst(cleanName(it.name)), createdAt: now, updatedAt: now };
        newIngs.push(ing);
        id = ing.id;
      }
    }
    if (!ids.includes(id)) ids.push(id);
  }
  const dish = {
    ...prev,
    ...draft,
    name: cleanName(draft.name),
    ingredientIds: ids,
    tags: normalizeTags(draft.tags),
    createdAt: prev?.createdAt || now,
    updatedAt: now,
  };
  Object.assign(dish, derivedCookFields(dish)); // Kochtage gehören nicht zum Formular
  if (prev && photo === undefined && !newIngs.length && contentKey(prev) === contentKey(dish)) {
    return { dish: prev, changed: false };
  }
  let full, thumb;
  if (photo) {
    full = await photo.full.arrayBuffer();
    thumb = await photo.thumb.arrayBuffer();
  }
  const meta = changeMeta(true);
  await db.write(['dishes', 'ingredients', 'photos', 'thumbs', 'meta'], s => {
    newIngs.forEach(i => s.ingredients.put(i));
    s.dishes.put(dish);
    if (photo === null) {
      s.photos.delete(dish.id);
      s.thumbs.delete(dish.id);
    } else if (photo) {
      s.photos.put({ id: dish.id, data: full, type: 'image/jpeg' });
      s.thumbs.put({ id: dish.id, data: thumb, type: 'image/jpeg' });
    }
    putMeta(s.meta, meta);
  });
  newIngs.forEach(i => state.ingredients.set(i.id, i));
  state.dishes.set(dish.id, dish);
  if (photo === null) setThumb(dish.id, null);
  else if (photo) setThumb(dish.id, { data: thumb, type: 'image/jpeg' });
  Object.assign(state.meta, meta);
  return { dish, changed: true };
}

async function patchDish(id, fields, countsForExport) {
  const dish = { ...state.dishes.get(id), ...fields, updatedAt: nowISO() };
  const meta = changeMeta(countsForExport);
  await db.write(['dishes', 'meta'], s => {
    s.dishes.put(dish);
    putMeta(s.meta, meta);
  });
  state.dishes.set(id, dish);
  Object.assign(state.meta, meta);
  return dish;
}

export const setFavorite = (id, favorite) => patchDish(id, { favorite }, true);

// ---------- Kochtage ----------
// Jeder Kochtag ist ein eigener Eintrag { id: "Gericht-ID|JJJJ-MM-TT", dishId, day, deleted, ts }.
// Gelöschte Tage bleiben mit deleted: true stehen, damit ein späterer Abgleich sie zusammenführen kann.
// lastCooked und cookCount im Gericht werden daraus abgeleitet. Kochtage zählen nicht für den Export-Hinweis.

export const cookKey = (dishId, day) => `${dishId}|${day}`;

const activeDays = cooks => (cooks ? [...cooks.values()].filter(c => !c.deleted).map(c => c.day).sort() : []);

function derivedCookFields(dish, cooks = state.cooks.get(dish.id)) {
  const days = activeDays(cooks);
  return { lastCooked: days.length ? days[days.length - 1] : null, cookCount: (dish.cookCountBase || 0) + days.length };
}

// Eingetragene Kochtage eines Gerichts, neuester zuerst
export const cookDays = dishId => activeDays(state.cooks.get(dishId)).reverse();

async function writeCooks(dishId, recs) {
  const cooks = new Map(state.cooks.get(dishId));
  recs.forEach(r => cooks.set(r.day, r));
  const dish = { ...state.dishes.get(dishId) };
  Object.assign(dish, derivedCookFields(dish, cooks));
  const meta = changeMeta(false);
  await db.write(['cooks', 'dishes', 'meta'], s => {
    recs.forEach(r => s.cooks.put(r));
    s.dishes.put(dish);
    putMeta(s.meta, meta);
  });
  state.cooks.set(dishId, cooks);
  state.dishes.set(dishId, dish);
  Object.assign(state.meta, meta);
}

// Trägt Kochtage ein (heute oder früher, nie in der Zukunft). Gibt eine Rückgängig-Funktion zurück,
// oder null, wenn alle Tage schon eingetragen waren.
export async function addCookDays(dishId, days) {
  const today = todayYMD();
  const have = new Set(cookDays(dishId));
  const fresh = [...new Set(days)].filter(day => isYMD(day) && day <= today && !have.has(day));
  if (!fresh.length) return null;
  const ts = nowISO();
  await writeCooks(dishId, fresh.map(day => ({ id: cookKey(dishId, day), dishId, day, deleted: false, ts })));
  return () => removeCookDays(dishId, fresh);
}

// Löscht Kochtage (als Markierung). Gibt eine Rückgängig-Funktion zurück oder null.
export async function removeCookDays(dishId, days) {
  const cooks = state.cooks.get(dishId);
  const gone = days.filter(day => cooks?.get(day) && !cooks.get(day).deleted);
  if (!gone.length) return null;
  const ts = nowISO();
  await writeCooks(dishId, gone.map(day => ({ ...cooks.get(day), deleted: true, ts })));
  return () => addCookDays(dishId, gone);
}

// "Heute gekocht": Rückgängig-Funktion oder null, wenn heute schon eingetragen
export const markCooked = id => addCookDays(id, [todayYMD()]);

export async function deleteDish(id) {
  const meta = changeMeta(true);
  const days = [...(state.cooks.get(id)?.keys() || [])];
  await db.write(['dishes', 'photos', 'thumbs', 'cooks', 'meta'], s => {
    s.dishes.delete(id);
    s.photos.delete(id);
    s.thumbs.delete(id);
    days.forEach(day => s.cooks.delete(cookKey(id, day)));
    putMeta(s.meta, meta);
  });
  state.dishes.delete(id);
  state.cooks.delete(id);
  setThumb(id, null);
  Object.assign(state.meta, meta);
}

// ---------- Zutaten ----------

// Gibt { conflict } zurück, wenn es den Namen schon gibt (dann ggf. zusammenführen).
export async function renameIngredient(id, newName) {
  const name = cleanName(newName);
  if (!name) throw new Error('Der Name darf nicht leer sein.');
  if (name === state.ingredients.get(id).name) return { ok: true }; // nichts geändert
  const other = findIngredient(name);
  if (other && other.id !== id) return { conflict: other };
  const ing = { ...state.ingredients.get(id), name, updatedAt: nowISO() };
  const meta = changeMeta(true);
  await db.write(['ingredients', 'meta'], s => {
    s.ingredients.put(ing);
    putMeta(s.meta, meta);
  });
  state.ingredients.set(id, ing);
  Object.assign(state.meta, meta);
  return { ok: true };
}

// Ersetzt Zutat fromId in allen Gerichten durch intoId und löscht fromId. Gibt Anzahl geänderter Gerichte zurück.
export async function mergeIngredient(fromId, intoId) {
  const now = nowISO();
  const changed = [];
  for (const d of state.dishes.values()) {
    if (!d.ingredientIds.includes(fromId)) continue;
    const ids = [];
    for (const x of d.ingredientIds) {
      const y = x === fromId ? intoId : x;
      if (!ids.includes(y)) ids.push(y);
    }
    changed.push({ ...d, ingredientIds: ids, updatedAt: now });
  }
  const meta = changeMeta(true);
  await db.write(['dishes', 'ingredients', 'meta'], s => {
    changed.forEach(d => s.dishes.put(d));
    s.ingredients.delete(fromId);
    putMeta(s.meta, meta);
  });
  changed.forEach(d => state.dishes.set(d.id, d));
  state.ingredients.delete(fromId);
  Object.assign(state.meta, meta);
  return changed.length;
}

export async function deleteIngredient(id) {
  if (ingredientUsage().get(id)) throw new Error('Die Zutat wird noch verwendet.');
  await db.write(['ingredients'], s => s.ingredients.delete(id));
  state.ingredients.delete(id);
}

// ---------- Zubereitungsarten ----------

export async function saveMethod({ id, name, icon }) {
  name = cleanName(name);
  if (!name) throw new Error('Der Name darf nicht leer sein.');
  const other = [...state.methods.values()].find(m => nameKey(m.name) === nameKey(name));
  if (other && other.id !== id) throw new Error(`„${other.name}“ gibt es schon.`);
  const now = nowISO();
  const prev = id && state.methods.get(id);
  const order = prev ? prev.order : Math.max(0, ...[...state.methods.values()].map(m => m.order ?? 0)) + 1;
  const m = { ...prev, id: id || uuid(), name, icon: cleanName(icon) || '•', order, createdAt: prev?.createdAt || now, updatedAt: now };
  const meta = changeMeta(true);
  await db.write(['methods', 'meta'], s => {
    s.methods.put(m);
    putMeta(s.meta, meta);
  });
  state.methods.set(m.id, m);
  Object.assign(state.meta, meta);
  return m;
}

export async function deleteMethod(id) {
  if (methodUsage().get(id)) throw new Error('Die Zubereitungsart wird noch verwendet.');
  await db.write(['methods'], s => s.methods.delete(id));
  state.methods.delete(id);
}

// ---------- Import ----------

// Ersetzt den kompletten Bestand in einer Transaktion. Schlägt etwas fehl, bleibt der alte Stand.
export async function replaceAll(data, metaPatch) {
  await db.write([...db.DATA_STORES, 'meta'], s => {
    for (const n of db.DATA_STORES) s[n].clear();
    for (const n of db.DATA_STORES) (data[n] || []).forEach(rec => s[n].put(rec));
    putMeta(s.meta, metaPatch);
  });
  await load();
}

// Fügt Gerichte (plus neue Zutaten/Zubereitungsarten und Fotos) hinzu.
export async function addAll(data) {
  const meta = changeMeta(true, data.dishes.length);
  await db.write([...db.DATA_STORES, 'meta'], s => {
    for (const n of db.DATA_STORES) (data[n] || []).forEach(rec => s[n].put(rec));
    putMeta(s.meta, meta);
  });
  await load();
}
