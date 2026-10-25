import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadStringIdMap } from "../scripts/bang-strings-build";
import { packBangIndexShards } from "../scripts/build";
import { generateCatalog } from "../scripts/codegen";
import { BANG_INDEX_SHARDS_PER_PACK } from "../src/shared/bang-binary-format";
import { bangShardIndex } from "../src/shared/bang-shards";
import { hashFNV1a } from "../src/shared/hash";
import {
  isBangDataInitialized,
  resetBangDataForTests,
} from "../src/sw/bang-data";
import { decodeHotBootRecord } from "../src/sw/hot-redirect";
import { installFakeIndexedDb } from "./helpers/fake-indexeddb";
import { TEST_BANG_SHARDS } from "./helpers/preload";
import { resetSharedDb, seedDb } from "./helpers/shared-db";

// Production workers resolve bangs through lazily decoded index packs over a
// global string store. Those globals are read once at module evaluation, so
// this suite loads its own worker instance with them defined; the
// monolithic-catalog worker in sw-runtime.test.ts never takes these paths.
const catalog = generateCatalog(
  await Bun.file("data/bangs.json").json(),
  loadStringIdMap()
);
const INDEX_PACKS = packBangIndexShards(catalog.index);
const INDEX_ASSETS = INDEX_PACKS.map(
  (_, pack) => `/bangs-ip${pack.toString(36)}-test.bin`
);
const STORE_ASSETS = ["/bangs-g-base-test.bin", "/bangs-g-tail-test.bin"];
const STORE_CHUNKS = [catalog.storeBase, catalog.storeTail];

const globals = globalThis as unknown as Record<string, unknown>;
globals.__BANG_INDEX_ASSETS__ = INDEX_ASSETS;
globals.__BANG_INDEX_SHARDS_PER_ASSET__ = BANG_INDEX_SHARDS_PER_PACK;
globals.__BANG_STORE_ASSETS__ = STORE_ASSETS;
globals.__CACHE_VERSION__ = "index-test";
// The query gives this suite a separate module instance; a plain specifier
// would share the worker other suites evaluated without these globals.
const INDEX_RUNTIME_WORKER = "../src/sw/sw.ts?index-runtime";
const sw: typeof import("../src/sw/sw") = await import(INDEX_RUNTIME_WORKER);
// Later suites evaluate their own worker; keep it on the monolithic catalog.
globals.__BANG_INDEX_ASSETS__ = undefined;
globals.__BANG_INDEX_SHARDS_PER_ASSET__ = undefined;
globals.__BANG_STORE_ASSETS__ = undefined;

const ORIGINAL_REQUEST = Request;
const ORIGIN = "https://flashbang.local";
const CACHE_NAME = "fb-index-test";

type Asset = (path: string, fetchCount: number) => Response | null;

let cacheEntries = new Map<string, Map<string, Response>>();
let fetchCalls: string[] = [];
let serveAsset: Asset = () => null;
let restoreIndexedDb: (() => void) | null = null;

function bytesResponse(bytes: Uint8Array): Response {
  return new Response(bytes.slice().buffer);
}

function staleStoreChunk(bytes: Uint8Array): Uint8Array {
  const copy = bytes.slice();
  const header = new Uint32Array(copy.buffer, 0, 3);
  header[2]++;
  return copy;
}

// App shell requests succeed; any catalog path without a fixture is a 404.
function catalogAsset(path: string): Response | null {
  const storeIndex = STORE_ASSETS.indexOf(path);
  if (storeIndex !== -1) {
    return bytesResponse(STORE_CHUNKS[storeIndex]);
  }
  const packIndex = INDEX_ASSETS.indexOf(path);
  if (packIndex !== -1) {
    return bytesResponse(INDEX_PACKS[packIndex]);
  }
  const shardMatch = /^\/bangs-s([0-9a-z]+)-test\.bin$/.exec(path);
  if (shardMatch) {
    return bytesResponse(TEST_BANG_SHARDS[Number.parseInt(shardMatch[1], 36)]);
  }
  return path.startsWith("/bangs") ? null : new Response("ok");
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return new URL(input, ORIGIN).href;
  }
  return input instanceof URL ? input.href : input.url;
}

