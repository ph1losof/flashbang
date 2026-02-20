declare const self: ServiceWorkerGlobalScope;

import { redirect } from "./redirect";
import { readRedirectSettings, invalidateCache } from "./idb";

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
  const raw = e.request.url;

  // Fast path: extract ?q= without constructing a URL object
  const qIdx = raw.indexOf("?q=");
  if (qIdx !== -1) {
    const vStart = qIdx + 3;
    const vEnd = raw.indexOf("&", vStart);
    const q = decodeURIComponent(
      (vEnd === -1 ? raw.substring(vStart) : raw.substring(vStart, vEnd)).replace(
        /\+/g,
        " ",
      ),
    );
    if (q) {
      e.respondWith(readRedirectSettings().then((s) => redirect(q, s)));
      return;
    }
  }

  // /settings is the same SPA page as /
  const req = raw.endsWith("/settings") ? new Request("/") : e.request;

  e.respondWith(
    caches.match(req).then((r) =>
      r || fetch(req).catch(() => new Response("Offline", { status: 503 })),
    ),
  );
});
