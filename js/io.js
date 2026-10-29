// Export (= Backup), Import (ersetzt alles) und "Gerichte hinzufügen".
// Dateiformat: siehe README.md

import * as db from './db.js';
import { state, replaceAll, addAll, methodList, cookKey } from './store.js';
import { makeThumb, processPhoto } from './photo.js';
import { nowISO, ymd, uuid, cleanName, capFirst, nameKey, isYMD, bufToBase64, dataUrlToBuf, byName } from './util.js';

export const FORMAT = 'gerichte-app';
export const FORMAT_VERSION = 2; // 2 = mit Kochtagen ("cooks", seit 1.5.0)

export class ImportError extends Error {
  constructor(message, details = []) {
    super(message);
    this.details = details;
  }
}

// ---------- Export ----------

const toDataUrl = rec => `data:${rec.type || 'image/jpeg'};base64,${bufToBase64(rec.data)}`;

export async function buildExport() {
  const exportedAt = nowISO();
  const [photos, thumbs, cooks] = await Promise.all([db.getAll('photos'), db.getAll('thumbs'), db.getAll('cooks')]);
  const photoMap = new Map(photos.map(p => [p.id, p]));
  const thumbMap = new Map(thumbs.map(t => [t.id, t]));
  const dishes = [...state.dishes.values()].sort(byName);
  let photoCount = 0;
  const head = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    kind: 'backup',
    exportedAt,
    dataStand: state.meta.dataStand || exportedAt,
    counts: { dishes: dishes.length, photos: dishes.filter(d => photoMap.has(d.id)).length },
    methods: methodList(),
    ingredients: [...state.ingredients.values()].sort(byName),
    cooks: cooks.sort((a, b) => a.id.localeCompare(b.id)),
  };
  // Stückweise zusammensetzen, damit keine riesige Zeichenkette entsteht
  const parts = [JSON.stringify(head).slice(0, -1), ',\n"dishes":[\n'];
  dishes.forEach((d, i) => {
    const out = { ...d };
    if (photoMap.has(d.id)) {
      out.photo = toDataUrl(photoMap.get(d.id));
      if (thumbMap.has(d.id)) out.thumb = toDataUrl(thumbMap.get(d.id));
      photoCount++;
    }
    parts.push((i ? ',\n' : '') + JSON.stringify(out));
  });
  parts.push('\n]}\n');
  const name = `Gerichte-${ymd(new Date())}.json`;
  const file = new File(parts, name, { type: 'application/json' });
  return { file, name, size: file.size, exportedAt, dishCount: dishes.length, photoCount, changesAtExport: state.meta.changesSinceExport || 0 };
}

// ---------- Datei lesen ----------

export async function readJsonFile(file) {
  if (!file) throw new ImportError('Keine Datei ausgewählt.');
  let text;
  try {
    text = await file.text();
  } catch {
    throw new ImportError('Die Datei konnte nicht gelesen werden. Ist sie vollständig aus iCloud geladen? Bitte nochmal versuchen.');
  }
  let json;
  try {
    json = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new ImportError('Das ist keine Gerichte-Datei (der Inhalt ist kein gültiges JSON).');
  }
  if (!json || typeof json !== 'object' || json.format !== FORMAT) {
    throw new ImportError('Das ist keine Gerichte-Datei (die Kennung „gerichte-app“ fehlt).');
  }
  if (typeof json.formatVersion !== 'number' || json.formatVersion > FORMAT_VERSION) {
    throw new ImportError('Die Datei stammt von einer neueren App-Version. Bitte zuerst die App aktualisieren.');
  }
  if (!Array.isArray(json.dishes)) throw new ImportError('Die Datei enthält keine Gerichteliste.');
  return json;
}

// ---------- Prüfen ----------

// Ältere Angaben ("fleisch", "fisch") werden ohne Fehler zu "keine Angabe"
const DIET_ALIASES = {
  vegetarisch: 'vegetarisch', veggie: 'vegetarisch', vegan: 'vegan', fleisch: null, 'mit fleisch': null, fisch: null,
};

