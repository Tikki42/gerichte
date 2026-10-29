// Live-Abgleich mit dem Server (Quellcode in server/, nicht auf GitHub).
//
// Ablauf: Live-Verbindung (WebSocket) öffnen → "hello" mit dem eigenen Stand → der Server schickt alles Neuere
// ("changes", zum Schluss "synced") → das Gerät schickt seine Warteschlange ("push") und bekommt eine Quittung ("ack").
// Änderungen anderer Geräte kommen danach sofort als "changes". Fotos gehen über normale HTTPS-Anfragen: zuerst
// hochladen, dann den Foto-Stand senden. Vorschaubilder werden sofort geholt, große Fotos erst beim Öffnen.
// iOS trennt die Verbindung, wenn die App im Hintergrund ist – beim Zurückkehren wird neu verbunden und nachgeholt.

import { PROTO } from './sync-core.js';
import * as store from './store.js';
import { lsGet } from './util.js';
import { emitChange } from './ui.js';

export const SERVER = 'https://gerichte.tikki42.workers.dev';
// Zum Testen auf dem Mac lässt sich ein anderer Server eintragen: localStorage "syncServer"
const server = () => lsGet('syncServer', null) || SERVER;
const api = path => `${server()}/api/${PROTO}${path}`;
const coll = () => store.state.meta.sync?.collection;
const authHeader = () => `Bearer ${store.state.meta.sync.device}.${store.state.meta.sync.key}`;

export class SyncError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------- Status (für das Symbol oben und die Einstellungen) ----------
// state: off | connecting | online | offline | update | removed

const status = { state: 'off', lastSync: null };
const listeners = new Set();
export const syncStatus = () => ({ ...status, pending: store.state.queue.size });
export function onSyncStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function setStatus(next) {
  status.state = next;
  for (const fn of listeners) fn(syncStatus());
}
const notify = () => setStatus(status.state);

// Oberfläche nach Änderungen vom Server neu zeichnen (gebündelt)
let changedTimer = null;
function changed() {
  clearTimeout(changedTimer);
  changedTimer = setTimeout(emitChange, 80);
}

// ---------- Anfragen ----------

async function call(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (auth) headers.Authorization = authHeader();
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(api(path), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  } catch {
    throw new SyncError('offline', 'Keine Verbindung zum Server. Bitte prüfe das Internet und versuche es noch einmal.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* keine JSON-Antwort */ }
  if (!res.ok) {
    const code = data?.error || `http_${res.status}`;
    if (auth && code === 'device_unknown') await removedByServer();
    if (code === 'update_required') setStatus('update');
    throw new SyncError(code, data?.message || `Der Server antwortet mit Fehler ${res.status}.`);
  }
  return data;
}

// Abweichung der Geräte-Uhr von der Serverzeit (Mitte zwischen Anfrage und Antwort)
const offsetOf = (serverNow, t0) => Math.round(serverNow - (t0 + Date.now()) / 2);

export function suggestDeviceName() {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return 'Android';
  return 'Computer';
}

// ---------- Sammlung anlegen, beitreten, Geräte ----------

export async function createCollection(name) {
  const t0 = Date.now();
  const r = await call('/collections', { method: 'POST', auth: false, body: { deviceName: name, records: store.snapshot() } });
  await store.becomeSynced({ collection: r.collection, device: r.device, key: r.key, name }, offsetOf(r.now, t0));
  start();
}

export async function joinCollection(code, name) {
  const t0 = Date.now();
  const r = await call('/join', { method: 'POST', auth: false, body: { code, deviceName: name } });
  stop();
  await store.joinWipe({ collection: r.collection, device: r.device, key: r.key, name }, offsetOf(r.now, t0));
  start();
}

export const createInvite = () => call(`/c/${coll()}/invites`, { method: 'POST' });
export const listDevices = () => call(`/c/${coll()}/devices`);

export async function renameDevice(id, name) {
  const r = await call(`/c/${coll()}/devices/${id}`, { method: 'PATCH', body: { name } });
  if (id === store.state.meta.sync?.device) await store.setMeta({ sync: { ...store.state.meta.sync, name: r.name } });
  return r;
}

export const removeDevice = id => call(`/c/${coll()}/devices/${id}`, { method: 'DELETE' });

// Abgleich beenden: beim Server abmelden (geht das nicht, bleibt das Gerät dort in der Liste und kann von den
// anderen entfernt werden) und lokal weitermachen. Ergebnis: true, wenn der Server Bescheid weiß.
export async function leaveCollection() {
  let told = true;
  try {
    await removeDevice(store.state.meta.sync.device);
  } catch (e) {
    if (e.code !== 'device_unknown') told = false;
  }
  stop();
  await store.leaveSync();
  setStatus('off');
  changed();
  return told;
}

async function removedByServer() {
  if (!store.isSynced()) return;
  stop();
  await store.leaveSync();
  setStatus('removed');
  changed();
}

// ---------- Live-Verbindung ----------

let ws = null;
let ready = false;    // Stand ist nachgeholt, Live-Änderungen kommen
let inflight = false; // ein "push" wartet auf seine Quittung
let pushing = false;
let pushAgain = false;
let started = false;
let retryTimer = null;
let retryDelay = 0;
let pingTimer = null;
let pongTimer = null;
let pushTimer = null;
let lastProbe = 0;
let chain = Promise.resolve(); // Nachrichten streng nacheinander verarbeiten
const syncedWaiters = [];

export function start() {
  if (!store.isSynced()) return setStatus('off');
  if (status.state === 'removed' || status.state === 'off') setStatus('connecting');
  if (!started) {
    started = true;
    store.setSyncHooks({ changed: schedulePush, fetchPhoto });
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', () => connect());
  }
  connect();
}

function stop() {
  clearTimeout(retryTimer);
  stopPing();
  const sock = ws;
  ws = null;
  ready = false;
  inflight = false;
  if (sock) {
    try { sock.close(1000); } catch { /* schon zu */ }
  }
}

// Wartet, bis der Stand nachgeholt ist (z. B. nach dem Beitreten)
export function whenSynced(ms = 30000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new SyncError('timeout', 'Der Server hat nicht rechtzeitig geantwortet.')), ms);
    syncedWaiters.push(() => { clearTimeout(t); resolve(); });
  });
}

