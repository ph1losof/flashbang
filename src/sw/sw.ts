declare const self: ServiceWorkerGlobalScope;

import { COOKIE_MAX_AGE_S } from "../shared/constants";
import {
  encodeSuggestCookieValue,
  parseSuggestCookieValue,
} from "../shared/suggest-cookie";
import { initializeBangData, isBangDataInitialized } from "./bang-data";
import {
  getCachedSettings,
  getTopFrecencyRecord,
  hasTopFrecency,
  invalidateCache,
  loadFrecency,
  readRedirectSettings,
  seedRedirectSettings,
  trackBangUsage,
} from "./idb";
import {
  type RedirectSettings,
  redirectRaw,
  redirectRawUrl,
  redirectUrl,
} from "./redirect";

declare const __CACHE_VERSION__: string;
declare const __BANG_DATA_ASSET__: string;
declare const __FALLBACK_ASSET__: string;
declare const __REQUIRED_APP_ASSETS__: string[];
declare const __CONTROLLED_HTML__: string;
declare const __CONTROLLED_HEADERS__: Record<string, string>;
declare const __IS_DEV__: boolean;

const CACHE_PREFIX = "fb-";
const LEGACY_CACHE_NAMES = new Set(["flashbang-dev"]);
const CACHE_NAME = __CACHE_VERSION__.startsWith(CACHE_PREFIX)
  ? __CACHE_VERSION__
  : `${CACHE_PREFIX}${__CACHE_VERSION__}`;
const BANG_DATA_ASSET = __BANG_DATA_ASSET__;
const APP_ASSETS = [
  "/home",
  "/app.js",
  __FALLBACK_ASSET__,
  "/icon.svg",
  "/manifest.json",
  ...__REQUIRED_APP_ASSETS__,
];

const DEFERRED_ASSETS = APP_ASSETS;
const PRECACHE_CONCURRENCY = 4;
let deferredPrecachePromise: Promise<void> | null = null;
let bangDataPromise: Promise<void> | null = null;
let runtimeWarmPromise: Promise<void> | null = null;
const BENCHMARK_SETTINGS: RedirectSettings = {
  custom: Object.assign(Object.create(null), {
    custom: ["https://benchmark.example/search?q=", ""],
    path: ["https://benchmark.example/users/", ""],
  }),
  defaultUrl: ["https://www.google.com/search?q=", ""],
  luckyUrl: ["https://duckduckgo.com/?q=\\", ""],
};
let benchmarkState: {
  clientId: string;
  navigationCount: number;
  requestCount: number;
  token: string;
} | null = null;
const RESOLVED_PROMISE: Promise<void> = Promise.resolve();
const swallowError = () => {
  /* best-effort */
};

const BENCHMARK_TARGET_PATH = "/__flashbang-bench-target";
const BENCHMARK_TARGET_HTML = `<!doctype html><meta charset="utf-8"><title>flashbang benchmark target</title><script>opener?.postMessage({type:"flashbang-benchmark-navigation",token:new URLSearchParams(location.search).get("fb-bench"),sequence:Number(new URLSearchParams(location.search).get("fb-seq"))},location.origin)</script>`;
const APP_ORIGIN = self.location.origin;
const ROOT_URL = `${APP_ORIGIN}/`;
const INDEX_URL = `${APP_ORIGIN}/index.html`;

function isManagedCache(name: string): boolean {
  return name.startsWith(CACHE_PREFIX) || LEGACY_CACHE_NAMES.has(name);
}

function isAppPath(rawUrl: string, path: string): boolean {
  const absolute = `${APP_ORIGIN}${path}`;
  return rawUrl === absolute || rawUrl.startsWith(`${absolute}?`);
}

function rawQueryParameter(rawUrl: string, name: string): string | null {
  const marker = `${name}=`;
  let start = rawUrl.indexOf(`?${marker}`);
  if (start === -1) {
    start = rawUrl.indexOf(`&${marker}`);
  }
  if (start === -1) {
    return null;
  }
  start += marker.length + 1;
  const end = rawUrl.indexOf("&", start);
  return end === -1 ? rawUrl.substring(start) : rawUrl.substring(start, end);
}