const METHOD_ALIASES = {
  backofen: 'ofen', airfryer: 'heissluft', 'air fryer': 'heissluft', heißluft: 'heissluft',
  heissluftfritteuse: 'heissluft', pfanne: 'herd', topf: 'herd', kochfeld: 'herd', wok: 'herd',
  mikro: 'mikrowelle', ohne: 'ohne', kalt: 'ohne', roh: 'ohne', 'ohne kochen': 'ohne',
};

// Prüft die allgemeinen Felder eines Gerichts und gibt sie bereinigt zurück.
function checkFields(raw, err) {
  const out = {};
  const opt = (v, d) => (v === undefined || v === null ? d : v);

  const e = opt(raw.effort, null);
  if (e !== null && ![1, 2, 3].includes(e)) err('Aufwand muss 1, 2 oder 3 sein');
  out.effort = e;

  const dRaw = opt(raw.diet, null);
  const diet = dRaw === null || dRaw === '' ? null : DIET_ALIASES[nameKey(dRaw)];
  if (diet === undefined) err(`Ernährung „${dRaw}“ unbekannt (erlaubt: vegan, vegetarisch)`);
  out.diet = diet || null;

  for (const [k, def] of [['quick', false], ['mealPrep', false], ['cold', false], ['meatOptional', false], ['favorite', false]]) {
    const v = opt(raw[k], def);
    if (typeof v !== 'boolean') err(`${k} muss true oder false sein`);
    out[k] = v === true;
  }

  const tags = opt(raw.tags, []);
  if (!Array.isArray(tags) || tags.some(x => typeof x !== 'string')) err('Tags müssen eine Liste von Texten sein');
  out.tags = Array.isArray(tags) ? tags.filter(x => typeof x === 'string').map(cleanName).filter(Boolean) : [];

  for (const k of ['note', 'link']) {
    const v = opt(raw[k], '');
    if (typeof v !== 'string') err(`${k} muss ein Text sein`);
    out[k] = typeof v === 'string' ? v.trim() : '';
  }

  const lc = opt(raw.lastCooked, null);
  if (lc !== null && !isYMD(lc)) err('lastCooked muss ein Datum JJJJ-MM-TT sein');
  out.lastCooked = isYMD(lc) ? lc : null;

  const cc = opt(raw.cookCount, 0);
  if (!(Number.isInteger(cc) && cc >= 0)) err('cookCount muss eine ganze Zahl sein');
  out.cookCount = Number.isInteger(cc) && cc >= 0 ? cc : 0;

  // Frühere Male ohne Datum (ab formatVersion 2). Fehlt die Angabe, wird sie aus cookCount abgeleitet.
  const cb = opt(raw.cookCountBase, null);
  if (cb !== null && !(Number.isInteger(cb) && cb >= 0)) err('cookCountBase muss eine ganze Zahl sein');
  out.cookCountBase = Number.isInteger(cb) && cb >= 0 ? cb : null;
  return out;
}

// resize = true: Foto wie beim Erfassen verkleinern (für "Gerichte hinzufügen")
async function decodePhotos(raw, id, err, photos, thumbs, resize = false) {
  if (raw.photo === undefined || raw.photo === null || raw.photo === '') return;
  let full;
  try {
    full = dataUrlToBuf(raw.photo);
  } catch (e) {
    err(`Foto unlesbar (${e.message})`);
    return;
  }
  if (resize) {
    try {
      const p = await processPhoto(new Blob([full.buf], { type: full.type }));
      photos.push({ id, data: await p.full.arrayBuffer(), type: 'image/jpeg' });
      thumbs.push({ id, data: await p.thumb.arrayBuffer(), type: 'image/jpeg' });
    } catch {
      err('Foto lässt sich nicht anzeigen');
    }
    return;
  }
  let thumb = null;
  if (raw.thumb) {
    try { thumb = dataUrlToBuf(raw.thumb); } catch { thumb = null; }
  }
  if (!thumb) {
    try {
      const b = await makeThumb(new Blob([full.buf], { type: full.type }));
      thumb = { type: 'image/jpeg', buf: await b.arrayBuffer() };
    } catch {
      err('Foto lässt sich nicht anzeigen');
      return;
    }
  }
  photos.push({ id, data: full.buf, type: full.type });
  thumbs.push({ id, data: thumb.buf, type: thumb.type });
}

