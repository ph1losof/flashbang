declare const self: ServiceWorkerGlobalScope;
declare const cookieStore: CookieStore;

import { COOKIE_MAX_AGE_S } from "../shared/constants";
import { SEED_CACHE_NAME } from "../shared/seed-cache";
import {
  encodeSuggestCookieValue,
  parseSuggestCookieValue,
} from "../shared/suggest-cookie";
import {
  initializeBangData,
  isBangDataInitialized,
  isBangDataUnavailable,
} from "./bang-data";
import {
  createHotBootState,
  decodeHotBootRecord,
  encodeHotBootRecord,
  HOT_BOOT_SENTINEL,
  type HotBootRecord,
  hotBootSettingsNeedPublish,
  lookupGeneratedHotBang,
  materializeCompactBaseSettings,
  materializeHotFrecency,
} from "./hot-redirect";
import {
  getCachedSettings,
  getTopFrecencyRecord,
  hasTopFrecency,
  invalidateCache,
  loadFrecency,
  readRedirectSettings,
  seedRedirectSettings,
  trackBangUsage,
  waitForRedirectSettingsPersistence,
} from "./idb";
import {
  type HotBangLookup,
  isHotBangLookupBlocked,
  type RedirectSettings,
  redirectRaw,
  redirectRawUrl,
  redirectUrl,
} from "./redirect";
import {
  type PreparedRedirectSettings,
  prepareRedirectSettings,
} from "./redirect-settings";

declare const __CACHE_VERSION__: string;
declare const __BANG_DATA_ASSET__: string;
declare const __FALLBACK_ASSET__: string;
declare const __REQUIRED_APP_ASSETS__: string[];
declare const __IS_DEV__: boolean;

const CACHE_PREFIX = "fb-";
const LEGACY_CACHE_NAMES = new Set(["flashbang-dev"]);
const RAW_CACHE_VERSION =
  typeof __CACHE_VERSION__ === "undefined" ? "test-cache" : __CACHE_VERSION__;
const CACHE_NAME = RAW_CACHE_VERSION.startsWith(CACHE_PREFIX)
  ? RAW_CACHE_VERSION
  : `${CACHE_PREFIX}${RAW_CACHE_VERSION}`;
const BANG_DATA_ASSET =
  typeof __BANG_DATA_ASSET__ === "undefined"
    ? "/bangs.bin"
    : __BANG_DATA_ASSET__;
const BASE_APP_ASSETS = [
  "/home",
  "/app.js",
  typeof __FALLBACK_ASSET__ === "undefined"
    ? "/fallback.js"
    : __FALLBACK_ASSET__,
  "/icon.svg",
  "/manifest.json",
];
function appAssets(): string[] {
  return [
    ...BASE_APP_ASSETS,
    ...(typeof __REQUIRED_APP_ASSETS__ === "undefined"
      ? []
      : __REQUIRED_APP_ASSETS__),
  ];
}

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
const NO_HOT_BOOT_PROMISE: Promise<HotBootRecord | null> =
  Promise.resolve(null);
function currentNavigationPreload(): NavigationPreloadManager | undefined {
  return typeof self === "undefined"
    ? undefined
    : self.registration?.navigationPreload;
}
let hotBootAvailable = currentNavigationPreload() !== undefined;
let hotBootGeneration = 0;
let currentHotBoot: HotBootRecord | null = null;
let hotBootPromise: Promise<HotBootRecord | null> = readInitialHotBoot();
let hotBootMutation: Promise<void> = RESOLVED_PROMISE;
const hotBootUpdateTokens = new Set<string>();
const swallowError = () => {
  /* best-effort */
};

function readInitialHotBoot(): Promise<HotBootRecord | null> {
  const navigationPreload = currentNavigationPreload();
  const initialHotBootGeneration = hotBootGeneration;
  return navigationPreload
    ? navigationPreload
        .getState()
        .then((state) => {
          const raw = state.headerValue ?? "";
          const record = state.enabled
            ? null
            : decodeHotBootRecord(raw, CACHE_NAME);
          if (hotBootGeneration !== initialHotBootGeneration) {
            return currentHotBoot;
          }
          currentHotBoot = record;
          if (record?.settings) {
            seedRedirectSettings(record.settings);
          }
          return record;
        })
        .catch(() => {
          if (hotBootGeneration === initialHotBootGeneration) {
            hotBootAvailable = false;
          }
          return currentHotBoot;
        })
    : NO_HOT_BOOT_PROMISE;
}

