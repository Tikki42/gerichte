// Bausteine der Oberfläche: Vollbild-Seiten (Seitenstapel im Browser-Verlauf, Zurück-Wischen),
// Fenster von unten (Bottom Sheets), Rückfragen, Hinweise.

import { esc, $, isStandalone, lsSet, nowISO } from './util.js';
import { icon } from './icons.js';
import { animateTo, fade, allDone, reduceMotion, MS } from './motion.js';
import { dragGesture, passed } from './gestures.js';

const layer = () => document.getElementById('overlays');
const home = () => document.getElementById('app');

// Andere Teile der App melden so, dass sich Daten geändert haben (Liste neu zeichnen).
export const emitChange = () => document.dispatchEvent(new CustomEvent('data-changed'));

// ---------- Seitenstapel ----------
// Seiten liegen übereinander, die oberste zuletzt. Eine neue Seite schiebt sich von rechts herein,
// die verdeckte rückt leicht nach links mit; nach dem Übergang ist nur die oberste sichtbar.

const pages = [];
const sheets = [];  // offene Fenster von unten
let moving = 0;     // laufende Seitenwechsel und Wischgesten

const UNDER = 'translateX(-30%)';
const OUT = 'translateX(100%)';
const topLayer = () => pages.at(-1)?.el || home();

async function transition(...steps) {
  moving++;
  try {
    await allDone(steps);
  } finally {
    moving--;
    settleLayers();
  }
}

// Nur die oberste Ebene ist sichtbar und antippbar (verdeckte Seiten behalten ihre Scroll-Position)
function settleLayers() {
  if (moving) return;
  const layers = [home(), ...pages.map(p => p.el)];
  layers.forEach((el, i) => {
    const below = i < layers.length - 1;
    el.classList.toggle('under', below);
    el.classList.toggle('covered', below);
  });
}

function showPage(page, under) {
  under.classList.add('under');
  if (reduceMotion()) {
    page.el.style.opacity = '0';
    return transition(fade(page.el, ''));
  }
  page.el.style.transform = OUT;
  page.shade.style.opacity = '0';
  return transition(animateTo(page.el, 'transform', ''), animateTo(page.shade, 'opacity', ''), animateTo(under, 'transform', UNDER));
}

function hidePage(page, under, { animate = true, slide = false, duration = MS.page } = {}) {
  page.el.classList.add('closing');
  under.classList.remove('covered');
  if (!animate || (reduceMotion() && !slide)) {
    under.style.transform = '';
    return transition(animate ? fade(page.el, '0') : null);
  }
  const o = { duration };
  return transition(animateTo(page.el, 'transform', OUT, o), animateTo(page.shade, 'opacity', '0', o), animateTo(under, 'transform', '', o));
}

