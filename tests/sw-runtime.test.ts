import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { REDIRECT_SETTINGS_SNAPSHOT_KEY } from "../src/shared/constants";
import {
  getHotBootSettings,
  HOT_BOOT_SENTINEL,
  parseHotBootRecord,
  resolveHotRedirect,
} from "../src/sw/hot-redirect";
import { redirectRawUrl } from "../src/sw/redirect";
import { loadTestBangData } from "./helpers/bang-data";
import { installFakeIndexedDb, reqToPromise } from "./helpers/fake-indexeddb";

type SwHandler = (event: unknown) => Promise<void> | void;
type HandlerMap = Partial<
  Record<"activate" | "fetch" | "install" | "message", SwHandler>
>;

const ORIGINAL_REQUEST = Request;

let restoreIndexedDb: (() => void) | null = null;
let handlers: HandlerMap = {};
let skipWaitingCalls = 0;
let claimCalls = 0;
let cacheDeleteCalls: string[] = [];
let cachePutCalls: string[] = [];
let cacheEntries = new Map<string, Map<string, Response>>();
let fetchCalls: string[] = [];
let navigationPreloadWrites: string[] = [];
let fetchImpl: (input: RequestInfo | URL) => Promise<Response> = () =>
  Promise.resolve(new Response("ok"));

function loadSharedIdb() {
  return import("../src/shared/idb");
}

