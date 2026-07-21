import { describe, expect, test } from "bun:test";

import { compileCaptureUrl } from "../src/shared/capture-template";
import { compileSnapTarget } from "../src/shared/snap-target";
import {
  createHotBootState,
  decodeHotBootRecord,
  encodeHotBootRecord,
  materializeCompactBaseSettings,
} from "../src/sw/hot-redirect";
import type { UrlParts } from "../src/sw/redirect";
import {
  compileTriggerSyntax,
  type HotBangLookup,
  type RedirectSettings,
  redirectRaw,
} from "../src/sw/redirect";
import { loadTestBangData } from "./helpers/bang-data";

await loadTestBangData();

const DEFAULT_URL: UrlParts = ["https://www.google.com/search?q=", ""];
const LUCKY_URL: UrlParts = ["https://www.google.com/search?btnI&q=", ""];
const CAPTURE_URL = compileCaptureUrl(
  "https://translate.example/$1/$2",
  "(\\w+)\\s+(.*)",
  "percent"
)!;
const SNAP_TARGET = compileSnapTarget("docs.example.com/reference")!;

function settings(): RedirectSettings {
  return {
    defaultUrl: DEFAULT_URL,
    custom: {
      g: ["https://www.google.com/search?q=", ""],
      tw: ["https://twitter.com/", ""],
      tr: CAPTURE_URL,
      docs: ["https://search.example.com?q=", "", SNAP_TARGET],
      gh: ["https://github.com/search?q=", ""],
      mdn: ["https://developer.mozilla.org/search?q=", ""],
      so: ["https://stackoverflow.com/search?q=", ""],
      w: ["https://en.wikipedia.org/search?q=", ""],
    },
    luckyUrl: LUCKY_URL,
  };
}

const WARMUP = 10_000;
const ITERS = 100_000;

function benchRedirectRaw(
  raw: string,
  s = settings(),
  hotBangLookup?: HotBangLookup
): number {
  for (let i = 0; i < WARMUP; i++) {
    redirectRaw(raw, s, hotBangLookup);
  }
  const t0 = performance.now();
  for (let i = 0; i < ITERS; i++) {
    redirectRaw(raw, s, hotBangLookup);
  }
  return (performance.now() - t0) / ITERS;
}

function hotBootRecord(custom: RedirectSettings["custom"]): string {
  const sourceSettings = { ...settings(), custom };
  const snapshot = {
    custom,
    defaultBang: "g",
    luckyProvider: "default",
    luckyUrl: null,
  };
  return encodeHotBootRecord(
    "fb-perf",
    createHotBootState(snapshot),
    snapshot,
    sourceSettings
  );
}

function benchHotBootDecode(record: string): number {
  const warmup = 100;
  const iterations = 1000;
  for (let i = 0; i < warmup; i++) {
    decodeHotBootRecord(record, "fb-perf");
  }
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) {
    decodeHotBootRecord(record, "fb-perf");
  }
  return (performance.now() - t0) / iterations;
}

describe("redirect performance regression", () => {
  test("canonical hot bang resolution stays under 0.005ms", () => {
    const snapshot = {
      custom: Object.create(null),
      defaultBang: "g",
      luckyProvider: "default",
      luckyUrl: null,
      syntax: compileTriggerSyntax(";", "@"),
    };
    const compactSettings = materializeCompactBaseSettings(snapshot)!;
    const compact = decodeHotBootRecord(
      encodeHotBootRecord(
        "fb-perf",
        createHotBootState(snapshot),
        undefined,
        compactSettings
      ),
      "fb-perf"
    )!;
    expect(
      benchRedirectRaw(
        "%3Bgh+service+workers",
        compact.compactSettings!,
        compact.hotBangLookup
      )
    ).toBeLessThan(0.005);
    expect(
      benchRedirectRaw(
        "service+workers",
        compact.compactSettings!,
        compact.hotBangLookup
      )
    ).toBeLessThan(0.005);
  });

  test("prefix bang redirect stays under 0.005ms", () => {
    const ms = benchRedirectRaw("!g+kittens+are+cute");
    expect(ms).toBeLessThan(0.005);
  });

  test("long query redirect stays under 0.01ms", () => {
    const ms = benchRedirectRaw(`!g+${"a+".repeat(50)}b`);
    expect(ms).toBeLessThan(0.01);
  });

  test("path-based bang redirect stays under 0.005ms", () => {
    const ms = benchRedirectRaw("!tw+hello+world");
    expect(ms).toBeLessThan(0.005);
  });

  test("prefix snap redirect stays under 0.005ms", () => {
    const ms = benchRedirectRaw("@g+kittens");
    expect(ms).toBeLessThan(0.005);
  });

  test("suffix snap redirect stays under 0.005ms", () => {
    const ms = benchRedirectRaw("kittens+@g");
    expect(ms).toBeLessThan(0.005);
  });

  test("four-target prefix snap chain stays under 0.005ms", () => {
    const ms = benchRedirectRaw("@gh,so,mdn,w+service+workers");
    expect(ms).toBeLessThan(0.005);
  });

  test("four-target suffix snap chain stays under 0.005ms", () => {
    const ms = benchRedirectRaw("service+workers+@gh,so,mdn,w");
    expect(ms).toBeLessThan(0.005);
  });

  test("built-in capture redirect stays under 0.01ms", () => {
    const ms = benchRedirectRaw(
      "!ktr+japanese+https%3A%2F%2Fexample.com%2Farticle"
    );
    expect(ms).toBeLessThan(0.01);
  });

  test("custom capture redirect stays under 0.01ms", () => {
    const ms = benchRedirectRaw("!tr+japanese+hello+world");
    expect(ms).toBeLessThan(0.01);
  });

  test("hot-boot custom capture redirect stays under 0.01ms", () => {
    const source = settings();
    const restored = decodeHotBootRecord(
      hotBootRecord(source.custom),
      "fb-perf"
    )!.settings!;
    const ms = benchRedirectRaw("!tr+japanese+hello+world", restored);
    expect(ms).toBeLessThan(0.01);
  });

  test("eight advanced bangs restore from hot boot under 1ms", () => {
    const custom = Object.create(null) as RedirectSettings["custom"];
    for (let i = 0; i < 8; i++) {
      custom[`capture${i}`] = CAPTURE_URL;
    }
    expect(benchHotBootDecode(hotBootRecord(custom))).toBeLessThan(1);
  });

  test("built-in ad snap redirect stays under 0.005ms", () => {
    const ms = benchRedirectRaw("@hn+kittens");
    expect(ms).toBeLessThan(0.005);
  });

  test("custom snap target redirect stays under 0.005ms", () => {
    const ms = benchRedirectRaw("@docs+kittens");
    expect(ms).toBeLessThan(0.005);
  });

  test("configured prefix bang redirect stays under 0.005ms", () => {
    const s = {
      ...settings(),
      syntax: compileTriggerSyntax("$", "~"),
    };
    const ms = benchRedirectRaw("%24g+kittens+are+cute", s);
    expect(ms).toBeLessThan(0.005);
  });

  test("configured prefix snap redirect stays under 0.005ms", () => {
    const s = {
      ...settings(),
      syntax: compileTriggerSyntax("$", "~"),
    };
    const ms = benchRedirectRaw("~g+kittens", s);
    expect(ms).toBeLessThan(0.005);
  });
});
