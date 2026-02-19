declare const self: ServiceWorkerGlobalScope;

import { redirect } from "./redirect";
import { readRedirectSettings, readSuggestSettings, invalidateCache } from "./idb";

const CACHE_NAME = "flashbang-v1";
const ASSETS = ["/", "/index.html", "/app.js", "/icon.svg", "/manifest.json"];

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
  if (e.data?.type === "invalidate") invalidateCache();
});

self.addEventListener("fetch", (e: FetchEvent) => {
  const url = new URL(e.request.url);
  const q = url.searchParams.get("q");

  if (url.pathname === "/suggest" && q) {
    const query = q;
    e.respondWith(
      Promise.all([import("./suggest"), readSuggestSettings()]).then(
        ([m, s]) => m.suggest(query, s),
      ),
    );
    return;
  }

  if (q && (url.pathname === "/" || url.pathname === "/search")) {
    e.respondWith(
      readRedirectSettings().then((s) => redirect(q, s)),
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((r) =>
      r || fetch(e.request).catch(() => new Response("Offline", { status: 503 })),
    ),
  );
});