function setupGlobals(navigationPreload?: NavigationPreloadState) {
  cacheEntries = new Map();
  fetchCalls = [];
  serveAsset = (path) => catalogAsset(path);
  globals.__BANG_DATA_ASSET__ = "/bangs.bin";
  globals.__REQUIRED_APP_ASSETS__ = [];

  (globalThis as unknown as { self: unknown }).self = {
    addEventListener() {
      /* handlers are invoked directly */
    },
    clients: { claim: () => Promise.resolve() },
    location: new URL(`${ORIGIN}/sw.js`),
    skipWaiting: () => Promise.resolve(),
    ...(navigationPreload
      ? {
          registration: {
            navigationPreload: {
              disable() {
                navigationPreload.enabled = false;
                return Promise.resolve();
              },
              getState: () => Promise.resolve({ ...navigationPreload }),
              setHeaderValue(value: string) {
                navigationPreload.headerValue = value;
                return Promise.resolve();
              },
            },
          },
        }
      : {}),
  };

  const openCache = (name: string) => {
    let entries = cacheEntries.get(name);
    if (!entries) {
      entries = new Map();
      cacheEntries.set(name, entries);
    }
    return entries;
  };
  (globalThis as unknown as { caches: unknown }).caches = {
    delete: (name: string) => Promise.resolve(cacheEntries.delete(name)),
    keys: () => Promise.resolve([...cacheEntries.keys()]),
    match(request: RequestInfo | URL) {
      const url = requestUrl(request);
      for (const entries of cacheEntries.values()) {
        const response = entries.get(url);
        if (response) {
          return Promise.resolve(response.clone());
        }
      }
      return Promise.resolve(undefined);
    },
    open(name: string) {
      const entries = openCache(name);
      return Promise.resolve({
        match: (request: RequestInfo | URL) =>
          Promise.resolve(entries.get(requestUrl(request))?.clone()),
        put(request: RequestInfo | URL, response: Response) {
          entries.set(requestUrl(request), response.clone());
          return Promise.resolve();
        },
      });
    },
  };

  (
    globalThis as unknown as {
      fetch: (input: RequestInfo | URL) => Promise<Response>;
    }
  ).fetch = (input) => {
    const path = new URL(requestUrl(input)).pathname;
    fetchCalls.push(path);
    const fetchCount = fetchCalls.filter((call) => call === path).length;
    return Promise.resolve(
      serveAsset(path, fetchCount) ?? new Response("missing", { status: 404 })
    );
  };

  (globalThis as unknown as { Request: typeof Request }).Request =
    class extends ORIGINAL_REQUEST {
      constructor(input: string | URL | Request, init?: RequestInit) {
        super(
          typeof input === "string" && input.startsWith("/")
            ? `${ORIGIN}${input}`
            : input,
          init
        );
      }
    };

  sw.resetSwStateForTests();
}

function messageEvent(data: unknown, reply?: (message: unknown) => void) {
  const waits: Promise<unknown>[] = [];
  return {
    event: {
      data,
      origin: ORIGIN,
      ports: reply ? [{ postMessage: reply }] : [],
      source: { id: "client-1", postMessage: reply },
      waitUntil(promise: Promise<unknown>) {
        waits.push(Promise.resolve(promise));
      },
    } as unknown as ExtendableMessageEvent,
    settled: () => Promise.all(waits),
  };
}

function fetchEvent(path: string, mode: RequestMode = "navigate") {
  const waits: Promise<unknown>[] = [];
  let response: Promise<Response> | null = null;
  const request = new Request(`${ORIGIN}${path}`);
  Object.defineProperty(request, "mode", { value: mode });
  return {
    event: {
      clientId: "",
      request,
      respondWith(value: Response | Promise<Response>) {
        response = Promise.resolve(value);
      },
      waitUntil(promise: Promise<unknown>) {
        waits.push(Promise.resolve(promise).catch(() => undefined));
      },
    } as unknown as FetchEvent,
    response() {
      if (!response) {
        throw new Error("respondWith was not called");
      }
      return response;
    },
    settled: () => Promise.all(waits),
  };
}