function readCurrentRedirectSettings(
  prepared?: Promise<PreparedRedirectSettings>,
  bangDataReady?: Promise<void>
): Promise<RedirectSettings> {
  const cached = getCachedSettings();
  if (cached) {
    return Promise.resolve(cached);
  }
  return hotBootPromise.then((record) => {
    const current = getCachedSettings();
    if (current) {
      return current;
    }
    if (record === currentHotBoot && record?.settings) {
      seedRedirectSettings(record.settings);
      return record.settings;
    }
    return readRedirectSettings(
      prepared,
      BANG_DATA_ASSET,
      bangDataReady ?? ensureBangData()
    );
  });
}

function queueHotBootMutation(operation: () => Promise<void>): Promise<void> {
  const next = hotBootMutation.then(operation, operation);
  hotBootMutation = next.catch(swallowError);
  return next;
}

async function disableHotBoot(): Promise<void> {
  hotBootGeneration++;
  currentHotBoot = null;
  hotBootPromise = NO_HOT_BOOT_PROMISE;
  const navigationPreload = currentNavigationPreload();
  if (!(navigationPreload && hotBootAvailable)) {
    return;
  }
  try {
    await navigationPreload.setHeaderValue(HOT_BOOT_SENTINEL);
    await navigationPreload.disable();
  } catch {
    hotBootAvailable = false;
    await navigationPreload.disable().catch(swallowError);
  }
}

async function publishHotBoot(includeSettings = false): Promise<void> {
  if (hotBootUpdateTokens.size > 0) {
    return;
  }
  const navigationPreload = currentNavigationPreload();
  if (!(navigationPreload && hotBootAvailable)) {
    if (includeSettings && isBangDataInitialized() && !getCachedSettings()) {
      await readCurrentRedirectSettings();
    }
    return;
  }
  const prepared = await prepareRedirectSettings(BANG_DATA_ASSET);
  const snapshot = prepared.snapshot;
  const state = createHotBootState(snapshot);
  let settings: RedirectSettings | undefined;
  if (includeSettings && isBangDataInitialized()) {
    await loadFrecency();
    settings =
      getCachedSettings() ??
      (await readCurrentRedirectSettings(
        Promise.resolve(prepared),
        RESOLVED_PROMISE
      ));
  }
  const frecency = settings
    ? materializeHotFrecency(getTopFrecencyRecord(), snapshot)
    : undefined;
  const compactSettings = settings
    ? undefined
    : materializeCompactBaseSettings(snapshot, prepared.settings);
  const record = encodeHotBootRecord(
    CACHE_NAME,
    state,
    settings ? snapshot : undefined,
    settings ?? compactSettings ?? undefined,
    frecency
  );
  try {
    await navigationPreload.disable();
    await navigationPreload.setHeaderValue(record);
  } catch {
    hotBootAvailable = false;
    hotBootGeneration++;
    currentHotBoot = null;
    hotBootPromise = NO_HOT_BOOT_PROMISE;
    return;
  }
  const decoded = decodeHotBootRecord(record, CACHE_NAME);
  hotBootGeneration++;
  currentHotBoot = decoded;
  hotBootPromise = Promise.resolve(decoded);
  if (decoded?.settings) {
    seedRedirectSettings(decoded.settings);
  }
}

const BENCHMARK_TARGET_PATH = "/__flashbang-bench-target";
const BENCHMARK_TARGET_HTML = `<!doctype html><meta charset="utf-8"><title>flashbang benchmark target</title><script>opener?.postMessage({type:"flashbang-benchmark-navigation",token:new URLSearchParams(location.search).get("fb-bench"),sequence:Number(new URLSearchParams(location.search).get("fb-seq"))},location.origin)</script>`;
const APP_ORIGIN =
  typeof self === "undefined" || self.location === undefined
    ? "https://flashbang.local"
    : self.location.origin;
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

function rawPrivateQuery(rawUrl: string): string | null {
  const start = rawUrl.indexOf("#q=");
  if (start === -1) {
    return null;
  }
  const valueStart = start + 3;
  const end = rawUrl.indexOf("&", valueStart);
  return end === -1
    ? rawUrl.substring(valueStart)
    : rawUrl.substring(valueStart, end);
}

async function loadBangData(): Promise<void> {
  const request = new Request(BANG_DATA_ASSET);
  const cache = await caches.open(CACHE_NAME);
  let response = await cache.match(request);
  if (!response) {
    const seedCache = await caches.open(SEED_CACHE_NAME);
    response = await seedCache.match(request);
    if (response) {
      await caches.delete(SEED_CACHE_NAME);
    }
  }
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
  const publishSettings = hotBootSettingsNeedPublish(currentHotBoot)
    ? queueHotBootMutation(() => publishHotBoot(true)).catch(swallowError)
    : RESOLVED_PROMISE;
  return Promise.all([persistData, loadFrecency(), publishSettings]).then(
    () => undefined
  );
}

