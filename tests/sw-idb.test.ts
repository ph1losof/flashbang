import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { REDIRECT_SETTINGS_SNAPSHOT_KEY } from "../src/shared/constants";
import * as coveredSwIdb from "../src/sw/idb";
import {
  compileTriggerSyntax,
  type RedirectSettings,
  redirectUrl,
} from "../src/sw/redirect";
import type { PreparedRedirectSettings } from "../src/sw/redirect-settings";
import { loadTestBangData } from "./helpers/bang-data";
import { installFakeIndexedDb, reqToPromise } from "./helpers/fake-indexeddb";

await loadTestBangData();

let restoreIndexedDb: (() => void) | null = null;
const swIdbModule: typeof import("../src/sw/idb") = coveredSwIdb;

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
  swIdbModule.resetIdbStateForTests();
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

  test("keeps safe defaults for the worker lifetime when IndexedDB fails", async () => {
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
    const realNow = Date.now;
    let now = realNow();
    let settings: RedirectSettings;
    try {
      Date.now = () => now;
      settings = await mod.readRedirectSettings();
      now += 6_000;
      expect(await mod.readRedirectSettings()).toBe(settings);
    } finally {
      Date.now = realNow;
    }

    expect(settings.defaultUrl[0]).toContain("google.com/search?q=");
    expect(settings.luckyUrl?.[0]).toContain("duckduckgo.com/?q=");
    expect(settings.custom).toEqual(Object.create(null));
    expect(attempts).toBe(1);
  });

  test("uses explicitly seeded startup settings without opening IndexedDB", async () => {
    let attempts = 0;
    (globalThis as { indexedDB?: unknown }).indexedDB = {
      open() {
        attempts++;
        throw new Error("boom");
      },
    };
    const shared = await loadSharedIdb();
    shared.resetDB();
    const startupSettings: RedirectSettings = {
      custom: Object.create(null),
      defaultUrl: ["https://duckduckgo.com/?q=", ""],
      luckyUrl: null,
      syntax: compileTriggerSyntax("$", "~"),
    };

    const mod = await loadSwIdb();
    mod.seedRedirectSettings(startupSettings);
    const settings = await mod.readRedirectSettings();

    expect(settings).toBe(startupSettings);
    expect(attempts).toBe(0);
    expect(redirectUrl("plain query", settings)).toContain(
      "duckduckgo.com/?q=plain+query"
    );
    expect(redirectUrl("$g cats", settings)).toContain(
      "google.com/search?q=cats"
    );
    expect(redirectUrl("!g cats", settings)).toContain("q=!g+cats");
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
    const first = await mod.readRedirectSettings(
      undefined,
      "catalog-a",
      Promise.resolve()
    );
    await mod.waitForRedirectSettingsPersistence();
    expect(first.custom.translate?.[3]).toBeInstanceOf(RegExp);

    const shared = await loadSharedIdb();
    const db = await shared.openDB();
    const tx = db.transaction(["settings", "custom-bangs"], "readwrite");
    await Promise.all([
      reqToPromise(tx.objectStore("settings").delete("default-bang")),
      reqToPromise(tx.objectStore("custom-bangs").clear()),
    ]);
    coveredSwIdb.resetIdbStateForTests();
    const restarted = coveredSwIdb;
    const cached = await restarted.readRedirectSettings(
      undefined,
      "catalog-a",
      new Promise(() => undefined)
    );
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
    expect(rebuilt?.version).toBe(2);
  });

  test("rebuilds a bundle when the bang catalog changes", async () => {
    await seedDb({ settings: [{ key: "default-bang", value: "g" }] });
    const mod = await loadSwIdb();
    await mod.readRedirectSettings(undefined, "catalog-a", Promise.resolve());
    await mod.waitForRedirectSettingsPersistence();

    const shared = await loadSharedIdb();
    const db = await shared.openDB();
    await reqToPromise(
      db
        .transaction("settings", "readwrite")
        .objectStore("settings")
        .put({ key: "default-bang", value: "ddg" })
    );
    coveredSwIdb.resetIdbStateForTests();
    const restarted = coveredSwIdb;
    const rebuilt = await restarted.readRedirectSettings(
      undefined,
      "catalog-b",
      Promise.resolve()
    );
    expect(rebuilt.defaultUrl[0]).toContain("duckduckgo.com");
  });

  test("waits for bang data only when rebuilding a bundle", async () => {
    let releaseBangData!: () => void;
    const bangDataReady = new Promise<void>((resolve) => {
      releaseBangData = resolve;
    });
    const prepared: PreparedRedirectSettings = {
      settings: null,
      snapshot: {
        custom: Object.create(null),
        defaultBang: "ddg",
        luckyProvider: "default",
        luckyUrl: null,
      },
    };
    const mod = await loadSwIdb();
    let settled = false;
    const loading = mod
      .readRedirectSettings(
        Promise.resolve(prepared),
        "catalog-a",
        bangDataReady
      )
      .then((settings) => {
        settled = true;
        return settings;
      });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseBangData();
    expect((await loading).defaultUrl[0]).toContain("duckduckgo.com");
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
    let resolvePrepared!: (snapshot: PreparedRedirectSettings) => void;
    const prepared = new Promise<PreparedRedirectSettings>((resolve) => {
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
      settings: null,
      snapshot: {
        custom: Object.create(null),
        defaultBang: "g",
        luckyProvider: "default",
        luckyUrl: null,
      },
    });
    await Promise.all([staleLoad, invalidation]);

    const settings = await mod.readRedirectSettings();
    expect(settings.custom.mydocs).toEqual([
      "https://docs.example/search?q=",
      "",
    ]);
    await mod.waitForRedirectSettingsPersistence();
    const shared = await loadSharedIdb();
    const db = await shared.openDB();
    const stored = await reqToPromise<
      { snapshot?: { custom?: Record<string, unknown> } } | undefined
    >(
      db
        .transaction("settings", "readonly")
        .objectStore("settings")
        .get(REDIRECT_SETTINGS_SNAPSHOT_KEY)
    );
    expect(stored?.snapshot?.custom?.mydocs).toBeDefined();
  });
});