// beforeClose: true = Seite darf zu, sonst ein Promise (z. B. Rückfrage „Änderungen verwerfen?“).
// replace: Die neue Seite tritt an die Stelle der obersten (Zurück führt dann gleich weiter nach unten).
export function openPage({ title, body = '', foot = '', back = 'Zurück', right = '', beforeClose, onClose, replace = false }) {
  document.activeElement?.blur?.();
  const el = document.createElement('section');
  el.className = 'page';
  // "Zurück" als runder Glas-Knopf mit Pfeil, andere Beschriftungen (z. B. "Abbrechen") als Text
  const backBtn = back === 'Zurück'
    ? `<button class="nav-btn icon-only glass" data-back aria-label="Zurück">${icon.back(22)}</button>`
    : `<button class="nav-btn glass" data-back>${esc(back)}</button>`;
  el.innerHTML = `
    <div class="page-shade" aria-hidden="true"></div>
    <header class="page-head">
      ${backBtn}
      <h2>${esc(title)}</h2>
      ${right || '<span></span>'}
    </header>
    <div class="page-body">${body}</div>
    <div class="bottom-fade" hidden></div>
    <footer class="page-foot" hidden></footer>`;
  layer().append(el);
  const page = {
    el,
    body: $('.page-body', el),
    foot: $('.page-foot', el),
    shade: $('.page-shade', el),
    beforeClose,
    closing: false,
    setFoot(html) {
      this.foot.innerHTML = html;
      this.foot.hidden = !html;
      $('.bottom-fade', el).hidden = !html;
      el.classList.toggle('has-foot', !!html);
    },
    // Knopf rechts oben (z. B. "Bearbeiten")
    setRight(html) {
      $('.page-head', el).lastElementChild.outerHTML = html || '<span></span>';
    },
    close() {
      closePage(page);
    },
    async tryClose() {
      if (beforeClose && !(await beforeClose())) return;
      page.close();
    },
    // endgültig entfernen, wenn der Übergang vorbei ist
    remove() {
      el.remove();
      onClose?.();
    },
  };
  $('[data-back]', el).addEventListener('click', () => page.tryClose());
  page.setFoot(foot);
  const prev = replace ? pages.pop() : null;
  if (prev) prev.closing = true;
  const under = prev?.el || topLayer();
  pages.push(page);
  if (prev) histReplace(pages.length);
  else histPush(pages.length);
  page.opened = showPage(page, under).then(() => prev?.remove());
  return page;
}

function closePage(page, { fromHistory = false, animate = true, slide = false, duration } = {}) {
  if (page.closing) return;
  page.closing = true;
  if (page.el.contains(document.activeElement)) document.activeElement.blur();
  const i = pages.indexOf(page);
  pages.splice(i, 1);
  if (!fromHistory) histGoTo(pages.length);
  if (i < pages.length) return page.remove(); // nicht die oberste (selten): sofort entfernen
  hidePage(page, topLayer(), { animate, slide, duration }).then(() => page.remove());
}

// ---------- Browser-Verlauf ----------
// Jede offene Seite hat einen Eintrag im Verlauf (state.gerichte = Zahl der offenen Seiten).
// So nehmen Zurück-Knopf, Zurück-Wischen und Browser-Zurück (Safari, später Android) denselben Weg.

let histQueue = Promise.resolve();
let histWait = null; // eigenes history.go(), dessen popstate noch aussteht

const histDepth = () => history.state?.gerichte ?? 0;
// nacheinander ausführen, denn history.go() wirkt erst später (popstate)
const histDo = fn => { histQueue = histQueue.then(fn).catch(e => console.warn('Verlauf:', e)); };
const histPush = depth => histDo(() => history.pushState({ gerichte: depth }, ''));
const histReplace = depth => histDo(() => history.replaceState({ gerichte: depth }, ''));

function histGoTo(depth) {
  histDo(() => new Promise(resolve => {
    const steps = depth - histDepth();
    if (steps >= 0) return resolve();
    const wait = { depth, done: () => { if (histWait === wait) histWait = null; resolve(); } };
    histWait = wait;
    setTimeout(wait.done, 1500); // falls kein popstate kommt
    history.go(steps);
  }));
}

window.addEventListener('popstate', e => {
  const depth = histDepth();
  if (histWait?.depth === depth) return histWait.done();
  browserBack(depth, e.hasUAVisualTransition === true);
});

// Zurück im Browser oder durch iOS selbst (nicht über die App): Seiten oberhalb der Zieltiefe schließen.
// uaAnimated: Der Browser hat den Wechsel schon gezeigt (Safari-Wischgeste) – dann nicht noch einmal animieren.
function browserBack(depth, uaAnimated) {
  if (depth > pages.length) return histReplace(pages.length); // vorwärts: diese Seite gibt es nicht mehr
  if (depth === pages.length) return;
  if (isStandalone()) lsSet('nativeBack', nowISO()); // für die Prüfliste: blättert iOS in der App selbst zurück?
  for (const s of [...sheets].reverse()) s.close();
  const top = pages.at(-1);
  const ok = top.beforeClose ? top.beforeClose() : true;
  if (ok !== true) {
    histPush(pages.length); // Rückfrage: Seite bleibt vorerst offen, ihr Eintrag kommt zurück
    Promise.resolve(ok).then(yes => yes && closePage(top));
    return;
  }
  while (pages.length > depth) closePage(pages.at(-1), { fromHistory: true, animate: !uaAnimated && pages.length === depth + 1 });
}

