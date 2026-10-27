// Small persistent key-value store (IndexedDB) used by the Matrix layer to keep
// identifier mappings and encrypted media keys stable across reloads

const DB_VERSION = 1;
const STORE_NAME = 'kv';
const FLUSH_DELAY_MS = 300;

let dbName = 'peyvand-matrix';
let dbPromise: Promise<IDBDatabase | undefined> | undefined;
const cache = new Map<string, string>();
const pendingWrites = new Map<string, string | undefined>();
let flushTimeout: ReturnType<typeof setTimeout> | undefined;

export function setStoreName(name: string) {
  dbName = name;
}

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const request = indexedDB.open(dbName, DB_VERSION);
        request.onupgradeneeded = () => {
          request.result.createObjectStore(STORE_NAME);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });
  }

  return dbPromise;
}

export async function loadStore() {
  const db = await openDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      cache.set(String(cursor.key), cursor.value as string);
      cursor.continue();
    };
    request.onerror = () => resolve();
  });
}

export function getValue(key: string) {
  return cache.get(key);
}

export function setValue(key: string, value: string) {
  if (cache.get(key) === value) return;
  cache.set(key, value);
  pendingWrites.set(key, value);
  scheduleFlush();
}

export function deleteValue(key: string) {
  if (!cache.has(key)) return;
  cache.delete(key);
  pendingWrites.set(key, undefined);
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimeout) return;
  flushTimeout = setTimeout(flush, FLUSH_DELAY_MS);
}

async function flush() {
  clearTimeout(flushTimeout);
  flushTimeout = undefined;
  const db = await openDb();
  if (!db || !pendingWrites.size) return;

  const writes = [...pendingWrites];
  pendingWrites.clear();

  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  writes.forEach(([key, value]) => {
    if (value === undefined) {
      store.delete(key);
    } else {
      store.put(value, key);
    }
  });
}

// Writes pending values now, for values that must survive the browser closing right away
export function flushStore() {
  return flush();
}

export async function clearStore() {
  cache.clear();
  pendingWrites.clear();
  const db = await openDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}
