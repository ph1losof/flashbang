import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { resetDB } from "../src/shared/idb";
import { resetBangDataForTests } from "../src/sw/bang-data";
import { installFakeIndexedDb } from "./helpers/fake-indexeddb";
import { putSettingRecord, seedDb } from "./helpers/shared-db";

/**
 * `src/ui/fallback.ts` is a standalone bundle entry point: it reads the profile
 * and its injected asset global once, at import time. The profile is therefore
 * seeded before the single import below and every test shares that snapshot.
 * A first-visit profile is a different import-time environment, so it lives in
 * `ui-fallback-first-visit.test.ts`.
 */

const globals = globalThis as unknown as Record<string, unknown>;
let restoreIndexedDb: (() => void) | null = null;
let savedBangDataAsset: unknown;
let fetchSpy: ReturnType<typeof spyOn> | null = null;
let fallback: typeof import("../src/ui/fallback");

beforeAll(async () => {
  savedBangDataAsset = globals.__BANG_DATA_ASSET__;
  globals.__BANG_DATA_ASSET__ = "/bangs.bin";
  restoreIndexedDb = installFakeIndexedDb();
  resetDB();
  resetBangDataForTests();

  // A returning profile with a hot default bang plus a custom bang, so the
  // eager settings read covers its whole path.
  await putSettingRecord({ key: "default-bang", value: "yt" });
  await seedDb({
    customBangs: [{ trigger: "zqx", url: "https://mine.test/?q={}" }],
  });

  fallback = await import("../src/ui/fallback");
});

afterAll(() => {
  resetDB();
  resetBangDataForTests();
  restoreIndexedDb?.();
  restoreIndexedDb = null;
  globals.__BANG_DATA_ASSET__ = savedBangDataAsset;
});

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = null;
});

function bangData(): Promise<ArrayBuffer> {
  return Bun.file("src/generated/bangs.bin").arrayBuffer();
}

describe("hot fallback resolution", () => {
  test("resolves a hot bang without touching the full catalog", async () => {
    const resolved = await fallback.resolveHotFallback("!gh coverage");

    expect(resolved).not.toBeNull();
    expect(resolved?.url).toContain("github.com");
    expect(resolved?.url).toContain("coverage");
  });

  test("applies the stored default bang to a plain query", async () => {
    const resolved = await fallback.resolveHotFallback("coverage");

    expect(resolved?.url).toContain("youtube.com");
  });

  test("resolves an already-encoded raw query", async () => {
    const resolved = await fallback.resolveHotFallback(
      "!gh+service+workers",
      true
    );

    expect(resolved?.url).toContain("github.com");
    expect(resolved?.url).toContain("service+workers");
  });

  test("carries stored custom bangs into the resolved settings", async () => {
    const resolved = await fallback.resolveHotFallback("!zqx coverage");

    expect(resolved?.url).toContain("mine.test");
    expect(resolved?.settings.custom.zqx).toBeDefined();
  });

  test("returns null for a bang outside the hot catalog", async () => {
    expect(
      await fallback.resolveHotFallback("!zzzznotabang coverage")
    ).toBeNull();
  });

  test("returns null for a raw bang outside the hot catalog", async () => {
    expect(
      await fallback.resolveHotFallback("!zzzznotabang+coverage", true)
    ).toBeNull();
  });
});

describe("full catalog fallback resolution", () => {
  test("resolves a bang against the full catalog", async () => {
    const { settings, url } = await fallback.resolveFallback(
      "!gh flashbang",
      await bangData()
    );

    expect(url).toContain("github.com");
    expect(url).toContain("flashbang");
    expect(settings.defaultUrl).toBeDefined();
  });

  test("resolves a bang the hot set does not contain", async () => {
    const { url } = await fallback.resolveFallback(
      "!hn flashbang",
      await bangData()
    );

    expect(url).toContain("flashbang");
  });

  test("uses the stored default bang for a plain query", async () => {
    const { url } = await fallback.resolveFallback(
      "flashbang",
      await bangData()
    );

    expect(url).toContain("youtube.com");
  });

  test("falls back to a provider for an unknown trigger", async () => {
    const { url } = await fallback.resolveFallback(
      "!zzzznotabang flashbang",
      await bangData()
    );

    expect(url).toContain("flashbang");
  });

  test("resolves an already-encoded raw query", async () => {
    const { url } = await fallback.resolveFallback(
      "!gh+flashbang",
      await bangData(),
      true
    );

    expect(url).toContain("github.com");
    expect(url).toContain("flashbang");
  });

  test("applies stored custom bangs", async () => {
    const { url } = await fallback.resolveFallback(
      "!zqx flashbang",
      await bangData()
    );

    expect(url).toContain("mine.test");
  });

  test("recovers with default settings when the profile read fails", async () => {
    resetDB();
    const failing = spyOn(indexedDB, "open").mockImplementation(() => {
      throw new Error("IndexedDB blocked");
    });

    const { settings, url } = await fallback.resolveFallback(
      "!gh flashbang",
      await bangData()
    );

    expect(url).toContain("github.com");
    expect(settings.defaultUrl).toBeDefined();
    failing.mockRestore();
  });
});
