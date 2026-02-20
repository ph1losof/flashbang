declare const self: ServiceWorkerGlobalScope;

import { redirect } from "./redirect";
import {
  readRedirectSettings,
  getCachedSettings,
  invalidateCache,
} from "./idb";

const CACHE_NAME = "flashbang-v1";
const ASSETS = [
  "/",
  "/index.html",
  "/app.js",
  "/icon.svg",
  "/manifest.json",
  "/bench.html",
  "/bench.js",
];

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
    Promise.all([
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)),
          ),
        ),
      readRedirectSettings(),
    ]).then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (e: ExtendableMessageEvent) => {
  if (e.data?.type === "invalidate") invalidateCache();
  if (e.data?.type === "claim") e.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (e: FetchEvent) => {
  const raw = e.request.url;

  const qIdx = raw.indexOf("?q=");
  if (qIdx !== -1) {
    const vStart = qIdx + 3;
    const vEnd = raw.indexOf("&", vStart);
    const q = decodeURIComponent(
      (vEnd === -1
        ? raw.substring(vStart)
        : raw.substring(vStart, vEnd)
      ).replace(/\+/g, " "),
    );
    if (q) {
      const cached = getCachedSettings();
      if (cached) {
        e.respondWith(redirect(q, cached));
      } else {
        e.respondWith(readRedirectSettings().then((s) => redirect(q, s)));
      }
      return;
    }
  }

  if (raw.endsWith("/bench")) {
    e.respondWith(
      caches
        .match(new Request("/bench.html"))
        .then(
          (r) =>
            r ||
            fetch("/bench.html").catch(
              () => new Response("Offline", { status: 503 }),
            ),
        )
        .then((r) => {
          const h = new Headers(r.headers);
          h.set("Cross-Origin-Opener-Policy", "same-origin");
          h.set("Cross-Origin-Embedder-Policy", "credentialless");
          return new Response(r.body, { status: r.status, headers: h });
        }),
    );
    return;
  }

  const req = raw.endsWith("/settings") ? new Request("/") : e.request;

  e.respondWith(
    caches
      .match(req)
      .then(
        (r) =>
          r || fetch(req).catch(() => new Response("Offline", { status: 503 })),
      ),
  );
});
