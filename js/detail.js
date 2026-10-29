// Detailansicht eines Gerichts.

import { state, canEdit, ingName, photoUrl, markCooked, setFavorite, cookDays, removeCookDays, EFFORT, DIET_LABEL, OPTIONS } from './store.js';
import { esc, $, fmtDate, relDays, todayYMD, weekdayShort, plural } from './util.js';
import { openPage, toast, showError, emitChange } from './ui.js';
import { openEdit } from './edit.js';
import { openCookSheet } from './cook.js';
import { icon } from './icons.js';

const COOK_ROWS = 5; // so viele Kochtage sind sofort sichtbar, der Rest über "Alle anzeigen"

// replace: ersetzt die oberste Seite (nach „Neues Gericht“ → Speichern)
export function openDetail(id, { replace = false } = {}) {
  let photo = null;
  let photoFor = null;
  let allDays = false;
  const onChange = () => render();
  const page = openPage({
    title: '',
    replace,
    onClose: () => {
      document.removeEventListener('data-changed', onChange);
      if (photo) URL.revokeObjectURL(photo);
    },
  });
  document.addEventListener('data-changed', onChange);

  async function render() {
    const d = state.dishes.get(id);
    if (!d) return page.close(); // z. B. auf einem anderen Gerät gelöscht
    const main = canEdit();
    const methods = d.methodIds.map(m => state.methods.get(m)).filter(Boolean);
    const options = OPTIONS.filter(([k]) => d[k]).map(([, l]) => l);
    const link = /^https?:\/\//i.test(d.link || '') ? d.link : '';
    const rows = [
      ['Zubereitung', methods.length ? methods.map(m => `${esc(m.icon)} ${esc(m.name)}`).join('<br>') : '–'],
      ['Aufwand', d.effort ? `${d.effort} · ${EFFORT[d.effort]}` : '–'],
      ['Ernährung', DIET_LABEL[d.diet] || '–'],
      ['Optionen', options.length ? options.join('<br>') : '–'],
      ['Gekocht', d.lastCooked
        ? `zuletzt ${relDays(d.lastCooked)} (${fmtDate(d.lastCooked)})<br>insgesamt ${d.cookCount || 0}×`
        : d.cookCount ? `insgesamt ${d.cookCount}×, ohne Datum` : 'noch nie'],
    ];
    if (d.tags?.length) rows.push(['Tags', d.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')]);
    if (d.note) rows.push(['Notiz', `<div class="note">${esc(d.note)}</div>`]);
    if (link) rows.push(['Rezept', `<a href="${esc(link)}" target="_blank" rel="noopener">Originalrezept öffnen ↗</a>`]);

    const hasThumb = state.thumbs.has(id);
    page.body.innerHTML = `
      ${hasThumb ? `<img class="detail-photo" id="dPhoto" src="${photo && photoFor === state.thumbs.get(id) ? photo : state.thumbs.get(id)}" alt="">` : ''}
      <div class="detail-title">
        <h2>${esc(d.name)}</h2>
        ${main ? `<button class="star-btn ${d.favorite ? 'on' : ''}" data-fav aria-label="Favorit">${d.favorite ? '★' : '☆'}</button>`
               : d.favorite ? '<span class="star-btn on">★</span>' : ''}
      </div>
      <div class="ing-chips">${d.ingredientIds.map(i => `<span class="ing-chip">${esc(ingName(i))}</span>`).join('') || '<span class="muted">Keine Zutaten eingetragen</span>'}</div>
      <div class="info">${rows.map(([k, v]) => `<div class="info-row"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')}</div>
      ${cookListHtml(d, main)}
      <p class="hint">Angelegt am ${fmtDate(d.createdAt)} · geändert am ${fmtDate(d.updatedAt)}</p>`;

    // "Bearbeiten" oben rechts wie in iOS-Apps, unten ist Platz für "Heute gekocht" und den Kalender-Knopf
    const cookedToday = d.lastCooked === todayYMD();
    page.setRight(main ? '<button class="nav-btn glass" data-edit>Bearbeiten</button>' : '');
    page.setFoot(main ? `<div class="btn-row">
        <button class="btn primary big grow" data-cook ${cookedToday ? 'disabled' : ''}>${icon.check(20)} ${cookedToday ? 'Heute schon gekocht' : 'Heute gekocht'}</button>
        <button class="btn tinted big icon-btn" data-cook-past aria-label="Früher gekocht">${icon.calendar(24)}</button>
      </div>` : '');

    // Großes Foto nachladen (das Vorschaubild wird sofort gezeigt)
    if (hasThumb && photoFor !== state.thumbs.get(id)) {
      const stamp = state.thumbs.get(id);
      const u = await photoUrl(id);
      if (!page.el.isConnected) return u && URL.revokeObjectURL(u);
      if (photo) URL.revokeObjectURL(photo);
      photo = u;
      photoFor = stamp;
      const img = $('#dPhoto', page.el);
      if (img && u) img.src = u;
    }
  }

  // Liste "Gekocht am": neuester Tag oben, auf dem Hauptgerät mit Löschen
  function cookListHtml(d, main) {
    const days = cookDays(id);
    if (!days.length) return '';
    const shown = allDays ? days : days.slice(0, COOK_ROWS);
    const base = d.cookCountBase || 0;
    return `
      <h3 class="cook-head">Gekocht am</h3>
      <div class="list-box">${shown.map(day => `<div class="list-row cook-row">
        <span>${weekdayShort(day)}, ${fmtDate(day)}</span><span class="when">${relDays(day)}</span>
        ${main ? `<button class="close-btn" data-rm-day="${esc(day)}" aria-label="Kochtag ${fmtDate(day)} löschen">${icon.close(14)}</button>` : ''}
      </div>`).join('')}</div>
      ${days.length > shown.length ? `<button class="link-btn more-days" data-all-days>Alle ${days.length} Kochtage anzeigen</button>` : ''}
      ${base ? `<p class="hint">Dazu ${plural(base, 'früheres Mal', 'frühere Male')} ohne Datum.</p>` : ''}`;
  }

  page.el.addEventListener('click', async e => {
    try {
      if (e.target.closest('[data-fav]')) {
        const d = state.dishes.get(id);
        await setFavorite(id, !d.favorite);
        emitChange();
      }
      if (e.target.closest('[data-edit]')) openEdit(id);
      if (e.target.closest('[data-cook]')) {
        const undo = await markCooked(id);
        emitChange();
        if (undo) toast('Als heute gekocht eingetragen.', { action: 'Rückgängig', onAction: () => undo().then(emitChange).catch(showError) });
      }
      if (e.target.closest('[data-cook-past]')) openCookSheet(id);
      const rm = e.target.closest('[data-rm-day]');
      if (rm) {
        const day = rm.dataset.rmDay;
        const undo = await removeCookDays(id, [day]);
        emitChange();
        if (undo) toast(`Kochtag ${fmtDate(day)} gelöscht.`, { action: 'Rückgängig', onAction: () => undo().then(emitChange).catch(showError) });
      }
      if (e.target.closest('[data-all-days]')) {
        allDays = true;
        render();
      }
    } catch (err) { showError(err); }
  });

  render();
}