async function seedDb(data: {
  customBangs?: Array<{ trigger: string; url: string }>;
  settings?: Array<{ key: string; value: string }>;
}) {
  const shared = await loadSharedIdb();
  shared.resetDB();
  const db = await shared.openDB();
  const tx = db.transaction(["settings", "custom-bangs"], "readwrite");
  const settingsStore = tx.objectStore("settings");
  const customStore = tx.objectStore("custom-bangs");
  await reqToPromise(settingsStore.delete(REDIRECT_SETTINGS_SNAPSHOT_KEY));

  if (data.settings) {
    for (const row of data.settings) {
      await reqToPromise(settingsStore.put(row));
    }
  }
  if (data.customBangs) {
    for (const row of data.customBangs) {
      await reqToPromise(customStore.put(row));
    }
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return new URL(input, "https://flashbang.local").href;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function setupSwGlobals(
  requiredAppAssets: readonly string[] = [],
  preserveCaches = false,
  navigationPreloadState?: NavigationPreloadState
) {
  handlers = {};
  skipWaitingCalls = 0;
  claimCalls = 0;
  cacheDeleteCalls = [];
  cachePutCalls = [];
  fetchCalls = [];
  navigationPreloadWrites = [];
  fetchImpl = () => Promise.resolve(new Response("ok"));
  if (!preserveCaches) {
    cacheEntries = new Map([
      ["fb-old-cache", new Map()],
      ["fb-test-cache", new Map()],
      ["flashbang-dev", new Map()],
      ["other-cache", new Map()],
    ]);
  }

  const globals = globalThis as unknown as Record<string, unknown>;
  globals.__BANG_DATA_ASSET__ = "/bangs.bin";
  globals.__FALLBACK_ASSET__ = "/fallback.js";
  globals.__CACHE_VERSION__ = "test-cache";
  globals.__REQUIRED_APP_ASSETS__ = [...requiredAppAssets];
  globals.__CONTROLLED_HTML__ =
    "<!doctype html><title>flashbang bootstrap</title>";
  globals.__CONTROLLED_HEADERS__ = {
    "Content-Security-Policy": "default-src 'self'",
    "Content-Type": "text/html; charset=utf-8",
  };
  globals.__IS_DEV__ = false;

  (globalThis as unknown as { self: unknown }).self = {
    addEventListener(
      type: "activate" | "fetch" | "install" | "message",
      cb: SwHandler
    ) {
      handlers[type] = cb;
    },
    skipWaiting() {
      skipWaitingCalls++;
      return Promise.resolve();
    },
    clients: {
      claim() {
        claimCalls++;
        return Promise.resolve();
      },
    },
    location: new URL("https://flashbang.local/sw.js"),
    ...(navigationPreloadState
      ? {
          registration: {
            navigationPreload: {
              disable() {
                navigationPreloadState.enabled = false;
                return Promise.resolve();
              },
              getState() {
                return Promise.resolve({ ...navigationPreloadState });
              },
              setHeaderValue(value: string) {
                navigationPreloadState.headerValue = value;
                navigationPreloadWrites.push(value);
                return Promise.resolve();
              },
            },
          },
        }
      : {}),
  };

  (globalThis as unknown as { caches: unknown }).caches = {
    delete(name: string) {
      cacheDeleteCalls.push(name);
      return Promise.resolve(cacheEntries.delete(name));
    },
    keys() {
      return Promise.resolve([...cacheEntries.keys()]);
    },
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
      let entries = cacheEntries.get(name);
      if (!entries) {
        entries = new Map();
        cacheEntries.set(name, entries);
      }
      return Promise.resolve({
        match(request: RequestInfo | URL) {
          return Promise.resolve(entries.get(requestUrl(request))?.clone());
        },
        put(request: RequestInfo | URL, response: Response) {
          const url = requestUrl(request);
          cachePutCalls.push(new URL(url).pathname);
          entries.set(url, response.clone());
          return Promise.resolve();
        },
      });
    },
  };

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (input) => {
    const raw =
      typeof input === "string" || input instanceof URL ? input : input.url;
    fetchCalls.push(new URL(raw, "https://flashbang.local").pathname);
    return fetchImpl(input);
  };

  (globalThis as unknown as { Request: typeof Request }).Request =
    class extends ORIGINAL_REQUEST {
      constructor(input: string | URL | Request, init?: RequestInit) {
        if (typeof input === "string" && input.startsWith("/")) {
          super(`https://flashbang.local${input}`, init);
          return;
        }
        super(input, init);
      }
    };
}

function createExtendableEvent() {
  const waits: Promise<unknown>[] = [];
  return {
    waits,
    event: {
      waitUntil(promise: Promise<unknown>) {
        waits.push(Promise.resolve(promise));
      },
    } as unknown as ExtendableEvent,
  };
}

function createMessageEvent(
  data: unknown,
  source?: { id?: string; postMessage: (message: unknown) => void },
  reply?: (message: unknown) => void,
  origin = "https://flashbang.local"
) {
  const waits: Promise<unknown>[] = [];
  return {
    waits,
    event: {
      data,
      origin,
      ports: reply ? [{ postMessage: reply }] : [],
      source,
      waitUntil(promise: Promise<unknown>) {
        waits.push(Promise.resolve(promise));
      },
    } as unknown as ExtendableMessageEvent,
  };
}

function createFetchEvent(url: string, clientId = "", mode?: RequestMode) {
  const waits: Promise<unknown>[] = [];
  let responsePromise: Promise<Response> | null = null;
  const request = new Request(url);
  if (mode) {
    Object.defineProperty(request, "mode", { value: mode });
  }
  return {
    waits,
    event: {
      clientId,
      request,
      respondWith(response: Response | Promise<Response>) {
        responsePromise = Promise.resolve(response);
      },
      waitUntil(promise: Promise<unknown>) {
        waits.push(Promise.resolve(promise));
      },
    } as unknown as FetchEvent,
    response() {
      if (!responsePromise) {
        throw new Error("respondWith was not called");
      }
      return responsePromise;
    },
  };
}

async function loadSwRuntime(
  requiredAppAssets: readonly string[] = [],
  preserveCaches = false,
  navigationPreloadState?: NavigationPreloadState
) {
  setupSwGlobals(requiredAppAssets, preserveCaches, navigationPreloadState);
  await import(`../src/sw/sw.ts?test=${Date.now()}-${Math.random()}`);
}

beforeEach(async () => {
  await loadTestBangData();
  restoreIndexedDb = installFakeIndexedDb();
  const swIdb = await import("../src/sw/idb");
  swIdb.invalidateCache();
  await seedDb({
    settings: [
      { key: "default-bang", value: "g" },
      { key: "lucky-provider", value: "default" },
      { key: "frecency", value: `${Date.now()}|g:2` },
    ],
  });
});

afterEach(async () => {
  const shared = await loadSharedIdb();
  shared.resetDB();
  const swIdb = await import("../src/sw/idb");
  swIdb.invalidateCache();
  restoreIndexedDb?.();
  restoreIndexedDb = null;
  (globalThis as unknown as { Request: typeof Request }).Request =
    ORIGINAL_REQUEST;
  (globalThis as { cookieStore?: unknown }).cookieStore = undefined;
});

describe("sw runtime with real modules", () => {
  test("lifecycle defers app precaching and preserves unrelated caches", async () => {
    await loadSwRuntime(["/chunk-catalog123.js"]);
    expect(typeof handlers.install).toBe("function");
    expect(typeof handlers.activate).toBe("function");

    const installEvt = createExtendableEvent();
    await handlers.install?.(installEvt.event);
    await Promise.all(installEvt.waits);
    expect(skipWaitingCalls).toBe(1);
    expect(fetchCalls).toEqual([]);

    const activateEvt = createExtendableEvent();
    await handlers.activate?.(activateEvt.event);
    await Promise.all(activateEvt.waits);
    expect(claimCalls).toBe(1);
    expect(cacheDeleteCalls).toEqual([]);

    const fetchEvt = createFetchEvent("https://flashbang.local/home");
    await handlers.fetch?.(fetchEvt.event);
    await Promise.all(fetchEvt.waits);
    await fetchEvt.response();
    const swIdb = await import("../src/sw/idb");
    expect(swIdb.getTopFrecencyRecord()).toEqual({ g: 2 });
    expect([...new Set(fetchCalls)].toSorted()).toEqual([
      "/app.js",
      "/chunk-catalog123.js",
      "/fallback.js",
      "/home",
      "/icon.svg",
      "/manifest.json",
    ]);
    expect(cacheDeleteCalls).toEqual(["fb-old-cache", "flashbang-dev"]);
    expect(cacheDeleteCalls).not.toContain("other-cache");

    await loadSwRuntime(["/chunk-catalog123.js"], true);
    const restartFetchEvt = createFetchEvent("https://flashbang.local/home");
    await handlers.fetch?.(restartFetchEvt.event);
    await Promise.all(restartFetchEvt.waits);
    await restartFetchEvt.response();
    expect(fetchCalls).toEqual([]);
  });

  test("seeds bang data and redirect settings without a worker fetch", async () => {
    await loadSwRuntime();
    const bangData = await Bun.file("src/generated/bangs.bin").arrayBuffer();
    const foreignSeedEvt = createMessageEvent(
      {
        type: "seed-runtime",
        asset: "/bangs.bin",
        bangData,
        redirectSettings: {
          custom: Object.create(null),
          defaultUrl: ["https://foreign.example/?q=", ""],
          luckyUrl: null,
        },
      },
      undefined,
      undefined,
      "https://foreign.example"
    );
    await handlers.message?.(foreignSeedEvt.event);
    expect(foreignSeedEvt.waits).toHaveLength(0);
    expect(cachePutCalls).toEqual([]);

    const staleSeedEvt = createMessageEvent({
      type: "seed-runtime",
      asset: "/bangs-stale.bin",
      bangData,
      redirectSettings: {
        custom: Object.create(null),
        defaultUrl: ["https://stale.example/?q=", ""],
        luckyUrl: null,
      },
    });
    await handlers.message?.(staleSeedEvt.event);
    expect(staleSeedEvt.waits).toHaveLength(0);
    expect(cachePutCalls).toEqual([]);

    const seedEvt = createMessageEvent({
      type: "seed-runtime",
      asset: "/bangs.bin",
      bangData,
      redirectSettings: {
        custom: Object.create(null),
        defaultUrl: ["https://seeded.example/search?q=", ""],
        luckyUrl: null,
      },
    });

    await handlers.message?.(seedEvt.event);
    expect(seedEvt.waits).toHaveLength(1);
    await Promise.all(seedEvt.waits);
    expect(cachePutCalls).toContain("/bangs.bin");
    expect(fetchCalls).toEqual([]);

    const posted: unknown[] = [];
    const redirectEvt = createMessageEvent(
      { type: "redirect", query: "hello" },
      { postMessage: (message) => posted.push(message) }
    );
    await handlers.message?.(redirectEvt.event);
    expect(redirectEvt.waits).toHaveLength(0);
    expect((posted[0] as { url: string }).url).toBe(
      "https://seeded.example/search?q=hello"
    );
  });

  test("serves the root bootstrap from memory without starting precache", async () => {
    await loadSwRuntime(["/chunk-catalog123.js"]);

    const fetchEvt = createFetchEvent(
      "https://flashbang.local/",
      "",
      "navigate"
    );
    await handlers.fetch?.(fetchEvt.event);
    const response = await fetchEvt.response();

    expect(await response.text()).toContain("flashbang bootstrap");
    expect(response.headers.get("Content-Type")).toBe(
      "text/html; charset=utf-8"
    );
    expect(fetchEvt.waits).toHaveLength(0);
    expect(fetchCalls).toEqual([]);
  });

  test("only serves the root bootstrap for same-origin navigations", async () => {
    await loadSwRuntime();

    const crossOrigin = createFetchEvent(
      "https://example.com/",
      "",
      "navigate"
    );
    await handlers.fetch?.(crossOrigin.event);
    await Promise.all(crossOrigin.waits);
    const response = await crossOrigin.response();
    expect(await response.text()).toBe("ok");
  });

  test("lets health checks pass through without warming or precaching", async () => {
    await loadSwRuntime(["/chunk-catalog123.js"]);

    const health = createFetchEvent("https://flashbang.local/health");
    await handlers.fetch?.(health.event);
    expect(health.waits).toHaveLength(0);
    expect(fetchCalls).toEqual([]);
  });

  test("shares one runtime warm operation across concurrent asset requests", async () => {
    await loadSwRuntime();

    const first = createFetchEvent("https://flashbang.local/app.js");
    const second = createFetchEvent("https://flashbang.local/icon.svg");
    await handlers.fetch?.(first.event);
    await handlers.fetch?.(second.event);

    expect(first.waits[0]).toBe(second.waits[0]);
    await Promise.all([...first.waits, ...second.waits]);
    await Promise.all([first.response(), second.response()]);
  });

  test("does not block installation when deferred app precaching fails", async () => {
    await loadSwRuntime(["/chunk-catalog123.js"]);
    fetchImpl = (input) => {
      const raw =
        typeof input === "string" || input instanceof URL ? input : input.url;
      return new URL(raw, "https://flashbang.local").pathname ===
        "/chunk-catalog123.js"
        ? Promise.reject(new Error("offline"))
        : Promise.resolve(new Response("ok"));
    };

    const installEvt = createExtendableEvent();
    await handlers.install?.(installEvt.event);
    await Promise.all(installEvt.waits);
    expect(skipWaitingCalls).toBe(1);
    expect(fetchCalls).toEqual([]);

    const fetchEvt = createFetchEvent("https://flashbang.local/home");
    await handlers.fetch?.(fetchEvt.event);
    await Promise.all(fetchEvt.waits);
    await fetchEvt.response();
    expect(fetchCalls).toContain("/chunk-catalog123.js");
    expect(cacheDeleteCalls).toEqual([]);

    fetchImpl = () => Promise.resolve(new Response("ok"));
    const retryEvt = createFetchEvent("https://flashbang.local/home");
    await handlers.fetch?.(retryEvt.event);
    await Promise.all(retryEvt.waits);
    await retryEvt.response();
    expect(
      fetchCalls.filter((path) => path === "/chunk-catalog123.js")
    ).toHaveLength(2);
    expect(cacheDeleteCalls).toEqual(["fb-old-cache", "flashbang-dev"]);
  });

  test("message redirect and invalidate paths work end-to-end", async () => {
    await loadSwRuntime();
    expect(typeof handlers.message).toBe("function");

    const posted: unknown[] = [];
    const redirectEvt = createMessageEvent(
      { type: "redirect", query: "hello" },
      {
        postMessage(message: unknown) {
          posted.push(message);
        },
      }
    );
    await handlers.message?.(redirectEvt.event);
    expect(redirectEvt.waits).toHaveLength(1);
    await Promise.all(redirectEvt.waits);
    expect(String((posted[0] as { url: string }).url)).toContain("google.com");

    const portReplies: unknown[] = [];
    const portRedirectEvt = createMessageEvent(
      { type: "redirect", rawQuery: "%21g%20hello" },
      undefined,
      (message) => portReplies.push(message)
    );
    await handlers.message?.(portRedirectEvt.event);
    expect(String(portReplies[0])).toContain("google.com");

    const rawPosted: unknown[] = [];
    await handlers.message?.(
      createMessageEvent(
        { type: "redirect", rawQuery: "%21g%20hello" },
        { postMessage: (message) => rawPosted.push(message) }
      ).event
    );
    expect(typeof rawPosted[0]).toBe("string");
    expect(String(rawPosted[0])).toContain("google.com");

    // Change default bang, invalidate cache, and verify redirect reflects new settings.
    await seedDb({ settings: [{ key: "default-bang", value: "ddg" }] });
    await handlers.message?.(createMessageEvent({ type: "invalidate" }).event);

    const postedAfterInvalidate: unknown[] = [];
    const redirectEvt2 = createMessageEvent(
      { type: "redirect", query: "hello" },
      {
        postMessage(message: unknown) {
          postedAfterInvalidate.push(message);
        },
      }
    );
    await handlers.message?.(redirectEvt2.event);
    expect(redirectEvt2.waits).toHaveLength(1);
    await Promise.all(redirectEvt2.waits);
    expect(String((postedAfterInvalidate[0] as { url: string }).url)).toContain(
      "duckduckgo.com"
    );
  });

  test("publishes and safely updates registration hot-boot metadata", async () => {
    await seedDb({
      settings: [
        { key: "bang-prefix", value: ";" },
        { key: "snap-prefix", value: "@" },
      ],
    });
    const state: NavigationPreloadState = {
      enabled: false,
      headerValue: "true",
    };
    await loadSwRuntime([], false, state);

    const activate = createExtendableEvent();
    await handlers.activate?.(activate.event);
    await Promise.all(activate.waits);
    const initial = parseHotBootRecord(state.headerValue, "fb-test-cache");
    expect(initial).toBeGreaterThanOrEqual(0);
    expect(resolveHotRedirect(";gh+test", initial)).toContain("github.com");

    const token = "settings-write-1";
    const beginReplies: unknown[] = [];
    const begin = createMessageEvent(
      { type: "hot-boot-begin", token },
      undefined,
      (message) => beginReplies.push(message)
    );
    await handlers.message?.(begin.event);
    await Promise.all(begin.waits);
    expect(beginReplies).toEqual([true]);
    expect(state.headerValue).toBe(HOT_BOOT_SENTINEL);

    await seedDb({
      customBangs: [{ trigger: "gh", url: "https://custom.example/?q={}" }],
    });
    const endReplies: unknown[] = [];
    const end = createMessageEvent(
      { type: "hot-boot-end", token },
      undefined,
      (message) => endReplies.push(message)
    );
    await handlers.message?.(end.event);
    await Promise.all(end.waits);
    expect(endReplies).toEqual([true]);
    const updated = parseHotBootRecord(state.headerValue, "fb-test-cache");
    expect(resolveHotRedirect(";gh+test", updated)).toBeNull();
    expect(redirectRawUrl(";gh+test", getHotBootSettings()!)).toBe(
      "https://custom.example/?q=test"
    );
    expect(navigationPreloadWrites).toContain(HOT_BOOT_SENTINEL);
  });

  test("keeps hot-boot metadata disabled until concurrent writes finish", async () => {
    const state: NavigationPreloadState = {
      enabled: false,
      headerValue: "true",
    };
    await loadSwRuntime([], false, state);
    const activate = createExtendableEvent();
    await handlers.activate?.(activate.event);
    await Promise.all(activate.waits);

    for (const token of ["write-a", "write-b"]) {
      const begin = createMessageEvent(
        { type: "hot-boot-begin", token },
        undefined,
        () => undefined
      );
      await handlers.message?.(begin.event);
      await Promise.all(begin.waits);
    }
    expect(state.headerValue).toBe(HOT_BOOT_SENTINEL);

    const endA = createMessageEvent(
      { type: "hot-boot-end", token: "write-a" },
      undefined,
      () => undefined
    );
    await handlers.message?.(endA.event);
    await Promise.all(endA.waits);
    expect(state.headerValue).toBe(HOT_BOOT_SENTINEL);

    const endB = createMessageEvent(
      { type: "hot-boot-end", token: "write-b" },
      undefined,
      () => undefined
    );
    await handlers.message?.(endB.event);
    await Promise.all(endB.waits);
    expect(
      parseHotBootRecord(state.headerValue, "fb-test-cache")
    ).toBeGreaterThan(0);
  });

  test("fetch q= path redirects without deferred app precaching", async () => {
    await loadSwRuntime(["/chunk-catalog123.js"]);
    expect(typeof handlers.fetch).toBe("function");

    for (const url of [
      "https://flashbang.local/?q=hello",
      "https://flashbang.local/?foo=bar&q=hello",
    ]) {
      const fetchEvt = createFetchEvent(url);
      await handlers.fetch?.(fetchEvt.event);
      const response = await fetchEvt.response();
      expect(response.status).toBe(302);
      const location = response.headers.get("Location");
      expect(location).toContain("google.com");
      expect(new URL(location!).searchParams.get("q")).toBe("hello");
      expect(fetchEvt.waits).toHaveLength(0);
      expect(fetchCalls).toEqual([]);
    }
  });

  test("benchmark mode validates and counts client-scoped worker requests", async () => {
    await loadSwRuntime();
    const source = {
      id: "bench-client",
      postMessage() {
        /* Benchmark replies use the transferred message port. */
      },
    };
    const modeReplies: unknown[] = [];
    await handlers.message?.(
      createMessageEvent(
        { type: "benchmark-mode", enabled: true, token: "token" },
        source,
        (message) => modeReplies.push(message)
      ).event
    );
    expect(modeReplies).toEqual([
      {
        bangDataReady: true,
        enabled: true,
        navigationCount: 0,
        requestCount: 0,
        token: "token",
      },
    ]);

    const baseline = createFetchEvent(
      "https://flashbang.local/__flashbang-bench-noop",
      "bench-client"
    );
    await handlers.fetch?.(baseline.event);
    expect((await baseline.response()).status).toBe(204);

    const redirect = createFetchEvent(
      "https://flashbang.local/?q=!custom+kittens",
      "bench-client"
    );
    await handlers.fetch?.(redirect.event);
    expect((await redirect.response()).headers.get("Location")).toBe(
      "https://benchmark.example/search?q=kittens"
    );

    const navigation = createFetchEvent(
      "https://flashbang.local/?q=!custom+kittens&fb-bench=token&fb-seq=7",
      "popup-client",
      "navigate"
    );
    await handlers.fetch?.(navigation.event);
    expect((await navigation.response()).headers.get("Location")).toBe(
      "https://flashbang.local/__flashbang-bench-target?fb-bench=token&fb-seq=7"
    );

    const target = createFetchEvent(
      "https://flashbang.local/__flashbang-bench-target?fb-bench=token&fb-seq=7",
      "popup-client",
      "navigate"
    );
    await handlers.fetch?.(target.event);
    const targetResponse = await target.response();
    expect(targetResponse.status).toBe(200);
    await expect(targetResponse.text()).resolves.toContain(
      "flashbang-benchmark-navigation"
    );

    const countReplies: unknown[] = [];
    await handlers.message?.(
      createMessageEvent(
        { type: "benchmark-count", token: "token" },
        source,
        (message) => countReplies.push(message)
      ).event
    );
    expect(countReplies).toEqual([
      { active: true, navigationCount: 1, requestCount: 2 },
    ]);
  });

  test("bench route returns offline fallback with security headers", async () => {
    await loadSwRuntime();
    expect(typeof handlers.fetch).toBe("function");

    fetchImpl = (input) => {
      let url: string;
      if (typeof input === "string") {
        url = input;
      } else if (input instanceof URL) {
        url = input.pathname;
      } else {
        url = new URL(input.url).pathname;
      }
      if (url === "/bench") {
        return Promise.reject(new Error("offline"));
      }
      return Promise.resolve(new Response("ok"));
    };

    for (const path of ["/bench", "/bench.html"]) {
      const fetchEvt = createFetchEvent(`https://flashbang.local${path}`);
      await handlers.fetch?.(fetchEvt.event);
      const response = await fetchEvt.response();
      expect(response.status).toBe(503);
      expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe(
        "same-origin"
      );
      expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe(
        "credentialless"
      );
    }
  });

  test("caches benchmark assets only after they are requested", async () => {
    await loadSwRuntime();

    for (let i = 0; i < 2; i++) {
      const fetchEvt = createFetchEvent("https://flashbang.local/bench");
      await handlers.fetch?.(fetchEvt.event);
      await Promise.all(fetchEvt.waits);
      expect((await fetchEvt.response()).status).toBe(200);
    }

    expect(fetchCalls.filter((path) => path === "/bench")).toHaveLength(1);
    expect(cachePutCalls).toContain("/bench");
  });
});