// Nach dem Neuladen (z. B. „Neu laden“ bei einer neuen Version) ist keine Seite mehr offen
if (histDepth() > 0) histGoTo(0);

// ---------- Zurück-Wischen vom linken Rand ----------
// Nur in der installierten App – im Safari-Browser übernimmt dessen eigene Geste (über den Verlauf).

const EDGE = 24; // Breite des Randstreifens in Punkten

dragGesture(layer(), {
  axis: 'x',
  begin(e, t) {
    const page = pages.at(-1);
    if (t.clientX > EDGE || moving || sheets.length || !page?.el.contains(e.target) || !isStandalone()) return null;
    return { page, under: pages.at(-2)?.el || home() };
  },
  start(g) {
    moving++;
    g.w = g.page.el.offsetWidth;
    g.parallax = !reduceMotion(); // bei „Bewegung reduzieren“ bleibt die untere Seite stehen
    g.under.classList.remove('covered');
  },
  move({ page, under, w, parallax }, d) {
    if (page.closing) return;
    const p = Math.min(d / w, 1);
    page.el.style.transform = `translateX(${d}px)`;
    page.shade.style.opacity = String(1 - p);
    if (parallax) under.style.transform = `translateX(${(p - 1) * 30}%)`;
  },
  end({ page, under, w, parallax }, d, v, cancelled) {
    moving--;
    if (page.closing) return settleLayers(); // inzwischen anders geschlossen (z. B. von iOS selbst)
    if (!cancelled && passed(d, v, w, .4)) {
      const ok = page.beforeClose ? page.beforeClose() : true;
      if (ok === true) return closePage(page, { slide: true, duration: Math.min(MS.page, Math.max(120, (w - d) / Math.max(v, 1))) });
      Promise.resolve(ok).then(yes => yes && closePage(page)); // ungespeicherte Änderungen: zurückfedern und fragen
    }
    const o = { duration: MS.back };
    transition(animateTo(page.el, 'transform', '', o), animateTo(page.shade, 'opacity', '', o), animateTo(under, 'transform', parallax ? UNDER : '', o));
  },
});

// ---------- Fenster von unten (Bottom Sheet) ----------

// Fenster hoch- oder hinausgleiten lassen, die Abdunklung blendet mit
function slideSheet(bd, show) {
  const panel = $('.sheet', bd);
  const shade = $('.shade', bd);
  if (reduceMotion()) {
    if (show) {
      panel.style.opacity = '0';
      shade.style.opacity = '0';
    }
    return allDone([fade(panel, show ? '' : '0'), fade(shade, show ? '' : '0')]);
  }
  const below = `translateY(${bd.clientHeight - panel.offsetTop + 40}px)`; // ganz unter den unteren Rand
  if (show) {
    panel.style.transform = below;
    shade.style.opacity = '0';
  }
  const o = { duration: show ? MS.sheetIn : MS.sheetOut };
  return allDone([animateTo(panel, 'transform', show ? '' : below, o), animateTo(shade, 'opacity', show ? '' : '0', o)]);
}

