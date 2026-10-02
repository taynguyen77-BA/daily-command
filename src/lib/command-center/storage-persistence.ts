// E1 — ask the browser to keep this origin's storage (IndexedDB/localStorage) instead of
// evicting it under storage pressure. Best-effort browser storage can be cleared without any
// prompt; persistent storage is only cleared by the user. Feature-detected: browsers without
// the StorageManager API report "unsupported" and the app works exactly as before.

export type StoragePersistence = "persistent" | "best-effort" | "unsupported";

type StorageManagerLike = { persisted?: () => Promise<boolean>; persist?: () => Promise<boolean> };

/** Checks, and if needed requests, persistent storage. Never throws. `nav` is injectable for
 *  tests; undefined (server render, tests) → "unsupported". */
export async function requestPersistentStorage(nav: { storage?: StorageManagerLike } | undefined): Promise<StoragePersistence> {
  const storage = nav?.storage;
  if (!storage || typeof storage.persist !== "function") return "unsupported";
  try {
    if (typeof storage.persisted === "function" && (await storage.persisted())) return "persistent";
    return (await storage.persist()) ? "persistent" : "best-effort";
  } catch {
    return "unsupported";
  }
}

let pending: Promise<StoragePersistence> | null = null;

/** Once per page load: the app header calls it on first load, Data & Settings reads the same
 *  answer. */
export function ensurePersistentStorage(): Promise<StoragePersistence> {
  if (!pending) pending = requestPersistentStorage(typeof navigator === "undefined" ? undefined : (navigator as { storage?: StorageManagerLike }));
  return pending;
}

export function storagePersistenceLabel(p: StoragePersistence): string {
  if (p === "persistent") return "Storage: persistent";
  if (p === "best-effort") return "Storage: may be cleared by the browser";
  return "Storage: may be cleared by the browser (this browser can't make it persistent)";
}
