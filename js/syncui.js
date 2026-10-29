// Oberfläche für den Abgleich: Symbol oben, Sammlung anlegen, beitreten, einladen, Geräte, „Zuletzt gelöscht“.

import { state, isSynced, trashList, restoreDish, TRASH_DAYS } from './store.js';
import { syncStatus, syncNow, createCollection, joinCollection, whenSynced, createInvite, listDevices, renameDevice,
  removeDevice, leaveCollection, suggestDeviceName } from './sync.js';
import { checkForUpdate } from './pwa.js';
import { esc, $, fmtDate, fmtDateTime, plural, daysSince } from './util.js';
import { openPage, openSheet, confirmSheet, toast, showError, emitChange } from './ui.js';
import { icon } from './icons.js';

// ---------- Status ----------

export function statusInfo(st = syncStatus()) {
  const n = st.pending;
  switch (st.state) {
    case 'online':
      return n ? { icon: icon.cloudUp, cls: '', text: `${plural(n, 'Änderung wird', 'Änderungen werden')} gesendet …` }
        : { icon: icon.cloudOk, cls: 'ok', text: 'Alles abgeglichen' };
    case 'connecting':
      return { icon: icon.cloudUp, cls: '', text: 'Verbinde …' };
    case 'offline':
      return { icon: icon.cloudOff, cls: '', text: n ? `Keine Verbindung – ${plural(n, 'Änderung wartet', 'Änderungen warten')}` : 'Keine Verbindung' };
    case 'update':
      return { icon: icon.cloudAlert, cls: 'alert', text: 'Bitte die App aktualisieren' };
    case 'removed':
      return { icon: icon.cloudAlert, cls: 'alert', text: 'Dieses Gerät wurde aus der Sammlung entfernt' };
    default:
      return { icon: icon.cloudOff, cls: '', text: 'Nicht verbunden' };
  }
}

export function syncButtonHtml() {
  const s = statusInfo();
  return `<button class="sync-btn glass ${s.cls}" id="btnSync" aria-label="Abgleich: ${esc(s.text)}">${s.icon(24)}</button>`;
}

export function openSyncSheet({ onSettings } = {}) {
  let timer = null;
  const s = openSheet({ title: 'Abgleich', onClose: () => clearInterval(timer) });
  const render = () => {
    const st = syncStatus();
    const info = statusInfo(st);
    s.body.innerHTML = `
      <p class="sync-line ${info.cls}">${info.icon(26)}<b>${esc(info.text)}</b></p>
      ${st.lastSync ? `<p class="muted">Zuletzt abgeglichen: ${fmtDateTime(new Date(st.lastSync))}</p>` : ''}
      <p class="hint">${st.state === 'offline'
        ? 'Ohne Internet geht alles weiter. Änderungen werden abgeglichen, sobald wieder eine Verbindung besteht.'
        : st.state === 'update' ? 'Diese Version passt nicht mehr zum Server. Nach dem Aktualisieren geht der Abgleich weiter.'
          : 'Änderungen erscheinen nach wenigen Sekunden auf den anderen Geräten.'}</p>`;
    s.setFoot(`<button class="btn grow" data-settings>Einstellungen</button>
      ${st.state === 'update' ? '<button class="btn primary grow" data-update>Aktualisieren</button>'
        : isSynced() ? '<button class="btn primary grow" data-now>Abgleichen</button>' : ''}`);
  };
  timer = setInterval(render, 1000);
  s.el.addEventListener('click', async e => {
    if (e.target.closest('[data-now]')) syncNow();
    if (e.target.closest('[data-settings]')) {
      s.close();
      onSettings?.();
    }
    if (e.target.closest('[data-update]')) {
      const r = await checkForUpdate();
      toast(r === 'update' ? 'Neue Version gefunden – oben auf „Neu laden“ tippen.' : 'Keine neue Version gefunden. Bitte später erneut versuchen.');
    }
  });
  render();
}

// ---------- Sammlung anlegen ----------

const nameField = value => `
  <div class="field"><label for="devName">Name dieses Geräts</label>
    <input class="input" id="devName" value="${esc(value)}" maxlength="40" autocomplete="off" autocorrect="off">
    <p class="hint">Damit ihr die Geräte in der Liste erkennt, z. B. „iPhone Lukas“.</p></div>`;

