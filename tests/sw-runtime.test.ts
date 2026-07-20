import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
let fetchCalls: string[] = [];
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

function setupSwGlobals(requiredAppAssets: readonly string[] = []) {
  handlers = {};
  skipWaitingCalls = 0;
  claimCalls = 0;
  cacheDeleteCalls = [];
  fetchCalls = [];
  fetchImpl = () => Promise.resolve(new Response("ok"));

  const globals = globalThis as unknown as Record<string, unknown>;
  globals.__BANG_DATA_ASSET__ = "/bangs.bin";
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
  };

  (globalThis as unknown as { caches: unknown }).caches = {
    delete(name: string) {
      cacheDeleteCalls.push(name);
      return Promise.resolve(true);
    },
    keys() {
      return Promise.resolve([
        "fb-old-cache",
        "fb-test-cache",
        "flashbang-dev",
        "other-cache",
      ]);
    },
    match() {
      return Promise.resolve(null);
    },
    open() {
      return Promise.resolve({
        put() {
          // no-op
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
  reply?: (message: unknown) => void
) {
  const waits: Promise<unknown>[] = [];
  return {
    waits,
    event: {
      data,
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

async function loadSwRuntime(requiredAppAssets: readonly string[] = []) {
  setupSwGlobals(requiredAppAssets);
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
    const swIdb = await import("../src/sw/idb");
    expect(swIdb.getTopFrecencyRecord()).toEqual({ g: 2 });
    expect(cacheDeleteCalls).toEqual(["fb-old-cache", "flashbang-dev"]);
    expect(cacheDeleteCalls).not.toContain("other-cache");

    const fetchEvt = createFetchEvent("https://flashbang.local/home");
    await handlers.fetch?.(fetchEvt.event);
    await Promise.all(fetchEvt.waits);
    await fetchEvt.response();
    expect([...new Set(fetchCalls)].toSorted()).toEqual([
      "/app.js",
      "/bench",
      "/bench.js",
      "/chunk-catalog123.js",
      "/fallback.js",
      "/home",
      "/icon.svg",
      "/manifest.json",
    ]);
  });

  test("serves the root bootstrap from memory without starting precache", async () => {
    await loadSwRuntime(["/chunk-catalog123.js"]);

    const fetchEvt = createFetchEvent("https://flashbang.local/");
    await handlers.fetch?.(fetchEvt.event);
    const response = await fetchEvt.response();

    expect(await response.text()).toContain("flashbang bootstrap");
    expect(response.headers.get("Content-Type")).toBe(
      "text/html; charset=utf-8"
    );
    expect(fetchEvt.waits).toHaveLength(0);
    expect(fetchCalls).toEqual([]);
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
});