async function loadBangData(): Promise<void> {
  const request = new Request(BANG_DATA_ASSET);
  const cache = await caches.open(CACHE_NAME);
  let response = await cache.match(request);
  if (!response) {
    for (const cacheName of await caches.keys()) {
      if (cacheName === CACHE_NAME || !isManagedCache(cacheName)) {
        continue;
      }
      response = await (await caches.open(cacheName)).match(request);
      if (response) {
        break;
      }
    }
    if (!response) {
      response = await fetch(request);
      if (!response.ok) {
        throw new Error(
          `Failed to load ${BANG_DATA_ASSET}: ${response.status} ${response.statusText}`
        );
      }
    }
    await cache.put(request, response.clone());
  }
  initializeBangData(await response.arrayBuffer());
}

function ensureBangData(): Promise<void> {
  if (isBangDataInitialized()) {
    return RESOLVED_PROMISE;
  }
  if (!bangDataPromise) {
    bangDataPromise = loadBangData().catch((error) => {
      bangDataPromise = null;
      throw error;
    });
  }
  return bangDataPromise;
}

function seedRuntime(
  buffer: ArrayBuffer,
  settings: RedirectSettings
): Promise<void> {
  const response = new Response(buffer);
  initializeBangData(buffer);
  seedRedirectSettings(settings);
  bangDataPromise = RESOLVED_PROMISE;
  const persistData = caches
    .open(CACHE_NAME)
    .then((cache) => cache.put(new Request(BANG_DATA_ASSET), response))
    .catch(swallowError);
  return Promise.all([persistData, loadFrecency()]).then(() => undefined);
}

function warmRuntime(): Promise<void> {
  if (isBangDataInitialized() && getCachedSettings()) {
    return RESOLVED_PROMISE;
  }
  if (!runtimeWarmPromise) {
    const warming = Promise.all([
      ensureBangData(),
      readRedirectSettings(),
    ]).then(() => undefined);
    let current: Promise<void>;
    current = warming.catch(swallowError).finally(() => {
      if (runtimeWarmPromise === current) {
        runtimeWarmPromise = null;
      }
    });
    runtimeWarmPromise = current;
  }
  return runtimeWarmPromise;
}

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
      if (await cache.match(req)) {
        continue;
      }
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
  const results = await Promise.allSettled(
    Array.from({ length: workers }, () => work())
  );
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (failure) {
    throw failure.reason;
  }
}

async function deleteOldCaches(cacheName: string): Promise<void> {
  const keys = await caches.keys();
  await Promise.all(
    keys
      .filter((k) => isManagedCache(k) && k !== cacheName)
      .map((k) => caches.delete(k))
  );
}

function ensureDeferredPrecache(): Promise<void> {
  if (deferredPrecachePromise) {
    return deferredPrecachePromise;
  }
  const warming = precacheAssets(CACHE_NAME, DEFERRED_ASSETS).then(() =>
    deleteOldCaches(CACHE_NAME)
  );
  let current: Promise<void>;
  current = warming.catch(() => {
    if (deferredPrecachePromise === current) {
      deferredPrecachePromise = null;
    }
  });
  deferredPrecachePromise = current;
  return deferredPrecachePromise;
}

async function cacheOnUse(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }
  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response.clone()).catch(swallowError);
    }
    return response;
  } catch {
    return new Response("Offline", { status: 503 });
  }
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
    loadFrecency()
      .then(() => {
        const usage = trackBangUsage(trigger);
        if (typeof cookieStore === "undefined" || !usage.topChanged) {
          return usage.persistence;
        }

        if (!hasTopFrecency()) {
          return usage.persistence;
        }
        const frecency = getTopFrecencyRecord();
        const cookieSync = cookieStore
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
                frecency,
                parsed.bangPrefix,
                parsed.snapPrefix
              ),
              path: "/",
              expires: Date.now() + COOKIE_MAX_AGE_S * 1000,
              sameSite: "lax",
            });
          })
          .catch(swallowError);
        return Promise.all([usage.persistence, cookieSync]).then(
          () => undefined
        );
      })
      .catch(swallowError)
  );
}