export function openCreateSheet({ onDone } = {}) {
  const n = state.dishes.size;
  const s = openSheet({
    title: 'Neue Sammlung anlegen',
    body: `
      <p>${n ? `Die ${plural(n, 'Gericht', 'Gerichte')} von diesem Gerät werden die gemeinsame Sammlung.` : 'Die Sammlung startet leer.'}
        Danach könnt ihr weitere Geräte mit einem Code einladen. Alle Änderungen werden abgeglichen.</p>
      ${nameField(suggestDeviceName())}
      <p class="hint">Die Daten liegen auf eurem Server bei Cloudflare in der EU. Dafür braucht es jetzt eine Internetverbindung.</p>`,
    foot: '<button class="btn primary grow" data-go>Sammlung anlegen</button>',
  });
  $('[data-go]', s.el).addEventListener('click', async e => {
    const b = e.currentTarget;
    const name = $('#devName', s.el).value.trim() || suggestDeviceName();
    b.disabled = true;
    b.textContent = 'Lege an …';
    try {
      await createCollection(name);
      b.textContent = 'Gleiche ab …';
      await whenSynced().catch(() => {});
      s.close();
      emitChange();
      toast('Sammlung angelegt. Weitere Geräte: Einstellungen → „Gerät einladen“.', { ms: 6000 });
      onDone?.();
    } catch (err) {
      b.disabled = false;
      b.textContent = 'Sammlung anlegen';
      showError(err, 'Die Sammlung konnte nicht angelegt werden.');
    }
  });
}

// ---------- Beitreten ----------

const fmtCode = raw => {
  const c = raw.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8);
  return c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
};

export function openJoinSheet({ onDone } = {}) {
  const n = state.dishes.size;
  const s = openSheet({
    title: 'Mit Code beitreten',
    body: `
      <p>Auf einem Gerät, das schon dabei ist: Einstellungen → „Gerät einladen“. Den Code hier eingeben.</p>
      <div class="field"><label for="joinCode">Code</label>
        <input class="input code-input" id="joinCode" placeholder="ABCD-EFGH" maxlength="9" autocomplete="off" autocorrect="off"
          autocapitalize="characters" spellcheck="false" inputmode="text" enterkeyhint="go"></div>
      ${nameField(suggestDeviceName())}
      ${n ? `<div class="error-box">⚠︎ Die ${plural(n, 'Gericht', 'Gerichte')} auf diesem Gerät werden durch die gemeinsame Sammlung ersetzt.
        Falls hier etwas Wichtiges ist, das die anderen nicht haben: vorher exportieren.</div>` : ''}`,
    foot: '<button class="btn primary grow" data-go disabled>Beitreten</button>',
  });
  const input = $('#joinCode', s.el);
  const go = $('[data-go]', s.el);
  input.addEventListener('input', () => {
    input.value = fmtCode(input.value);
    go.disabled = input.value.replace('-', '').length !== 8;
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !go.disabled) go.click(); });
  go.addEventListener('click', async () => {
    const name = $('#devName', s.el).value.trim() || suggestDeviceName();
    go.disabled = true;
    go.textContent = 'Trete bei …';
    try {
      await joinCollection(input.value, name);
      go.textContent = 'Lade die Sammlung …';
      await whenSynced().catch(() => {});
      s.close();
      emitChange();
      toast(`Beigetreten – ${plural(state.dishes.size, 'Gericht', 'Gerichte')} geladen.`);
      onDone?.();
    } catch (err) {
      go.disabled = false;
      go.textContent = 'Beitreten';
      showError(err, 'Beitreten hat nicht geklappt.');
    }
  });
  setTimeout(() => input.focus(), 350);
}

// ---------- Einladen ----------

export function openInviteSheet() {
  let timer = null;
  const s = openSheet({ title: 'Gerät einladen', body: '<p class="muted">Erzeuge einen Code …</p>', onClose: () => clearInterval(timer) });
  const make = async () => {
    clearInterval(timer);
    s.setFoot('');
    s.body.innerHTML = '<p class="muted">Erzeuge einen Code …</p>';
    try {
      const { code, expiresAt } = await createInvite();
      s.body.innerHTML = `
        <p>Auf dem neuen Gerät die App öffnen und „Mit Code beitreten“ wählen (bei einem Gerät, das schon Gerichte hat:
          Einstellungen → Abgleich). Dann diesen Code eingeben:</p>
        <div class="invite-code">${code.slice(0, 4)}-${code.slice(4)}</div>
        <p class="hint" id="inviteLeft" style="text-align:center"></p>
        <ol class="invite-steps"><li>Der Code gilt 15 Minuten und nur für ein Gerät.</li>
          <li>Das neue Gerät übernimmt die gemeinsame Sammlung.</li></ol>`;
      const tick = () => {
        const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
        const el = $('#inviteLeft', s.el);
        if (el) el.textContent = left ? `gilt noch ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} Minuten` : 'abgelaufen';
        if (!left) {
          clearInterval(timer);
          s.setFoot('<button class="btn primary grow" data-again>Neuen Code erzeugen</button>');
        }
      };
      tick();
      timer = setInterval(tick, 1000);
    } catch (err) {
      s.body.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
      s.setFoot('<button class="btn primary grow" data-again>Erneut versuchen</button>');
    }
  };
  s.el.addEventListener('click', e => { if (e.target.closest('[data-again]')) make(); });
  make();
}

// ---------- Geräte ----------

