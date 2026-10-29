// Einstellungen: Abgleich, Export, Import, Gerichte hinzufügen, Listen, Speicher, Version.

import { state, canEdit, isSynced, setMeta, lastExport, exportDue, noteExport, EXPORT_REMIND_DAYS } from './store.js';
import { buildExport, readJsonFile, prepareReplace, commitReplace, prepareAdd, commitAdd } from './io.js';
import { checkForUpdate, appVersion } from './pwa.js';
import { syncStatus, onSyncStatus } from './sync.js';
import { statusInfo, openCreateSheet, openJoinSheet, openInviteSheet, openDevices, openTrash, confirmLeave } from './syncui.js';
import { esc, $, fmtDateTime, fmtDate, fmtBytes, plural, isStandalone } from './util.js';
import { openPage, openSheet, confirmSheet, toast, showError, emitChange } from './ui.js';
import { openIngredients, openMethods } from './manage.js';
import { icon } from './icons.js';

export function openSettings({ focus } = {}) {
  let prepared = null; // vorbereitete Exportdatei
  const onChange = () => render();
  const offStatus = onSyncStatus(() => renderSyncLine());
  const page = openPage({
    title: 'Einstellungen',
    onClose: () => {
      document.removeEventListener('data-changed', onChange);
      offStatus();
    },
  });
  document.addEventListener('data-changed', onChange);

  function syncHtml() {
    if (isSynced()) {
      const s = statusInfo();
      return `
        <div class="section"><h3>Abgleich</h3><div class="box">
          <p class="sync-line ${s.cls}" id="syncLine">${s.icon(22)}<b>${esc(s.text)}</b></p>
          <p class="muted">Dieses Gerät: <b>${esc(state.meta.sync.name)}</b></p>
          <button class="btn primary" data-invite>Gerät einladen …</button>
          <p class="hint">Zeigt einen Code, mit dem ein weiteres Gerät der Sammlung beitritt.</p>
        </div>
        <div class="menu" style="margin-top:12px"><button class="menu-item" data-devices>Geräte</button></div>
        <button class="btn danger full" data-leave style="margin-top:12px">Abgleich beenden …</button></div>`;
    }
    const reader = state.meta.deviceType === 'reader';
    return `
      <div class="section"><h3>Abgleich</h3><div class="box">
        <p>${reader
          ? 'Dieses Gerät ist ein Lesegerät, die Daten kommen als Datei. Mit dem Abgleich habt ihr auf allen Geräten sofort denselben Stand und dürft alle bearbeiten.'
          : 'Die Gerichte liegen nur auf diesem Gerät.'}</p>
        ${reader ? '' : `<button class="btn primary" data-create>Neue Sammlung anlegen …</button>
          <p class="hint">Für das erste Gerät: Seine Gerichte werden die gemeinsame Sammlung.</p>`}
        <button class="btn ${reader ? 'primary' : 'tinted'}" data-join ${reader ? '' : 'style="margin-top:14px"'}>Mit Code beitreten …</button>
        <p class="hint">Ein anderes Gerät zeigt unter „Gerät einladen“ einen Code. Die Gerichte hier werden dann durch die gemeinsame Sammlung ersetzt.</p>
        ${reader ? '<button class="link-btn" data-local style="margin-top:8px">Stattdessen nur auf diesem Gerät nutzen</button>' : ''}
      </div></div>`;
  }

  function renderSyncLine() {
    const el = $('#syncLine', page.el);
    if (!el) return;
    const s = statusInfo();
    el.className = `sync-line ${s.cls}`;
    el.innerHTML = `${s.icon(22)}<b>${esc(s.text)}</b>`;
  }

  function exportHtml() {
    const last = lastExport();
    const status = exportDue()
      ? `<p class="bad">⚠︎ ${last ? `Letzter Export vor über ${EXPORT_REMIND_DAYS} Tagen` : 'Noch nicht exportiert'}</p>`
      : last ? '<p class="ok">✓ Gesichert</p>' : '';
    const step = prepared
      ? `<p>Datei bereit: <b>${esc(prepared.name)}</b><br>
           <span class="muted">${plural(prepared.dishCount, 'Gericht', 'Gerichte')}, ${plural(prepared.photoCount, 'Foto', 'Fotos')} · ${fmtBytes(prepared.size)}</span></p>
         <button class="btn primary" data-share>2. Teilen …</button>
         <p class="hint">Im Teilen-Menü „In Dateien sichern“ wählen, dann euren geteilten iCloud-Ordner.</p>
         <button class="link-btn" data-download>Stattdessen herunterladen</button>`
      : '<button class="btn primary" data-prepare>1. Exportdatei vorbereiten</button>';
    return `
      <div class="section" id="secExport"><h3>Export = Backup</h3><div class="box">
        <p>Letzter Export: <b>${last ? fmtDateTime(last.at) : 'noch nie'}</b>${last?.by ? ` <span class="muted">von ${esc(last.by)}</span>` : ''}</p>
        ${status}
        ${step}
        <p class="hint">Die App erinnert, wenn der letzte Export länger als ${EXPORT_REMIND_DAYS} Tage zurückliegt${isSynced() ? '. Ein Export gilt für die ganze Sammlung' : ''}.</p>
      </div></div>`;
  }

  function render() {
    const edit = canEdit();
    const reader = state.meta.deviceType === 'reader';
    const m = state.meta;
    page.body.innerHTML = `
      ${syncHtml()}

      ${edit ? exportHtml() : ''}

      <div class="section"><h3>${reader ? 'Daten' : 'Import'}</h3><div class="box">
        ${reader ? `<p>Stand: <b>${m.lastImport ? fmtDate(m.dataStand) : 'noch keine Daten'}</b>
            ${m.lastImport ? `<br><span class="muted">geladen am ${fmtDateTime(m.lastImport.at)}</span>` : ''}</p>
          <button class="btn primary" data-replace>Daten aktualisieren …</button>` : `
          <button class="btn tinted" data-add>Gerichte hinzufügen …</button>
          <p class="hint">Übernimmt aus einer Datei nur Gerichte, die noch fehlen.</p>
          <button class="btn tinted" data-replace style="margin-top:14px">Backup wiederherstellen …</button>
          <p class="hint">${isSynced()
            ? 'Ersetzt die Gerichte auf allen Geräten der Sammlung durch den Stand aus einer Exportdatei.'
            : 'Ersetzt alle Gerichte durch den Stand aus einer Exportdatei.'}</p>`}
      </div></div>

      ${edit ? `<div class="section"><h3>Listen pflegen</h3><div class="menu">
        <button class="menu-item" data-ings>Zutaten <small>${state.ingredients.size}</small></button>
        <button class="menu-item" data-methods>Zubereitungsarten <small>${state.methods.size}</small></button>
        <button class="menu-item" data-trash>Zuletzt gelöscht <small>${state.trash.size}</small></button>
      </div></div>` : ''}

      <div class="section"><h3>Speicher</h3><div class="box" id="storage"><p class="muted">Prüfe …</p></div></div>

      <div class="section"><h3>App</h3><div class="box">
        <p>Bestand: ${plural(state.dishes.size, 'Gericht', 'Gerichte')}, ${plural(state.thumbs.size, 'Foto', 'Fotos')}</p>
        <p>Version: <b id="ver">…</b></p>
        <button class="btn tinted" data-update>Nach neuer Version suchen</button>
      </div></div>`;
    renderStorage();
    appVersion().then(v => { const el = $('#ver', page.el); if (el) el.textContent = v; });
  }

  async function renderStorage(asked) {
    let persisted = null;
    let estimate = null;
    try { persisted = await navigator.storage?.persisted?.(); } catch { /* nicht unterstützt */ }
    try { estimate = await navigator.storage?.estimate?.(); } catch { /* nicht unterstützt */ }
    const el = $('#storage', page.el);
    if (!el) return;
    el.innerHTML = `
      <p>Dauerhafter Speicher: ${persisted === true ? '<span class="ok">✓ gewährt</span>'
        : persisted === false ? '<span class="bad">nicht gewährt</span>' : '<span class="muted">unbekannt</span>'}</p>
      ${estimate?.usage != null ? `<p class="muted">Belegt: ${fmtBytes(estimate.usage)}</p>` : ''}
      ${persisted === false ? `<p class="hint">Ohne dauerhaften Speicher kann iOS die Daten bei Speichermangel löschen. Regelmäßig exportieren!
        ${isStandalone() ? '' : 'Tipp: In der Home-Bildschirm-App wird er meist gewährt.'}</p>
        <button class="btn tinted" data-persist>Erneut anfordern</button>` : ''}
      ${asked && persisted === false ? '<p class="hint">iOS hat die Anfrage abgelehnt.</p>' : ''}`;
  }

  // ---------- Export ----------

  async function markExported() {
    await noteExport(prepared.exportedAt, isSynced() ? state.meta.sync.name : null);
    emitChange();
  }

  function download() {
    const url = URL.createObjectURL(prepared.file);
    const a = document.createElement('a');
    a.href = url;
    a.download = prepared.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    markExported().then(() => toast('Datei heruntergeladen.')).catch(showError);
  }

  function share() {
    const files = [prepared.file];
    if (!navigator.canShare?.({ files })) return download();
    // Safari öffnet das Teilen-Menü nur direkt nach einem Tipp – daher kein await davor
    navigator.share({ files }).then(
      () => markExported().then(() => toast('Export gesichert.')),
      e => {
        if (e?.name === 'AbortError') toast('Teilen abgebrochen – noch nicht gesichert.');
        else showError(e, 'Teilen hat nicht geklappt. Versuche „Stattdessen herunterladen“.');
      },
    ).catch(showError);
  }

  page.body.addEventListener('click', async e => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    try {
      if (d.create !== undefined) openCreateSheet({ onDone: render });
      if (d.join !== undefined) openJoinSheet({ onDone: render });
      if (d.invite !== undefined) openInviteSheet();
      if (d.devices !== undefined) openDevices();
      if (d.leave !== undefined && (await confirmLeave())) render();
      if (d.local !== undefined) {
        const ok = await confirmSheet({ title: 'Nur auf diesem Gerät nutzen?', text: 'Anlegen und Bearbeiten werden eingeblendet. Die Daten bleiben erhalten, abgeglichen wird nichts.', ok: 'Ja, nur hier' });
        if (!ok) return;
        await setMeta({ deviceType: 'main' });
        emitChange();
      }
      if (d.prepare !== undefined) {
        b.disabled = true;
        b.textContent = 'Bereite vor …';
        prepared = await buildExport();
        render();
      }
      if (d.share !== undefined) share();
      if (d.download !== undefined) download();
      if (d.replace !== undefined) openImport('replace');
      if (d.add !== undefined) openImport('add');
      if (d.ings !== undefined) openIngredients();
      if (d.methods !== undefined) openMethods();
      if (d.trash !== undefined) openTrash();
      if (d.persist !== undefined) {
        try { await navigator.storage.persist(); } catch { /* egal */ }
        renderStorage(true);
      }
      if (d.update !== undefined) {
        b.disabled = true;
        const r = await checkForUpdate();
        b.disabled = false;
        toast({ update: 'Neue Version gefunden – oben auf „Neu laden“ tippen.', aktuell: 'Die App ist aktuell.', offline: 'Keine Verbindung – später nochmal versuchen.' }[r] || 'Updates werden hier nicht unterstützt.');
      }
    } catch (err) {
      showError(err);
      render();
    }
  });

  render();
  if (focus === 'export') setTimeout(() => $('#secExport', page.el)?.scrollIntoView({ block: 'start' }), 50);
}

