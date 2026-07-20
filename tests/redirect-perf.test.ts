import { describe, expect, test } from "bun:test";

import { compileCaptureUrl } from "../src/shared/capture-template";
import { compileSnapTarget } from "../src/shared/snap-target";
import type { UrlParts } from "../src/sw/redirect";
import {
  compileTriggerSyntax,
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

function benchRedirectRaw(raw: string, s = settings()): number {
  for (let i = 0; i < WARMUP; i++) {
    redirectRaw(raw, s);
  }
  const t0 = performance.now();
  for (let i = 0; i < ITERS; i++) {
    redirectRaw(raw, s);
  }
  return (performance.now() - t0) / ITERS;
}

describe("redirect performance regression", () => {
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
