// Einstieg: Start, Startseite mit Suche/Filtern/Liste und "Was essen wir heute?".

import { state, load, isMain, setMeta, ingName, methodList, ingredientUsage, markCooked, photoUrl, DIETS, DIET_LABEL, EFFORT } from './store.js';
import { filters, resetFilters, activeFilterCount, query, pickRandom, SORTS, TIME_STEPS } from './search.js';
import { esc, $, fmtShort, relDays, lsGet, lsSet, isStandalone, fold, plural } from './util.js';
import { openSheet, toast, showError, emitChange, fixBottomGap } from './ui.js';
import { icon } from './icons.js';
import { initServiceWorker } from './pwa.js';
import { openDetail } from './detail.js';
import { openEdit } from './edit.js';
import { openSettings, openImport } from './settings.js';

const app = document.getElementById('app');
let searchText = '';
let sort = lsGet('sort', 'longest');
let results = [];

boot();

async function boot() {
  try {
    await load();
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="boot">Die Daten konnten nicht geladen werden.<br><br>${esc(e.message)}</div>`;
    return;
  }
  fixBottomGap();
  initServiceWorker();
  requestPersistentStorage();
  document.addEventListener('data-changed', () => { if ($('#list')) renderAll(); });
  if (!state.meta.deviceType) showWelcome();
  else renderShell();
}

async function requestPersistentStorage() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch { /* nicht unterstützt */ }
}

// ---------- Erster Start ----------

function showWelcome() {
  app.innerHTML = `
    <div class="welcome">
      <h1>Willkommen!</h1>
      <p>Wofür nutzt ihr dieses iPhone?</p>
      <button class="choice" data-type="main">
        <b>Hauptgerät</b>
        <span>Hier wird die Bibliothek gepflegt: Gerichte anlegen, bearbeiten, exportieren.</span>
      </button>
      <button class="choice" data-type="reader">
        <b>Lesegerät</b>
        <span>Nur suchen, filtern und zufällig auswählen. Die Daten kommen als Datei vom Hauptgerät.</span>
      </button>
      <p class="muted">Lässt sich später in den Einstellungen ändern.</p>
      ${isStandalone() ? '' : `<div class="error-box">Tipp: Öffne die App über das Symbol auf dem Home-Bildschirm.
        Daten in Safari und in der Home-Bildschirm-App sind getrennt.</div>`}
    </div>`;
  app.querySelectorAll('[data-type]').forEach(b => b.addEventListener('click', async () => {
    try {
      await setMeta({ deviceType: b.dataset.type });
      renderShell();
    } catch (e) { showError(e); }
  }));
}

// ---------- Startseite ----------

function renderShell() {
  app.innerHTML = `
    <header class="topbar">
      <div class="title-row">
        <h1>Gerichte</h1>
        <span id="standSlot"></span>
      </div>
      <form class="search" role="search" autocomplete="off" onsubmit="return false">
        ${icon.search(18)}
        <!-- Platzhalter ohne das Wort "Name", sonst bietet iOS das Ausfüllen von Kontaktdaten an -->
        <input id="q" type="search" name="gerichtsuche" placeholder="Gericht, Zutat, Tag, Notiz …"
          autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search">
        <button type="button" class="clear" id="qClear" aria-label="Suche löschen" hidden>${icon.close(16)}</button>
      </form>
    </header>
    <div class="filterbar" id="filterbar"></div>
    <div class="active-row" id="activeRow" hidden></div>
    <button class="notice" id="notice" hidden></button>
    <div class="result-row"><span id="count"></span><button class="link-btn" id="btnSort"></button></div>
    <main class="list" id="list"></main>
    <div class="bottom-fade"></div>
    <div class="bottombar">
      <button class="round-btn glass" id="btnSettings" aria-label="Einstellungen">${icon.gear(26)}</button>
      <button class="btn primary big grow" id="btnRandom">${icon.dice(22)} Was essen wir heute?</button>
      <button class="round-btn glass" id="btnAdd" aria-label="Neues Gericht">${icon.plus(26)}</button>
    </div>`;

  const q = $('#q');
  q.value = searchText;
  q.addEventListener('input', () => {
    searchText = q.value;
    $('#qClear').hidden = !searchText;
    renderList();
  });
  q.addEventListener('keydown', e => { if (e.key === 'Enter') q.blur(); });
  $('#qClear').addEventListener('click', () => {
    q.value = searchText = '';
    $('#qClear').hidden = true;
    renderList();
  });
  $('#btnSettings').addEventListener('click', () => openSettings());
  $('#btnAdd').addEventListener('click', () => openEdit(null, { onSaved: d => openDetail(d.id) }));
  $('#btnRandom').addEventListener('click', openRandom);
  $('#btnSort').addEventListener('click', openSortSheet);
  $('#filterbar').addEventListener('click', onFilterChip);
  $('#activeRow').addEventListener('click', onActivePill);
  $('#list').addEventListener('click', e => {
    const card = e.target.closest('[data-id]');
    if (card) openDetail(card.dataset.id);
    if (e.target.closest('[data-reset]')) resetAll();
    if (e.target.closest('[data-import]')) openImport('replace');
    if (e.target.closest('[data-new]')) $('#btnAdd').click();
  });
  $('#notice').addEventListener('click', onNotice);
  renderAll();
}

function renderAll() {
  renderTop();
  renderFilters();
  renderList();
}

function renderTop() {
  const main = isMain();
  const m = state.meta;
  $('#btnAdd').hidden = !main;
  $('#standSlot').innerHTML = main ? '' :
    `<button class="stand-btn glass" id="btnStand">${m.lastImport ? `Stand ${fmtShort(m.dataStand)}` : 'Keine Daten'} ${icon.again(15)}</button>`;
  $('#btnStand')?.addEventListener('click', () => openImport('replace'));
  const changes = m.changesSinceExport || 0;
  $('#btnSettings').classList.toggle('badge-dot', main && changes > 0);

  const notice = $('#notice');
  let html = '';
  if (main && changes > 0) {
    html = `<span><b>${plural(changes, 'Änderung', 'Änderungen')}</b> seit dem letzten Export – jetzt sichern ›</span>`;
    notice.dataset.kind = 'export';
  } else if (!isStandalone() && !lsGet('hideInstallTip', false)) {
    html = '<span>Tipp: In Safari über „Teilen“ → „Zum Home-Bildschirm“ als App installieren. Tippen zum Ausblenden.</span>';
    notice.dataset.kind = 'install';
  }
  notice.innerHTML = html;
  notice.hidden = !html;
}

function onNotice() {
  const kind = $('#notice').dataset.kind;
  if (kind === 'export') openSettings({ focus: 'export' });
  if (kind === 'install') {
    lsSet('hideInstallTip', true);
    renderTop();
  }
}

// ---------- Filter-Chips ----------

function chip(key, label, on) {
  return `<button class="chip ${on ? 'on' : ''}" data-f="${key}">${label}</button>`;
}

function renderFilters() {
  const f = filters;
  const methods = methodList();
  const one = (arr, fn, base) => (arr.length === 1 ? fn(arr[0]) : arr.length ? `${base} (${arr.length})` : base);
  $('#filterbar').innerHTML = [
    chip('ings', `${f.ings.length ? `Zutaten (${f.ings.length})` : 'Zutaten'} ▾`, f.ings.length),
    chip('time', `${f.maxTime ? `bis ${f.maxTime} min` : 'Zeit'} ▾`, f.maxTime),
    chip('mealPrep', 'Vorkochen', f.mealPrep),
    chip('fav', '★ Favoriten', f.fav),
    chip('methods', `${one(f.methods, id => esc(state.methods.get(id)?.name || '?'), 'Zubereitung')} ▾`, f.methods.length),
    chip('effort', `${f.effort.length ? `Aufwand ${[...f.effort].sort().join('+')}` : 'Aufwand'} ▾`, f.effort.length),
    chip('diets', `${one(f.diets, d => DIET_LABEL[d], 'Ernährung')} ▾`, f.diets.length),
    chip('meatOpt', 'Fleisch ergänzbar', f.meatOpt),
    chip('cold', 'Schmeckt kalt', f.cold),
  ].join('');

  // Aktive Filter als einzeln entfernbare Pillen + "Alle zurücksetzen"
  const pills = [];
  const pill = (attr, label) => pills.push(`<button class="chip small on" ${attr}>${label} <span class="x">×</span></button>`);
  for (const id of f.ings) pill(`data-rm-ing="${esc(id)}"`, esc(ingName(id)));
  if (f.ings.length > 1) {
    pills.push(`<button class="chip small" data-toggle-mode>${f.ingMode === 'all' ? 'alle enthalten' : 'mindestens eine'} ⇄</button>`);
  }
  if (f.maxTime) pill('data-rm="maxTime"', `bis ${f.maxTime} min`);
  if (f.mealPrep) pill('data-rm="mealPrep"', 'Vorkochen');
  if (f.fav) pill('data-rm="fav"', '★ Favoriten');
  for (const id of f.methods) pill(`data-rm-method="${esc(id)}"`, esc(state.methods.get(id)?.name || '?'));
  for (const e of f.effort) pill(`data-rm-effort="${e}"`, `Aufwand ${e}`);
  for (const d of f.diets) pill(`data-rm-diet="${d}"`, DIET_LABEL[d]);
  if (f.meatOpt) pill('data-rm="meatOpt"', 'Fleisch ergänzbar');
  if (f.cold) pill('data-rm="cold"', 'Schmeckt kalt');
  const row = $('#activeRow');
  row.hidden = !pills.length;
  row.innerHTML = pills.length ? `${pills.join('')}<button class="link-btn" data-reset-all>Alle zurücksetzen</button>` : '';
}

function onActivePill(e) {
  const b = e.target.closest('button');
  if (!b) return;
  const f = filters;
  const d = b.dataset;
  if (d.resetAll !== undefined) return resetAll();
  if (d.toggleMode !== undefined) f.ingMode = f.ingMode === 'all' ? 'any' : 'all';
  if (d.rmIng) f.ings = f.ings.filter(x => x !== d.rmIng);
  if (d.rmMethod) f.methods = f.methods.filter(x => x !== d.rmMethod);
  if (d.rmEffort) f.effort = f.effort.filter(x => x !== Number(d.rmEffort));
  if (d.rmDiet) f.diets = f.diets.filter(x => x !== d.rmDiet);
  if (d.rm === 'maxTime') f.maxTime = null;
  if (['mealPrep', 'fav', 'cold', 'meatOpt'].includes(d.rm)) f[d.rm] = false;
  refresh();
}

function resetAll() {
  resetFilters();
  searchText = '';
  $('#q').value = '';
  $('#qClear').hidden = true;
  refresh();
}

function refresh() {
  renderFilters();
  renderList();
}

function onFilterChip(e) {
  const key = e.target.closest('[data-f]')?.dataset.f;
  if (!key) return;
  if (['mealPrep', 'fav', 'cold', 'meatOpt'].includes(key)) {
    filters[key] = !filters[key];
    return refresh();
  }
  if (key === 'ings') return openIngredientSheet();
  if (key === 'time') {
    return choiceSheet('Maximale Zeit', [{ value: null, label: 'Egal' }, ...TIME_STEPS.map(t => ({ value: t, label: `bis ${t} Minuten` }))],
      filters.maxTime, v => { filters.maxTime = v; refresh(); });
  }
  if (key === 'methods') {
    return multiSheet('Zubereitung', methodList().map(m => ({ value: m.id, label: `${esc(m.icon)} ${esc(m.name)}` })), 'methods',
      'Zeigt Gerichte mit mindestens einer der gewählten Zubereitungsarten.');
  }
  if (key === 'effort') {
    return multiSheet('Aufwand', [1, 2, 3].map(n => ({ value: n, label: `${n} · ${EFFORT[n]}` })), 'effort');
  }
  if (key === 'diets') {
    return multiSheet('Ernährung', DIETS.map(([v, l]) => ({ value: v, label: l })), 'diets',
      '„Vegetarisch“ zeigt auch vegane Gerichte. Für Gerichte, zu denen man Fleisch extra machen kann, gibt es den Filter „Fleisch ergänzbar“.');
  }
}

// Ein-Auswahl-Liste, schließt sich nach dem Tippen
function choiceSheet(title, options, current, onPick) {
  const s = openSheet({
    title,
    body: `<div class="option-list">${options.map((o, i) =>
      `<button class="option ${o.value === current ? 'on' : ''}" data-i="${i}">${o.label}${o.value === current ? `<span class="check">${icon.check(20)}</span>` : ''}</button>`).join('')}</div>`,
  });
  s.body.addEventListener('click', e => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    s.close();
    onPick(options[Number(b.dataset.i)].value);
  });
}

const showButton = () => `<button class="btn primary grow" data-done>${plural(results.length, 'Gericht', 'Gerichte')} anzeigen</button>`;

// Mehrfachauswahl, wirkt sofort auf die Liste
function multiSheet(title, options, key, hint = '') {
  const s = openSheet({ title, body: '', foot: '' });
  const render = () => {
    const sel = filters[key];
    s.body.innerHTML = `${hint ? `<p class="hint">${hint}</p>` : ''}<div class="option-list">${options.map((o, i) =>
      `<button class="option ${sel.includes(o.value) ? 'on' : ''}" data-i="${i}">${o.label}${sel.includes(o.value) ? `<span class="check">${icon.check(20)}</span>` : ''}</button>`).join('')}</div>`;
    s.setFoot(`<button class="btn" data-clear>Leeren</button>${showButton()}`);
  };
  s.el.addEventListener('click', e => {
    const b = e.target.closest('[data-i]');
    if (b) {
      const v = options[Number(b.dataset.i)].value;
      filters[key] = filters[key].includes(v) ? filters[key].filter(x => x !== v) : [...filters[key], v];
    } else if (e.target.closest('[data-clear]')) {
      filters[key] = [];
    } else if (e.target.closest('[data-done]')) {
      return s.close();
    } else return;
    refresh();
    render();
  });
  render();
}

function openIngredientSheet() {
  const usage = ingredientUsage();
  const all = [...state.ingredients.values()]
    .filter(i => usage.get(i.id) || filters.ings.includes(i.id))
    .sort((a, b) => (usage.get(b.id) || 0) - (usage.get(a.id) || 0) || a.name.localeCompare(b.name, 'de'));
  const s = openSheet({
    title: 'Zutaten',
    body: `
      <div class="segmented" id="ingMode">
        <button data-mode="all">alle enthalten</button><button data-mode="any">mindestens eine</button>
      </div>
      <p class="hint" id="modeHint"></p>
      <input class="input" id="ingQ" type="search" name="zutatsuche" placeholder="Zutat suchen" autocomplete="off" autocorrect="off" style="margin:10px 0 12px">
      <div class="chips" id="ingChips"></div>`,
  });
  const chipsEl = $('#ingChips', s.el);
  const render = () => {
    $$mode(s.el);
    const fq = fold($('#ingQ', s.el).value.trim());
    const list = fq ? all.filter(i => fold(i.name).includes(fq)) : all;
    chipsEl.innerHTML = list.length ? list.map(i =>
      `<button class="chip ${filters.ings.includes(i.id) ? 'on' : ''}" data-ing="${esc(i.id)}">${esc(i.name)} <small>${usage.get(i.id) || 0}</small></button>`).join('')
      : '<p class="muted">Keine passende Zutat.</p>';
    s.setFoot(`<button class="btn" data-clear>Leeren</button>${showButton()}`);
  };
  const $$mode = root => {
    root.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === filters.ingMode));
    $('#modeHint', root).textContent = filters.ingMode === 'all'
      ? 'Zeigt Gerichte, die alle gewählten Zutaten enthalten.'
      : 'Für Reste: Gerichte mit den meisten Treffern stehen oben.';
  };
  $('#ingQ', s.el).addEventListener('input', render);
  s.el.addEventListener('click', e => {
    const ing = e.target.closest('[data-ing]');
    const mode = e.target.closest('[data-mode]');
    if (ing) {
      const id = ing.dataset.ing;
      filters.ings = filters.ings.includes(id) ? filters.ings.filter(x => x !== id) : [...filters.ings, id];
    } else if (mode) {
      filters.ingMode = mode.dataset.mode;
    } else if (e.target.closest('[data-clear]')) {
      filters.ings = [];
    } else if (e.target.closest('[data-done]')) {
      return s.close();
    } else return;
    refresh();
    render();
  });
  render();
}

function openSortSheet() {
  choiceSheet('Sortieren nach', Object.entries(SORTS).map(([value, label]) => ({ value, label })), sort, v => {
    sort = v;
    lsSet('sort', v);
    renderList();
  });
}

// ---------- Liste ----------

function cardHtml({ dish: d, hits }) {
  const thumb = state.thumbs.get(d.id);
  const img = thumb
    ? `<img class="thumb" src="${thumb}" alt="" loading="lazy">`
    : `<div class="thumb" aria-hidden="true">${esc(d.name.charAt(0).toUpperCase())}</div>`;
  const sel = new Set(filters.ings);
  const ings = d.ingredientIds.map(id => (sel.has(id) ? `<b>${esc(ingName(id))}</b>` : esc(ingName(id)))).join(', ');
  const icons = d.methodIds.map(id => state.methods.get(id)?.icon || '').join(' ');
  const meta = [
    filters.ings.length && filters.ingMode === 'any' ? `<span class="hits">${hits} von ${filters.ings.length}</span>` : '',
    d.timeMin != null ? `<span>${icon.clock(13)} ${d.timeMin} min</span>` : '',
    icons ? `<span>${esc(icons)}</span>` : '',
    `<span>${d.lastCooked ? `zuletzt ${relDays(d.lastCooked)}` : 'noch nie gekocht'}</span>`,
  ].join('');
  return `<button class="card" data-id="${esc(d.id)}">${img}
    <div class="card-body">
      <div class="card-title"><span>${esc(d.name)}</span>${d.favorite ? '<span class="fav">★</span>' : ''}</div>
      <div class="card-ings">${ings || '<i>keine Zutaten eingetragen</i>'}</div>
      <div class="card-meta">${meta}</div>
    </div></button>`;
}

function renderList() {
  results = query(searchText, sort);
  const total = state.dishes.size;
  const list = $('#list');
  $('#count').textContent = results.length === total ? plural(total, 'Gericht', 'Gerichte') : `${results.length} von ${total} Gerichten`;
  const sortLabel = filters.ings.length && filters.ingMode === 'any' ? 'Treffer, dann ' + SORTS[sort] : SORTS[sort];
  $('#btnSort').innerHTML = `${icon.sort(15)} ${esc(sortLabel)}`;
  $('#btnRandom').disabled = !results.length;

  if (!total) {
    list.innerHTML = isMain()
      ? `<div class="empty"><p>Noch keine Gerichte.</p><p>Tippe unten auf <b>+</b>, um das erste anzulegen – oder lade eine Liste über Einstellungen → „Gerichte hinzufügen“.</p></div>`
      : `<div class="empty"><p>Noch keine Daten auf diesem iPhone.</p><p>Lade die neueste Datei aus eurem geteilten iCloud-Ordner.</p>
         <button class="btn primary" data-import>Daten aktualisieren</button></div>`;
    return;
  }
  if (!results.length) {
    list.innerHTML = '<div class="empty"><p>Keine Treffer.</p><button class="btn" data-reset>Suche und Filter zurücksetzen</button></div>';
    return;
  }
  list.innerHTML = results.map(cardHtml).join('');
}

// ---------- Was essen wir heute? ----------

function openRandom() {
  const pool = results.map(r => r.dish);
  if (!pool.length) return toast('Keine Gerichte in der aktuellen Auswahl.');
  const shown = [];
  let url = null;
  const s = openSheet({ title: 'Was essen wir heute?', onClose: () => url && URL.revokeObjectURL(url) });

  const show = () => {
    const avoid = shown.slice(-Math.min(5, pool.length - 1));
    const d = pickRandom(pool, avoid);
    shown.push(d.id);
    const thumb = state.thumbs.get(d.id);
    const icons = d.methodIds.map(id => state.methods.get(id)).filter(Boolean).map(m => `${m.icon} ${m.name}`).join(', ');
    s.body.innerHTML = `
      ${thumb ? `<img class="pick-photo" id="pickImg" src="${thumb}" alt="">` : ''}
      <div class="pick-name">${esc(d.name)} ${d.favorite ? '<span class="fav">★</span>' : ''}</div>
      <div class="pick-sub">${esc(d.ingredientIds.map(ingName).join(', '))}</div>
      <p class="pick-sub">${[d.timeMin != null ? `${icon.clock(15)} ${d.timeMin} min` : '', esc(icons)].filter(Boolean).join(' · ')}</p>
      <p class="pick-sub">${d.lastCooked ? `Zuletzt gekocht ${relDays(d.lastCooked)}` : 'Noch nie gekocht'} ·
        <button class="link-btn" data-open style="padding:0;min-height:0">Details ansehen ›</button></p>
      <p class="hint">Aus ${plural(pool.length, 'Gericht', 'Gerichten')} der aktuellen Auswahl.</p>`;
    s.setFoot(`<button class="btn tinted big grow" data-again>${icon.again(20)} Nochmal</button>
      ${isMain() ? `<button class="btn primary big grow" data-cook>${icon.check(20)} Machen wir</button>` : ''}`);
    s.current = d;
    if (thumb) {
      photoUrl(d.id).then(u => {
        if (s.current !== d || !u) return u && URL.revokeObjectURL(u);
        if (url) URL.revokeObjectURL(url);
        url = u;
        const img = $('#pickImg', s.el);
        if (img) img.src = u;
      });
    }
  };

  s.el.addEventListener('click', async e => {
    if (e.target.closest('[data-again]')) show();
    if (e.target.closest('[data-open]')) {
      s.close();
      openDetail(s.current.id);
    }
    if (e.target.closest('[data-cook]')) {
      const d = s.current;
      try {
        const undo = await markCooked(d.id);
        s.close();
        emitChange();
        if (undo) {
          toast(`„${d.name}“ als heute gekocht eingetragen.`, {
            action: 'Rückgängig',
            onAction: () => undo().then(emitChange).catch(showError),
          });
        } else toast('Ist für heute schon eingetragen.');
      } catch (err) { showError(err); }
    }
  });
  show();
}