function failIfErrors(errors, intro) {
  if (!errors.length) return;
  const shown = errors.slice(0, 8);
  if (errors.length > 8) shown.push(`… und ${errors.length - 8} weitere Fehler`);
  throw new ImportError(intro, shown);
}

const isNonEmptyString = v => typeof v === 'string' && v.trim() !== '';

// Kochtage aus der Datei (ab formatVersion 2): Map Gericht-ID -> Map(Tag -> { day, deleted, ts }).
// Ältere Dateien haben keine Kochtage: Ergebnis null.
function readCooks(json, errors, fallbackTs) {
  if (json.cooks === undefined) return null;
  const byDish = new Map();
  if (!Array.isArray(json.cooks)) {
    errors.push('Die Kochtage müssen eine Liste sein');
    return byDish;
  }
  json.cooks.forEach((r, i) => {
    if (!r || !isNonEmptyString(r.dishId) || !isYMD(r.day)) return errors.push(`Kochtag ${i + 1}: Gericht oder Datum fehlt`);
    const rec = { day: r.day, deleted: r.deleted === true, ts: typeof r.ts === 'string' ? r.ts : fallbackTs };
    if (!byDish.has(r.dishId)) byDish.set(r.dishId, new Map());
    const days = byDish.get(r.dishId);
    if (!days.has(r.day) || rec.ts > days.get(r.day).ts) days.set(r.day, rec);
  });
  return byDish;
}

// Kochtage eines Gerichts für den Import: aus der Datei oder – bei älteren Dateien – aus lastCooked/cookCount.
// Ergebnis: die Einträge und die dazu passenden Felder cookCountBase, lastCooked und cookCount.
function cooksFor(id, fields, fileCooks, ts) {
  let cooks;
  let base;
  if (fileCooks) {
    cooks = [...(fileCooks.get(id)?.values() || [])].map(c => ({ id: cookKey(id, c.day), dishId: id, ...c }));
    base = fields.cookCountBase ?? Math.max(0, fields.cookCount - cooks.filter(c => !c.deleted).length);
  } else {
    cooks = fields.lastCooked ? [{ id: cookKey(id, fields.lastCooked), dishId: id, day: fields.lastCooked, deleted: false, ts }] : [];
    base = Math.max(0, fields.cookCount - cooks.length);
  }
  const days = cooks.filter(c => !c.deleted).map(c => c.day).sort();
  return { cooks, fields: { cookCountBase: base, lastCooked: days.length ? days[days.length - 1] : null, cookCount: base + days.length } };
}

// ---------- Kompletter Stand (ersetzt alles) ----------

