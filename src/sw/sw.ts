declare const self: ServiceWorkerGlobalScope;

import {
  getCachedSettings,
  invalidateCache,
  readRedirectSettings,
} from "./idb";
import { type RedirectSettings, redirect } from "./redirect";

const CACHE_NAME = "flashbang";
const ASSETS = ["/home", "/app.js", "/icon.svg", "/manifest.json"];

self.addEventListener("install", (e: ExtendableEvent) => {
  e.waitUntil(
    Promise.all([
      caches.open(CACHE_NAME).then((c) => c.addAll(ASSETS)),
      self.skipWaiting(),
    ])
  );
});

self.addEventListener("activate", (e: ExtendableEvent) => {
  readRedirectSettings();
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (e: ExtendableMessageEvent) => {
  if (e.data?.type === "invalidate") {
    invalidateCache();
  }
  if (e.data?.type === "claim") {
    e.waitUntil(self.clients.claim());
  }
  if (e.data?.type === "redirect" && e.data.query) {
    const q = e.data.query as string;
    const resolve = (s: RedirectSettings) => {
      const resp = redirect(q, s);
      (e.source as Client)?.postMessage({
        url: resp.headers.get("Location"),
      });
    };
    const cached = getCachedSettings();
    if (cached) {
      resolve(cached);
    } else {
      readRedirectSettings().then(resolve);
    }
  }
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
      ).replace(/\+/g, " ")
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
        .match(new Request("/bench"))
        .then(
          (r) =>
            r ||
            fetch("/bench").catch(
              () => new Response("Offline", { status: 503 })
            )
        )
        .then((r) => {
          const h = new Headers(r.headers);
          h.set("Cross-Origin-Opener-Policy", "same-origin");
          h.set("Cross-Origin-Embedder-Policy", "credentialless");
          return new Response(r.body, { status: r.status, headers: h });
        })
    );
    return;
  }

  if (
    raw.endsWith("/") ||
    raw.endsWith("/index.html") ||
    raw.endsWith("/settings")
  ) {
    e.respondWith(
      caches
        .match(new Request("/home"))
        .then(
          (r) =>
            r ||
            fetch("/home").catch(() => new Response("Offline", { status: 503 }))
        )
    );
    return;
  }

  e.respondWith(
    caches
      .match(e.request)
      .then(
        (r) =>
          r ||
          fetch(e.request).catch(() => new Response("Offline", { status: 503 }))
      )
  );
});
