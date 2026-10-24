// Bausteine der Oberfläche: Vollbild-Seiten, Bottom Sheets, Rückfragen, Hinweise.

import { esc, $ } from './util.js';
import { icon } from './icons.js';

const layer = () => document.getElementById('overlays');

// Andere Teile der App melden so, dass sich Daten geändert haben (Liste neu zeichnen).
export const emitChange = () => document.dispatchEvent(new CustomEvent('data-changed'));

// ---------- Vollbild-Seite ----------

export function openPage({ title, body = '', foot = '', back = 'Zurück', right = '', beforeClose, onClose }) {
  document.activeElement?.blur?.();
  const el = document.createElement('section');
  el.className = 'page';
  // "Zurück" als runder Glas-Knopf mit Pfeil, andere Beschriftungen (z. B. "Abbrechen") als Text
  const backBtn = back === 'Zurück'
    ? `<button class="nav-btn icon-only glass" data-back aria-label="Zurück">${icon.back(22)}</button>`
    : `<button class="nav-btn glass" data-back>${esc(back)}</button>`;
  el.innerHTML = `
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
    setFoot(html) {
      this.foot.innerHTML = html;
      this.foot.hidden = !html;
      $('.bottom-fade', el).hidden = !html;
      el.classList.toggle('has-foot', !!html);
    },
    close() {
      if (!el.isConnected) return;
      el.remove();
      onClose?.();
    },
    async tryClose() {
      if (beforeClose && !(await beforeClose())) return;
      page.close();
    },
  };
  $('[data-back]', el).addEventListener('click', () => page.tryClose());
  page.setFoot(foot);
  return page;
}

// ---------- Bottom Sheet ----------

export function openSheet({ title, body = '', foot = '', onClose }) {
  document.activeElement?.blur?.();
  const bd = document.createElement('div');
  bd.className = 'backdrop';
  bd.innerHTML = `
    <div class="sheet" role="dialog" aria-label="${esc(title)}">
      <div class="sheet-head"><h3>${esc(title)}</h3><button class="close-btn" data-x aria-label="Schließen">${icon.close(16)}</button></div>
      <div class="sheet-body">${body}</div>
      <div class="sheet-foot" ${foot ? '' : 'hidden'}>${foot}</div>
    </div>`;
  layer().append(bd);
  let closed = false;
  const sheet = {
    el: bd,
    body: $('.sheet-body', bd),
    foot: $('.sheet-foot', bd),
    setFoot(html) { this.foot.innerHTML = html; this.foot.hidden = !html; },
    close(result) {
      if (closed) return;
      closed = true;
      bd.remove();
      onClose?.(result);
    },
  };
  bd.addEventListener('click', e => { if (e.target === bd) sheet.close(); });
  $('[data-x]', bd).addEventListener('click', () => sheet.close());
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
