// Bewegung: kurze, iOS-artige Übergänge mit der Web Animations API des Browsers (ohne fremde Bibliothek).
// Ist auf dem Gerät „Bewegung reduzieren“ eingeschaltet, wird nur sanft überblendet.

export const EASE = 'cubic-bezier(.32, .72, 0, 1)'; // zügiger Start, weiches Auslaufen
export const MS = { page: 340, sheetIn: 380, sheetOut: 300, back: 260, fade: 200, list: 280 };

export const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Animiert transform oder opacity vom aktuellen Wert (auch mitten in einer Animation) zum Wert `to`.
// `to` bleibt danach als Stil stehen; '' heißt: zurück zum Wert aus app.css.
export function animateTo(el, prop, to, { duration = MS.page, easing = EASE } = {}) {
  if (!el.animate) {
    el.style[prop] = to;
    return Promise.resolve();
  }
  const from = getComputedStyle(el)[prop];
  for (const a of el.getAnimations()) {
    if (a.effect?.getKeyframes().some(k => prop in k)) a.cancel();
  }
  el.style[prop] = to;
  const end = getComputedStyle(el)[prop];
  if (from === end) return Promise.resolve();
  // Abgebrochen (weil eine neue Bewegung übernimmt) zählt ebenfalls als fertig
  return el.animate({ [prop]: [from, end] }, { duration, easing }).finished.catch(() => {});
}

export const fade = (el, to, duration = MS.fade) => animateTo(el, 'opacity', to, { duration, easing: 'ease' });

// Wartet, bis alle Bewegungen fertig sind – höchstens eine Sekunde, falls eine hängen bleibt
export const allDone = steps => Promise.race([Promise.all(steps), new Promise(r => setTimeout(r, 1000))]);

// Liste weich umstellen (Suchen, Filtern, Sortieren): render() tauscht den Inhalt aus,
// danach gleiten Karten (data-id) von ihrer alten an die neue Stelle, neue Einträge blenden ein.
export function flipList(list, render) {
  const animate = list.firstElementChild && list.animate && getComputedStyle(list).visibility !== 'hidden';
  const viewBefore = list.getBoundingClientRect();
  const before = new Map();
  if (animate) for (const el of list.children) if (el.dataset.id) before.set(el.dataset.id, el.getBoundingClientRect());
  render();
  if (!animate) return;
  const view = list.getBoundingClientRect();
  const visible = (r, v) => r.bottom > v.top && r.top < v.bottom;
  const calm = reduceMotion();
  for (const el of list.children) {
    const r = el.getBoundingClientRect();
    if (!visible(r, view)) continue; // außerhalb des sichtbaren Bereichs: nichts zu tun
    const was = before.get(el.dataset.id);
    if (was && was.top === r.top && was.left === r.left) continue;
    if (was && visible(was, viewBefore) && !calm) {
      el.animate({ transform: [`translate(${was.left - r.left}px, ${was.top - r.top}px)`, 'none'] }, { duration: MS.list, easing: EASE });
    } else {
      el.animate({ opacity: [0, 1] }, { duration: MS.fade, easing: 'ease-out' });
    }
  }
}
