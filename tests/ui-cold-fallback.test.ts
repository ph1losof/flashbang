import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { resetDB } from "../src/shared/idb";
import { resetBangDataForTests } from "../src/sw/bang-data";
import { installFakeIndexedDb } from "./helpers/fake-indexeddb";
import { TEST_BANG_SHARDS } from "./helpers/preload";

/**
 * `src/ui/cold-fallback.ts` decides whether the visitor is new the moment it
 * loads, so it is imported once here against an empty profile — the only state
 * in which the sharded cold path runs at all. The returning-visitor branch is
 * covered in `ui-fallback-first-visit.test.ts`, which imports its own copy.
 */

const globals = globalThis as unknown as Record<string, unknown>;
let restoreIndexedDb: (() => void) | null = null;
let savedBangDataAsset: unknown;
let fetchSpy: ReturnType<typeof spyOn> | null = null;
let coldFallback: typeof import("../src/ui/cold-fallback");

function shardBytes(shardId: number): ArrayBuffer {
  const shard = TEST_BANG_SHARDS[shardId];
  return shard.buffer.slice(
    shard.byteOffset,
    shard.byteOffset + shard.byteLength
  ) as ArrayBuffer;
}

function serveShards(): void {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      (input: unknown) => {
        const url = String(input instanceof Request ? input.url : input);
        const shardMatch = /\/bangs-s([0-9a-z]+)-test\.bin$/.exec(url);
        if (shardMatch) {
          return Promise.resolve(
            new Response(shardBytes(Number.parseInt(shardMatch[1], 36)))
          );
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      },
      { preconnect: () => undefined }
    ) as unknown as typeof fetch
  );
}

beforeAll(async () => {
  savedBangDataAsset = globals.__BANG_DATA_ASSET__;
  globals.__BANG_DATA_ASSET__ = "/bangs.bin";
  restoreIndexedDb = installFakeIndexedDb();
  resetDB();
  // No profile database exists, which is what marks this as a first visit.
  coldFallback = await import("../src/ui/cold-fallback");
});

afterAll(() => {
  resetDB();
  resetBangDataForTests();
  restoreIndexedDb?.();
  restoreIndexedDb = null;
  globals.__BANG_DATA_ASSET__ = savedBangDataAsset;
});

beforeEach(() => {
  resetBangDataForTests();
  serveShards();
});

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = null;
});

function requestedUrls(): string[] {
  return (fetchSpy?.mock.calls ?? []).map((call: unknown[]) => String(call[0]));
}

describe("cold fallback shard load failures", () => {
  // These run before any successful load: a shard, once fetched, stays cached
  // on the module's runtime for the rest of the process.
  test("propagates a network failure", async () => {
    fetchSpy?.mockRestore();
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(() => Promise.reject(new Error("network down")), {
        preconnect: () => undefined,
      }) as unknown as typeof fetch
    );

    await expect(
      coldFallback.resolveColdFallback("!hn coverage")
    ).rejects.toThrow();
  });

  test("propagates an unsuccessful shard response", async () => {
    fetchSpy?.mockRestore();
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        () => Promise.resolve(new Response(null, { status: 503 })),
        { preconnect: () => undefined }
      ) as unknown as typeof fetch
    );

    await expect(
      coldFallback.resolveColdFallback("!hn coverage")
    ).rejects.toThrow();
  });
});

describe("cold fallback on a first visit", () => {
  test("resolves a non-hot bang by loading only the routed shard", async () => {
    const resolved = await coldFallback.resolveColdFallback("!hn coverage");

    expect(resolved).not.toBeNull();
    expect(resolved?.url).toContain("coverage");
    expect(requestedUrls().length).toBeGreaterThan(0);
    // The full catalog is never downloaded on this path.
    expect(requestedUrls().every((url) => url.includes("bangs-s"))).toBe(true);
  });

  test("resolves a hot bang with no network at all", async () => {
    const resolved = await coldFallback.resolveColdFallback("!gh coverage");

    expect(resolved?.url).toContain("github.com");
    expect(requestedUrls()).toHaveLength(0);
  });

  test("resolves a plain query with the default provider", async () => {
    const resolved = await coldFallback.resolveColdFallback("coverage");

    expect(resolved?.url).toContain("coverage");
    expect(resolved?.url).toContain("google.com");
  });

  test("accepts prefetched bytes instead of refetching the shard", async () => {
    const resolved = await coldFallback.resolveColdFallback(
      "!hn coverage",
      shardBytes(0)
    );

    expect(resolved?.url).toContain("coverage");
  });

  test("accepts a promise of prefetched bytes", async () => {
    const resolved = await coldFallback.resolveColdFallback(
      "!hn coverage",
      Promise.resolve(shardBytes(0))
    );

    expect(resolved?.url).toContain("coverage");
  });

  test("loads every shard a snap chain needs", async () => {
    const resolved = await coldFallback.resolveColdFallback("@hn,so coverage");

    expect(resolved).not.toBeNull();
    expect(requestedUrls().length).toBeGreaterThan(0);
  });

  test("declines raw queries so the encoded path stays authoritative", async () => {
    expect(
      await coldFallback.resolveColdFallback("!hn+coverage", undefined, true)
    ).toBeNull();
  });
});
