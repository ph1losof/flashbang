import { BANGS } from "../generated/bangs-min.js";
import type { RedirectSettings } from "./redirect";

const DEFAULT_URL = "https://www.google.com/search?q={}";

const LUCKY_URLS: Record<string, string> = {
  g: "https://www.google.com/search?q={}&btnI=1",
  ddg: "https://duckduckgo.com/?q=\\{}",
};
const DEFAULT_LUCKY_URL = "https://duckduckgo.com/?q=\\{}";

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

export async function readRedirectSettings(): Promise<RedirectSettings> {
  if (cachedRedirect) return cachedRedirect;
  try {
    const db = await getDB();
    const stx = db.transaction("settings", "readonly");
    const store = stx.objectStore("settings");
    const ctx = db.transaction("custom-bangs", "readonly");
    const [result, luckyProviderResult, luckyUrlResult, all] = await Promise.all([
      idbGet(store, "default-bang"),
      idbGet(store, "lucky-provider"),
      idbGet(store, "lucky-url"),
      idbGetAll(ctx.objectStore("custom-bangs")),
    ]);
    const defaultBang = result?.value || "g";
    const defaultUrl = BANGS[defaultBang] || DEFAULT_URL;
    const luckyProvider = luckyProviderResult?.value ?? "default";
    let luckyUrl: string | null;
    switch (luckyProvider) {
      case "none":
        luckyUrl = null;
        break;
      case "google":
        luckyUrl = LUCKY_URLS.g;
        break;
      case "ddg":
        luckyUrl = LUCKY_URLS.ddg;
        break;
      case "custom":
        luckyUrl = luckyUrlResult?.value || null;
        break;
      default:
        luckyUrl = LUCKY_URLS[defaultBang] || DEFAULT_LUCKY_URL;
        break;
    }
    const custom: Record<string, string> = {};
    for (const e of all) custom[e.trigger] = e.url;

    cachedRedirect = { defaultUrl, custom, luckyUrl };
  } catch {
    cachedRedirect = { defaultUrl: DEFAULT_URL, custom: {}, luckyUrl: DEFAULT_LUCKY_URL };
  }
  return cachedRedirect!;
}

export function invalidateCache() {
  cachedRedirect = null;
  dbPromise = null;
}