// ---------- Import (ersetzen) und Gerichte hinzufügen ----------

export function openImport(mode) {
  const reader = state.meta.deviceType === 'reader';
  const synced = isSynced();
  const title = mode === 'add' ? 'Gerichte hinzufügen' : reader ? 'Daten aktualisieren' : 'Backup wiederherstellen';
  const intro = mode === 'add'
    ? 'Wähle eine Datei mit Gerichten. Übernommen werden nur Gerichte, die es noch nicht gibt (gleicher Name oder gleiche ID wird übersprungen).'
    : reader
      ? 'Wähle die neueste Datei aus eurem geteilten iCloud-Ordner (z. B. „Gerichte-2026-10-24.json“). Nach einer Vorschau wird der Stand ersetzt.'
      : synced
        ? 'Wähle eine Exportdatei. Nach einer Vorschau wird der Stand auf allen Geräten der Sammlung ersetzt. Gerichte, die nicht in der Datei stehen, kommen in „Zuletzt gelöscht“.'
        : 'Wähle eine Exportdatei. Nach einer Vorschau wird der komplette Bestand auf diesem Gerät durch die Datei ersetzt.';
  const s = openSheet({
    title,
    body: `
      <p>${intro}</p>
      <label class="btn primary full file-label">${icon.file(20)} Datei wählen<input type="file" id="impFile" accept=".json,application/json"></label>
      <div id="impResult"></div>`,
  });
  const out = $('#impResult', s.el);
  let plan = null;
  let fileName = '';

  $('#impFile', s.el).addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    fileName = file.name;
    plan = null;
    s.setFoot('');
    out.innerHTML = '<p class="muted" style="margin-top:12px">Prüfe die Datei …</p>';
    try {
      const json = await readJsonFile(file);
      plan = mode === 'add' ? await prepareAdd(json) : await prepareReplace(json);
      mode === 'add' ? previewAdd() : previewReplace();
    } catch (err) {
      console.error(err);
      const details = err.details?.length ? `<ul>${err.details.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
      out.innerHTML = `<div class="error-box"><b>${esc(err.message)}</b>${details}
        <p style="margin:8px 0 0">Der bisherige Stand bleibt unverändert.</p></div>`;
    }
  });

  function previewReplace() {
    out.innerHTML = `
      <div class="box result-box">
        <p><b>${esc(fileName)}</b></p>
        <p>Exportiert am: <b>${fmtDateTime(plan.exportedAt)}</b></p>
        <p>Enthält: <b>${plural(plan.dishCount, 'Gericht', 'Gerichte')}</b>, ${plural(plan.photoCount, 'Foto', 'Fotos')}</p>
        <p class="muted">Ersetzt die ${plural(state.dishes.size, 'Gericht', 'Gerichte')} ${synced ? 'auf allen Geräten der Sammlung' : 'auf diesem Gerät'} vollständig.</p>
      </div>
      ${synced ? '<div class="error-box">⚠︎ <b>Das betrifft alle Geräte der Sammlung.</b> Änderungen seit dem Export gehen dort ebenfalls verloren.</div>' : ''}
      ${plan.older ? `<div class="error-box">⚠︎ <b>Diese Datei ist älter als der aktuelle Stand</b>
        (${fmtDateTime(state.meta.dataStand)}). Neuere Änderungen gehen beim Ersetzen verloren.</div>` : ''}`;
    s.setFoot(`<button class="btn grow" data-cancel>Abbrechen</button>
      <button class="btn grow ${plan.older || synced ? 'danger-fill' : 'primary'}" data-go>Jetzt ersetzen</button>`);
  }

  function previewAdd() {
    const list = (items, fn, max = 40) => `<ul>${items.slice(0, max).map(fn).join('')}${items.length > max ? `<li>… und ${items.length - max} weitere</li>` : ''}</ul>`;
    out.innerHTML = `
      <div class="box result-box">
        <p><b>${esc(fileName)}</b></p>
        <p>Neu: <b>${plural(plan.dishes.length, 'Gericht', 'Gerichte')}</b></p>
        ${plan.dishes.length ? list(plan.dishes, d => `<li>${esc(d.name)}</li>`) : ''}
      </div>
      ${plan.skipped.length ? `<div class="box result-box"><p>Übersprungen: <b>${plan.skipped.length}</b></p>
        ${list(plan.skipped, x => `<li>${esc(x.name)} – ${esc(x.reason)}</li>`, 100)}</div>` : ''}
      ${plan.newIngredients.length ? `<div class="box result-box"><p>Neue Zutaten: <b>${plan.newIngredients.length}</b></p>
        <p class="muted">${plan.newIngredients.map(i => esc(i.name)).join(', ')}</p></div>` : ''}
      ${plan.newMethods.length ? `<div class="box result-box"><p>Neue Zubereitungsarten: <b>${plan.newMethods.length}</b></p>
        <p class="muted">${plan.newMethods.map(m => esc(m.name)).join(', ')}</p></div>` : ''}`;
    s.setFoot(`<button class="btn grow" data-cancel>Abbrechen</button>
      <button class="btn primary grow" data-go ${plan.dishes.length ? '' : 'disabled'}>${plural(plan.dishes.length, 'Gericht', 'Gerichte')} hinzufügen</button>`);
  }

  s.el.addEventListener('click', async e => {
    if (e.target.closest('[data-cancel]')) return s.close();
    const go = e.target.closest('[data-go]');
    if (!go || !plan) return;
    // In einer Sammlung nur mit aktuellem Stand ersetzen, sonst blieben Gerichte anderer Geräte übrig
    if (mode !== 'add' && synced && syncStatus().state !== 'online') {
      return showError(new Error('Dafür muss dieses Gerät mit dem Server verbunden und abgeglichen sein. Bitte mit Internet erneut versuchen.'), 'Gerade nicht möglich.');
    }
    go.disabled = true;
    go.textContent = 'Speichere …';
    try {
      if (mode === 'add') {
        const n = plan.dishes.length;
        await commitAdd(plan);
        toast(`${plural(n, 'Gericht', 'Gerichte')} hinzugefügt.`);
      } else {
        await commitReplace(plan, fileName);
        toast(`Stand vom ${fmtDate(plan.exportedAt)} geladen.`);
      }
      s.close();
      emitChange();
    } catch (err) {
      s.close();
      showError(err, 'Speichern hat nicht geklappt. Der bisherige Stand bleibt erhalten.');
    }
  });
}
