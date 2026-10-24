// Detailansicht eines Gerichts.

import { state, isMain, ingName, photoUrl, markCooked, setFavorite, EFFORT, DIET_LABEL } from './store.js';
import { esc, $, fmtDate, relDays, todayYMD } from './util.js';
import { openPage, toast, showError, emitChange } from './ui.js';
import { openEdit } from './edit.js';

export function openDetail(id) {
  let photo = null;
  let photoFor = null;
  const onChange = () => render();
  const page = openPage({
    title: '',
    onClose: () => {
      document.removeEventListener('data-changed', onChange);
      if (photo) URL.revokeObjectURL(photo);
    },
  });
  document.addEventListener('data-changed', onChange);

  async function render() {
    const d = state.dishes.get(id);
    if (!d) return page.close();
    const main = isMain();
    const methods = d.methodIds.map(m => state.methods.get(m)).filter(Boolean);
    const suits = [d.dinner && 'Abendbrot', d.mealPrep && 'Vorkochen fürs Mittag'].filter(Boolean).join(', ');
    const link = /^https?:\/\//i.test(d.link || '') ? d.link : '';
    const rows = [
      ['Zeit', d.timeMin != null ? `${d.timeMin} Minuten` : '–'],
      ['Zubereitung', methods.length ? methods.map(m => `${esc(m.icon)} ${esc(m.name)}`).join('<br>') : '–'],
      ['Aufwand', d.effort ? `${d.effort} · ${EFFORT[d.effort]}` : '–'],
      ['Passt für', (esc(suits) || '–') + (d.cold ? '<br>schmeckt auch kalt' : '')],
      ['Ernährung', d.diet ? DIET_LABEL[d.diet] : '–'],
      ['Gekocht', d.lastCooked
        ? `zuletzt ${relDays(d.lastCooked)} (${fmtDate(d.lastCooked)})<br>insgesamt ${d.cookCount || 0}×`
        : 'noch nie'],
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
      <div style="margin-top:10px">${d.ingredientIds.map(i => `<span class="ing-chip">${esc(ingName(i))}</span>`).join('') || '<span class="muted">Keine Zutaten eingetragen</span>'}</div>
      <div class="info">${rows.map(([k, v]) => `<div class="info-row"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')}</div>
      <p class="hint">Angelegt am ${fmtDate(d.createdAt)} · geändert am ${fmtDate(d.updatedAt)}</p>`;

    const cookedToday = d.lastCooked === todayYMD();
    page.setFoot(main ? `<div class="btn-row">
        <button class="btn primary big grow" data-cook ${cookedToday ? 'disabled' : ''}>${cookedToday ? '✓ Heute schon gekocht' : '✓ Heute gekocht'}</button>
        <button class="btn big" data-edit>Bearbeiten</button>
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
    } catch (err) { showError(err); }
  });

  render();
}
