// Gericht anlegen und bearbeiten (nur Hauptgerät).

import { state, blankDish, saveDish, deleteDish, ingName, ingredientUsage, tagUsage, methodList, findDishByName, EFFORT, DIETS } from './store.js';
import { processPhoto } from './photo.js';
import { esc, $, $$, cleanName, capFirst, nameKey, fold } from './util.js';
import { openPage, confirmSheet, toast, showError, emitChange } from './ui.js';

const TIME_CHOICES = [10, 15, 20, 30, 45, 60, 90];

export function openEdit(id, { onSaved } = {}) {
  const isNew = !id;
  const orig = isNew ? blankDish() : state.dishes.get(id);
  const draft = { ...orig, methodIds: [...orig.methodIds], tags: [...(orig.tags || [])] };
  const ings = orig.ingredientIds.map(i => ({ id: i, name: ingName(i) }));
  const tags = draft.tags.map(t => ({ name: t }));
  let photo;          // undefined = unverändert, null = entfernt, { full, thumb, url } = neu
  let dirty = false;

  const page = openPage({
    title: isNew ? 'Neues Gericht' : 'Bearbeiten',
    back: 'Abbrechen',
    beforeClose: async () => !dirty || confirmSheet({ title: 'Änderungen verwerfen?', ok: 'Verwerfen', cancel: 'Weiter bearbeiten', danger: true }),
    onClose: () => photo?.url && URL.revokeObjectURL(photo.url),
  });

  page.body.innerHTML = `
    <div class="field">
      <label for="fName">Name</label>
      <input class="input" id="fName" value="${esc(draft.name)}" placeholder="z. B. Chili con Carne" autocomplete="off" enterkeyhint="next">
    </div>
    <div class="field">
      <div class="label">Hauptzutaten</div>
      <div id="fIngs"></div>
    </div>
    <div class="field">
      <div class="label">Zeit gesamt</div>
      <div class="chips" id="fTimeChips">${TIME_CHOICES.map(t => `<button type="button" class="chip" data-time="${t}">${t}</button>`).join('')}</div>
      <div class="input-inline" style="margin-top:8px">
        <input class="input" id="fTime" type="number" inputmode="numeric" min="0" max="1440" value="${draft.timeMin ?? ''}" placeholder="–"> Minuten
      </div>
    </div>
    <div class="field">
      <div class="label">Zubereitung</div>
      <div class="chips" id="fMethods">${methodList().map(m =>
        `<button type="button" class="chip" data-method="${esc(m.id)}">${esc(m.icon)} ${esc(m.name)}</button>`).join('')}</div>
    </div>
    <div class="field">
      <div class="label">Aufwand</div>
      <div class="option-list" id="fEffort">${[1, 2, 3].map(n =>
        `<button type="button" class="option" data-effort="${n}"><b>${n}</b> ${EFFORT[n]}</button>`).join('')}</div>
    </div>
    <div class="field">
      <div class="label">Passt für</div>
      <div class="chips" id="fSuits">
        <button type="button" class="chip" data-flag="dinner">Abendbrot</button>
        <button type="button" class="chip" data-flag="mealPrep">Vorkochen fürs Mittag</button>
        <button type="button" class="chip" data-flag="cold">Schmeckt auch kalt</button>
      </div>
    </div>
    <div class="field">
      <div class="label">Ernährung</div>
      <div class="segmented" id="fDiet">${DIETS.map(([v, l]) => `<button type="button" data-diet="${v}">${l}</button>`).join('')}</div>
    </div>
    <div class="field">
      <div class="chips"><button type="button" class="chip" data-flag="favorite">★ Favorit</button></div>
    </div>
    <div class="field">
      <div class="label">Foto</div>
      <div class="photo-box">
        <div id="fPhotoPrev"></div>
        <div class="btn-col">
          <label class="btn file-label">📷 Foto wählen<input type="file" id="fPhoto" accept="image/*"></label>
          <button type="button" class="btn danger" id="fPhotoDel">Foto entfernen</button>
        </div>
      </div>
    </div>
    <div class="field">
      <div class="label">Tags</div>
      <div id="fTags"></div>
    </div>
    <div class="field">
      <label for="fNote">Notiz</label>
      <textarea class="input" id="fNote" placeholder="z. B. mit Reis vom Vortag, doppelte Menge">${esc(draft.note)}</textarea>
    </div>
    <div class="field">
      <label for="fLink">Link zum Originalrezept</label>
      <input class="input" id="fLink" type="url" inputmode="url" value="${esc(draft.link)}" placeholder="https://…" autocomplete="off" autocapitalize="off">
    </div>
    ${isNew ? '' : '<button type="button" class="btn danger full" id="fDelete" style="margin-top:10px">Gericht löschen</button>'}`;

  page.setFoot('<button class="btn primary big full" id="fSave">Speichern</button>');

  const usage = ingredientUsage();
  const ingField = chipField($('#fIngs', page.el), {
    values: ings,
    source: () => [...state.ingredients.values()].map(i => ({ id: i.id, name: i.name, count: usage.get(i.id) || 0 })),
    placeholder: 'Zutat eingeben …',
    newLabel: 'neu anlegen',
    cap: true,
    onChange: () => { dirty = true; },
  });
  const tagField = chipField($('#fTags', page.el), {
    values: tags,
    source: tagUsage,
    placeholder: 'z. B. asiatisch, Sommer …',
    newLabel: 'als Tag',
    cap: false,
    onChange: () => { dirty = true; },
  });

  // Zustand der Auswahl-Knöpfe sichtbar machen
  const sync = () => {
    $$('[data-time]', page.el).forEach(b => b.classList.toggle('on', Number($('#fTime', page.el).value) === Number(b.dataset.time)));
    $$('[data-method]', page.el).forEach(b => b.classList.toggle('on', draft.methodIds.includes(b.dataset.method)));
    $$('[data-effort]', page.el).forEach(b => b.classList.toggle('on', draft.effort === Number(b.dataset.effort)));
    $$('[data-flag]', page.el).forEach(b => b.classList.toggle('on', !!draft[b.dataset.flag]));
    $$('[data-diet]', page.el).forEach(b => b.classList.toggle('on', draft.diet === b.dataset.diet));
    const url = photo === null ? null : photo?.url || state.thumbs.get(draft.id);
    $('#fPhotoPrev', page.el).innerHTML = url ? `<img class="thumb" src="${url}" alt="">` : '<div class="thumb">📷</div>';
    $('#fPhotoDel', page.el).hidden = !url;
  };

  page.body.addEventListener('input', () => { dirty = true; sync(); });
  page.body.addEventListener('click', async e => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.time) $('#fTime', page.el).value = $('#fTime', page.el).value === d.time ? '' : d.time;
    else if (d.method) draft.methodIds = draft.methodIds.includes(d.method) ? draft.methodIds.filter(x => x !== d.method) : [...draft.methodIds, d.method];
    else if (d.effort) draft.effort = draft.effort === Number(d.effort) ? null : Number(d.effort);
    else if (d.flag) draft[d.flag] = !draft[d.flag];
    else if (d.diet) draft.diet = draft.diet === d.diet ? null : d.diet;
    else if (b.id === 'fPhotoDel') {
      if (photo?.url) URL.revokeObjectURL(photo.url);
      photo = null;
    } else if (b.id === 'fDelete') return remove();
    else return;
    dirty = true;
    sync();
  });

  $('#fPhoto', page.el).addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    $('#fPhotoPrev', page.el).innerHTML = '<div class="thumb">…</div>';
    try {
      const p = await processPhoto(file);
      if (photo?.url) URL.revokeObjectURL(photo.url);
      photo = { ...p, url: URL.createObjectURL(p.thumb) };
      dirty = true;
    } catch (err) { showError(err); }
    sync();
  });

  $('#fName', page.el).addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); $('#fIngs input', page.el).focus(); }
  });
  $('#fSave', page.el).addEventListener('click', save);

  async function save() {
    ingField.commitPending();
    tagField.commitPending();
    const name = cleanName($('#fName', page.el).value);
    if (!name) {
      toast('Bitte einen Namen eingeben.');
      $('#fName', page.el).focus();
      return;
    }
    const dup = findDishByName(name, draft.id);
    if (dup && !(await confirmSheet({ title: 'Name schon vergeben', text: `Es gibt schon „${esc(dup.name)}“. Trotzdem speichern?`, ok: 'Trotzdem speichern' }))) return;
    const t = $('#fTime', page.el).value.trim();
    const n = Math.round(Number(t));
    let link = $('#fLink', page.el).value.trim();
    if (link && !/^https?:\/\//i.test(link)) link = 'https://' + link;
    Object.assign(draft, {
      name,
      timeMin: t === '' || !Number.isFinite(n) || n < 0 ? null : n,
      note: $('#fNote', page.el).value.trim(),
      link,
      tags: tags.map(x => x.name),
    });
    const btn = $('#fSave', page.el);
    btn.disabled = true;
    try {
      const saved = await saveDish(draft, ings, photo === undefined ? undefined : photo && { full: photo.full, thumb: photo.thumb });
      dirty = false;
      page.close();
      emitChange();
      toast(isNew ? `„${saved.name}“ gespeichert.` : 'Änderungen gespeichert.');
      onSaved?.(saved);
    } catch (err) {
      btn.disabled = false;
      showError(err, 'Speichern hat nicht geklappt.');
    }
  }

  async function remove() {
    const ok = await confirmSheet({ title: 'Gericht löschen?', text: `„${esc(orig.name)}“ wird endgültig gelöscht.`, ok: 'Löschen', danger: true });
    if (!ok) return;
    try {
      await deleteDish(orig.id);
      dirty = false;
      page.close();
      emitChange();
      toast(`„${orig.name}“ gelöscht.`);
    } catch (err) { showError(err); }
  }

  sync();
  if (isNew) setTimeout(() => $('#fName', page.el)?.focus(), 250);
}