function warmRuntime(): Promise<void> {
  if (isBangDataInitialized() && getCachedSettings()) {
    return RESOLVED_PROMISE;
  }
  if (!runtimeWarmPromise) {
    const bangDataReady = ensureBangData();
    const warming = Promise.all([
      bangDataReady,
      readCurrentRedirectSettings(undefined, bangDataReady),
      loadFrecency(),
    ]).then(async () => {
      await waitForRedirectSettingsPersistence();
      if (hotBootSettingsNeedPublish(currentHotBoot)) {
        await queueHotBootMutation(() => publishHotBoot(true));
      }
    });
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
  const warming = precacheAssets(CACHE_NAME, appAssets()).then(() =>
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
        const hotBootSync =
          usage.topMembershipChanged && isBangDataInitialized()
            ? queueHotBootMutation(() => publishHotBoot(true)).catch(
                swallowError
              )
            : RESOLVED_PROMISE;
        if (typeof cookieStore === "undefined" || !usage.topChanged) {
          return Promise.all([usage.persistence, hotBootSync]).then(
            () => undefined
          );
        }

        if (!hasTopFrecency()) {
          return Promise.all([usage.persistence, hotBootSync]).then(
            () => undefined
          );
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
        return Promise.all([usage.persistence, cookieSync, hotBootSync]).then(
          () => undefined
        );
      })
      .catch(swallowError)
  );
}

export function handleInstall(e: ExtendableEvent): void {
  e.waitUntil(self.skipWaiting());
}

export function handleActivate(e: ExtendableEvent): void {
  e.waitUntil(
    queueHotBootMutation(async () => {
      await disableHotBoot();
      await publishHotBoot();
    })
      .catch(swallowError)
      .then(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        await ensureBangData().catch(swallowError);
        await self.clients.claim();
      })
  );
}

export function handleMessage(e: ExtendableMessageEvent): void {
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
  if (
    e.data?.type === "hot-boot-begin" &&
    typeof e.data.token === "string" &&
    e.data.token
  ) {
    const token = e.data.token;
    const update = queueHotBootMutation(async () => {
      hotBootUpdateTokens.add(token);
      try {
        await disableHotBoot();
        await invalidateCache();
      } catch (error) {
        hotBootUpdateTokens.delete(token);
        throw error;
      }
    });
    e.waitUntil(update);
    if (e.ports[0]) {
      e.waitUntil(
        update.then(
          () => e.ports[0].postMessage(true),
          () => e.ports[0].postMessage(false)
        )
      );
    }
    return;
  }
  if (
    e.data?.type === "hot-boot-end" &&
    typeof e.data.token === "string" &&
    e.data.token
  ) {
    const token = e.data.token;
    const update = queueHotBootMutation(async () => {
      hotBootUpdateTokens.delete(token);
      await invalidateCache();
      await publishHotBoot(true);
    });
    e.waitUntil(update);
    if (e.ports[0]) {
      e.waitUntil(
        update.then(
          () => e.ports[0].postMessage(true),
          () => e.ports[0].postMessage(false)
        )
      );
    }
    return;
  }
  if (e.data?.type === "invalidate") {
    hotBootPromise = NO_HOT_BOOT_PROMISE;
    const cacheInvalidation = invalidateCache();
    const invalidation = queueHotBootMutation(async () => {
      await disableHotBoot();
      await cacheInvalidation;
      await publishHotBoot(true);
    });
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
        e.waitUntil(readCurrentRedirectSettings().then(resolve));
      }
    } else {
      const bangDataReady = ensureBangData();
      e.waitUntil(
        readCurrentRedirectSettings(undefined, bangDataReady).then(
          async (settings) => {
            try {
              resolve(settings);
            } catch (error) {
              if (!isBangDataUnavailable(error)) {
                throw error;
              }
              await bangDataReady;
              resolve(settings);
            }
          }
        )
      );
    }
  }
}

function respondToRedirect(
  e: FetchEvent,
  rawQuery: string,
  settings: RedirectSettings,
  hotBangLookup?: HotBangLookup | null
): Response {
  const benchmark = benchmarkState?.clientId === e.clientId;
  const [response, trigger] = redirectRaw(
    rawQuery,
    benchmark ? BENCHMARK_SETTINGS : settings,
    benchmark ? null : hotBangLookup
  );
  if (benchmark && benchmarkState) {
    benchmarkState.requestCount++;
  } else if (trigger) {
    queueBangSideEffects(e, trigger);
  }
  return response;
}

function respondToCompactHotBang(
  e: FetchEvent,
  rawQuery: string,
  hotBoot: HotBootRecord
): Response | null {
  const settings = hotBoot.compactSettings;
  if (!settings) {
    return null;
  }
  const [response, trigger] = redirectRaw(
    rawQuery,
    settings,
    hotBoot.hotBangLookup
  );
  if (!(trigger || hotBoot.baseComplete)) {
    return null;
  }
  if (trigger) {
    queueBangSideEffects(e, trigger);
  }
  return response;
}

