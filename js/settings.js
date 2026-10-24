// Einstellungen: Gerätetyp, Export, Import, Gerichte hinzufügen, Speicher, Version.

import { state, isMain, setMeta } from './store.js';
import { buildExport, readJsonFile, prepareReplace, commitReplace, prepareAdd, commitAdd } from './io.js';
import { checkForUpdate, appVersion } from './pwa.js';
import { esc, $, fmtDateTime, fmtDate, fmtBytes, plural, isStandalone } from './util.js';
import { openPage, openSheet, confirmSheet, toast, showError, emitChange } from './ui.js';
import { openIngredients, openMethods } from './manage.js';

export function openSettings({ focus } = {}) {
  let prepared = null; // vorbereitete Exportdatei
  const onChange = () => render();
  const page = openPage({ title: 'Einstellungen', onClose: () => document.removeEventListener('data-changed', onChange) });
  document.addEventListener('data-changed', onChange);

  function exportHtml() {
    const m = state.meta;
    const changes = m.changesSinceExport || 0;
    const status = changes > 0
      ? `<p class="bad">⚠︎ ${plural(changes, 'Änderung', 'Änderungen')} seit dem letzten Export</p>`
      : m.lastExportAt ? '<p class="ok">✓ Alles exportiert</p>' : '';
    const step = prepared
      ? `<p>Datei bereit: <b>${esc(prepared.name)}</b><br>
           <span class="muted">${plural(prepared.dishCount, 'Gericht', 'Gerichte')}, ${plural(prepared.photoCount, 'Foto', 'Fotos')} · ${fmtBytes(prepared.size)}</span></p>
         <button class="btn primary" data-share>2. Teilen …</button>
         <p class="hint">Im Teilen-Menü „In Dateien sichern“ wählen, dann euren geteilten iCloud-Ordner.</p>
         <button class="link-btn" data-download>Stattdessen herunterladen</button>`
      : '<button class="btn primary" data-prepare>1. Exportdatei vorbereiten</button>';
    return `
      <div class="section" id="secExport"><h3>Export = Backup</h3><div class="box">
        <p>Letzter Export: <b>${m.lastExportAt ? fmtDateTime(m.lastExportAt) : 'noch nie'}</b></p>
        ${status}
        ${step}
      </div></div>`;
  }

  function render() {
    const main = isMain();
    const m = state.meta;
    page.body.innerHTML = `
      <div class="section"><h3>Dieses iPhone ist …</h3><div class="box">
        <div class="segmented">
          <button data-dev="main" class="${main ? 'on' : ''}">Hauptgerät</button>
          <button data-dev="reader" class="${main ? '' : 'on'}">Lesegerät</button>
        </div>
        <p class="hint">${main
          ? 'Alle Funktionen: anlegen, bearbeiten, exportieren.'
          : 'Nur lesen: suchen, filtern, Zufall. Die Daten kommen als Datei vom Hauptgerät.'}</p>
      </div></div>

      ${main ? exportHtml() : ''}

      <div class="section"><h3>${main ? 'Import' : 'Daten'}</h3><div class="box">
        ${main ? '' : `<p>Stand: <b>${m.lastImport ? fmtDate(m.dataStand) : 'noch keine Daten'}</b>
            ${m.lastImport ? `<br><span class="muted">geladen am ${fmtDateTime(m.lastImport.at)}</span>` : ''}</p>`}
        ${main ? `
          <button class="btn" data-add>Gerichte hinzufügen …</button>
          <p class="hint">Übernimmt aus einer Datei nur Gerichte, die noch fehlen.</p>
          <button class="btn" data-replace style="margin-top:12px">Backup wiederherstellen …</button>
          <p class="hint">Ersetzt alle Gerichte durch den Stand aus einer Exportdatei.</p>`
        : '<button class="btn primary" data-replace>Daten aktualisieren …</button>'}
      </div></div>

      ${main ? `<div class="section"><h3>Listen pflegen</h3><div class="menu">
        <button class="menu-item" data-ings>Zutaten <small>${state.ingredients.size}</small></button>
        <button class="menu-item" data-methods>Zubereitungsarten <small>${state.methods.size}</small></button>
      </div></div>` : ''}

      <div class="section"><h3>Speicher</h3><div class="box" id="storage"><p class="muted">Prüfe …</p></div></div>

      <div class="section"><h3>App</h3><div class="box">
        <p>Bestand: ${plural(state.dishes.size, 'Gericht', 'Gerichte')}, ${plural(state.thumbs.size, 'Foto', 'Fotos')}</p>
        <p>Version: <b id="ver">…</b></p>
        <button class="btn" data-update>Nach neuer Version suchen</button>
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
        <button class="btn" data-persist>Erneut anfordern</button>` : ''}
      ${asked && persisted === false ? '<p class="hint">iOS hat die Anfrage abgelehnt.</p>' : ''}`;
  }

  // ---------- Export ----------

  async function markExported() {
    const rest = Math.max(0, (state.meta.changesSinceExport || 0) - prepared.changesAtExport);
    await setMeta({ lastExportAt: prepared.exportedAt, changesSinceExport: rest });
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
      if (d.dev && d.dev !== state.meta.deviceType) {
        const toMain = d.dev === 'main';
        const ok = await confirmSheet(toMain
          ? { title: 'Zum Hauptgerät machen?', text: 'Nur ein iPhone sollte das Hauptgerät sein – sonst überschreibt ihr euch gegenseitig Änderungen.', ok: 'Hauptgerät' }
          : { title: 'Zum Lesegerät machen?', text: 'Anlegen und Bearbeiten werden ausgeblendet. Die Daten bleiben erhalten.', ok: 'Lesegerät' });
        if (!ok) return;
        await setMeta({ deviceType: d.dev });
        prepared = null;
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
  const main = isMain();
  const title = mode === 'add' ? 'Gerichte hinzufügen' : main ? 'Backup wiederherstellen' : 'Daten aktualisieren';
  const intro = mode === 'add'
    ? 'Wähle eine Datei mit Gerichten. Übernommen werden nur Gerichte, die es noch nicht gibt (gleicher Name oder gleiche ID wird übersprungen).'
    : main
      ? 'Wähle eine Exportdatei. Nach einer Vorschau wird der komplette Bestand auf diesem iPhone durch die Datei ersetzt.'
      : 'Wähle die neueste Datei aus eurem geteilten iCloud-Ordner (z. B. „Gerichte-2026-10-24.json“). Nach einer Vorschau wird der Stand ersetzt.';
  const s = openSheet({
    title,
    body: `
      <p>${intro}</p>
      <label class="btn primary full file-label">📄 Datei wählen<input type="file" id="impFile" accept=".json,application/json"></label>
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
    const changes = main ? state.meta.changesSinceExport || 0 : 0;
    out.innerHTML = `
      <div class="box result-box">
        <p><b>${esc(fileName)}</b></p>
        <p>Exportiert am: <b>${fmtDateTime(plan.exportedAt)}</b></p>
        <p>Enthält: <b>${plural(plan.dishCount, 'Gericht', 'Gerichte')}</b>, ${plural(plan.photoCount, 'Foto', 'Fotos')}</p>
        <p class="muted">Ersetzt die ${plural(state.dishes.size, 'Gericht', 'Gerichte')} auf diesem iPhone vollständig.</p>
      </div>
      ${plan.older ? `<div class="error-box">⚠︎ <b>Diese Datei ist älter als der aktuelle Stand</b> auf diesem iPhone
        (${fmtDateTime(state.meta.dataStand)}). Neuere Änderungen gehen beim Ersetzen verloren.</div>` : ''}
      ${changes ? `<div class="error-box">⚠︎ Es gibt ${plural(changes, 'Änderung', 'Änderungen')}, die noch nicht exportiert wurden. Sie gehen verloren.</div>` : ''}`;
    s.setFoot(`<button class="btn grow" data-cancel>Abbrechen</button>
      <button class="btn grow ${plan.older || changes ? 'danger-fill' : 'primary'}" data-go>Jetzt ersetzen</button>`);
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
