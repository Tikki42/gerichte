// "Früher gekocht": vergangene Kochtage nachtragen (nur Hauptgerät).

import { state, cookDays, addCookDays } from './store.js';
import { esc, $, todayYMD, addDaysYMD, weekdayShort, fmtShort, isYMD, plural } from './util.js';
import { openSheet, toast, showError, emitChange } from './ui.js';
import { icon } from './icons.js';

const RECENT_DAYS = 7; // so viele zurückliegende Tage stehen zum Antippen bereit

export function openCookSheet(dishId) {
  const dish = state.dishes.get(dishId);
  const today = todayYMD();
  const recent = Array.from({ length: RECENT_DAYS }, (_, i) => addDaysYMD(today, -(i + 1)));
  const done = new Set(cookDays(dishId));
  const picked = new Set(); // gewählte Tage, auch ältere über "Anderes Datum"

  const s = openSheet({
    title: 'Früher gekocht',
    body: `
      <p class="hint" style="margin-top:0">Wann habt ihr „${esc(dish.name)}“ gekocht? Mehrere Tage sind möglich.</p>
      <div class="day-grid" id="cookDays"></div>
      <div class="day-extra" id="cookExtra"></div>
      <label class="btn tinted full file-label date-btn">${icon.calendar(20)} Anderes Datum …<input type="date" id="cookDate" max="${today}"></label>`,
  });

  const dayName = (day, i) => (i === 0 ? 'Gestern' : i === 1 ? 'Vorgestern' : weekdayShort(day));

  const render = () => {
    $('#cookDays', s.el).innerHTML = recent.map((day, i) => (done.has(day)
      ? `<button type="button" class="day-chip" disabled><b>${dayName(day, i)}</b><small>${icon.check(13)} eingetragen</small></button>`
      : `<button type="button" class="day-chip ${picked.has(day) ? 'on' : ''}" data-day="${day}"><b>${dayName(day, i)}</b><small>${fmtShort(day)}</small></button>`)).join('');
    const older = [...picked].filter(day => !recent.includes(day)).sort().reverse();
    $('#cookExtra', s.el).innerHTML = older.map(day =>
      `<button type="button" class="chip on" data-day="${day}">${weekdayShort(day)} ${fmtShort(day)} <span class="x">×</span></button>`).join('');
    const n = picked.size;
    s.setFoot(`<button class="btn primary grow" data-save ${n ? '' : 'disabled'}>${n ? `${plural(n, 'Tag', 'Tage')} eintragen` : 'Tage antippen'}</button>`);
  };

  s.el.addEventListener('click', async e => {
    const b = e.target.closest('[data-day]');
    if (b) {
      const day = b.dataset.day;
      if (picked.has(day)) picked.delete(day);
      else picked.add(day);
      return render();
    }
    if (!e.target.closest('[data-save]')) return;
    const days = [...picked];
    try {
      const undo = await addCookDays(dishId, days);
      s.close();
      emitChange();
      if (undo) {
        toast(`${plural(days.length, 'Kochtag', 'Kochtage')} eingetragen.`, {
          action: 'Rückgängig',
          onAction: () => undo().then(emitChange).catch(showError),
        });
      }
    } catch (err) { showError(err); }
  });

  $('#cookDate', s.el).addEventListener('change', e => {
    const day = e.target.value;
    e.target.value = '';
    if (!isYMD(day)) return;
    if (day > today) return toast('Tage in der Zukunft gehen nicht.');
    if (done.has(day)) return toast('Dieser Tag ist schon eingetragen.');
    picked.add(day);
    render();
  });

  render();
}
