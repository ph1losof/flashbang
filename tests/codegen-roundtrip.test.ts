import { describe, expect, test } from "bun:test";
import { loadStringIdMap } from "../scripts/bang-strings-build";
import { packBangIndexShards } from "../scripts/build";
import { generateBinaryShards, generateCatalog } from "../scripts/codegen";
import { lookupAdvancedBang } from "../src/generated/bangs-sparse.js";
import {
  BANG_SHARD_COUNT,
  BANG_SHARD_ROUTER_SIZE,
  bangShardIndex,
  extractBangShardTriggers,
} from "../src/shared/bang-shards";
import { hashFNV1a } from "../src/shared/hash";
import {
  createBangIndexRuntime,
  createBangShardRuntime,
  decodeBangIndexPack,
  initializeBangData,
  isBangStringStoreStale,
  lookupBang,
} from "../src/sw/bang-data";
import { createBangStrings } from "../src/sw/bang-strings";
import { redirectRawUrl } from "../src/sw/redirect";
import { decodeBangCatalog } from "../src/ui/bang-catalog";

const testShardAssets = () =>
  Array.from(
    { length: BANG_SHARD_COUNT },
    (_, shard) => `/bangs-s${shard.toString(36)}-test.bin`
  );

import {
  BANG_BINARY_HEADER_WORDS,
  BANG_BINARY_MAGIC,
  BANG_BINARY_VERSION,
  BANG_META_MAGIC,
  BANG_META_VERSION,
  bangBinaryCheckpointOffset,
  bangBinaryFingerprints,
  bangBinaryNumericEnd,
  bangBinarySnapSlotOffset,
  bangBinarySnapTargetIdOffset,
  bangBinarySnapTargetLengthOffset,
  bangBinarySnapTriggerLengthOffset,
} from "./helpers/bang-binary";
import { loadTestBangData } from "./helpers/bang-data";

await loadTestBangData();

const bangs: Array<{
  domain: string;
  name: string;
  regex?: string;
  relevance: number;
  trigger: string;
  url: string;
}> = await Bun.file("data/bangs.json").json();
const customBangs: Record<string, { url: string }> = await Bun.file(
  "data/custom-bangs.json"
).json();