describe("sw/idb frecency", () => {
  test("canonical module persists frecency usage through the shared worker singleton", async () => {
    const realNow = Date.now;
    try {
      Date.now = () => 1_700_000_000_000;
      await seedDb({ settings: [{ key: "frecency", value: "g:5,ddg:2" }] });
      await coveredSwIdb.invalidateCache();

      await coveredSwIdb.loadFrecency();
      await coveredSwIdb.trackBangUsage("docs").persistence;

      expect(coveredSwIdb.hasTopFrecency()).toBe(true);
      expect(coveredSwIdb.getTopFrecencyRecord()).toMatchObject({
        docs: 1,
      });
      const shared = await loadSharedIdb();
      const db = await shared.openDB();
      const record = await reqToPromise<{ value: string } | undefined>(
        db
          .transaction("settings", "readonly")
          .objectStore("settings")
          .get("frecency")
      );
      expect(record?.value).toContain("docs:1");
    } finally {
      Date.now = realNow;
      await coveredSwIdb.invalidateCache();
    }
  });

  test("canonical module keeps usage persistence stable when the IDB factory is temporarily unavailable", async () => {
    await coveredSwIdb.invalidateCache();
    const working = indexedDB;
    let allowOpen = true;
    (globalThis as { indexedDB: IDBFactory }).indexedDB = {
      open(...args: Parameters<IDBFactory["open"]>) {
        if (!allowOpen) {
          throw new Error("disk unavailable");
        }
        return working.open(...args);
      },
    } as IDBFactory;

    await coveredSwIdb.loadFrecency();
    allowOpen = false;
    await coveredSwIdb.trackBangUsage("yt").persistence;
    expect(coveredSwIdb.getTopFrecencyRecord()).toMatchObject({ yt: 1 });

    allowOpen = true;
    const shared = await loadSharedIdb();
    shared.resetDB();
    const db = await shared.openDB();
    const record = await reqToPromise<{ value: string } | undefined>(
      db
        .transaction("settings", "readonly")
        .objectStore("settings")
        .get("frecency")
    );
    expect(record?.value).toContain("yt:1");
    await coveredSwIdb.invalidateCache();
  });

  test("keeps frecency outside the redirect settings critical path", async () => {
    await seedDb({
      settings: [{ key: "frecency", value: `${Date.now()}|g:5,ddg:2` }],
    });

    const mod = await loadSwIdb();
    await mod.readRedirectSettings();
    expect(mod.getTopFrecencyRecord()).toEqual({});
    await mod.loadFrecency();

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
    await mod.loadFrecency();

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
  test("closes and refreshes the cached connection on versionchange", async () => {
    const shared = await loadSharedIdb();
    shared.resetDB();
    const first = await shared.openDB();
    let closeCalls = 0;
    const realClose = first.close.bind(first);
    first.close = () => {
      closeCalls++;
      realClose();
    };

    first.onversionchange?.(
      new Event("versionchange") as IDBVersionChangeEvent
    );
    const second = await shared.openDB();

    expect(closeCalls).toBe(1);
    expect(second).not.toBe(first);
  });

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
