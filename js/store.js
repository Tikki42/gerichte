// Datenmodell und alle Operationen, die Daten verändern.
// Alles wird zuerst in IndexedDB gespeichert und erst danach im Speicher (state) übernommen.

import * as db from './db.js';
import { uuid, nowISO, todayYMD, cleanName, capFirst, nameKey } from './util.js';

export const DEFAULT_METHODS = [
  { id: 'herd', name: 'Herd', icon: '🍳' },
  { id: 'ofen', name: 'Ofen', icon: '🔥' },
  { id: 'heissluft', name: 'Heißluftfritteuse', icon: '💨' },
  { id: 'mikrowelle', name: 'Mikrowelle', icon: '⚡' },
  { id: 'grill', name: 'Grill', icon: '🍖' },
  { id: 'ohne', name: 'ohne Kochen', icon: '🥗' },
];

export const EFFORT = {
  1: 'Kaufen & aufwärmen',
  2: 'Mit Fertigprodukten',
  3: 'Komplett selbst gemacht',
};

export const DIETS = [
  ['vegan', 'Vegan'],
  ['vegetarisch', 'Vegetarisch'],
  ['fleisch', 'Mit Fleisch'],
];
export const DIET_LABEL = Object.fromEntries(DIETS);

export const state = {
  dishes: new Map(),
  ingredients: new Map(),
  methods: new Map(),
  thumbs: new Map(), // Gericht-ID -> Object-URL des kleinen Vorschaubilds
  meta: {},
};

// ---------- Laden ----------

export async function load() {
  const [dishes, ingredients, methods, thumbs, meta] = await Promise.all(
    ['dishes', 'ingredients', 'methods', 'thumbs', 'meta'].map(db.getAll));
  for (const url of state.thumbs.values()) URL.revokeObjectURL(url);
  state.dishes = new Map(dishes.map(d => [d.id, d]));
  state.ingredients = new Map(ingredients.map(i => [i.id, i]));
  state.methods = new Map(methods.map(m => [m.id, m]));
  state.thumbs = new Map(thumbs.map(t => [t.id, blobUrl(t)]));
  state.meta = Object.fromEntries(meta.map(m => [m.key, m.value]));
  if (!methods.length) {
    const now = nowISO();
    const defaults = DEFAULT_METHODS.map((m, i) => ({ ...m, order: i, createdAt: now, updatedAt: now }));
    await db.write(['methods'], s => defaults.forEach(m => s.methods.put(m)));
    state.methods = new Map(defaults.map(m => [m.id, m]));
  }
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
    timeMin: null,
    methodIds: [],
    effort: null,
    dinner: true,
    mealPrep: false,
    cold: false,
    diet: null,
    meatOptional: false, // bei vegetarischen/veganen Gerichten: Fleisch kann extra ergänzt werden
    favorite: false,
    tags: [],
    note: '',
    link: '',
    lastCooked: null,
    cookCount: 0,
    createdAt: null,
    updatedAt: null,
  };
}

// ---------- Gerichte ändern ----------

// ingredients: [{ id } | { name }] – unbekannte Namen werden als neue Zutat angelegt.
// photo: undefined = unverändert, null = entfernen, { full: Blob, thumb: Blob } = neu
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
  return dish;
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

// Setzt "zuletzt gekocht" auf heute. Gibt eine Rückgängig-Funktion zurück (oder null, wenn schon eingetragen).
export async function markCooked(id) {
  const prev = state.dishes.get(id);
  if (prev.lastCooked === todayYMD()) return null;
  const before = { lastCooked: prev.lastCooked, cookCount: prev.cookCount || 0 };
  await patchDish(id, { lastCooked: todayYMD(), cookCount: before.cookCount + 1 }, false);
  return () => patchDish(id, before, false);
}

export async function deleteDish(id) {
  const meta = changeMeta(true);
  await db.write(['dishes', 'photos', 'thumbs', 'meta'], s => {
    s.dishes.delete(id);
    s.photos.delete(id);
    s.thumbs.delete(id);
    putMeta(s.meta, meta);
  });
  state.dishes.delete(id);
  setThumb(id, null);
  Object.assign(state.meta, meta);
}

// ---------- Zutaten ----------

// Gibt { conflict } zurück, wenn es den Namen schon gibt (dann ggf. zusammenführen).
export async function renameIngredient(id, newName) {
  const name = cleanName(newName);
  if (!name) throw new Error('Der Name darf nicht leer sein.');
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
    for (const n of db.DATA_STORES) data[n].forEach(rec => s[n].put(rec));
    putMeta(s.meta, metaPatch);
  });
  await load();
}

// Fügt Gerichte (plus neue Zutaten/Zubereitungsarten und Fotos) hinzu.
export async function addAll(data) {
  const meta = changeMeta(true, data.dishes.length);
  await db.write([...db.DATA_STORES, 'meta'], s => {
    for (const n of db.DATA_STORES) data[n].forEach(rec => s[n].put(rec));
    putMeta(s.meta, meta);
  });
  await load();
}
