import { BANGS } from "../generated/bangs-min.js";
import type { RedirectSettings } from "./redirect";
import type { SuggestSettings } from "./suggest";

const DEFAULT_URL = "https://www.google.com/search?q={}";

let dbPromise: Promise<IDBDatabase> | null = null;

function getDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((ok, err) => {
      const r = indexedDB.open("flashbang", 1);
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
  return dbPromise;
}

function idbGet(store: IDBObjectStore, key: string): Promise<any> {
  return new Promise((ok, err) => {
    const r = store.get(key);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => err(r.error);
  });
}

function idbGetAll(store: IDBObjectStore): Promise<any[]> {
  return new Promise((ok, err) => {
    const r = store.getAll();
    r.onsuccess = () => ok(r.result);
    r.onerror = () => err(r.error);
  });
}

// --- Cached settings ---

let cachedRedirect: RedirectSettings | null = null;
let cachedSuggest: SuggestSettings | null = null;

export async function readRedirectSettings(): Promise<RedirectSettings> {
  if (cachedRedirect) return cachedRedirect;
  try {
    const db = await getDB();
    const stx = db.transaction("settings", "readonly");
    const result = await idbGet(stx.objectStore("settings"), "default-bang");
    const defaultUrl = BANGS[result?.value || "g"] || DEFAULT_URL;

    const ctx = db.transaction("custom-bangs", "readonly");
    const all = await idbGetAll(ctx.objectStore("custom-bangs"));
    const custom: Record<string, string> = {};
    for (const e of all) custom[e.trigger] = e.url;

    cachedRedirect = { defaultUrl, custom };
  } catch {
    cachedRedirect = { defaultUrl: DEFAULT_URL, custom: {} };
  }
  return cachedRedirect!;
}

export async function readSuggestSettings(): Promise<SuggestSettings> {
  if (cachedSuggest) return cachedSuggest;
  try {
    const db = await getDB();
    const tx = db.transaction("settings", "readonly");
    const s = tx.objectStore("settings");
    const [p, b, u] = await Promise.all([
      idbGet(s, "suggest-provider"),
      idbGet(s, "default-bang"),
      idbGet(s, "suggest-url"),
    ]);
    cachedSuggest = {
      provider: p?.value || "default",
      trigger: b?.value || "g",
      customUrl: u?.value || null,
    };
  } catch {
    cachedSuggest = { provider: "default", trigger: "g", customUrl: null };
  }
  return cachedSuggest!;
}

export function invalidateCache() {
  cachedRedirect = null;
  cachedSuggest = null;
  dbPromise = null;
}
