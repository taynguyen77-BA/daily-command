// V2.16 — local persistence backend, IndexedDB. localStorage has a hard ~5-10MB per-origin
// quota that a real Jira-scale dataset (thousands of work items plus a bounded-but-still-large
// snapshotHistory) can genuinely exceed; when it does, `localStorage.setItem` throws
// QuotaExceededError, and store.ts's old persist() swallowed that in a bare try/catch — every
// sync AFTER the dataset crossed the quota line silently stopped saving. The UI kept showing
// success (the in-memory state update always worked); the browser simply never wrote it, and
// the next reload reverted to whatever last successfully fit. IndexedDB's quota is a large
// fraction of available disk space (typically hundreds of MB to GB in modern browsers) — this
// is the actual fix, not a workaround.
//
// Kept as its own tiny module (raw IndexedDB, no library) so store.ts's persist()/hydrate()
// stay readable. Every export here assumes `indexedDB` exists — callers (store.ts) check
// `typeof indexedDB !== "undefined"` first and fall back to the legacy localStorage path
// otherwise (old browsers without IndexedDB, some locked-down private-browsing modes, and this
// app's own Node-based offline test environment, which has no `indexedDB` global at all).

const DB_NAME = "command-center-db";
const DB_VERSION = 1;
const STORE_NAME = "kv";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Failed to open IndexedDB"));
  });
}

export async function idbGet(key: string): Promise<string | null> {
  const db = await openDb();
  try {
    return await new Promise<string | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve((req.result as string | undefined) ?? null);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB read failed"));
    });
  } finally {
    db.close();
  }
}

export async function idbSet(key: string, value: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
    });
  } finally {
    db.close();
  }
}
