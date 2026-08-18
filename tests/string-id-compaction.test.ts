import { describe, expect, test } from "bun:test";
import {
  assignGlobalStringIds,
  emptyStringIdMap,
  encodeStringStore,
  type StringIdMap,
} from "../scripts/bang-strings-build";
import { rebuildStringIdMap } from "../scripts/codegen";
import { CHECKPOINT_SIZE } from "../src/shared/bang-binary-format";
import { createBangStrings } from "../src/sw/bang-strings";

interface Bang {
  domain: string;
  name: string;
  regex?: string;
  relevance: number;
  trigger: string;
  url: string;
}

function bang(trigger: string, url: string): Bang {
  return { domain: "e.example", name: trigger, relevance: 0, trigger, url };
}

function accretedMap(live: readonly Bang[], orphans: number): StringIdMap {
  const map = emptyStringIdMap();
  const prefixes: string[] = [];
  for (let i = 0; i < orphans; i++) {
    prefixes.push(`https://orphan${i}.example/?q=`);
  }
  for (const entry of live) {
    prefixes.push(entry.url.replace("{}", ""));
  }
  assignGlobalStringIds(map, prefixes, [""]);
  map.meta.basePrefixCount =
    Math.floor(map.prefixes.length / CHECKPOINT_SIZE) * CHECKPOINT_SIZE;
  return map;
}

const live = Array.from({ length: 40 }, (_, i) =>
  bang(`t${i}`, `https://site${i}.example/?q={}`)
);

describe("rebuildStringIdMap", () => {
  test("keeps every live string and drops the orphans", () => {
    const previous = accretedMap(live, 30);
    const rebuilt = rebuildStringIdMap(live, { bumpEpoch: true }, previous);
    for (const entry of live) {
      expect(rebuilt.prefixIds.has(entry.url.replace("{}", ""))).toBe(true);
    }
    expect(
      rebuilt.prefixes.filter((value) => value.includes("orphan"))
    ).toHaveLength(0);
    expect(rebuilt.prefixes.length).toBeLessThan(previous.prefixes.length);
  });

  test("bumps the epoch only when asked", () => {
    const previous = accretedMap(live, 30);
    expect(
      rebuildStringIdMap(live, { bumpEpoch: true }, previous).meta.epoch
    ).toBe(previous.meta.epoch + 1);
    expect(
      rebuildStringIdMap(live, { bumpEpoch: false }, previous).meta.epoch
    ).toBe(previous.meta.epoch);
  });

  test("produces base counts the loader will accept", () => {
    const rebuilt = rebuildStringIdMap(
      live,
      { bumpEpoch: true },
      accretedMap(live, 30)
    );
    for (const [base, length] of [
      [rebuilt.meta.basePrefixCount, rebuilt.prefixes.length],
      [rebuilt.meta.baseSuffixCount, rebuilt.suffixes.length],
    ]) {
      expect(base % CHECKPOINT_SIZE).toBe(0);
      expect(base).toBeLessThanOrEqual(length);
    }
  });

  test("skips capture bangs, which live outside the index shards", () => {
    const withRegex = [
      ...live,
      { ...bang("cap", "https://cap.example/$1"), regex: "(.*)" },
    ];
    const rebuilt = rebuildStringIdMap(
      withRegex,
      { bumpEpoch: true },
      accretedMap(live, 5)
    );
    expect(
      rebuilt.prefixes.some((value) => value.includes("cap.example"))
    ).toBe(false);
  });

  test("the rebuilt store decodes every string back at the new epoch", () => {
    const rebuilt = rebuildStringIdMap(
      live,
      { bumpEpoch: true },
      accretedMap(live, 30)
    );
    const { base, tail } = encodeStringStore(rebuilt);
    const strings = createBangStrings([
      base.buffer as ArrayBuffer,
      tail.buffer as ArrayBuffer,
    ]);
    expect(strings.epoch).toBe(rebuilt.meta.epoch);
    for (const entry of live) {
      const prefix = entry.url.replace("{}", "");
      const id = rebuilt.prefixIds.get(prefix);
      expect(id).toBeDefined();
      expect(strings.prefix(id as number)).toBe(prefix);
    }
  });

  test("is deterministic", () => {
    const previous = accretedMap(live, 30);
    const a = rebuildStringIdMap(live, { bumpEpoch: true }, previous);
    const b = rebuildStringIdMap(live, { bumpEpoch: true }, previous);
    expect(a.prefixes).toEqual(b.prefixes);
    expect(a.suffixes).toEqual(b.suffixes);
  });
});
