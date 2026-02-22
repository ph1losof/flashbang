import { BANGS } from "../generated/bangs-min.js";
import { idbWrap, openDB } from "../shared/idb";
import type { RedirectSettings } from "./redirect";

const DEFAULT_URL = "https://www.google.com/search?q={}";

const LUCKY_URLS: Record<string, string> = {
  g: "https://www.google.com/search?q={}&btnI=1",
  ddg: "https://duckduckgo.com/?q=\\{}",
  kagi: "https://kagi.com/search?q=\\{}",
};
const DEFAULT_LUCKY_URL = "https://duckduckgo.com/?q=\\{}";

let dbPromise: Promise<IDBDatabase> | null = null;

function getDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = openDB();
  }
  return dbPromise;
}

let cachedRedirect: RedirectSettings | null = null;

export function getCachedSettings(): RedirectSettings | null {
  return cachedRedirect;
}

export async function readRedirectSettings(): Promise<RedirectSettings> {
  if (cachedRedirect) {
    return cachedRedirect;
  }
  try {
    const db = await getDB();
    const tx = db.transaction(["settings", "custom-bangs"], "readonly");
    const store = tx.objectStore("settings");
    const [result, luckyProviderResult, luckyUrlResult, all] =
      await Promise.all([
        idbWrap(store.get("default-bang")),
        idbWrap(store.get("lucky-provider")),
        idbWrap(store.get("lucky-url")),
        idbWrap(tx.objectStore("custom-bangs").getAll()),
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
      case "kagi":
        luckyUrl = LUCKY_URLS.kagi;
        break;
      case "custom":
        luckyUrl = luckyUrlResult?.value || null;
        break;
      default:
        luckyUrl = LUCKY_URLS[defaultBang] || DEFAULT_LUCKY_URL;
        break;
    }
    const custom: Record<string, string> = {};
    for (const e of all) {
      custom[e.trigger] = e.url;
    }

    cachedRedirect = { defaultUrl, custom, luckyUrl };
  } catch {
    cachedRedirect = {
      defaultUrl: DEFAULT_URL,
      custom: {},
      luckyUrl: DEFAULT_LUCKY_URL,
    };
  }
  return cachedRedirect!;
}

export function invalidateCache() {
  cachedRedirect = null;
  dbPromise = null;
}