self.addEventListener("install", (e: ExtendableEvent) => {
  e.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (e: ExtendableEvent) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener("message", (e: ExtendableMessageEvent) => {
  if (e.origin !== self.location.origin) {
    return;
  }
  if (
    e.data?.type === "seed-runtime" &&
    e.data.asset === BANG_DATA_ASSET &&
    e.data.bangData instanceof ArrayBuffer &&
    typeof e.data.redirectSettings === "object" &&
    e.data.redirectSettings !== null
  ) {
    e.waitUntil(
      seedRuntime(e.data.bangData, e.data.redirectSettings as RedirectSettings)
    );
    return;
  }
  if (e.data?.type === "benchmark-mode") {
    const sourceId = (e.source as Client | null)?.id ?? null;
    const token = typeof e.data.token === "string" ? e.data.token : "";
    const enable = e.data.enabled === true && sourceId !== null && token !== "";
    if (enable) {
      benchmarkState = {
        clientId: sourceId,
        navigationCount: 0,
        requestCount: 0,
        token,
      };
    } else if (
      benchmarkState?.clientId === sourceId &&
      benchmarkState.token === token
    ) {
      benchmarkState = null;
    }
    const reply = () => {
      e.ports[0]?.postMessage({
        bangDataReady: isBangDataInitialized(),
        enabled:
          benchmarkState?.clientId === sourceId &&
          benchmarkState.token === token,
        navigationCount: benchmarkState?.navigationCount ?? 0,
        requestCount: benchmarkState?.requestCount ?? 0,
        token: benchmarkState?.token ?? null,
      });
    };
    if (enable && !isBangDataInitialized()) {
      e.waitUntil(ensureBangData().then(reply, reply));
    } else {
      reply();
    }
    return;
  }
  if (e.data?.type === "benchmark-count") {
    const sourceId = (e.source as Client | null)?.id ?? null;
    const token = typeof e.data.token === "string" ? e.data.token : "";
    e.ports[0]?.postMessage({
      active:
        benchmarkState?.clientId === sourceId && benchmarkState.token === token,
      navigationCount:
        benchmarkState?.clientId === sourceId && benchmarkState.token === token
          ? benchmarkState.navigationCount
          : -1,
      requestCount:
        benchmarkState?.clientId === sourceId && benchmarkState.token === token
          ? benchmarkState.requestCount
          : -1,
    });
    return;
  }
  if (e.data?.type === "invalidate") {
    const invalidation = invalidateCache();
    e.waitUntil(invalidation);
    if (e.ports[0]) {
      e.waitUntil(
        invalidation.then(() => {
          e.ports[0].postMessage(true);
        })
      );
    }
  }
  if (e.data?.type === "claim") {
    e.waitUntil(self.clients.claim());
  }
  const hasRawQuery = typeof e.data?.rawQuery === "string";
  let messageQuery = "";
  if (hasRawQuery) {
    messageQuery = e.data.rawQuery;
  } else if (typeof e.data?.query === "string") {
    messageQuery = e.data.query;
  }
  if (e.data?.type === "redirect" && messageQuery) {
    const resolve = (s: RedirectSettings) => {
      const url = hasRawQuery
        ? redirectRawUrl(messageQuery, s)
        : redirectUrl(messageQuery, s);
      if (e.ports[0]) {
        e.ports[0].postMessage(url);
      } else {
        (e.source as Client)?.postMessage(hasRawQuery ? url : { url });
      }
    };
    const cached = getCachedSettings();
    if (isBangDataInitialized()) {
      if (cached) {
        resolve(cached);
      } else {
        e.waitUntil(readRedirectSettings().then(resolve));
      }
    } else {
      e.waitUntil(
        ensureBangData().then(() => {
          const readySettings = getCachedSettings();
          if (readySettings) {
            resolve(readySettings);
            return;
          }
          return readRedirectSettings().then(resolve);
        })
      );
    }
  }
});

function respondToRedirect(
  e: FetchEvent,
  rawQuery: string,
  settings: RedirectSettings
): Response {
  const benchmark = benchmarkState?.clientId === e.clientId;
  const [response, trigger] = redirectRaw(
    rawQuery,
    benchmark ? BENCHMARK_SETTINGS : settings
  );
  if (benchmark && benchmarkState) {
    benchmarkState.requestCount++;
  } else if (trigger) {
    queueBangSideEffects(e, trigger);
  }
  return response;
}

self.addEventListener("fetch", (e: FetchEvent) => {
  const raw = e.request.url;

  if (__IS_DEV__ && raw.includes("/__dev/")) {
    return;
  }

  let benchmarkToken: string | null = null;
  if (benchmarkState) {
    benchmarkToken = rawQueryParameter(raw, "fb-bench");
    if (
      benchmarkState.token === benchmarkToken &&
      raw.includes(`${BENCHMARK_TARGET_PATH}?`)
    ) {
      e.respondWith(
        new Response(BENCHMARK_TARGET_HTML, {
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "text/html; charset=utf-8",
            "Cross-Origin-Embedder-Policy": "credentialless",
            "Cross-Origin-Opener-Policy": "same-origin",
          },
        })
      );
      return;
    }

    if (
      benchmarkState.clientId === e.clientId &&
      raw.endsWith("/__flashbang-bench-noop")
    ) {
      benchmarkState.requestCount++;
      e.respondWith(new Response(null, { status: 204 }));
      return;
    }
  }

  const vStart = findQueryValueStart(raw);
  if (vStart !== -1) {
    const vEnd = raw.indexOf("&", vStart);
    const rawQ =
      vEnd === -1 ? raw.substring(vStart) : raw.substring(vStart, vEnd);
    if (rawQ) {
      if (
        e.request.mode === "navigate" &&
        benchmarkState?.token === benchmarkToken
      ) {
        redirectRawUrl(rawQ, BENCHMARK_SETTINGS);
        benchmarkState.navigationCount++;
        const sequence = rawQueryParameter(raw, "fb-seq") ?? "0";
        const target = new URL(BENCHMARK_TARGET_PATH, raw);
        target.searchParams.set("fb-bench", benchmarkState.token);
        target.searchParams.set("fb-seq", sequence);
        e.respondWith(
          new Response(null, {
            status: 302,
            headers: {
              "Cross-Origin-Embedder-Policy": "credentialless",
              "Cross-Origin-Opener-Policy": "same-origin",
              Location: target.href,
            },
          })
        );
        return;
      }
      if (isBangDataInitialized()) {
        const cached = getCachedSettings();
        if (cached) {
          e.respondWith(respondToRedirect(e, rawQ, cached));
        } else {
          e.respondWith(
            readRedirectSettings().then((settings) =>
              respondToRedirect(e, rawQ, settings)
            )
          );
        }
      } else {
        e.respondWith(
          ensureBangData().then(() => {
            const cached = getCachedSettings();
            if (cached) {
              return respondToRedirect(e, rawQ, cached);
            }
            return readRedirectSettings().then((settings) =>
              respondToRedirect(e, rawQ, settings)
            );
          })
        );
      }
      return;
    }
  }

  if (
    e.request.mode === "navigate" &&
    (raw === ROOT_URL || raw === INDEX_URL)
  ) {
    e.respondWith(
      new Response(__CONTROLLED_HTML__, {
        headers: __CONTROLLED_HEADERS__,
      })
    );
    return;
  }

  if (isAppPath(raw, "/health")) {
    return;
  }

  // Private redirects should not install or compete with UI assets. Root is
  // handled above because the worker cannot see its URL fragment.
  if (!(isBangDataInitialized() && getCachedSettings())) {
    e.waitUntil(warmRuntime());
  }
  if (!deferredPrecachePromise) {
    e.waitUntil(ensureDeferredPrecache());
  }

  if (isAppPath(raw, "/bench") || isAppPath(raw, "/bench.html")) {
    e.respondWith(
      cacheOnUse(new Request("/bench")).then((r) => {
        const h = new Headers(r.headers);
        h.set("Cross-Origin-Opener-Policy", "same-origin");
        h.set("Cross-Origin-Embedder-Policy", "credentialless");
        return new Response(r.body, { status: r.status, headers: h });
      })
    );
    return;
  }

  if (isAppPath(raw, "/bench.js")) {
    e.respondWith(cacheOnUse(e.request));
    return;
  }

  if (raw.endsWith("/settings")) {
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