export async function prepareReplace(json) {
  if (json.kind !== 'backup') {
    throw new ImportError('Diese Datei enthält nur einzelne Gerichte, keinen kompletten Stand. Dafür gibt es auf dem Hauptgerät „Gerichte hinzufügen“.');
  }
  const exportedAt = json.exportedAt;
  if (typeof exportedAt !== 'string' || isNaN(Date.parse(exportedAt))) throw new ImportError('In der Datei fehlt das Exportdatum.');
  const errors = [];
  const fileCooks = readCooks(json, errors, exportedAt);

  const ingredients = [];
  const ingIds = new Set();
  const ingNames = new Set();
  (Array.isArray(json.ingredients) ? json.ingredients : []).forEach((r, i) => {
    const err = m => errors.push(`Zutat ${i + 1}: ${m}`);
    if (!r || !isNonEmptyString(r.id) || !isNonEmptyString(r.name)) return err('ID oder Name fehlt');
    if (ingIds.has(r.id)) return err('ID doppelt');
    if (ingNames.has(nameKey(r.name))) return err(`„${r.name}“ doppelt`);
    ingIds.add(r.id);
    ingNames.add(nameKey(r.name));
    ingredients.push({ ...r, name: cleanName(r.name) });
  });

  const methods = [];
  const methodIds = new Set();
  (Array.isArray(json.methods) ? json.methods : []).forEach((r, i) => {
    const err = m => errors.push(`Zubereitungsart ${i + 1}: ${m}`);
    if (!r || !isNonEmptyString(r.id) || !isNonEmptyString(r.name)) return err('ID oder Name fehlt');
    if (methodIds.has(r.id)) return err('ID doppelt');
    methodIds.add(r.id);
    methods.push({ ...r, name: cleanName(r.name), icon: typeof r.icon === 'string' && r.icon ? r.icon : '•' });
  });

  const dishes = [];
  const photos = [];
  const thumbs = [];
  const cooks = [];
  const dishIds = new Set();
  for (let i = 0; i < json.dishes.length; i++) {
    const raw = json.dishes[i];
    const label = `Gericht ${i + 1}${raw && isNonEmptyString(raw.name) ? ` „${cleanName(raw.name)}“` : ''}`;
    const err = m => errors.push(`${label}: ${m}`);
    if (!raw || typeof raw !== 'object') { err('ungültiger Eintrag'); continue; }
    if (!isNonEmptyString(raw.id)) err('ID fehlt');
    else if (dishIds.has(raw.id)) err('ID doppelt');
    if (!isNonEmptyString(raw.name)) err('Name fehlt');
    const iIds = Array.isArray(raw.ingredientIds) ? raw.ingredientIds : null;
    if (!iIds) err('Zutatenliste fehlt');
    else if (iIds.some(x => !ingIds.has(x))) err('verweist auf eine unbekannte Zutat');
    const mIds = Array.isArray(raw.methodIds) ? raw.methodIds : null;
    if (!mIds) err('Zubereitungsarten fehlen');
    else if (mIds.some(x => !methodIds.has(x))) err('verweist auf eine unbekannte Zubereitungsart');
    const fields = checkFields(raw, err);
    dishIds.add(raw.id);
    await decodePhotos(raw, raw.id, err, photos, thumbs);
    const cf = cooksFor(raw.id, fields, fileCooks, exportedAt);
    cooks.push(...cf.cooks);
    const rec = { ...raw, ...fields, ...cf.fields, name: cleanName(raw.name), ingredientIds: iIds || [], methodIds: mIds || [] };
    delete rec.photo;
    delete rec.thumb;
    rec.createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : exportedAt;
    rec.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : exportedAt;
    dishes.push(rec);
  }
  if (fileCooks && [...fileCooks.keys()].some(id => !dishIds.has(id))) errors.push('Kochtage verweisen auf ein unbekanntes Gericht');
  failIfErrors(errors, 'Die Datei ist fehlerhaft. Es wurde nichts geändert.');

  const localStand = state.meta.dataStand;
  return {
    exportedAt,
    dishCount: dishes.length,
    photoCount: photos.length,
    older: !!localStand && state.dishes.size > 0 && Date.parse(exportedAt) < Date.parse(localStand),
    data: { dishes, ingredients, methods, photos, thumbs, cooks },
  };
}

export async function commitReplace(prep, fileName) {
  await replaceAll(prep.data, {
    dataStand: prep.exportedAt,
    changesSinceExport: 0,
    lastImport: { at: nowISO(), exportedAt: prep.exportedAt, dishes: prep.dishCount, fileName: fileName || '' },
  });
}

// ---------- Gerichte hinzufügen (nur fehlende) ----------

