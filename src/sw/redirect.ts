import { BANGS } from "../generated/bangs-min.js";

const DEFAULT_URL = "https://www.google.com/search?q={}";
let cachedDefault: string | null = null;
let cachedCustom: Record<string, string> | null = null;
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

async function getDefault(): Promise<string> {
  if (cachedDefault) return cachedDefault;
  try {
    const db = await getDB();
    const tx = db.transaction("settings", "readonly");
    const result = await idbGet(tx.objectStore("settings"), "default-bang");
    const trigger = result?.value || "g";
    cachedDefault = BANGS[trigger] || DEFAULT_URL;
  } catch {
    cachedDefault = DEFAULT_URL;
  }
  return cachedDefault!;
}

async function getCustom(): Promise<Record<string, string>> {
  if (cachedCustom) return cachedCustom;
  try {
    const db = await getDB();
    const tx = db.transaction("custom-bangs", "readonly");
    const all = await idbGetAll(tx.objectStore("custom-bangs"));
    cachedCustom = {};
    for (const e of all) cachedCustom[e.trigger] = e.url;
  } catch {
    cachedCustom = {};
  }
  return cachedCustom;
}

function encode(s: string): string {
  return encodeURIComponent(s).replace(/%2F/g, "/");
}

function parse(q: string): { bang: string | null; term: string } {
  const s = q.trim();

  // "!g cats" or "!g"
  if (s.charCodeAt(0) === 33) {
    const sp = s.indexOf(" ");
    if (sp === -1) return { bang: s.substring(1).toLowerCase(), term: "" };
    return {
      bang: s.substring(1, sp).toLowerCase(),
      term: s.substring(sp + 1),
    };
  }

  // "g! cats" — prefix suffix-bang
  const excl = s.indexOf("!");
  if (excl > 0 && excl < s.length - 1 && s.charCodeAt(excl + 1) === 32) {
    return {
      bang: s.substring(0, excl).toLowerCase(),
      term: s.substring(excl + 2),
    };
  }

  // "g!" — suffix-bang alone
  if (s.endsWith("!") && !s.includes(" ")) {
    return { bang: s.slice(0, -1).toLowerCase(), term: "" };
  }

  // "cats !g" — trailing prefix-bang
  const bi = s.lastIndexOf(" !");
  if (bi !== -1 && bi < s.length - 2) {
    const b = s.substring(bi + 2);
    if (!b.includes(" "))
      return { bang: b.toLowerCase(), term: s.substring(0, bi) };
  }

  // "cats g!" — trailing suffix-bang
  if (s.endsWith("!")) {
    const lastSpace = s.lastIndexOf(" ");
    if (lastSpace !== -1) {
      const b = s.substring(lastSpace + 1, s.length - 1);
      if (b.length > 0)
        return { bang: b.toLowerCase(), term: s.substring(0, lastSpace) };
    }
  }

  return { bang: null, term: s };
}

export async function redirect(query: string): Promise<Response> {
  if (query === "!") {
    return Response.redirect("/", 302);
  }

  const { bang, term } = parse(query);
  let url: string | undefined;

  if (bang) {
    const [custom, def] = await Promise.all([getCustom(), getDefault()]);
    url = custom[bang] || BANGS[bang];

    if (!url) {
      return Response.redirect(def.replace("{}", encode(query)), 302);
    }
  } else {
    url = await getDefault();
  }

  if (!term) {
    try {
      return Response.redirect(new URL(url!.replace("{}", "")).origin, 302);
    } catch {
      return Response.redirect(url!.replace("{}", ""), 302);
    }
  }

  return Response.redirect(url!.replace("{}", encode(term)), 302);
}

export function invalidateCache() {
  cachedDefault = null;
  cachedCustom = null;
  dbPromise = null;
}