// Eingabefeld mit Chips und Vorschlägen (für Zutaten und Tags).
// values wird direkt verändert: [{ id?, name }]
function chipField(root, { values, source, placeholder, newLabel, cap, onChange }) {
  root.innerHTML = `
    <div class="chip-input"><input type="text" placeholder="${esc(placeholder)}" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="done"></div>
    <div class="suggest"></div>`;
  const box = $('.chip-input', root);
  const input = $('input', root);
  const sug = $('.suggest', root);
  let shown = [];

  const has = name => values.some(v => nameKey(v.name) === nameKey(name));
  const matches = q => {
    const fq = fold(q);
    let list = source().filter(s => !has(s.name));
    if (fq) {
      list = list.filter(s => fold(s.name).includes(fq));
      list.sort((a, b) => fold(b.name).startsWith(fq) - fold(a.name).startsWith(fq) || b.count - a.count || a.name.localeCompare(b.name, 'de'));
      return list.slice(0, 8);
    }
    list.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'de'));
    return list.filter(s => s.count > 0).slice(0, 10);
  };
  const renderChips = () => {
    $$('.chip', box).forEach(c => c.remove());
    values.forEach((v, i) => input.insertAdjacentHTML('beforebegin',
      `<span class="chip">${esc(v.name)}<button type="button" class="x" data-i="${i}" aria-label="${esc(v.name)} entfernen">×</button></span>`));
  };
  const renderSug = () => {
    const q = cleanName(input.value);
    shown = matches(q);
    const exact = q && (has(q) || shown.some(s => nameKey(s.name) === nameKey(q)));
    sug.innerHTML = (q || shown.length ? '' : '') +
      shown.map((s, i) => `<button type="button" class="chip" data-s="${i}">${esc(s.name)}</button>`).join('') +
      (q && !exact ? `<button type="button" class="chip new" data-new>+ „${esc(cap ? capFirst(q) : q)}“ ${newLabel}</button>` : '');
  };
  const add = item => {
    if (!has(item.name)) values.push(item);
    input.value = '';
    renderChips();
    renderSug();
    onChange();
  };
  const fromText = q => {
    const list = matches(q);
    const exact = list.find(s => nameKey(s.name) === nameKey(q));
    // Enter übernimmt bevorzugt eine vorhandene Schreibweise ("Kartoffel" -> "Kartoffeln")
    const pick = exact || (list[0] && fold(list[0].name).startsWith(fold(q)) ? list[0] : null);
    return pick ? { id: pick.id, name: pick.name } : { name: cap ? capFirst(q) : q };
  };

  input.addEventListener('input', e => { e.stopPropagation(); renderSug(); });
  input.addEventListener('keydown', e => {
    const q = cleanName(input.value);
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (q) add(fromText(q));
      else input.blur();
    } else if (e.key === 'Backspace' && !input.value && values.length) {
      values.pop();
      renderChips();
      renderSug();
      onChange();
    }
  });
  // Fokus im Eingabefeld behalten, wenn ein Vorschlag angetippt wird
  sug.addEventListener('mousedown', e => e.preventDefault());
  sug.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    e.stopPropagation();
    if (b.dataset.new !== undefined) add({ name: cap ? capFirst(cleanName(input.value)) : cleanName(input.value) });
    else add({ id: shown[Number(b.dataset.s)].id, name: shown[Number(b.dataset.s)].name });
  });
  box.addEventListener('click', e => {
    e.stopPropagation();
    const x = e.target.closest('.x');
    if (x) {
      values.splice(Number(x.dataset.i), 1);
      renderChips();
      renderSug();
      onChange();
    } else input.focus();
  });
  renderChips();
  renderSug();
  return {
    commitPending() {
      const q = cleanName(input.value);
      if (q) add(fromText(q));
    },
  };
}
