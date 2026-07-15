declare const self: ServiceWorkerGlobalScope;

import { COOKIE_MAX_AGE_S } from "../shared/constants";
import {
  encodeSuggestCookieValue,
  parseSuggestCookieValue,
} from "../shared/suggest-cookie";
import {
  getCachedSettings,
  getTopFrecencyRecord,
  hasTopFrecency,
  invalidateCache,
  loadFrecency,
  readRedirectSettings,
  trackBangUsage,
} from "./idb";
import { type RedirectSettings, redirectRaw, redirectUrl } from "./redirect";

declare const __CACHE_VERSION__: string;
declare const __REQUIRED_APP_ASSETS__: string[];
declare const __IS_DEV__: boolean;

const CACHE_PREFIX = "fb-";
const LEGACY_CACHE_NAMES = new Set(["flashbang-dev"]);
const CACHE_NAME = __CACHE_VERSION__.startsWith(CACHE_PREFIX)
  ? __CACHE_VERSION__
  : `${CACHE_PREFIX}${__CACHE_VERSION__}`;
const REQUIRED_ASSETS = [
  "/home",
  "/app.js",
  "/icon.svg",
  "/manifest.json",
  ...__REQUIRED_APP_ASSETS__,
];

const OPTIONAL_ASSETS = ["/bench", "/bench.js"];
const PRECACHE_CONCURRENCY = 4;
let optionalPrecachePromise: Promise<void> | null = null;
let benchmarkClientId: string | null = null;
const RESOLVED_PROMISE: Promise<void> = Promise.resolve();
const swallowError = () => {
  /* best-effort */
};

async function precacheAssets(
  cacheName: string,
  assetPaths: readonly string[]
): Promise<void> {
  if (assetPaths.length === 0) {
    return;
  }
  const cache = await caches.open(cacheName);
  let nextIndex = 0;

  async function work(): Promise<void> {
    while (true) {
      const idx = nextIndex++;
      if (idx >= assetPaths.length) {
        return;
      }
      const assetPath = assetPaths[idx];
      const req = new Request(assetPath);
      const res = await fetch(req);
      if (!res.ok) {
        throw new Error(
          `Failed to precache ${assetPath}: ${res.status} ${res.statusText}`
        );
      }
      await cache.put(req, res);
    }
  }

  const workers = Math.min(PRECACHE_CONCURRENCY, assetPaths.length);
  await Promise.all(Array.from({ length: workers }, () => work()));
}

async function deleteOldCaches(cacheName: string): Promise<void> {
  const keys = await caches.keys();
  await Promise.all(
    keys
      .filter(
        (k) =>
          (k.startsWith(CACHE_PREFIX) || LEGACY_CACHE_NAMES.has(k)) &&
          k !== cacheName
      )
      .map((k) => caches.delete(k))
  );
}

function ensureOptionalPrecache(): Promise<void> {
  if (optionalPrecachePromise) {
    return optionalPrecachePromise;
  }
  optionalPrecachePromise = precacheAssets(CACHE_NAME, OPTIONAL_ASSETS).catch(
    swallowError
  );
  return optionalPrecachePromise;
}

function findQueryValueStart(raw: string): number {
  let paramStart = raw.indexOf("?") + 1;
  while (paramStart > 0) {
    if (
      raw.charCodeAt(paramStart) === 113 &&
      raw.charCodeAt(paramStart + 1) === 61
    ) {
      return paramStart + 2;
    }
    const separator = raw.indexOf("&", paramStart);
    if (separator === -1) {
      return -1;
    }
    paramStart = separator + 1;
  }
  return -1;
}

function queueBangSideEffects(e: FetchEvent, trigger: string): void {
  e.waitUntil(
    RESOLVED_PROMISE.then(() => {
      trackBangUsage(trigger);
      if (typeof cookieStore === "undefined") {
        return;
      }

      if (!hasTopFrecency()) {
        return;
      }
      const frecency = getTopFrecencyRecord();
      return cookieStore
        .get("suggest")
        .then((cookie) => {
          if (!cookie?.value) {
            return;
          }
          const parsed = parseSuggestCookieValue(cookie.value, true);
          return cookieStore.set({
            name: "suggest",
            value: encodeSuggestCookieValue(
              parsed.provider,
              parsed.trigger,
              parsed.customUrl || "",
              parsed.custom,
              frecency
            ),
            path: "/",
            expires: Date.now() + COOKIE_MAX_AGE_S * 1000,
            sameSite: "lax",
          });
        })
        .catch(swallowError);
    }).catch(swallowError)
  );
}

self.addEventListener("install", (e: ExtendableEvent) => {
  e.waitUntil(
    precacheAssets(CACHE_NAME, REQUIRED_ASSETS).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e: ExtendableEvent) => {
  e.waitUntil(
    Promise.all([
      deleteOldCaches(CACHE_NAME),
      self.clients.claim(),
      readRedirectSettings(),
      loadFrecency(),
    ]).then(() => {
      /* no-op */
    })
  );
});

self.addEventListener("message", (e: ExtendableMessageEvent) => {
  if (e.data?.type === "benchmark-mode") {
    const sourceId = (e.source as Client | null)?.id ?? null;
    const enable = e.data.enabled === true && sourceId !== null;
    if (enable) {
      benchmarkClientId = sourceId;
    } else if (benchmarkClientId === sourceId) {
      benchmarkClientId = null;
    }
    e.ports[0]?.postMessage({ enabled: benchmarkClientId === sourceId });
    return;
  }
  if (e.data?.type === "invalidate") {
    invalidateCache();
  }
  if (e.data?.type === "claim") {
    e.waitUntil(self.clients.claim());
  }
  if (e.data?.type === "redirect" && e.data.query) {
    const q = e.data.query as string;
    const resolve = (s: RedirectSettings) => {
      (e.source as Client)?.postMessage({
        url: redirectUrl(q, s),
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

  if (__IS_DEV__ && raw.includes("/__dev/")) {
    return;
  }

  const vStart = findQueryValueStart(raw);
  if (vStart !== -1) {
    const vEnd = raw.indexOf("&", vStart);
    const rawQ =
      vEnd === -1 ? raw.substring(vStart) : raw.substring(vStart, vEnd);
    if (rawQ) {
      const cached = getCachedSettings();
      if (cached) {
        const [resp, trigger] = redirectRaw(rawQ, cached);
        if (
          trigger &&
          (benchmarkClientId === null || e.clientId !== benchmarkClientId)
        ) {
          queueBangSideEffects(e, trigger);
        }
        e.respondWith(resp);
      } else {
        e.respondWith(
          readRedirectSettings().then((s) => {
            const [resp, trigger] = redirectRaw(rawQ, s);
            if (
              trigger &&
              (benchmarkClientId === null || e.clientId !== benchmarkClientId)
            ) {
              queueBangSideEffects(e, trigger);
            }
            return resp;
          })
        );
      }
      return;
    }
  }

  // Redirect requests should not compete with optional UI asset warmup.
  if (!optionalPrecachePromise) {
    e.waitUntil(ensureOptionalPrecache());
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
      .catch(() => new Response("Offline", { status: 503 }))
  );
});