export function openSheet({ title, body = '', foot = '', onClose }) {
  document.activeElement?.blur?.();
  const bd = document.createElement('div');
  bd.className = 'backdrop';
  bd.innerHTML = `
    <div class="shade"></div>
    <div class="sheet" role="dialog" aria-label="${esc(title)}">
      <div class="grabber" aria-hidden="true"></div>
      <div class="sheet-head"><h3>${esc(title)}</h3><button class="close-btn" data-x aria-label="Schließen">${icon.close(16)}</button></div>
      <div class="sheet-body">${body}</div>
      <div class="sheet-foot" ${foot ? '' : 'hidden'}>${foot}</div>
    </div>`;
  layer().append(bd);
  const panel = $('.sheet', bd);
  const shade = $('.shade', bd);
  let opening = true;
  let closed = false;
  const sheet = {
    el: bd,
    body: $('.sheet-body', bd),
    foot: $('.sheet-foot', bd),
    setFoot(html) { this.foot.innerHTML = html; this.foot.hidden = !html; },
    close(result) {
      if (closed) return;
      closed = true;
      sheets.splice(sheets.indexOf(sheet), 1);
      if (bd.contains(document.activeElement)) document.activeElement.blur();
      bd.classList.add('closing'); // Hinweise rücken gleich wieder nach unten, Tippen geht schon durch
      slideSheet(bd, false).then(() => bd.remove());
      onClose?.(result);
    },
  };
  sheets.push(sheet);
  bd.addEventListener('click', e => { if (e.target === shade) sheet.close(); });
  $('[data-x]', bd).addEventListener('click', () => sheet.close());
  // Nach unten wegwischen: am Griff, am Kopf oder Fuß – im Inhalt nur, wenn er ganz oben steht
  dragGesture(panel, {
    axis: 'y',
    begin(e) {
      const inner = e.target.closest('.sheet-body');
      if (opening || closed || (inner && (inner.scrollTop > 0 || e.target.closest('input, textarea, select')))) return null;
      return {};
    },
    move(_, d) {
      panel.style.transform = `translateY(${d}px)`;
      shade.style.opacity = String(Math.max(0, 1 - d / panel.offsetHeight));
    },
    end(_, d, v, cancelled) {
      if (closed) return;
      if (!cancelled && passed(d, v, panel.offsetHeight, .3)) return sheet.close();
      const o = { duration: MS.back };
      animateTo(panel, 'transform', '', o);
      animateTo(shade, 'opacity', '', o);
    },
  });
  slideSheet(bd, true).then(() => { opening = false; });
  return sheet;
}

// Rückfrage mit zwei Knöpfen. Ergebnis: true/false
export function confirmSheet({ title, text = '', ok = 'OK', cancel = 'Abbrechen', danger = false }) {
  return new Promise(resolve => {
    const s = openSheet({
      title,
      body: text ? `<p>${text}</p>` : '',
      foot: `<button class="btn grow" data-no>${esc(cancel)}</button>
             <button class="btn grow ${danger ? 'danger-fill' : 'primary'}" data-yes>${esc(ok)}</button>`,
      onClose: r => resolve(r === true),
    });
    $('[data-no]', s.el).addEventListener('click', () => s.close(false));
    $('[data-yes]', s.el).addEventListener('click', () => s.close(true));
  });
}

export function alertSheet(title, html) {
  return new Promise(resolve => {
    const s = openSheet({ title, body: html, foot: '<button class="btn primary grow" data-ok>OK</button>', onClose: resolve });
    $('[data-ok]', s.el).addEventListener('click', () => s.close());
  });
}

// ---------- Hinweis unten ----------

export function toast(text, { action, onAction, ms = 4000 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${esc(text)}</span>${action ? `<button>${esc(action)}</button>` : ''}`;
  document.getElementById('toasts').append(el);
  const t = setTimeout(() => el.remove(), ms);
  if (action) {
    $('button', el).addEventListener('click', () => {
      clearTimeout(t);
      el.remove();
      onAction?.();
    });
  }
}

// Zeigt Fehler verständlich an (statt die App abstürzen zu lassen)
export function showError(e, intro = 'Das hat nicht geklappt.') {
  console.error(e);
  const details = e?.details?.length ? `<ul>${e.details.map(d => `<li>${esc(d)}</li>`).join('')}</ul>` : '';
  return alertSheet('Fehler', `<p>${esc(intro)}</p><p>${esc(e?.message || String(e))}</p>${details}`);
}
