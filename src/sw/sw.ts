declare const self: ServiceWorkerGlobalScope;

import { redirect, invalidateCache } from "./redirect";
import type { SuggestSettings } from "./suggest";

const CACHE_NAME = "flashbang-v1";
const ASSETS = ["/", "/index.html", "/app.js"];

self.addEventListener("install", (e: ExtendableEvent) => {
  e.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e: ExtendableEvent) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (e: ExtendableMessageEvent) => {
  if (e.data?.type === "invalidate") {
    invalidateCache();
    cachedSuggestSettings = null;
  }
});

self.addEventListener("fetch", (e: FetchEvent) => {
  const url = new URL(e.request.url);
  const q = url.searchParams.get("q");

  if (url.pathname === "/suggest" && q) {
    e.respondWith(
      Promise.all([import("./suggest"), readSuggestSettings()]).then(
        ([m, s]) => m.suggest(q!, s),
      ),
    );
    return;
  }

  if (q && (url.pathname === "/" || url.pathname === "/search")) {
    e.respondWith(redirect(q));
    return;
  }

  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});

let cachedSuggestSettings: SuggestSettings | null = null;

async function readSuggestSettings(): Promise<SuggestSettings> {
  if (cachedSuggestSettings) return cachedSuggestSettings;
  try {
    const db = await new Promise<IDBDatabase>((ok, err) => {
      const r = indexedDB.open("flashbang", 1);
      r.onsuccess = () => ok(r.result);
      r.onerror = () => err(r.error);
    });
    const tx = db.transaction("settings", "readonly");
    const s = tx.objectStore("settings");
    const get = (key: string) =>
      new Promise<any>((ok, err) => {
        const r = s.get(key);
        r.onsuccess = () => ok(r.result);
        r.onerror = () => err(r.error);
      });
    const [p, b, u] = await Promise.all([
      get("suggest-provider"),
      get("default-bang"),
      get("suggest-url"),
    ]);
    cachedSuggestSettings = {
      provider: p?.value || "default",
      trigger: b?.value || "g",
      customUrl: u?.value || null,
    };
  } catch {
    cachedSuggestSettings = { provider: "default", trigger: "g", customUrl: null };
  }
  return cachedSuggestSettings!;
}
