// @ts-nocheck
import { redirect, invalidateCache } from "./redirect";

const CACHE_NAME = "flashbang-v1";
const ASSETS = ["/", "/index.html", "/app.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
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

self.addEventListener("message", (e) => {
  if (e.data?.type === "invalidate") invalidateCache();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const q = url.searchParams.get("q");

  if (q && (url.pathname === "/" || url.pathname === "/search")) {
    e.respondWith(redirect(q));
    return;
  }

  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