export async function prepareAdd(json) {
  if (json.kind !== 'dishes' && json.kind !== 'backup') throw new ImportError('Unbekannte Dateiart.');
  const errors = [];
  const now = nowISO();
  const fileCooks = readCooks(json, errors, now);

  // Bei einer Backup-Datei werden IDs über die Listen in der Datei in Namen übersetzt
  const fileIng = new Map((json.ingredients || []).filter(Boolean).map(i => [i.id, i.name]));
  const fileMethod = new Map((json.methods || []).filter(Boolean).map(m => [m.id, m]));

  const localNames = new Map([...state.dishes.values()].map(d => [nameKey(d.name), d.name]));
  const seenNames = new Set();
  const skipped = [];
  const accepted = [];

  for (let i = 0; i < json.dishes.length; i++) {
    const raw = json.dishes[i];
    const name = raw && typeof raw.name === 'string' ? cleanName(raw.name) : '';
    const label = `Gericht ${i + 1}${name ? ` „${name}“` : ''}`;
    const err = m => errors.push(`${label}: ${m}`);
    if (!raw || typeof raw !== 'object') { err('ungültiger Eintrag'); continue; }
    if (!name) { err('Name fehlt'); continue; }

    let ingNames = [];
    if (Array.isArray(raw.ingredients)) ingNames = raw.ingredients;
    else if (Array.isArray(raw.ingredientIds)) ingNames = raw.ingredientIds.map(id => fileIng.get(id));
    else if (raw.ingredients !== undefined) err('ingredients muss eine Liste sein');
    if (ingNames.some(x => !isNonEmptyString(x))) err('Zutaten müssen Texte sein');

    let mNames = [];
    if (Array.isArray(raw.methods)) mNames = raw.methods.map(m => ({ name: m }));
    else if (Array.isArray(raw.methodIds)) mNames = raw.methodIds.map(id => fileMethod.get(id) || { name: undefined });
    else if (raw.methods !== undefined) err('methods muss eine Liste sein');
    if (mNames.some(x => !isNonEmptyString(x.name))) err('Zubereitungsarten müssen Texte sein');

    const fields = checkFields(raw, err);
    if (raw.id !== undefined && !isNonEmptyString(raw.id)) err('id muss ein Text sein');

    let reason = null;
    if (isNonEmptyString(raw.id) && state.dishes.has(raw.id)) reason = 'gleiche ID schon vorhanden';
    else if (localNames.has(nameKey(name))) reason = 'gibt es schon';
    else if (seenNames.has(nameKey(name))) reason = 'doppelt in der Datei';
    seenNames.add(nameKey(name));
    if (reason) { skipped.push({ name, reason }); continue; }
    accepted.push({ raw, name, ingNames, mNames, fields });
  }

  // Zutaten und Zubereitungsarten zuordnen (Groß-/Kleinschreibung egal), fehlende neu anlegen
  const ingByKey = new Map([...state.ingredients.values()].map(i => [nameKey(i.name), i.id]));
  const methodByKey = new Map([...state.methods.values()].map(m => [nameKey(m.name), m.id]));
  const newIngredients = [];
  const newMethods = [];
  let order = Math.max(0, ...[...state.methods.values()].map(m => m.order ?? 0));

  const dishes = [];
  const photos = [];
  const thumbs = [];
  const cooks = [];
  for (const a of accepted) {
    const ingredientIds = [];
    for (const n of a.ingNames) {
      if (!isNonEmptyString(n)) continue;
      const k = nameKey(n);
      if (!ingByKey.has(k)) {
        const ing = { id: uuid(), name: capFirst(cleanName(n)), createdAt: now, updatedAt: now };
        newIngredients.push(ing);
        ingByKey.set(k, ing.id);
      }
      if (!ingredientIds.includes(ingByKey.get(k))) ingredientIds.push(ingByKey.get(k));
    }
    const methodIds = [];
    for (const m of a.mNames) {
      if (!isNonEmptyString(m.name)) continue;
      const k = nameKey(m.name);
      let id = methodByKey.get(k);
      if (!id && METHOD_ALIASES[k] && state.methods.has(METHOD_ALIASES[k])) id = METHOD_ALIASES[k];
      if (!id) {
        const nm = { id: uuid(), name: cleanName(m.name), icon: typeof m.icon === 'string' && m.icon ? m.icon : '•', order: ++order, createdAt: now, updatedAt: now };
        newMethods.push(nm);
        methodByKey.set(k, nm.id);
        id = nm.id;
      }
      if (!methodIds.includes(id)) methodIds.push(id);
    }
    const id = isNonEmptyString(a.raw.id) ? a.raw.id : uuid();
    const err = m => errors.push(`„${a.name}“: ${m}`);
    await decodePhotos(a.raw, id, err, photos, thumbs, true);
    const cf = cooksFor(id, a.fields, fileCooks, now);
    cooks.push(...cf.cooks);
    const rec = { ...a.raw, ...a.fields, ...cf.fields, id, name: a.name, ingredientIds, methodIds, createdAt: now, updatedAt: now };
    for (const k of ['photo', 'thumb', 'ingredients', 'methods']) delete rec[k];
    dishes.push(rec);
  }
  failIfErrors(errors, 'Die Datei ist fehlerhaft. Es wurde nichts hinzugefügt.');

  return {
    dishes,
    skipped,
    newIngredients,
    newMethods,
    data: { dishes, ingredients: newIngredients, methods: newMethods, photos, thumbs, cooks },
  };
}

export const commitAdd = plan => addAll(plan.data);
