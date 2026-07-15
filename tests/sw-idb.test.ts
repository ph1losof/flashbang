import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { redirectUrl } from "../src/sw/redirect";
import { installFakeIndexedDb, reqToPromise } from "./helpers/fake-indexeddb";

let restoreIndexedDb: (() => void) | null = null;
let swIdbModule: typeof import("../src/sw/idb");

function loadSharedIdb() {
  return import("../src/shared/idb");
}

function loadSwIdb() {
  return Promise.resolve(swIdbModule);
}

async function seedDb(data: {
  customBangs?: Array<{
    trigger: string;
    url: string;
    regex?: string;
    encoding?: "percent" | "plus" | "raw";
    snap?: string;
  }>;
  settings?: Array<{ key: string; value: string }>;
}): Promise<void> {
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

beforeEach(async () => {
  restoreIndexedDb = installFakeIndexedDb();
  const shared = await loadSharedIdb();
  shared.resetDB();
  swIdbModule = await import(
    `../src/sw/idb.ts?test=${Date.now()}-${Math.random()}`
  );
});

afterEach(() => {
  restoreIndexedDb?.();
  restoreIndexedDb = null;
});

describe("sw/idb redirect settings", () => {
  test("reads default/lucky/custom settings from IndexedDB", async () => {
    await seedDb({
      settings: [
        { key: "default-bang", value: "ddg" },
        { key: "lucky-provider", value: "custom" },
        { key: "lucky-url", value: "https://lucky.example/?q={}" },
      ],
      customBangs: [
        { trigger: "mydocs", url: "https://docs.example/search?q={}" },
      ],
    });

    const mod = await loadSwIdb();
    const settings = await mod.readRedirectSettings();

    expect(settings.defaultUrl[0]).toContain("duckduckgo.com");
    expect(settings.luckyUrl).toEqual(["https://lucky.example/?q=", ""]);
    expect(settings.custom.mydocs).toEqual([
      "https://docs.example/search?q=",
      "",
    ]);
  });

  test("resolves a user custom bang as the default", async () => {
    await seedDb({
      settings: [{ key: "default-bang", value: "mydocs" }],
      customBangs: [
        {
          trigger: "mydocs",
          url: "https://docs.example/search?q={}&again={}",
        },
      ],
    });

    const settings = await (await loadSwIdb()).readRedirectSettings();
    expect(redirectUrl("query words", settings)).toBe(
      "https://docs.example/search?q=query+words&again=query+words"
    );
  });

  test("rejects a built-in capture bang as the default", async () => {
    await seedDb({
      settings: [{ key: "default-bang", value: "ktr" }],
    });

    const settings = await (await loadSwIdb()).readRedirectSettings();
    expect(redirectUrl("japanese hello world", settings)).toContain(
      "google.com/search?q=japanese+hello+world"
    );
    expect(settings.luckyUrl?.[0]).toContain("google.com/search?q=");
  });

  test("rejects a user capture bang as the default", async () => {
    await seedDb({
      settings: [{ key: "default-bang", value: "translate" }],
      customBangs: [
        {
          trigger: "translate",
          url: "https://translate.example/$1/$2",
          regex: "(\\w+)\\s+(.*)",
          encoding: "percent",
        },
      ],
    });

    const settings = await (await loadSwIdb()).readRedirectSettings();
    expect(redirectUrl("french bonjour monde", settings)).toContain(
      "google.com/search?q=french+bonjour+monde"
    );
    expect(settings.custom.translate?.[3]).toBeInstanceOf(RegExp);
  });

  test("does not expose a shadowed built-in as an advanced custom default", async () => {
    await seedDb({
      settings: [{ key: "default-bang", value: "g" }],
      customBangs: [
        {
          trigger: "g",
          url: "https://capture.example/$1",
          regex: "(.+)",
        },
      ],
    });

    const settings = await (await loadSwIdb()).readRedirectSettings();
    expect(redirectUrl("hello", settings)).toContain(
      "google.com/search?q=hello"
    );
    expect(settings.custom.g?.[3]).toBeInstanceOf(RegExp);
  });

  test("returns safe defaults when IndexedDB is unavailable", async () => {
    (globalThis as { indexedDB?: unknown }).indexedDB = {
      open() {
        throw new Error("boom");
      },
    };

    const shared = await loadSharedIdb();
    shared.resetDB();

    const mod = await loadSwIdb();
    const settings = await mod.readRedirectSettings();

    expect(settings.defaultUrl[0]).toContain("google.com/search?q=");
    expect(settings.luckyUrl?.[0]).toContain("duckduckgo.com/?q=");
    expect(settings.custom).toEqual(Object.create(null));
  });

  test("compiles custom capture bangs once while loading settings", async () => {
    await seedDb({
      customBangs: [
        {
          trigger: "translate",
          url: "https://translate.example/$1/$2",
          regex: "(\\w+)\\s+(.*)",
          encoding: "percent",
          snap: "translate.example/docs",
        },
      ],
    });

    const mod = await loadSwIdb();
    const settings = await mod.readRedirectSettings();
    expect(settings.custom.translate?.[3]).toBeInstanceOf(RegExp);
    expect(settings.custom.translate?.[2]).toEqual([1, 2]);
    expect(settings.custom.translate?.[5]).toEqual([
      "+site:translate.example/docs",
      "https://translate.example/docs",
    ]);
  });

  test("ignores invalid persisted capture patterns", async () => {
    await seedDb({
      customBangs: [
        {
          trigger: "unsafe",
          url: "https://example.com/$1",
          regex: "(a+)+$",
        },
      ],
    });

    const mod = await loadSwIdb();
    const settings = await mod.readRedirectSettings();
    expect(settings.custom.unsafe).toBeUndefined();
  });

  test("precompiles custom snap targets into the custom tuple", async () => {
    await seedDb({
      customBangs: [
        {
          trigger: "docs",
          url: "https://search.example.com?q={}",
          snap: "docs.example.com/reference",
        },
      ],
    });

    const mod = await loadSwIdb();
    const settings = await mod.readRedirectSettings();
    expect(settings.custom.docs).toEqual([
      "https://search.example.com?q=",
      "",
      [
        "+site:docs.example.com/reference",
        "https://docs.example.com/reference",
      ],
    ]);
  });

  test("falls back to DuckDuckGo lucky for an unmatched default bang", async () => {
    await seedDb({
      settings: [{ key: "default-bang", value: "w" }],
    });

    const mod = await loadSwIdb();
    const settings = await mod.readRedirectSettings();

    expect(settings.luckyUrl?.[0]).toContain("duckduckgo.com/?q=");
  });

  test("matches the google bang to Google lucky", async () => {
    await seedDb({
      settings: [{ key: "default-bang", value: "google" }],
    });

    const mod = await loadSwIdb();
    const settings = await mod.readRedirectSettings();

    expect(settings.luckyUrl).toEqual([
      "https://www.google.com/search?q=",
      "&btnI=1",
    ]);
  });
});

describe("sw/idb frecency", () => {
  test("loads compact frecency format and exposes top entries", async () => {
    await seedDb({
      settings: [{ key: "frecency", value: `${Date.now()}|g:5,ddg:2` }],
    });

    const mod = await loadSwIdb();
    await mod.loadFrecency();
    expect(mod.hasTopFrecency()).toBe(true);
    expect(mod.getTopFrecencyRecord()).toEqual({ g: 5, ddg: 2 });
  });

  test("settings invalidation preserves frecency and increments prior counts", async () => {
    await seedDb({
      settings: [{ key: "frecency", value: `${Date.now()}|` }],
    });

    const mod = await loadSwIdb();
    await mod.loadFrecency();

    mod.trackBangUsage("yt");
    mod.trackBangUsage("yt");
    mod.trackBangUsage("g");
    expect(mod.getTopFrecencyRecord()).toEqual({ yt: 2, g: 1 });

    mod.invalidateCache();
    expect(mod.getTopFrecencyRecord()).toEqual({ yt: 2, g: 1 });

    mod.trackBangUsage("yt");
    expect(mod.getTopFrecencyRecord()).toEqual({ yt: 3, g: 1 });
  });
});
