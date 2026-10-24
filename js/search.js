// Suche, Filter, Sortierung und Zufallsauswahl.

import { state, ingName } from './store.js';
import { fold, daysSince } from './util.js';

export const SORTS = {
  longest: 'Am längsten nicht gekocht',
  name: 'Name',
  newest: 'Zuletzt hinzugefügt',
};

export const filters = {
  fav: false,
  effort: [],
  ings: [],          // Zutaten-IDs
  ingMode: 'all',    // 'all' = alle enthalten, 'any' = mindestens eine
  methods: [],
  diets: [],
  // "Sonstiges": Ja/Nein-Filter, Schlüssel wie die Felder im Gericht
  quick: false,
  mealPrep: false,
  meatOptional: false,
  cold: false,
};

export const OTHER_FILTERS = [
  ['quick', 'Blitzgericht'],
  ['mealPrep', 'Vorkochen'],
  ['meatOptional', 'Fleisch ergänzbar'],
  ['cold', 'Schmeckt kalt'],
];

export function resetFilters() {
  Object.assign(filters, { fav: false, effort: [], ings: [], ingMode: 'all', methods: [], diets: [] });
  for (const [k] of OTHER_FILTERS) filters[k] = false;
}

export function activeFilterCount() {
  const f = filters;
  return (f.fav ? 1 : 0) + (f.effort.length ? 1 : 0) + (f.ings.length ? 1 : 0) + (f.methods.length ? 1 : 0)
    + (f.diets.length ? 1 : 0) + OTHER_FILTERS.filter(([k]) => f[k]).length;
}

function haystack(d) {
  return fold([d.name, ...d.ingredientIds.map(ingName), ...(d.tags || []), d.note || ''].join(' \u0001 '));
}

const byNameCmp = (a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' });

const SORT_FNS = {
  longest: (a, b) => (a.lastCooked || '').localeCompare(b.lastCooked || '') || byNameCmp(a, b),
  name: byNameCmp,
  newest: (a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') || byNameCmp(a, b),
};

// Liefert [{ dish, hits }] passend zu Suchtext und Filtern, sortiert.
export function query(text, sort = 'longest') {
  const f = filters;
  const tokens = fold(text).split(/\s+/).filter(Boolean);
  // "vegetarisch" schließt vegane Gerichte mit ein
  const diets = new Set(f.diets);
  if (diets.has('vegetarisch')) diets.add('vegan');
  const out = [];
  for (const d of state.dishes.values()) {
    if (f.fav && !d.favorite) continue;
    if (OTHER_FILTERS.some(([k]) => f[k] && !d[k])) continue;
    if (f.methods.length && !f.methods.some(m => d.methodIds.includes(m))) continue;
    if (f.effort.length && !f.effort.includes(d.effort)) continue;
    if (diets.size && !diets.has(d.diet)) continue;
    let hits = 0;
    if (f.ings.length) {
      hits = f.ings.filter(id => d.ingredientIds.includes(id)).length;
      if (f.ingMode === 'all' ? hits < f.ings.length : hits === 0) continue;
    }
    if (tokens.length) {
      const h = haystack(d);
      if (!tokens.every(t => h.includes(t))) continue;
    }
    out.push({ dish: d, hits });
  }
  const cmp = SORT_FNS[sort] || SORT_FNS.longest;
  const byHits = f.ings.length && f.ingMode === 'any';
  out.sort((a, b) => (byHits ? b.hits - a.hits : 0) || cmp(a.dish, b.dish));
  return out;
}

// Gewicht für die Zufallsauswahl: lange nicht Gekochtes und Favoriten kommen öfter dran.
export function weight(d) {
  const days = d.lastCooked ? Math.max(0, daysSince(d.lastCooked)) : 120;
  let w = 1 + Math.min(days, 120) / 15;   // 1 … 9
  if (d.favorite) w *= 2;
  if (days <= 3) w *= 0.25;
  return w;
}

// Wählt zufällig ein Gericht; "avoid" (zuletzt gezeigte IDs) wird möglichst vermieden.
export function pickRandom(dishes, avoid = [], rnd = Math.random) {
  if (!dishes.length) return null;
  let pool = dishes.filter(d => !avoid.includes(d.id));
  if (!pool.length) pool = dishes.filter(d => d.id !== avoid[avoid.length - 1]);
  if (!pool.length) pool = dishes;
  const weights = pool.map(weight);
  let r = rnd() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}
