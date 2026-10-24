// Zutaten und Zubereitungsarten verwalten (umbenennen, zusammenführen, löschen).

import { state, ingredientUsage, methodUsage, methodList, renameIngredient, mergeIngredient, deleteIngredient, saveMethod, deleteMethod } from './store.js';
import { esc, $, fold, plural, byName } from './util.js';
import { openPage, openSheet, confirmSheet, toast, showError, emitChange } from './ui.js';

// ---------- Zutaten ----------

export function openIngredients() {
  const page = openPage({ title: 'Zutaten' });
  page.body.innerHTML = `
    <input class="input" id="iq" type="search" placeholder="Zutat suchen" autocomplete="off" autocorrect="off">
    <p class="hint">Tippe auf eine Zutat, um sie umzubenennen, mit einer anderen zusammenzuführen (z. B. „Huhn“ → „Hähnchen“) oder zu löschen.</p>
    <div class="list-box" id="ilist" style="margin-top:12px"></div>`;
  const render = () => {
    const usage = ingredientUsage();
    const fq = fold($('#iq', page.el).value.trim());
    const list = [...state.ingredients.values()].filter(i => !fq || fold(i.name).includes(fq)).sort(byName);
    $('#ilist', page.el).innerHTML = list.length
      ? list.map(i => `<button class="list-row" data-id="${esc(i.id)}">${esc(i.name)}<span class="count">${plural(usage.get(i.id) || 0, 'Gericht', 'Gerichte')}</span></button>`).join('')
      : '<p class="muted" style="padding:14px">Keine Zutaten gefunden.</p>';
  };
  $('#iq', page.el).addEventListener('input', render);
  $('#ilist', page.el).addEventListener('click', e => {
    const row = e.target.closest('[data-id]');
    if (row) editIngredient(row.dataset.id, render);
  });
  render();
}

function editIngredient(id, after) {
  const ing = state.ingredients.get(id);
  const usage = ingredientUsage();
  const count = usage.get(id) || 0;
  const s = openSheet({
    title: ing.name,
    body: `
      <div class="field">
        <label for="rn">Umbenennen</label>
        <input class="input" id="rn" value="${esc(ing.name)}" autocomplete="off" autocorrect="off">
        <button class="btn primary full" data-rename style="margin-top:8px">Namen speichern</button>
      </div>
      <div class="field">
        <div class="label">Zusammenführen mit …</div>
        <p class="hint" style="margin-bottom:8px">„${esc(ing.name)}“ wird in ${plural(count, 'Gericht', 'Gerichten')} durch die gewählte Zutat ersetzt und danach gelöscht.</p>
        <input class="input" id="mq" type="search" placeholder="Ziel-Zutat suchen" autocomplete="off" autocorrect="off">
        <div class="option-list" id="mlist" style="margin-top:8px"></div>
      </div>
      ${count ? '' : '<button class="btn danger full" data-del>Zutat löschen (wird nicht verwendet)</button>'}`,
  });
  const renderTargets = () => {
    const fq = fold($('#mq', s.el).value.trim());
    const list = [...state.ingredients.values()].filter(i => i.id !== id && (!fq || fold(i.name).includes(fq)))
      .sort((a, b) => (usage.get(b.id) || 0) - (usage.get(a.id) || 0) || byName(a, b)).slice(0, fq ? 20 : 6);
    $('#mlist', s.el).innerHTML = list.map(i =>
      `<button class="option" data-into="${esc(i.id)}">${esc(i.name)} <small>${usage.get(i.id) || 0}</small></button>`).join('');
  };
  $('#mq', s.el).addEventListener('input', renderTargets);
  renderTargets();

  const merge = async intoId => {
    const into = state.ingredients.get(intoId);
    const ok = await confirmSheet({
      title: 'Zusammenführen?',
      text: `„${esc(ing.name)}“ wird durch „${esc(into.name)}“ ersetzt (${plural(count, 'Gericht', 'Gerichte')}).`,
      ok: 'Zusammenführen',
    });
    if (!ok) return;
    const n = await mergeIngredient(id, intoId);
    s.close();
    toast(`Zusammengeführt – ${plural(n, 'Gericht', 'Gerichte')} angepasst.`);
    emitChange();
    after();
  };

  s.el.addEventListener('click', async e => {
    try {
      if (e.target.closest('[data-rename]')) {
        const res = await renameIngredient(id, $('#rn', s.el).value);
        if (res.conflict) return merge(res.conflict.id);
        s.close();
        toast('Umbenannt.');
        emitChange();
        after();
      }
      const into = e.target.closest('[data-into]');
      if (into) await merge(into.dataset.into);
      if (e.target.closest('[data-del]')) {
        await deleteIngredient(id);
        s.close();
        toast('Gelöscht.');
        after();
      }
    } catch (err) { showError(err); }
  });
}

// ---------- Zubereitungsarten ----------

export function openMethods() {
  const page = openPage({ title: 'Zubereitungsarten' });
  const render = () => {
    const usage = methodUsage();
    page.body.innerHTML = `
      <div class="list-box">${methodList().map(m =>
        `<button class="list-row" data-id="${esc(m.id)}">${esc(m.icon)} ${esc(m.name)}<span class="count">${plural(usage.get(m.id) || 0, 'Gericht', 'Gerichte')}</span></button>`).join('')}</div>
      <button class="btn tinted full" data-new style="margin-top:14px">+ Neue Zubereitungsart</button>`;
  };
  page.body.addEventListener('click', e => {
    const row = e.target.closest('[data-id]');
    if (row) editMethod(state.methods.get(row.dataset.id), render);
    if (e.target.closest('[data-new]')) editMethod(null, render);
  });
  render();
}

function editMethod(m, after) {
  const used = m ? methodUsage().get(m.id) || 0 : 0;
  const s = openSheet({
    title: m ? m.name : 'Neue Zubereitungsart',
    body: `
      <div class="field"><label for="mn">Name</label><input class="input" id="mn" value="${esc(m?.name || '')}" placeholder="z. B. Slow Cooker" autocomplete="off"></div>
      <div class="field"><label for="mi">Symbol (ein Emoji)</label><input class="input" id="mi" value="${esc(m?.icon || '')}" placeholder="z. B. 🍲" maxlength="4" style="width:120px"></div>
      ${m && !used ? '<button class="btn danger full" data-del>Löschen (wird nicht verwendet)</button>' : ''}`,
    foot: '<button class="btn primary grow" data-save>Speichern</button>',
  });
  s.el.addEventListener('click', async e => {
    try {
      if (e.target.closest('[data-save]')) {
        await saveMethod({ id: m?.id, name: $('#mn', s.el).value, icon: $('#mi', s.el).value });
        s.close();
        emitChange();
        after();
      }
      if (e.target.closest('[data-del]')) {
        await deleteMethod(m.id);
        s.close();
        emitChange();
        after();
      }
    } catch (err) { showError(err); }
  });
}