describe("codegen round-trip", () => {
  test("extracts canonical cold candidates and complete snap chains", () => {
    expect(extractBangShardTriggers("!gh cats")).toEqual(["gh"]);
    expect(extractBangShardTriggers("gh! cats")).toEqual(["gh"]);
    expect(extractBangShardTriggers("cats !gh")).toEqual(["gh"]);
    expect(extractBangShardTriggers("@gh,mdn,npm cats")).toEqual([
      "gh",
      "mdn",
      "npm",
    ]);
    expect(extractBangShardTriggers("cats @gh,mdn,gh")).toEqual(["gh", "mdn"]);
    expect(extractBangShardTriggers("$npm cats", "$", "~")).toEqual(["npm"]);
    expect(extractBangShardTriggers("plain query")).toEqual([]);
  });

  test("every 100th bang resolves to a non-null entry", () => {
    const sample = bangs.filter((_, i) => i % 100 === 0);
    for (const bang of sample) {
      const result =
        lookupBang(bang.trigger, hashFNV1a(bang.trigger)) ??
        lookupAdvancedBang(bang.trigger);
      expect(result).not.toBeNull();
    }
  });

  test("common bangs resolve correctly", () => {
    const common = ["g", "w", "yt", "gh", "mdn", "npm"];
    for (const trigger of common) {
      const result = lookupBang(trigger, hashFNV1a(trigger));
      expect(result).not.toBeNull();
      expect(result![0]).toContain("://");
    }
  });

  test("compiles binary URL mode on fill but not lookup", async () => {
    initializeBangData(await Bun.file("src/generated/bangs.bin").arrayBuffer());
    const hash = hashFNV1a("g");
    const entry = lookupBang("g", hash)!;

    expect(Object.hasOwn(entry, "m")).toBeFalse();
    expect(
      redirectRawUrl("!g+a+b%2Fc", {
        custom: Object.create(null),
        defaultUrl: ["https://default.example/?q=", ""],
        luckyUrl: null,
      })
    ).toBe("https://www.google.com/search?q=a+b%2Fc");
    expect(lookupBang("g", hash)).toBe(entry);
    expect(Object.hasOwn(entry, "m")).toBeTrue();
  });

  test("preserves upstream site-filter search templates", () => {
    const siteFiltered = bangs.filter(
      (bang) =>
        !bang.regex && /(?:site(?::|%3a)|(?:as_)?sitesearch=)/i.test(bang.url)
    );
    expect(siteFiltered.length).toBeGreaterThan(100);
    for (const bang of siteFiltered) {
      const generated = lookupBang(bang.trigger, hashFNV1a(bang.trigger));
      expect(generated).not.toBeNull();
      expect(`${generated![0]}{}${generated![1]}`).toBe(bang.url);
    }
  });

  test("applies every curated custom override", () => {
    for (const [trigger, bang] of Object.entries(customBangs)) {
      const generated = lookupBang(trigger, hashFNV1a(trigger));
      expect(generated).not.toBeNull();
      const placeholder = bang.url.indexOf("{}");
      expect(generated?.slice(0, 2)).toEqual(
        placeholder === -1
          ? [bang.url, null]
          : [
              bang.url.substring(0, placeholder),
              bang.url.substring(placeholder + 2),
            ]
      );
    }
  });

  test("materializes and caches URL tuples on demand", () => {
    const hash = hashFNV1a("g");
    const first = lookupBang("g", hash);
    expect(first).not.toBeNull();
    expect(lookupBang("g", hash)).toBe(first);
  });

  test("emits the binary lookup artifact", async () => {
    const binary = await Bun.file("src/generated/bangs.bin").arrayBuffer();
    const header = new Uint32Array(binary, 0, BANG_BINARY_HEADER_WORDS);
    expect(header[0]).toBe(BANG_BINARY_MAGIC);
    expect(header[1]).toBe(BANG_BINARY_VERSION);
    expect(header[2]).toBe(bangs.filter((bang) => !bang.regex).length);
    expect(header[11]).toBe(binary.byteLength);
    expect(header[3] & (header[3] - 1)).toBe(0);
    expect([2, 4]).toContain(header[12]);

    expect(header[10]).toBe(bangBinaryNumericEnd(header));

    expect(header[4]).toBe(Uint16Array.BYTES_PER_ELEMENT);
    expect(bangBinaryFingerprints(binary, header)).toHaveLength(header[2]);
  });

  test("resolves every regular bang through the perfect hash", () => {
    for (const bang of bangs) {
      if (bang.regex) {
        continue;
      }
      const generated = lookupBang(bang.trigger, hashFNV1a(bang.trigger));
      expect(generated).not.toBeNull();
      expect(
        generated![1] === null
          ? generated![0]
          : `${generated![0]}{}${generated![1]}`
      ).toBe(bang.url);
    }
  });

  test("routes every regular bang through its deterministic cold shard", async () => {
    const { router, shards } = generateBinaryShards(bangs);
    const repeated = generateBinaryShards(bangs);
    expect(router).toHaveLength(BANG_SHARD_ROUTER_SIZE);
    // The router is frozen in data/bang-router.json, so adding a bang must not
    // move any existing bang between shards.
    const grown = generateBinaryShards([
      ...bangs,
      {
        domain: "shard-stability.example",
        name: "Shard stability probe",
        relevance: 1,
        trigger: "zzshardstabilityprobe",
        url: "https://shard-stability.example/?q={}",
      },
    ]);
    expect(Array.from(grown.router)).toEqual(Array.from(router));
    const churned = grown.shards.filter(
      (shard, id) => Bun.hash(shard) !== Bun.hash(shards[id])
    ).length;
    expect(churned).toBe(1);
    expect(shards).toHaveLength(BANG_SHARD_COUNT);
    expect(Array.from(repeated.router)).toEqual(Array.from(router));
    expect(repeated.shards.map((shard) => Bun.hash(shard))).toEqual(
      shards.map((shard) => Bun.hash(shard))
    );
    const shardSizes = shards.map((shard) => shard.byteLength);
    expect(
      Math.max(...shardSizes) /
        (shardSizes.reduce((a, b) => a + b) / shardSizes.length)
    ).toBeLessThan(1.15);
    for (let shardId = 0; shardId < shards.length; shardId++) {
      const shard = shards[shardId];
      initializeBangData(
        shard.buffer.slice(
          shard.byteOffset,
          shard.byteOffset + shard.byteLength
        ) as ArrayBuffer
      );
      for (const bang of bangs) {
        const hash = hashFNV1a(bang.trigger);
        if (!(bang.regex || bangShardIndex(hash, router) !== shardId)) {
          expect(lookupBang(bang.trigger, hash)).not.toBeNull();
        }
      }
    }
    initializeBangData(await Bun.file("src/generated/bangs.bin").arrayBuffer());
  });

  test("loads and resets an exact shard through the shared runtime", async () => {
    const { router, shards } = generateBinaryShards(bangs);
    const runtime = createBangShardRuntime(router, testShardAssets());
    const trigger = "github";
    const hash = hashFNV1a(trigger);
    const shardId = bangShardIndex(hash, router);

    let unavailable: unknown;
    try {
      runtime.lookup(trigger, hash);
    } catch (error) {
      unavailable = error;
    }
    expect(runtime.unavailableShardId(unavailable)).toBe(shardId);

    const shard = shards[shardId];
    await runtime.ensure(
      shardId,
      shard.buffer.slice(
        shard.byteOffset,
        shard.byteOffset + shard.byteLength
      ) as ArrayBuffer
    );
    expect(runtime.lookup(trigger, hash)?.[0]).toContain("github.com");
    await runtime.ensure(shardId);

    runtime.reset();
    expect(() => runtime.lookup(trigger, hash)).toThrow();
  });

  test("loads a v11 shard against the global store and detects stale pairs", async () => {
    const catalog = generateCatalog(bangs, loadStringIdMap());
    const detach = (bytes: Uint8Array): ArrayBuffer =>
      bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer;
    const strings = createBangStrings([
      detach(catalog.storeBase),
      detach(catalog.storeTail),
    ]);
    const shardsPerAsset = 3;
    const packs = packBangIndexShards(catalog.index, shardsPerAsset);
    const assets = packs.map(
      (_, pack) => `/bangs-ip${pack.toString(36)}-test.bin`
    );
    const reads: string[] = [];
    const runtime = createBangIndexRuntime(
      catalog.router,
      assets,
      shardsPerAsset,
      () => strings,
      (asset) => {
        reads.push(asset);
        const pack = Number.parseInt(
          /^\/bangs-ip([0-9a-z]+)-/.exec(asset)![1],
          36
        );
        return Promise.resolve(detach(packs[pack]));
      }
    );
    const trigger = "github";
    const hash = hashFNV1a(trigger);
    const shardId = bangShardIndex(hash, catalog.router);
    await runtime.ensure(shardId);
    expect(runtime.lookup(trigger, hash)?.[0]).toContain("github.com");
    await runtime.ensure(shardId);
    expect(reads).toEqual([assets[Math.floor(shardId / shardsPerAsset)]]);

    const staleRuntime = createBangIndexRuntime(
      catalog.router,
      assets,
      shardsPerAsset,
      () => ({
        ...strings,
        epoch: strings.epoch + 1,
      })
    );
    let staleError: unknown;
    try {
      await staleRuntime.ensure(
        shardId,
        detach(packs[Math.floor(shardId / shardsPerAsset)])
      );
    } catch (error) {
      staleError = error;
    }
    expect(isBangStringStoreStale(staleError)).toBe(true);

    expect(() => createBangIndexRuntime([], [], 0, () => strings)).toThrow(
      "positive integer"
    );
    expect(() => decodeBangIndexPack(new ArrayBuffer(4), 0)).toThrow(
      "Truncated"
    );
    // A pack is a 4-aligned header followed by raw shard bytes, so its total
    // length is a multiple of 4 only by chance — most packs are not. Corrupt a
    // misaligned one so the decoder stays exercised against unaligned tails and
    // these assertions cannot start depending on the day's bang data.
    const misaligned = packs.find((pack) => pack.byteLength % 4 !== 0);
    expect(misaligned).toBeDefined();
    const invalidMagic = detach(misaligned!).slice(0);
    // Bounded views only: `new Uint32Array(buffer)` throws on an unaligned tail.
    new Uint32Array(invalidMagic, 0, 1)[0] = 0;
    expect(() => decodeBangIndexPack(invalidMagic, 0)).toThrow("Unsupported");
    const invalidOffsets = detach(misaligned!).slice(0);
    const offsetHeader = new Uint32Array(invalidOffsets, 0, 5);
    offsetHeader[4] = offsetHeader[3];
    expect(() => decodeBangIndexPack(invalidOffsets, 0)).toThrow("offsets");
    expect(() => decodeBangIndexPack(detach(misaligned!), 3)).toThrow("layout");
  });

  test("retries a shard after a failed network response", async () => {
    const runtime = createBangShardRuntime(
      new Uint8Array(256),
      testShardAssets()
    );
    const globals = globalThis as unknown as {
      fetch: (input: RequestInfo | URL) => Promise<Response>;
    };
    const originalFetch = globals.fetch;
    let attempts = 0;
    globals.fetch = () => {
      attempts++;
      return Promise.resolve(new Response(null, { status: 503 }));
    };
    try {
      await expect(runtime.ensure(0)).rejects.toThrow(
        "Failed to load bang shard: 503"
      );
      await expect(runtime.ensure(0)).rejects.toThrow(
        "Failed to load bang shard: 503"
      );
    } finally {
      globals.fetch = originalFetch;
    }
    expect(attempts).toBe(2);
  });

  test("rejects sampled unknown triggers with fingerprint verification", () => {
    for (let i = 0; i < bangs.length; i += 100) {
      const trigger = `${bangs[i].trigger}~missing`;
      expect(lookupBang(trigger, hashFNV1a(trigger))).toBeNull();
    }
  });

  test("preserves metadata records and sparse captures in source order", async () => {
    const binary = await Bun.file("src/generated/bangs-meta.bin").arrayBuffer();
    const header = new Uint32Array(binary, 0, 6);
    expect(header[0]).toBe(BANG_META_MAGIC);
    expect(header[1]).toBe(BANG_META_VERSION);
    expect(header[2]).toBe(bangs.length);
    expect(header[3]).toBe(bangs.filter((bang) => bang.regex).length);
    expect(header[5]).toBe(binary.byteLength);

    const catalog = decodeBangCatalog(binary);
    expect(catalog.entries).toHaveLength(bangs.length);
    for (let i = 0; i < bangs.length; i += 100) {
      expect(catalog.entries[i]).toMatchObject({
        capture: Boolean(bangs[i].regex),
        domain: bangs[i].domain,
        name: bangs[i].name,
        trigger: bangs[i].trigger,
      });
    }
  });

  test("rejects malformed metadata fields, captures, and UTF-8", async () => {
    const binary = await Bun.file("src/generated/bangs-meta.bin").arrayBuffer();
    const header = new Uint32Array(binary, 0, 6);

    const invalidCapture = binary.slice(0);
    new Uint32Array(invalidCapture, 24, header[3])[0] = header[2];
    expect(() => decodeBangCatalog(invalidCapture)).toThrow(
      "Invalid bang metadata capture indexes"
    );

    const invalidFields = binary.slice(0);
    new Uint8Array(invalidFields)[invalidFields.byteLength - 1] = 1;
    expect(() => decodeBangCatalog(invalidFields)).toThrow(
      "Invalid bang metadata fields"
    );

    const invalidUtf8 = binary.slice(0);
    new Uint8Array(invalidUtf8)[header[4]] = 0xff;
    expect(() => decodeBangCatalog(invalidUtf8)).toThrow();
  });

  test("rejects invalid binary lookup metadata", async () => {
    const binary = await Bun.file("src/generated/bangs.bin").arrayBuffer();
    const binaryHeader = new Uint32Array(binary, 0, BANG_BINARY_HEADER_WORDS);
    for (const [word, value, message] of [
      [0, 0, "Unsupported binary bang data"],
      [11, binary.byteLength + 1, "Truncated binary bang data"],
      [
        10,
        new Uint32Array(binary, 0, BANG_BINARY_HEADER_WORDS)[10] + 1,
        "Invalid binary bang data layout",
      ],
    ] as const) {
      const invalid = binary.slice(0);
      new Uint32Array(invalid, 0, BANG_BINARY_HEADER_WORDS)[word] = value;
      expect(() => initializeBangData(invalid)).toThrow(message);
    }
    for (const [word, value, message] of [
      [2, 0, "Invalid binary bang entry count"],
      [3, 0, "Invalid binary bang MPHF bucket count"],
      [3, 3, "Invalid binary bang MPHF bucket count"],
      [4, 0, "Invalid binary bang fingerprint width"],
      [4, 3, "Invalid binary bang fingerprint width"],
      [12, 0, "Invalid binary bang MPHF displacement width"],
      [12, 3, "Invalid binary bang MPHF displacement width"],
      [13, binaryHeader[2] + 1, "Invalid binary bang snap counts"],
      [14, binaryHeader[13] + 1, "Invalid binary bang snap counts"],
    ] as const) {
      const invalid = binary.slice(0);
      new Uint32Array(invalid, 0, BANG_BINARY_HEADER_WORDS)[word] = value;
      expect(() => initializeBangData(invalid)).toThrow(message);
    }

    const invalidSnapSlot = binary.slice(0);
    const snapSlotHeader = new Uint32Array(
      invalidSnapSlot,
      0,
      BANG_BINARY_HEADER_WORDS
    );
    const snapSlots = new Uint16Array(
      invalidSnapSlot,
      bangBinarySnapSlotOffset(snapSlotHeader),
      snapSlotHeader[13]
    );
    snapSlots[1] = snapSlots[0];
    expect(() => initializeBangData(invalidSnapSlot)).toThrow(
      "Invalid binary bang snap index"
    );

    const invalidSnapTargetId = binary.slice(0);
    const snapTargetIdHeader = new Uint32Array(
      invalidSnapTargetId,
      0,
      BANG_BINARY_HEADER_WORDS
    );
    new Uint16Array(
      invalidSnapTargetId,
      bangBinarySnapTargetIdOffset(snapTargetIdHeader),
      snapTargetIdHeader[13]
    )[0] = snapTargetIdHeader[14];
    expect(() => initializeBangData(invalidSnapTargetId)).toThrow(
      "Invalid binary bang snap index"
    );

    const invalidSnapTargetLength = binary.slice(0);
    const snapTargetLengthHeader = new Uint32Array(
      invalidSnapTargetLength,
      0,
      BANG_BINARY_HEADER_WORDS
    );
    new Uint16Array(
      invalidSnapTargetLength,
      bangBinarySnapTargetLengthOffset(snapTargetLengthHeader),
      snapTargetLengthHeader[14] * 2
    )[0]++;
    expect(() => initializeBangData(invalidSnapTargetLength)).toThrow(
      "Invalid binary bang snap target lengths"
    );

    const invalidSnapTriggerLength = binary.slice(0);
    const snapTriggerLengthHeader = new Uint32Array(
      invalidSnapTriggerLength,
      0,
      BANG_BINARY_HEADER_WORDS
    );
    new Uint16Array(
      invalidSnapTriggerLength,
      bangBinarySnapTriggerLengthOffset(snapTriggerLengthHeader),
      snapTriggerLengthHeader[13]
    )[0]++;
    expect(() => initializeBangData(invalidSnapTriggerLength)).toThrow(
      "Invalid binary bang snap trigger lengths"
    );

    const invalidDisplacement = binary.slice(0);
    const header = new Uint32Array(
      invalidDisplacement,
      0,
      BANG_BINARY_HEADER_WORDS
    );
    const displacements =
      header[12] === 2
        ? new Int16Array(
            invalidDisplacement,
            BANG_BINARY_HEADER_WORDS * Uint32Array.BYTES_PER_ELEMENT,
            header[3]
          )
        : new Int32Array(
            invalidDisplacement,
            BANG_BINARY_HEADER_WORDS * Uint32Array.BYTES_PER_ELEMENT,
            header[3]
          );
    displacements[0] = -(header[2] + 1);
    expect(() => initializeBangData(invalidDisplacement)).toThrow(
      "Invalid binary bang MPHF displacement"
    );

    const invalidCheckpoint = binary.slice(0);
    const checkpointHeader = new Uint32Array(
      invalidCheckpoint,
      0,
      BANG_BINARY_HEADER_WORDS
    );
    const checkpointOffset = bangBinaryCheckpointOffset(checkpointHeader);
    const prefixCheckpoints = new Uint32Array(
      invalidCheckpoint,
      checkpointOffset,
      Math.ceil(checkpointHeader[5] / 16)
    );
    prefixCheckpoints[prefixCheckpoints.length - 1]++;
    expect(() => initializeBangData(invalidCheckpoint)).toThrow(
      "Invalid binary bang string lengths"
    );
  });

  test("regex bangs are emitted only through the sparse advanced lookup", () => {
    expect(lookupBang("ktr", hashFNV1a("ktr"))).toBeNull();
    const advanced = lookupAdvancedBang("ktr");
    expect(advanced?.[0]).toBe("https://translate.kagi.com/");
    expect(advanced?.[2]).toEqual([1, 2]);
    expect(advanced?.[3].source).toBe("(\\w+)\\s+(.*)");
  });

  test("Kagi ad values are embedded in binary bang entries", () => {
    expect(lookupBang("g", hashFNV1a("g"))?.[2]).toBeUndefined();
    expect(lookupBang("not-hn", hashFNV1a("hn"))?.[2]).toBeUndefined();
    expect(lookupBang("hn", hashFNV1a("hn"))?.[2]).toEqual([
      "+site:news.ycombinator.com",
      "https://news.ycombinator.com",
    ]);
    expect(lookupBang("nr", hashFNV1a("nr"))?.[2]?.[0]).toBe(
      "+site:github.com/NixOS/nixpkgs"
    );
    expect(lookupBang("sklearn", hashFNV1a("sklearn"))?.[2]?.[0]).toBe(
      "+site:scikit-learn.org/stable"
    );
    expect(lookupBang("saltstack", hashFNV1a("saltstack"))?.[2]?.[1]).toBe(
      "https://docs.saltproject.io/en/latest"
    );
  });
});