export function syncNow() {
  if (ws && ready) return pushNext();
  connect();
}

function connect() {
  if (!store.isSynced() || ws || ['removed', 'update'].includes(status.state)) return;
  clearTimeout(retryTimer);
  const { collection, device, key } = store.state.meta.sync;
  setStatus('connecting');
  let sock;
  try {
    sock = new WebSocket(`${server().replace(/^http/, 'ws')}/api/${PROTO}/c/${collection}/ws`, ['gerichte', `k.${device}.${key}`]);
  } catch {
    setStatus('offline');
    return scheduleReconnect();
  }
  ws = sock;
  ready = false;
  inflight = false;
  sock.onopen = () => {
    send({ type: 'hello', since: store.state.meta.syncCursor || 0 });
    startPing();
  };
  sock.onmessage = e => {
    if (e.data === 'pong') return clearTimeout(pongTimer);
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    chain = chain.then(() => (ws === sock ? handle(msg) : null)).catch(err => console.warn('Abgleich:', err));
  };
  sock.onclose = e => {
    if (ws !== sock) return;
    const wasReady = ready;
    ws = null;
    ready = false;
    inflight = false;
    stopPing();
    if (e.code === 4001) return void removedByServer();
    setStatus('offline');
    if (!wasReady) probe();
    scheduleReconnect();
  };
}

const send = msg => {
  try { ws?.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); } catch { /* Verbindung schon weg */ }
};

function scheduleReconnect() {
  clearTimeout(retryTimer);
  if (document.visibilityState !== 'visible') return; // beim Zurückkehren in die App
  retryDelay = Math.min(30000, retryDelay ? retryDelay * 2 : 1000);
  retryTimer = setTimeout(connect, retryDelay);
}

// Lehnt der Server die Live-Verbindung ab, verrät der Browser den Grund nicht. Eine normale Anfrage zeigt,
// ob das Gerät entfernt wurde oder die App zu alt ist (höchstens einmal pro Minute).
function probe() {
  if (Date.now() - lastProbe < 60000) return;
  lastProbe = Date.now();
  call(`/c/${coll()}/me`).catch(() => {});
}

function startPing() {
  stopPing();
  pingTimer = setInterval(ping, 25000);
}

function stopPing() {
  clearInterval(pingTimer);
  clearTimeout(pongTimer);
}

// Lebt die Verbindung noch? Ohne Antwort wird neu verbunden.
function ping(wait = 10000) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  send('ping');
  clearTimeout(pongTimer);
  pongTimer = setTimeout(() => ws?.close(), wait);
}

function onVisible() {
  if (document.visibilityState !== 'visible' || !store.isSynced()) return;
  retryDelay = 0;
  if (ws) ping(4000);
  else connect();
}

