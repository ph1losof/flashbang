const DB_NAME = "flashbang";
const DB_VERSION = 1;

export function openDB(): Promise<IDBDatabase> {
  return new Promise((ok, err) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("settings"))
        db.createObjectStore("settings", { keyPath: "key" });
      if (!db.objectStoreNames.contains("custom-bangs"))
        db.createObjectStore("custom-bangs", { keyPath: "trigger" });
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => err(r.error);
  });
}

export function idbWrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((ok, err) => {
    req.onsuccess = () => ok(req.result);
    req.onerror = () => err(req.error);
  });
}
