declare const self: ServiceWorkerGlobalScope;
declare const cookieStore: CookieStore;

import { HOT_TRIGGERS } from "../generated/bangs-hot.js";
import {
  BANG_SHARD_COUNT,
  bangShardIndex,
  extractBangShardTriggers,
} from "../shared/bang-shards";
import { COOKIE_MAX_AGE_S } from "../shared/constants";
import { hashFNV1a } from "../shared/hash";
import { SEED_CACHE_NAME } from "../shared/seed-cache";
import {
  encodeSuggestCookieValue,
  parseSuggestCookieValue,
} from "../shared/suggest-cookie";
import {
  type BangShardRuntime,
  configureBangFallbackLookup,
  createBangIndexRuntime,
  createBangShardRuntime,
  initializeBangData,
  isBangDataInitialized,
  isBangDataUnavailable,
  isBangStringStoreStale,
} from "./bang-data";
import { type BangStrings, createBangStrings } from "./bang-strings";
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
declare const __BANG_SHARD_ROUTER__: readonly number[];
declare const __BANG_SHARD_ASSETS__: readonly string[];
declare const __BANG_INDEX_ASSETS__: readonly string[];
declare const __BANG_INDEX_SHARDS_PER_ASSET__: number;
declare const __BANG_STORE_ASSETS__: readonly string[];
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
const BANG_SHARD_ROUTER =
  typeof __BANG_SHARD_ROUTER__ === "undefined" ? null : __BANG_SHARD_ROUTER__;
const BANG_SHARD_ASSETS =
  typeof __BANG_SHARD_ASSETS__ === "undefined" ? [] : __BANG_SHARD_ASSETS__;
const BANG_INDEX_ASSETS =
  typeof __BANG_INDEX_ASSETS__ === "undefined" ? [] : __BANG_INDEX_ASSETS__;
const BANG_INDEX_SHARDS_PER_ASSET =
  typeof __BANG_INDEX_SHARDS_PER_ASSET__ === "undefined"
    ? 1
    : __BANG_INDEX_SHARDS_PER_ASSET__;
const BANG_STORE_ASSETS =
  typeof __BANG_STORE_ASSETS__ === "undefined" ? [] : __BANG_STORE_ASSETS__;
const bangIndexAsset = (shardId: number): string =>
  BANG_INDEX_ASSETS[Math.floor(shardId / BANG_INDEX_SHARDS_PER_ASSET)];
const workerShardRuntime: BangShardRuntime | null =
  BANG_SHARD_ROUTER?.length && BANG_SHARD_ASSETS.length
    ? createBangShardRuntime(BANG_SHARD_ROUTER, BANG_SHARD_ASSETS)
    : null;