async function handle(msg) {
  if (msg.type === 'changes') {
    const photos = await store.applyRemote(msg.recs || [], msg.seq);
    changed();
    queueDownloads(photos);
  } else if (msg.type === 'synced') {
    await store.setMeta({ syncOffset: Math.round(msg.now - Date.now()), syncCursor: Math.max(store.state.meta.syncCursor || 0, msg.seq) });
    ready = true;
    retryDelay = 0;
    status.lastSync = Date.now();
    setStatus('online');
    syncedWaiters.splice(0).forEach(fn => fn());
    queueDownloads(store.photoIds());
    pushNext();
  } else if (msg.type === 'ack') {
    inflight = false;
    const bad = (msg.revs || []).filter(r => r[2]);
    if (bad.length) console.warn('Vom Server abgelehnt:', bad);
    await store.settleQueue(msg.revs || []);
    status.lastSync = Date.now();
    notify();
    pushNext();
  } else if (msg.type === 'photo') {
    if (msg.size === 'thumb') queueDownloads([msg.dish]);
  }
}

// ---------- Warteschlange senden ----------

function schedulePush() {
  notify();
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushNext, 250);
}

async function pushNext() {
  if (pushing) {
    pushAgain = true;
    return;
  }
  if (!ready || inflight || !ws) return notify();
  pushing = true;
  try {
    const batch = store.pendingBatch(100);
    const ops = [];
    let failed = false;
    for (const e of batch) {
      if (!e.rec) {
        await store.settleQueue([[e.key, e.rev]]); // Datensatz gibt es nicht mehr
        continue;
      }
      if (e.upload) {
        if (!(await uploadPhoto(e.key.slice(6)))) {
          failed = true;
          continue;
        }
        await store.markUploaded(e.key, e.rev);
      }
      ops.push({ key: e.rec.key, f: e.rec.f, t: e.rec.t, rev: e.rev });
    }
    if (ops.length && ready && ws) {
      inflight = true;
      send({ type: 'push', ops });
    }
    if (failed) setTimeout(pushNext, 30000); // Foto später erneut hochladen
  } finally {
    pushing = false;
    notify();
  }
  if (pushAgain) {
    pushAgain = false;
    pushNext();
  }
}

// ---------- Fotos ----------

const photoPath = (id, ver, size) => api(`/c/${coll()}/photos/${encodeURIComponent(id)}/${ver}/${size}`);

// Erst das Vorschaubild, dann das große Foto. Ergebnis: true, wenn alles oben ist (oder nichts zu tun war).
async function uploadPhoto(id) {
  const ver = store.photoVersion(id);
  if (!ver) return true;
  for (const size of ['thumb', 'full']) {
    const rec = await store.localPhoto(id, size);
    if (!rec || rec.ver !== ver) continue;
    const res = await fetch(photoPath(id, ver, size), {
      method: 'PUT',
      headers: { Authorization: authHeader(), 'Content-Type': rec.type || 'image/jpeg' },
      body: rec.data,
    }).catch(() => null);
    if (!res) return false;
    if (res.status === 413) {
      console.warn('Foto zu groß für den Server:', id, size);
      continue;
    }
    if (!res.ok) return false;
  }
  return true;
}

async function fetchPhoto(id, ver, size) {
  if (!store.isSynced()) return null;
  const res = await fetch(photoPath(id, ver, size), { headers: { Authorization: authHeader() }, cache: 'no-store' }).catch(() => null);
  if (!res?.ok) return null;
  const data = await res.arrayBuffer();
  return store.storeRemotePhoto(id, ver, size, data, res.headers.get('Content-Type'));
}

// Vorschaubilder holen, deren Version nicht zum Foto-Stand passt (fehlende kommen beim nächsten Mal)
const downloads = new Set();
let downloading = false;

function queueDownloads(ids) {
  for (const id of ids) {
    const ver = store.photoVersion(id);
    if (ver && store.thumbVersion(id) !== ver) downloads.add(id);
  }
  runDownloads();
}

async function runDownloads() {
  if (downloading) return;
  downloading = true;
  try {
    while (downloads.size && ready) {
      const id = downloads.values().next().value;
      downloads.delete(id);
      const ver = store.photoVersion(id);
      if (!ver || store.thumbVersion(id) === ver) continue;
      if (await fetchPhoto(id, ver, 'thumb')) changed();
    }
  } finally {
    downloading = false;
  }
}
