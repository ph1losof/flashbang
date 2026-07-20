import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { REDIRECT_SETTINGS_SNAPSHOT_KEY } from "../src/shared/constants";
import { redirectUrl } from "../src/sw/redirect";
import type { RedirectSettingsSnapshot } from "../src/sw/redirect-settings";
import { loadTestBangData } from "./helpers/bang-data";
import { installFakeIndexedDb, reqToPromise } from "./helpers/fake-indexeddb";

await loadTestBangData();

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

  test("precompiles distinct bang and snap prefixes while loading settings", async () => {
    await seedDb({
      settings: [
        { key: "bang-prefix", value: "$" },
        { key: "snap-prefix", value: "~" },
      ],
    });

    const settings = await (await loadSwIdb()).readRedirectSettings();
    expect(settings.syntax).toBeDefined();
    expect(redirectUrl("$g cats", settings)).toContain(
      "google.com/search?q=cats"
    );
    expect(redirectUrl("~g cats", settings)).toContain(
      "google.com/search?q=cats+site:google.com"
    );
    expect(redirectUrl("!g cats", settings)).toContain("q=!g+cats");
    expect(redirectUrl("@g cats", settings)).toContain("q=@g+cats");
  });

  test("falls back to default syntax for equal persisted prefixes", async () => {
    await seedDb({
      settings: [
        { key: "bang-prefix", value: "$" },
        { key: "snap-prefix", value: "$" },
      ],
    });

    const settings = await (await loadSwIdb()).readRedirectSettings();
    expect(settings.syntax).toBeUndefined();
    expect(redirectUrl("!g cats", settings)).toContain(
      "google.com/search?q=cats"
    );
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
    let attempts = 0;
    (globalThis as { indexedDB?: unknown }).indexedDB = {
      open() {
        attempts++;
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
    expect(attempts).toBe(1);
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

  test("reuses the compiled snapshot without the source records", async () => {
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
    const mod = await loadSwIdb();
    const first = await mod.readRedirectSettings();
    expect(first.custom.translate?.[3]).toBeInstanceOf(RegExp);

    const shared = await loadSharedIdb();
    const db = await shared.openDB();
    const tx = db.transaction(["settings", "custom-bangs"], "readwrite");
    await Promise.all([
      reqToPromise(tx.objectStore("settings").delete("default-bang")),
      reqToPromise(tx.objectStore("custom-bangs").clear()),
    ]);
    const restarted = await import(
      `../src/sw/idb.ts?restart=${Date.now()}-${Math.random()}`
    );
    const cached = await restarted.readRedirectSettings();
    expect(cached.custom.translate?.[3]).toBeInstanceOf(RegExp);
    expect(redirectUrl("!translate french bonjour monde", cached)).toBe(
      "https://translate.example/french/bonjour%20monde"
    );
  });

  test("rebuilds an obsolete snapshot from existing user settings", async () => {
    await seedDb({
      settings: [{ key: "default-bang", value: "ddg" }],
    });
    const shared = await loadSharedIdb();
    const db = await shared.openDB();
    await reqToPromise(
      db.transaction("settings", "readwrite").objectStore("settings").put({
        key: REDIRECT_SETTINGS_SNAPSHOT_KEY,
        snapshot: {},
        version: 0,
      })
    );

    const settings = await (await loadSwIdb()).readRedirectSettings();
    expect(settings.defaultUrl[0]).toContain("duckduckgo.com");
    const rebuilt = await reqToPromise<{ version: number } | undefined>(
      db
        .transaction("settings", "readonly")
        .objectStore("settings")
        .get(REDIRECT_SETTINGS_SNAPSHOT_KEY)
    );
    expect(rebuilt?.version).toBe(1);
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

  test("waits for an in-flight settings load before invalidating", async () => {
    let resolvePrepared!: (snapshot: RedirectSettingsSnapshot) => void;
    const prepared = new Promise<RedirectSettingsSnapshot>((resolve) => {
      resolvePrepared = resolve;
    });
    const mod = await loadSwIdb();
    const staleLoad = mod.readRedirectSettings(prepared);

    await seedDb({
      customBangs: [
        { trigger: "mydocs", url: "https://docs.example/search?q={}" },
      ],
    });
    const invalidation = mod.invalidateCache();
    let invalidated = false;
    void invalidation.then(() => {
      invalidated = true;
    });
    await Promise.resolve();
    expect(invalidated).toBe(false);

    resolvePrepared({
      custom: Object.create(null),
      defaultBang: "g",
      luckyProvider: "default",
      luckyUrl: null,
    });
    await Promise.all([staleLoad, invalidation]);

    const settings = await mod.readRedirectSettings();
    expect(settings.custom.mydocs).toEqual([
      "https://docs.example/search?q=",
      "",
    ]);
  });
});

describe("sw/idb frecency", () => {
  test("hydrates frecency alongside the redirect settings snapshot", async () => {
    await seedDb({
      settings: [{ key: "frecency", value: `${Date.now()}|g:5,ddg:2` }],
    });

    const mod = await loadSwIdb();
    await mod.readRedirectSettings();

    expect(mod.getTopFrecencyRecord()).toEqual({ g: 5, ddg: 2 });
  });

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

    const firstYt = mod.trackBangUsage("yt");
    const secondYt = mod.trackBangUsage("yt");
    const firstG = mod.trackBangUsage("g");
    expect(firstYt.topMembershipChanged).toBe(true);
    expect(secondYt.topMembershipChanged).toBe(false);
    expect(firstG.topMembershipChanged).toBe(true);
    expect(mod.getTopFrecencyRecord()).toEqual({ yt: 2, g: 1 });

    mod.invalidateCache();
    expect(mod.getTopFrecencyRecord()).toEqual({ yt: 2, g: 1 });

    mod.trackBangUsage("yt");
    expect(mod.getTopFrecencyRecord()).toEqual({ yt: 3, g: 1 });
  });

  test("coalesces usage updates through the final committed snapshot", async () => {
    await seedDb({
      settings: [{ key: "frecency", value: `${Date.now()}|g:1` }],
    });
    const mod = await loadSwIdb();
    await mod.readRedirectSettings();

    const first = mod.trackBangUsage("yt");
    const second = mod.trackBangUsage("yt");
    const third = mod.trackBangUsage("yt");
    expect(first.persistence).toBe(second.persistence);
    expect(second.persistence).toBe(third.persistence);
    await third.persistence;

    const shared = await loadSharedIdb();
    const db = await shared.openDB();
    const record = await reqToPromise<{ value: string } | undefined>(
      db
        .transaction("settings", "readonly")
        .objectStore("settings")
        .get("frecency")
    );
    expect(record?.value).toContain("g:1");
    expect(record?.value).toContain("yt:3");
  });

  test("bounds in-memory and persisted frecency during a worker lifetime", async () => {
    await seedDb({
      settings: [{ key: "frecency", value: `${Date.now()}|` }],
    });
    const mod = await loadSwIdb();
    await mod.readRedirectSettings();

    let persistence = Promise.resolve();
    for (let i = 0; i < 80; i++) {
      persistence = mod.trackBangUsage(`trigger-${i}`).persistence;
    }
    await persistence;

    const shared = await loadSharedIdb();
    const db = await shared.openDB();
    const record = await reqToPromise<{ value: string } | undefined>(
      db
        .transaction("settings", "readonly")
        .objectStore("settings")
        .get("frecency")
    );
    const entries = record?.value.split("|")[1]?.split(",").filter(Boolean);
    expect(entries).toHaveLength(64);
  });
});

describe("shared IndexedDB recovery", () => {
  test("retries after a failed database open", async () => {
    const shared = await loadSharedIdb();
    shared.resetDB();
    const working = indexedDB;
    let attempts = 0;
    (globalThis as { indexedDB: IDBFactory }).indexedDB = {
      open(...args: Parameters<IDBFactory["open"]>) {
        attempts++;
        if (attempts === 1) {
          throw new Error("temporary open failure");
        }
        return working.open(...args);
      },
    } as IDBFactory;

    await expect(shared.openDB()).rejects.toThrow("temporary open failure");
    expect(await shared.openDB()).toBeDefined();
    expect(attempts).toBe(2);
  });
});