export function openDevices() {
  const page = openPage({ title: 'Geräte' });
  let list = [];
  let self = null;
  const render = () => {
    page.body.innerHTML = `
      <div class="list-box">${list.map(d => `
        <button class="list-row device-row" data-id="${esc(d.id)}">
          <span><b>${esc(d.name)}</b>${d.id === self ? ' <span class="muted">(dieses Gerät)</span>' : ''}
            <span class="sub">${d.online ? 'gerade verbunden' : d.lastSeen ? `zuletzt am ${fmtDateTime(new Date(d.lastSeen))}` : ''}</span></span>
          ${d.online ? '<span class="dot" aria-hidden="true"></span>' : ''}
        </button>`).join('')}</div>
      <p class="hint">Tippe auf ein Gerät, um es umzubenennen oder zu entfernen. Ein entferntes Gerät wird sofort getrennt
        und behält nur seine bisherige Kopie.</p>`;
  };
  const load = async () => {
    page.body.innerHTML = '<p class="muted">Lade die Geräteliste …</p>';
    try {
      const r = await listDevices();
      list = r.devices;
      self = r.self;
      render();
    } catch (err) {
      page.body.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
    }
  };
  page.body.addEventListener('click', e => {
    const row = e.target.closest('[data-id]');
    if (row) editDevice(list.find(d => d.id === row.dataset.id), self, load);
  });
  load();
}

function editDevice(dev, self, after) {
  const mine = dev.id === self;
  const s = openSheet({
    title: dev.name,
    body: `
      <div class="field"><label for="devRename">Name</label>
        <input class="input" id="devRename" value="${esc(dev.name)}" maxlength="40" autocomplete="off" autocorrect="off"></div>
      <button class="btn primary full" data-rename>Namen speichern</button>
      ${mine ? '' : '<button class="btn danger full" data-remove style="margin-top:12px">Gerät entfernen …</button>'}`,
  });
  s.el.addEventListener('click', async e => {
    try {
      if (e.target.closest('[data-rename]')) {
        await renameDevice(dev.id, $('#devRename', s.el).value);
        s.close();
        toast('Umbenannt.');
        after();
      }
      if (e.target.closest('[data-remove]')) {
        const ok = await confirmSheet({
          title: `„${esc(dev.name)}“ entfernen?`,
          text: 'Das Gerät wird sofort getrennt und kann ohne neuen Code nicht wieder beitreten. Seine bisherige Kopie der Gerichte bleibt dort.',
          ok: 'Entfernen',
          danger: true,
        });
        if (!ok) return;
        await removeDevice(dev.id);
        s.close();
        toast(`„${dev.name}“ entfernt.`);
        after();
      }
    } catch (err) { showError(err); }
  });
}

export async function confirmLeave() {
  const ok = await confirmSheet({
    title: 'Abgleich beenden?',
    text: 'Dieses Gerät verlässt die Sammlung. Seine Gerichte bleiben hier, Änderungen werden aber nicht mehr abgeglichen. Ist es das letzte Gerät, wird die Sammlung auf dem Server gelöscht.',
    ok: 'Abgleich beenden',
    danger: true,
  });
  if (!ok) return false;
  const told = await leaveCollection();
  toast(told ? 'Abgleich beendet.' : 'Abgleich beendet. Der Server war nicht erreichbar – entfernt das Gerät auf einem anderen unter „Geräte“.', { ms: 6000 });
  return true;
}

// ---------- Zuletzt gelöscht ----------

export function openTrash() {
  const onChange = () => render();
  const page = openPage({ title: 'Zuletzt gelöscht', onClose: () => document.removeEventListener('data-changed', onChange) });
  document.addEventListener('data-changed', onChange);
  function render() {
    const items = trashList();
    page.body.innerHTML = items.length ? `
      <div class="list-box">${items.map(d => {
        const left = Math.max(0, TRASH_DAYS - (daysSince(d.deleted.slice(0, 10)) ?? 0));
        const thumb = state.thumbs.get(d.id);
        return `<div class="list-row trash-row">
          ${thumb ? `<img class="thumb" src="${thumb}" alt="">` : `<div class="thumb" aria-hidden="true">${esc(d.name.charAt(0).toUpperCase())}</div>`}
          <span><b>${esc(d.name)}</b><span class="sub">gelöscht am ${fmtDate(d.deleted)} · ${left ? `noch ${plural(left, 'Tag', 'Tage')}` : 'wird bald entfernt'}</span></span>
          <button class="btn tinted" data-restore="${esc(d.id)}">Zurückholen</button>
        </div>`;
      }).join('')}</div>
      <p class="hint">Gelöschte Gerichte bleiben ${TRASH_DAYS} Tage hier, danach werden sie mit Foto und Kochtagen endgültig entfernt${isSynced() ? ' – auf allen Geräten' : ''}.</p>`
      : `<div class="empty"><p>Nichts gelöscht.</p><p class="muted">Gelöschte Gerichte bleiben ${TRASH_DAYS} Tage hier und lassen sich zurückholen.</p></div>`;
  }
  page.body.addEventListener('click', async e => {
    const b = e.target.closest('[data-restore]');
    if (!b) return;
    try {
      const name = state.trash.get(b.dataset.restore)?.name;
      await restoreDish(b.dataset.restore);
      emitChange();
      toast(`„${name}“ ist wieder da.`);
    } catch (err) { showError(err); }
  });
  render();
}