function responseForQuery(
  e: FetchEvent,
  rawQuery: string
): Response | Promise<Response> {
  if (isBangDataInitialized()) {
    const cached = getCachedSettings();
    if (cached) {
      return respondToRedirect(e, rawQuery, cached);
    }
    return readCurrentRedirectSettings().then((settings) =>
      respondToRedirect(e, rawQuery, settings)
    );
  }
  return hotBootPromise.then((hotBoot) => {
    if (e.request.mode === "navigate") {
      const settings = hotBoot?.settings;
      try {
        if (settings) {
          return respondToRedirect(
            e,
            rawQuery,
            settings,
            hotBoot.hotBangLookup
          );
        }
        if (hotBoot?.compactSettings) {
          const response = respondToCompactHotBang(e, rawQuery, hotBoot);
          if (response) {
            return response;
          }
        }
      } catch (error) {
        if (!(isBangDataUnavailable(error) || isHotBangLookupBlocked(error))) {
          throw error;
        }
      }
    }
    const bangDataReady =
      hotBootUpdateTokens.size > 0
        ? invalidateCache().then(ensureBangData)
        : ensureBangData();
    e.waitUntil(bangDataReady.catch(swallowError));
    return readCurrentRedirectSettings(undefined, bangDataReady).then(
      async (settings) => {
        if (hotBootSettingsNeedPublish(currentHotBoot)) {
          e.waitUntil(
            bangDataReady
              .then(() => queueHotBootMutation(() => publishHotBoot(true)))
              .catch(swallowError)
          );
        }
        try {
          return respondToRedirect(
            e,
            rawQuery,
            settings,
            hotBoot?.hotBangLookup ?? lookupGeneratedHotBang
          );
        } catch (error) {
          if (
            !(isBangDataUnavailable(error) || isHotBangLookupBlocked(error))
          ) {
            throw error;
          }
          await bangDataReady;
          return respondToRedirect(
            e,
            rawQuery,
            settings,
            hotBoot?.hotBangLookup ?? lookupGeneratedHotBang
          );
        }
      }
    );
  });
}

function createSyntheticRedirectResponse(response: Response): Response {
  const location = response.headers.get("Location");
  if (!location) {
    return response;
  }
  const serializedLocation = JSON.stringify(location)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  return new Response(
    `<!doctype html><script>location.replace(${serializedLocation})</script>`,
    {
      headers: {
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'",
        "Content-Type": "text/html; charset=utf-8",
        "Referrer-Policy": "no-referrer",
      },
    }
  );
}

function refreshHome(): Response {
  return new Response(null, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      Refresh: `0;url=${APP_ORIGIN}/home`,
    },
  });
}

export function handleFetch(e: FetchEvent): void {
  const raw = e.request.url;

  if (
    typeof __IS_DEV__ !== "undefined" &&
    __IS_DEV__ &&
    raw.includes("/__dev/")
  ) {
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

  if (e.request.mode === "navigate") {
    const privateQuery = rawPrivateQuery(raw);
    if (privateQuery !== null) {
      if (!privateQuery) {
        e.respondWith(refreshHome());
        return;
      }
      e.respondWith(
        Promise.resolve(responseForQuery(e, privateQuery)).then(
          createSyntheticRedirectResponse
        )
      );
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
      e.respondWith(responseForQuery(e, rawQ));
      return;
    }
  }

  if (
    e.request.mode === "navigate" &&
    (raw === ROOT_URL || raw === INDEX_URL)
  ) {
    e.respondWith(Response.redirect(`${APP_ORIGIN}/home`, 302));
    return;
  }

  if (isAppPath(raw, "/health")) {
    return;
  }

  // Private redirects should not install or compete with UI assets.
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
}

export function registerServiceWorker(): void {
  if (
    typeof self === "undefined" ||
    typeof self.addEventListener !== "function" ||
    self.clients === undefined
  ) {
    return;
  }
  self.addEventListener("install", handleInstall);
  self.addEventListener("activate", handleActivate);
  self.addEventListener("message", handleMessage);
  self.addEventListener("fetch", handleFetch);
}

export function resetSwStateForTests(): void {
  deferredPrecachePromise = null;
  bangDataPromise = null;
  runtimeWarmPromise = null;
  benchmarkState = null;
  hotBootAvailable = currentNavigationPreload() !== undefined;
  hotBootGeneration = 0;
  currentHotBoot = null;
  hotBootPromise = readInitialHotBoot();
  hotBootMutation = RESOLVED_PROMISE;
  hotBootUpdateTokens.clear();
}

registerServiceWorker();