async function sendMessage(data: unknown): Promise<unknown[]> {
  const replies: unknown[] = [];
  const message = messageEvent(data, (reply) => replies.push(reply));
  sw.handleMessage(message.event);
  await message.settled();
  return replies;
}

async function redirectLocation(path: string): Promise<string | null> {
  const fetch = fetchEvent(path);
  sw.handleFetch(fetch.event);
  const response = await fetch.response();
  await fetch.settled();
  return response.headers.get("Location");
}

const indexFetches = () =>
  fetchCalls.filter((path) => path.startsWith("/bangs-ip"));
const storeFetches = () =>
  fetchCalls.filter((path) => path.startsWith("/bangs-g-"));

beforeEach(async () => {
  resetBangDataForTests();
  restoreIndexedDb = installFakeIndexedDb();
  const swIdb = await import("../src/sw/idb");
  swIdb.resetIdbStateForTests();
  await seedDb({
    settings: [
      { key: "default-bang", value: "g" },
      { key: "lucky-provider", value: "default" },
    ],
  });
  setupGlobals();
});

afterEach(async () => {
  await resetSharedDb();
  const swIdb = await import("../src/sw/idb");
  swIdb.resetIdbStateForTests();
  restoreIndexedDb?.();
  restoreIndexedDb = null;
  resetBangDataForTests();
  (globalThis as unknown as { Request: typeof Request }).Request =
    ORIGINAL_REQUEST;
});

