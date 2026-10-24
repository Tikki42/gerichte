// Service Worker: Offline-Betrieb und Hinweis bei neuer App-Version.

let registration = null;
let updating = false;

export function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (updating) location.reload();
  });
  navigator.serviceWorker.register('sw.js').then(reg => {
    registration = reg;
    const offer = w => { if (w && navigator.serviceWorker.controller) showUpdateBar(w); };
    offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed') offer(w); });
    });
    // Beim Zurückkehren in die App nach einer neuen Version schauen
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch(e => console.warn('Service Worker nicht registriert', e));
}

function showUpdateBar(worker) {
  if (document.querySelector('.update-bar')) return;
  const bar = document.createElement('div');
  bar.className = 'update-bar';
  bar.innerHTML = '<span>Neue Version verfügbar</span><button class="btn primary">Neu laden</button>';
  bar.querySelector('button').addEventListener('click', () => {
    updating = true;
    worker.postMessage('skipWaiting');
    setTimeout(() => location.reload(), 2500); // falls controllerchange ausbleibt
  });
  document.body.append(bar);
}

// Sucht aktiv nach einer neuen Version. Ergebnis: 'update' | 'aktuell' | 'offline' | 'nicht unterstützt'
export async function checkForUpdate() {
  if (!registration) return 'nicht unterstützt';
  try {
    await registration.update();
  } catch {
    return 'offline';
  }
  await new Promise(r => setTimeout(r, 1500));
  if (registration.waiting || registration.installing) {
    if (registration.waiting) showUpdateBar(registration.waiting);
    return 'update';
  }
  return 'aktuell';
}

// Fragt den Service Worker nach seiner Versionsnummer
export function appVersion() {
  const ctrl = navigator.serviceWorker?.controller;
  if (!ctrl) return Promise.resolve('–');
  return new Promise(resolve => {
    const ch = new MessageChannel();
    const t = setTimeout(() => resolve('–'), 1500);
    ch.port1.onmessage = e => { clearTimeout(t); resolve(e.data); };
    ctrl.postMessage('version', [ch.port2]);
  });
}
