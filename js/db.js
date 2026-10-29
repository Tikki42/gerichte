// Dünne Hülle um IndexedDB.
// Fotos werden als ArrayBuffer gespeichert (zuverlässiger als Blobs in älteren iOS-Versionen).

const DB_NAME = 'gerichte';
const DB_VERSION = 2; // 2 = Kochtage als eigene Einträge ("cooks", seit 1.5.0)

// Datenbestände, die ein Import komplett ersetzt. "meta" (Gerätetyp, Exportstand …) bleibt.
export const DATA_STORES = ['dishes', 'ingredients', 'methods', 'photos', 'thumbs', 'cooks'];

let dbPromise;

export function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of DATA_STORES) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); location.reload(); };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Die Datenbank ist blockiert. Bitte die App komplett schließen und neu öffnen.'));
    });
  }
  return dbPromise;
}

const done = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export async function getAll(store) {
  const db = await openDB();
  return done(db.transaction(store).objectStore(store).getAll());
}

export async function get(store, key) {
  const db = await openDB();
  return done(db.transaction(store).objectStore(store).get(key));
}

// Führt fn(stores) in EINER Transaktion aus. Entweder wird alles gespeichert oder nichts.
// fn muss synchron sein (kein await darin), sonst schließt IndexedDB die Transaktion.
export async function write(storeNames, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, 'readwrite');
    const stores = {};
    for (const n of storeNames) stores[n] = tx.objectStore(n);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('Speichern fehlgeschlagen'));
    tx.onabort = () => reject(tx.error || new Error('Speichern abgebrochen'));
    try {
      result = fn(stores);
    } catch (e) {
      try { tx.abort(); } catch { /* schon beendet */ }
      reject(e);
    }
  });
}