describe("sw index runtime", () => {
  test("warming loads the string store and caches every index pack", async () => {
    await sendMessage({ type: "warm-runtime" });

    expect(storeFetches()).toEqual(STORE_ASSETS);
    expect(new Set(indexFetches())).toEqual(new Set(INDEX_ASSETS));
    expect(fetchCalls).not.toContain("/bangs.bin");
    expect(isBangDataInitialized()).toBe(false);
    for (const asset of INDEX_ASSETS) {
      expect(cacheEntries.get(CACHE_NAME)?.has(`${ORIGIN}${asset}`)).toBe(true);
    }

    // Warm settings take the synchronous index path; a miss decodes the
    // routed pack from cache instead of fetching it again.
    const fetchesBefore = fetchCalls.length;
    expect(await redirectLocation("/?q=!hn+coverage")).toContain(
      "hn.algolia.com"
    );
    expect(await redirectLocation("/?q=plain+query")).toContain(
      "google.com/search?q=plain"
    );
    expect(fetchCalls).toHaveLength(fetchesBefore);
  });

  test("warming prioritizes the hot-boot default bang pack", async () => {
    const state: NavigationPreloadState = {
      enabled: false,
      headerValue: "true",
    };
    setupGlobals(state);
    const activation = messageEvent(null);
    sw.handleActivate(activation.event);
    await activation.settled();
    expect(state.headerValue).not.toBe("true");

    await sendMessage({ type: "warm-runtime" });

    const defaultPack = Math.floor(
      bangShardIndex(hashFNV1a("g"), catalog.router) /
        BANG_INDEX_SHARDS_PER_PACK
    );
    expect(indexFetches()[0]).toBe(INDEX_ASSETS[defaultPack]);
    expect(new Set(indexFetches())).toEqual(new Set(INDEX_ASSETS));
    expect(await redirectLocation("/?q=!hn+coverage")).toContain(
      "hn.algolia.com"
    );
  });

  test("publishes frequent bangs whose index shards are not decoded yet", async () => {
    await seedDb({
      settings: [{ key: "frecency", value: `${Date.now()}|npm:3` }],
    });
    const state: NavigationPreloadState = {
      enabled: false,
      headerValue: "true",
    };
    setupGlobals(state);
    const activation = messageEvent(null);
    sw.handleActivate(activation.event);
    await activation.settled();

    await sendMessage({ type: "warm-runtime" });

    // Materializing the hot frecency entry must not abort warming: the
    // offline catalog still gets cached after the record is published.
    const record = decodeHotBootRecord(state.headerValue ?? "", CACHE_NAME);
    expect(record?.frecency?.npm?.[0]).toBe("https://www.npmjs.com/search?q=");
    expect(new Set(indexFetches())).toEqual(new Set(INDEX_ASSETS));
  });

  test("resolves a redirect after cached settings are invalidated", async () => {
    await sendMessage({ type: "warm-runtime" });
    const swIdb = await import("../src/sw/idb");
    swIdb.invalidateCache();

    expect(await redirectLocation("/?q=!hn+coverage")).toContain(
      "hn.algolia.com"
    );
  });

  test("a redirect message before the catalog loads resolves its shard", async () => {
    const replies = await sendMessage({
      type: "redirect",
      query: "!hn coverage",
    });

    expect(replies).toEqual([expect.stringContaining("hn.algolia.com")]);
    expect(storeFetches()).toEqual(STORE_ASSETS);
    expect(fetchCalls).not.toContain("/bangs.bin");
  });

  test("a cold fetch redirect resolves through the index runtime", async () => {
    // No hot-boot record is available, so the first navigation waits for the
    // string store and then decodes only the packs its query routes to.
    expect(await redirectLocation("/?q=!hn+coverage")).toContain(
      "hn.algolia.com"
    );
    expect(storeFetches()).toEqual(STORE_ASSETS);
  });

  test("reloads a stale string store before decoding an index pack", async () => {
    serveAsset = (path, fetchCount) => {
      const storeIndex = STORE_ASSETS.indexOf(path);
      if (storeIndex !== -1 && fetchCount === 1) {
        return bytesResponse(staleStoreChunk(STORE_CHUNKS[storeIndex]));
      }
      return catalogAsset(path);
    };

    const replies = await sendMessage({
      type: "redirect",
      query: "!hn coverage",
    });

    expect(replies).toEqual([expect.stringContaining("hn.algolia.com")]);
    expect(storeFetches()).toEqual([...STORE_ASSETS, ...STORE_ASSETS]);
  });

  test("falls back to the monolithic catalog when the store is unavailable", async () => {
    const bangData = await Bun.file("src/generated/bangs.bin").arrayBuffer();
    serveAsset = (path) => {
      if (STORE_ASSETS.includes(path)) {
        return null;
      }
      return path === "/bangs.bin"
        ? new Response(bangData)
        : catalogAsset(path);
    };

    const replies = await sendMessage({
      type: "redirect",
      query: "!hn coverage",
    });

    expect(replies).toEqual([expect.stringContaining("hn.algolia.com")]);
    expect(isBangDataInitialized()).toBe(true);
  });

  test("benchmark mode reports an unavailable catalog when every source fails", async () => {
    serveAsset = (path) =>
      path.startsWith("/bangs") ? null : catalogAsset(path);

    const replies = await sendMessage({
      type: "benchmark-mode",
      enabled: true,
      token: "bench-token",
    });

    expect(replies).toEqual([
      expect.objectContaining({ bangDataReady: false, enabled: true }),
    ]);
    expect(fetchCalls).toContain("/bangs.bin");
  });

  test("deferred precache copies index packs from an older managed cache", async () => {
    const previous = new Map<string, Response>();
    for (const [pack, asset] of INDEX_ASSETS.entries()) {
      previous.set(`${ORIGIN}${asset}`, bytesResponse(INDEX_PACKS[pack]));
    }
    cacheEntries.set("fb-previous", previous);

    const asset = fetchEvent("/app.js", "no-cors");
    sw.handleFetch(asset.event);
    await asset.response();
    await asset.settled();

    expect(indexFetches()).toEqual([]);
    expect(cacheEntries.has("fb-previous")).toBe(false);
    for (const indexAsset of INDEX_ASSETS) {
      expect(cacheEntries.get(CACHE_NAME)?.has(`${ORIGIN}${indexAsset}`)).toBe(
        true
      );
    }
  });
});