// The warm catalog. Index shards are fetched and decoded only when a query
// routes to them, so a worker that only ever sees a handful of bangs never
// materializes the rest of the catalog.
let bangStrings: BangStrings | null = null;
const workerIndexRuntime: BangShardRuntime | null =
  BANG_SHARD_ROUTER?.length && BANG_INDEX_ASSETS.length
    ? createBangIndexRuntime(
        BANG_SHARD_ROUTER,
        BANG_INDEX_ASSETS,
        BANG_INDEX_SHARDS_PER_ASSET,
        () => bangStrings,
        loadCatalogAsset
      )
    : null;
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
let bangStringReloadPromise: Promise<void> | null = null;
let runtimeWarmPromise: Promise<void> | null = null;
const catalogCachePromises = new Map<string, Promise<void>>();
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
let coldRedirectSettings: RedirectSettings | null = null;
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
    const catalogReady = bangDataReady ?? ensureBangData();
    const preparedForCatalog = (
      prepared ?? prepareRedirectSettings(BANG_DATA_ASSET)
    ).then(async (value) => {
      if (!value.settings) {
        await catalogReady;
      }
      const defaultTrigger = value.snapshot.defaultBang;
      if (
        !value.settings &&
        bangStrings &&
        workerIndexRuntime &&
        !value.snapshot.custom[defaultTrigger]
      ) {
        await ensureRuntimeShard(
          workerIndexRuntime,
          bangShardIndex(hashFNV1a(defaultTrigger), BANG_SHARD_ROUTER!)
        );
        configureBangFallbackLookup(workerIndexRuntime.lookup);
      }
      return value;
    });
    return readRedirectSettings(
      preparedForCatalog,
      BANG_DATA_ASSET,
      catalogReady
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
  coldRedirectSettings = null;
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
    if (includeSettings && workerCatalogReady() && !getCachedSettings()) {
      await readCurrentRedirectSettings();
    }
    return;
  }
  const prepared = await prepareRedirectSettings(BANG_DATA_ASSET);
  const snapshot = prepared.snapshot;
  const state = createHotBootState(snapshot);
  let settings: RedirectSettings | undefined;
  if (includeSettings && workerCatalogReady()) {
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
  coldRedirectSettings =
    settings ??
    (compactSettings ? { ...compactSettings, custom: snapshot.custom } : null);
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

/**
 * Load the global string store, then hand the catalog to the lazily-decoding
 * index runtime.
 *
 * The store is the only mandatory catalog download; individual index shards
 * follow on demand. When no index artifacts are configured (dev, tests) this
 * falls back to the monolithic catalog.
 */
async function loadBangData(): Promise<void> {
  if (workerIndexRuntime && BANG_STORE_ASSETS.length > 0) {
    try {
      const chunks = await Promise.all(
        BANG_STORE_ASSETS.map((asset) => loadCatalogAsset(asset))
      );
      bangStrings = createBangStrings(chunks);
      configureBangFallbackLookup(workerIndexRuntime.lookup);
      return;
    } catch (storeError) {
      // A worker update may activate while the client is offline with only the
      // previous monolithic catalog cached. Keep redirects working through that
      // transition; the next worker lifetime can adopt the v11 store.
      try {
        initializeBangData(await loadCatalogAsset(BANG_DATA_ASSET));
        return;
      } catch {
        throw storeError;
      }
    }
  }
  initializeBangData(await loadCatalogAsset(BANG_DATA_ASSET));
}

function workerCatalogReady(): boolean {
  return (
    isBangDataInitialized() ||
    (bangStrings !== null && workerIndexRuntime !== null)
  );
}

async function populateCatalogCache(
  asset: string,
  forceNetwork = false
): Promise<void> {
  const request = new Request(asset);
  const cache = await caches.open(CACHE_NAME);
  let response = forceNetwork ? undefined : await cache.match(request);
  if (!response) {
    if (!forceNetwork) {
      for (const cacheName of await caches.keys()) {
        if (cacheName === CACHE_NAME || !isManagedCache(cacheName)) {
          continue;
        }
        response = await (await caches.open(cacheName)).match(request);
        if (response) {
          break;
        }
      }
    }
    if (!response) {
      response = await fetch(
        forceNetwork ? new Request(asset, { cache: "reload" }) : request
      );
      if (!response.ok) {
        throw new Error(
          `Failed to load ${asset}: ${response.status} ${response.statusText}`
        );
      }
    }
    await cache.put(request, response);
  }
}

function ensureCatalogAssetCached(
  asset: string,
  forceNetwork = false
): Promise<void> {
  const existing = catalogCachePromises.get(asset);
  if (existing && !forceNetwork) {
    return existing;
  }
  let current: Promise<void>;
  const populate = () => populateCatalogCache(asset, forceNetwork);
  current = (
    existing ? existing.catch(swallowError).then(populate) : populate()
  ).finally(() => {
    if (catalogCachePromises.get(asset) === current) {
      catalogCachePromises.delete(asset);
    }
  });
  catalogCachePromises.set(asset, current);
  return current;
}

async function loadCatalogAsset(
  asset: string,
  forceNetwork = false
): Promise<ArrayBuffer> {
  const cache = await caches.open(CACHE_NAME);
  if (!forceNetwork) {
    const cached = await cache.match(new Request(asset));
    if (cached) {
      return cached.arrayBuffer();
    }
  }
  await ensureCatalogAssetCached(asset, forceNetwork);
  const response = await cache.match(new Request(asset));
  if (!response) {
    throw new Error(`Catalog asset disappeared from cache: ${asset}`);
  }
  return response.arrayBuffer();
}

function ensureBangData(): Promise<void> {
  if (workerCatalogReady()) {
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
  if (workerCatalogReady() && getCachedSettings()) {
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
      // Offline coverage is deliberately last: settings become executable
      // before background catalog transfer begins, and decoding remains lazy.
      if (workerIndexRuntime) {
        await warmAllCatalogShards().catch(swallowError);
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

// Pull every index shard into Cache Storage so the catalog resolves offline.
// Fetch-only and run once after a response has been sent: nothing is decoded,
// so the redirect path pays no CPU and per-shard decode stays lazy.
let catalogWarmPromise: Promise<void> | null = null;
function warmAllCatalogShards(): Promise<void> {
  if (!catalogWarmPromise) {
    catalogWarmPromise = (async () => {
      // warmRuntime calls this only after the executable settings state and
      // hot-boot metadata are durable. The ordering is dependency-based rather
      // than timed, so it is identical across machines and browsers.
      const priorityPackIds = HOT_TRIGGERS.map((trigger) =>
        Math.floor(
          bangShardIndex(hashFNV1a(trigger), BANG_SHARD_ROUTER!) /
            BANG_INDEX_SHARDS_PER_ASSET
        )
      );
      if (currentHotBoot?.defaultBang) {
        priorityPackIds.unshift(
          Math.floor(
            bangShardIndex(
              hashFNV1a(currentHotBoot.defaultBang),
              BANG_SHARD_ROUTER!
            ) / BANG_INDEX_SHARDS_PER_ASSET
          )
        );
      }
      const pending = [
        ...new Set([
          ...priorityPackIds.map((packId) => BANG_INDEX_ASSETS[packId]),
          ...BANG_INDEX_ASSETS,
        ]),
      ];
      let nextIndex = 0;
      const workers = Array.from(
        { length: Math.min(PRECACHE_CONCURRENCY, pending.length) },
        async () => {
          for (;;) {
            const asset = pending[nextIndex++];
            if (!asset) {
              return;
            }
            await ensureCatalogAssetCached(asset);
          }
        }
      );
      await Promise.all(workers);
    })().catch((error) => {
      catalogWarmPromise = null;
      throw error;
    });
  }
  return catalogWarmPromise;
}

// Defer work that must not run inside the fetch dispatch task. A response
// handed to FetchEvent.respondWith() only reaches the browser at the microtask
// checkpoint after every listener returns, and respondWith() queues its
// reaction after any microtask scheduled earlier from within the handler. Only
// a macrotask hop reliably lands after the redirect has been delivered.
function afterResponse(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function warmRuntimeAfterResponse(e: FetchEvent): void {
  e.waitUntil(afterResponse().then(warmRuntime));
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
  const warming = precacheAssets(CACHE_NAME, appAssets())
    .then(async () => {
      // Content-addressed catalog assets are copied from an older managed cache
      // before it is deleted. This preserves offline coverage across updates and
      // avoids issuing 43 nominal fetches for byte-identical index shards.
      if (workerIndexRuntime) {
        await ensureBangData();
        await warmAllCatalogShards();
      }
    })
    .then(() => deleteOldCaches(CACHE_NAME));
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

// Usage counting, the suggestion cookie, and hot-boot refreshes are all
// write-behind: none of them feed the redirect being served. loadFrecency()
// runs into an IndexedDB open on the first redirect of a worker lifetime, so it
// waits for the response to be delivered rather than running during dispatch.
function queueBangSideEffects(e: FetchEvent, trigger: string): void {
  e.waitUntil(
    afterResponse()
      .then(loadFrecency)
      .then(() => {
        const usage = trackBangUsage(trigger);
        const hotBootSync =
          usage.topMembershipChanged && workerCatalogReady()
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
  const hasRuntimeHandoff = caches
    .keys()
    .then((cacheNames) => cacheNames.includes(SEED_CACHE_NAME))
    .catch(() => false);
  const activation = queueHotBootMutation(async () => {
    await disableHotBoot();
    await publishHotBoot();
  })
    .catch(swallowError)
    .then(() => self.clients.claim());
  e.waitUntil(
    Promise.all([activation, hasRuntimeHandoff])
      .then(async ([, shouldWarm]) => {
        if (!shouldWarm) {
          return;
        }
        // Let the page initiate its redirect before the catalog competes for
        // bandwidth. waitUntil keeps this activation alive until it is cached.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        await warmRuntime();
        await caches.delete(SEED_CACHE_NAME);
      })
      .catch(swallowError)
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
  if (e.data?.type === "warm-runtime") {
    e.waitUntil(warmRuntime());
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
        bangDataReady: workerCatalogReady(),
        enabled:
          benchmarkState?.clientId === sourceId &&
          benchmarkState.token === token,
        navigationCount: benchmarkState?.navigationCount ?? 0,
        requestCount: benchmarkState?.requestCount ?? 0,
        token: benchmarkState?.token ?? null,
      });
    };
    if (enable && !workerCatalogReady()) {
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
    const resolve = (settings: RedirectSettings): string =>
      hasRawQuery
        ? redirectRawUrl(messageQuery, settings)
        : redirectUrl(messageQuery, settings);
    const reply = (url: string) => {
      if (e.ports[0]) {
        e.ports[0].postMessage(url);
      } else {
        (e.source as Client)?.postMessage(hasRawQuery ? url : { url });
      }
    };
    const cached = getCachedSettings();
    if (isBangDataInitialized()) {
      if (cached) {
        reply(resolve(cached));
      } else {
        e.waitUntil(readCurrentRedirectSettings().then(resolve).then(reply));
      }
    } else {
      const bangDataReady = ensureBangData();
      e.waitUntil(
        readCurrentRedirectSettings(undefined, bangDataReady)
          .then(async (settings) => {
            try {
              return resolve(settings);
            } catch (error) {
              if (
                !(
                  isBangDataUnavailable(error) ||
                  (workerIndexRuntime !== null &&
                    workerIndexRuntime.unavailableShardId(error) !== null)
                )
              ) {
                throw error;
              }
              await bangDataReady;
              if (bangStrings && workerIndexRuntime) {
                return runWithShardRuntime(workerIndexRuntime, () =>
                  resolve(settings)
                );
              }
              return resolve(settings);
            }
          })
          .then(reply)
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

function candidateBangShardIds(
  rawQuery: string,
  settings: RedirectSettings
): number[] {
  try {
    const query = decodeURIComponent(rawQuery.replaceAll("+", " "));
    const bangMarker = String.fromCharCode((settings.syntax?.[0] ?? 33) & 0xff);
    const snapMarker = String.fromCharCode((settings.syntax?.[1] ?? 64) & 0xff);
    return [
      ...new Set(
        extractBangShardTriggers(query, bangMarker, snapMarker)
          .filter(
            (trigger) =>
              !(settings.custom[trigger] || lookupGeneratedHotBang(trigger))
          )
          .map((trigger) =>
            bangShardIndex(hashFNV1a(trigger), BANG_SHARD_ROUTER!)
          )
      ),
    ];
  } catch {
    // The canonical parser remains authoritative for malformed input.
    return [];
  }
}

function reloadBangStringStore(): Promise<void> {
  if (!(workerIndexRuntime && BANG_STORE_ASSETS.length > 0)) {
    return Promise.reject(new Error("Bang string store is not configured"));
  }
  if (!bangStringReloadPromise) {
    let current: Promise<void>;
    current = Promise.all(
      BANG_STORE_ASSETS.map((asset) => loadCatalogAsset(asset, true))
    )
      .then((chunks) => {
        const replacement = createBangStrings(chunks);
        bangStrings = replacement;
        workerIndexRuntime.reset();
        configureBangFallbackLookup(workerIndexRuntime.lookup);
      })
      .finally(() => {
        if (bangStringReloadPromise === current) {
          bangStringReloadPromise = null;
        }
      });
    bangStringReloadPromise = current;
  }
  return bangStringReloadPromise;
}

async function ensureRuntimeShard(
  runtime: BangShardRuntime,
  shardId: number
): Promise<void> {
  try {
    await runtime.ensure(shardId);
  } catch (error) {
    if (!(runtime === workerIndexRuntime && isBangStringStoreStale(error))) {
      throw error;
    }
    // A stale pair can only be recovered by replacing both sides: otherwise a
    // poisoned response under either content-addressed URL would be reused.
    await reloadBangStringStore();
    await runtime.ensure(
      shardId,
      loadCatalogAsset(bangIndexAsset(shardId), true)
    );
  }
}

async function runWithShardRuntime<T>(
  runtime: BangShardRuntime,
  operation: () => T
): Promise<T> {
  for (let attempt = 0; attempt <= BANG_SHARD_COUNT; attempt++) {
    // The fallback lookup is shared by the redirect core. Re-publish it after
    // every await so concurrent cold and warm requests cannot leave the other
    // runtime selected.
    configureBangFallbackLookup(runtime.lookup);
    try {
      return operation();
    } catch (error) {
      const shardId = runtime.unavailableShardId(error);
      if (shardId === null) {
        throw error;
      }
      await ensureRuntimeShard(runtime, shardId);
    }
  }
  throw new Error("Bang shard resolution exceeded the catalog shard count");
}

function respondFromShardRuntime(
  runtime: BangShardRuntime,
  e: FetchEvent,
  rawQuery: string,
  settings: RedirectSettings,
  hotBangLookup?: HotBangLookup | null
): Response | Promise<Response> {
  // The common warm path must stay synchronous. Generated hot bangs and
  // already-decoded shards can resolve without parsing the query a second time
  // or crossing an async boundary. Only predict and fetch candidate shards
  // after the authoritative lookup reports a genuine cache miss.
  configureBangFallbackLookup(runtime.lookup);
  try {
    return respondToRedirect(e, rawQuery, settings, hotBangLookup);
  } catch (error) {
    if (runtime.unavailableShardId(error) === null) {
      throw error;
    }
  }

  const shardIds = candidateBangShardIds(rawQuery, settings);
  const candidatesReady =
    shardIds.length === 0
      ? RESOLVED_PROMISE
      : Promise.all(
          shardIds.map((shardId) => ensureRuntimeShard(runtime, shardId))
        ).then(() => undefined);
  return candidatesReady.then(() =>
    runWithShardRuntime(runtime, () =>
      respondToRedirect(e, rawQuery, settings, hotBangLookup)
    )
  );
}

async function respondFromColdShard(
  e: FetchEvent,
  rawQuery: string,
  settings: RedirectSettings,
  hotBangLookup: HotBangLookup,
  bangDataReady: Promise<void>
): Promise<Response | null> {
  const runtime = workerShardRuntime;
  if (!runtime) {
    return null;
  }
  const shardIds = candidateBangShardIds(rawQuery, settings);
  if (shardIds.length > 0) {
    const candidateShardsReady = Promise.all(
      shardIds.map((shardId) => ensureRuntimeShard(runtime, shardId))
    ).then(() => true as const);
    try {
      const coldWon = await Promise.any([
        candidateShardsReady,
        bangDataReady.then(() => false as const),
      ]);
      if (!coldWon) {
        return null;
      }
    } catch {
      return null;
    }
  }
  try {
    return await runWithShardRuntime(runtime, () =>
      respondToRedirect(e, rawQuery, settings, hotBangLookup)
    );
  } catch (error) {
    if (isHotBangLookupBlocked(error)) {
      return null;
    }
    // The warm index runtime remains the authoritative fallback if a cold-shard
    // request fails or the lightweight parser misses an unusual syntax form.
    return null;
  }
}

function responseForQuery(
  e: FetchEvent,
  rawQuery: string,
  isNavigate: boolean
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
  if (bangStrings && workerIndexRuntime) {
    const cached = getCachedSettings();
    return cached
      ? respondFromShardRuntime(
          workerIndexRuntime,
          e,
          rawQuery,
          cached,
          lookupGeneratedHotBang
        )
      : readCurrentRedirectSettings().then((settings) =>
          respondFromShardRuntime(
            workerIndexRuntime,
            e,
            rawQuery,
            settings,
            lookupGeneratedHotBang
          )
        );
  }
  return hotBootPromise.then((hotBoot) => {
    if (isNavigate) {
      const settings = hotBoot?.settings;
      try {
        if (settings) {
          const response = respondToRedirect(
            e,
            rawQuery,
            settings,
            hotBoot.hotBangLookup
          );
          warmRuntimeAfterResponse(e);
          return response;
        }
        if (hotBoot?.compactSettings) {
          const response = respondToCompactHotBang(e, rawQuery, hotBoot);
          if (response) {
            warmRuntimeAfterResponse(e);
            return response;
          }
        }
      } catch (error) {
        if (
          !(
            isBangDataUnavailable(error) ||
            isHotBangLookupBlocked(error) ||
            (workerIndexRuntime !== null &&
              workerIndexRuntime.unavailableShardId(error) !== null)
          )
        ) {
          throw error;
        }
      }
    }
    const bangDataReady = RESOLVED_PROMISE.then(() =>
      hotBootUpdateTokens.size > 0
        ? invalidateCache().then(ensureBangData)
        : ensureBangData()
    );
    e.waitUntil(bangDataReady.catch(swallowError));
    if (hotBootSettingsNeedPublish(currentHotBoot)) {
      e.waitUntil(
        bangDataReady
          .then(() => queueHotBootMutation(() => publishHotBoot(true)))
          .catch(swallowError)
      );
    }
    const resolveWithFullCatalog = () =>
      readCurrentRedirectSettings(undefined, bangDataReady).then(
        async (settings) => {
          const hotLookup = hotBoot?.hotBangLookup ?? lookupGeneratedHotBang;
          try {
            return respondToRedirect(e, rawQuery, settings, hotLookup);
          } catch (error) {
            if (
              !(
                isBangDataUnavailable(error) ||
                (workerIndexRuntime !== null &&
                  workerIndexRuntime.unavailableShardId(error) !== null)
              )
            ) {
              throw error;
            }
            await bangDataReady;
            if (bangStrings && workerIndexRuntime) {
              return respondFromShardRuntime(
                workerIndexRuntime,
                e,
                rawQuery,
                settings,
                hotLookup
              );
            }
            return respondToRedirect(e, rawQuery, settings, hotLookup);
          }
        }
      );
    const coldSettings = hotBoot?.settings ?? coldRedirectSettings;
    if (isNavigate && coldSettings && workerShardRuntime) {
      return respondFromColdShard(
        e,
        rawQuery,
        coldSettings,
        hotBoot?.hotBangLookup ?? lookupGeneratedHotBang,
        bangDataReady
      ).then((response) => response ?? resolveWithFullCatalog());
    }
    return resolveWithFullCatalog();
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
  // Request accessors cross into the host on every read, so the two the
  // redirect path needs are pulled once instead of per branch.
  const request = e.request;
  const raw = request.url;

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

  const isNavigate = request.mode === "navigate";

  if (isNavigate) {
    const privateQuery = rawPrivateQuery(raw);
    if (privateQuery !== null) {
      if (!privateQuery) {
        e.respondWith(refreshHome());
        return;
      }
      e.respondWith(
        Promise.resolve(responseForQuery(e, privateQuery, isNavigate)).then(
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
      if (isNavigate && benchmarkState?.token === benchmarkToken) {
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
      e.respondWith(responseForQuery(e, rawQ, isNavigate));
      return;
    }
  }

  if (isNavigate && (raw === ROOT_URL || raw === INDEX_URL)) {
    e.respondWith(Response.redirect(`${APP_ORIGIN}/home`, 302));
    return;
  }

  if (isAppPath(raw, "/health")) {
    return;
  }

  // Private redirects should not install or compete with UI assets.
  if (!(workerCatalogReady() && getCachedSettings())) {
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
    e.respondWith(cacheOnUse(request));
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
      .match(request)
      .then(
        (r) =>
          r ||
          fetch(request).catch(() => new Response("Offline", { status: 503 }))
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
  bangStringReloadPromise = null;
  runtimeWarmPromise = null;
  catalogWarmPromise = null;
  catalogCachePromises.clear();
  benchmarkState = null;
  hotBootAvailable = currentNavigationPreload() !== undefined;
  hotBootGeneration = 0;
  currentHotBoot = null;
  coldRedirectSettings = null;
  hotBootPromise = readInitialHotBoot();
  hotBootMutation = RESOLVED_PROMISE;
  hotBootUpdateTokens.clear();
  bangStrings = null;
  workerShardRuntime?.reset();
  workerIndexRuntime?.reset();
}

registerServiceWorker();
