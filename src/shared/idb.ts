import { DB_VERSION } from "./constants";

const DB_NAME = "flashbang";

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    const opening = new Promise<IDBDatabase>((ok, err) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = (event) => {
        const db = r.result;
        const oldVersion = event.oldVersion;
        if (oldVersion < 1) {
          db.createObjectStore("settings", { keyPath: "key" });
          db.createObjectStore("custom-bangs", { keyPath: "trigger" });
        }
      };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => err(r.error);
    });
    let current: Promise<IDBDatabase>;
    current = opening.then(
      (db) => {
        db.onversionchange = () => {
          db.close();
          if (dbPromise === current) {
            dbPromise = null;
          }
        };
        return db;
      },
      (error) => {
        if (dbPromise === current) {
          dbPromise = null;
        }
        throw error;
      }
    );
    dbPromise = current;
  }
  return dbPromise;
}

export function resetDB(): void {
  const existing = dbPromise;
  dbPromise = null;
  void existing?.then(
    (db) => db.close(),
    () => {
      /* A failed open has no connection to close. */
    }
  );
}

export function idbWrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((ok, err) => {
    req.onsuccess = () => ok(req.result);
    req.onerror = () => err(req.error);
  });
}
