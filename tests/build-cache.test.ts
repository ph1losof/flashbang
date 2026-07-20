import { describe, expect, test } from "bun:test";
import {
  createCacheVersion,
  precacheFileInputs,
  requiredAppAssetPaths,
} from "../scripts/build";
import {
  configureBangDataAsset,
  configureCustomSuggestOption,
  configureFallbackAsset,
  customSuggestUrlsEnabled,
} from "../scripts/shared";

describe("build cache version", () => {
  test("is deterministic regardless of input order", () => {
    const inputs = [
      { path: "/home", bytes: new TextEncoder().encode("home") },
      { path: "/sw.js", bytes: new TextEncoder().encode("worker") },
    ];

    expect(createCacheVersion(inputs)).toBe(
      createCacheVersion(inputs.toReversed())
    );
  });

  test("changes for asset paths, asset bytes, and preliminary SW bytes", () => {
    const base = [
      { path: "/home", bytes: new TextEncoder().encode("home") },
      { path: "/sw.js", bytes: new TextEncoder().encode("worker") },
    ];
    const version = createCacheVersion(base);

    expect(
      createCacheVersion([{ path: "/bench", bytes: base[0].bytes }, base[1]])
    ).not.toBe(version);
    expect(
      createCacheVersion([
        { path: "/home", bytes: new TextEncoder().encode("changed") },
        base[1],
      ])
    ).not.toBe(version);
    expect(
      createCacheVersion([
        base[0],
        { path: "/sw.js", bytes: new TextEncoder().encode("changed") },
      ])
    ).not.toBe(version);
  });

  test("maps every concrete core and chunk precache input", () => {
    expect(precacheFileInputs(["/chunk-abc12345.js"])).toEqual([
      ["/bangs.bin", "dist/bangs.bin"],
      ["/home", "dist/home.html"],
      ["/bench", "dist/bench.html"],
      ["/bench.js", "dist/bench.js"],
      ["/app.js", "dist/app.js"],
      ["/fallback.js", "dist/fallback.js"],
      ["/icon.svg", "dist/icon.svg"],
      ["/manifest.json", "dist/manifest.json"],
      ["/chunk-abc12345.js", "dist/chunk-abc12345.js"],
    ]);
  });

  test("maps a content-hashed binary asset", () => {
    expect(precacheFileInputs([], "/bangs-0123456789ab.bin")[0]).toEqual([
      "/bangs-0123456789ab.bin",
      "dist/bangs-0123456789ab.bin",
    ]);
  });

  test("maps a content-hashed fallback asset", () => {
    expect(
      precacheFileInputs(
        [],
        "/bangs-0123456789ab.bin",
        "/fallback-abcdef123456.js"
      )[5]
    ).toEqual(["/fallback-abcdef123456.js", "dist/fallback-abcdef123456.js"]);
  });

  test("requires every app dependency regardless of output size", () => {
    expect(
      requiredAppAssetPaths([
        { kind: "entry-point", path: "/tmp/dist/app.js" },
        {
          kind: "chunk",
          path: "/tmp/dist/chunk-catalog123.js",
          size: 900_000,
        },
        { kind: "asset", path: "/tmp/dist/app-icon.svg" },
        { kind: "sourcemap", path: "/tmp/dist/app.js.map" },
      ])
    ).toEqual(["/app-icon.svg", "/chunk-catalog123.js"]);
  });
});

describe("custom suggestion build flag", () => {
  const source =
    '<select><!-- custom-suggest-provider-option --><option value="none">None</option></select>';

  test("only the exact value true enables custom suggestion URLs", () => {
    expect(customSuggestUrlsEnabled("true")).toBe(true);
    expect(customSuggestUrlsEnabled("false")).toBe(false);
    expect(customSuggestUrlsEnabled("TRUE")).toBe(false);
    expect(customSuggestUrlsEnabled("1")).toBe(false);
  });

  test("omits the custom provider from disabled builds", () => {
    const html = configureCustomSuggestOption(source, false);
    expect(html).not.toContain('value="custom"');
    expect(html).not.toContain("custom-suggest-provider-option");
  });

  test("includes the custom provider in enabled builds", () => {
    const html = configureCustomSuggestOption(source, true);
    expect(html).toContain('<option value="custom">Custom</option>');
    expect(html).not.toContain("custom-suggest-provider-option");
  });
});

describe("bang data asset injection", () => {
  test("replaces the generated binary path marker", () => {
    expect(
      configureBangDataAsset(
        '<link href="__BANG_DATA_ASSET__">',
        "/bangs-0123456789ab.bin"
      )
    ).toBe('<link href="/bangs-0123456789ab.bin">');
  });

  test("replaces the generated fallback path marker", () => {
    expect(
      configureFallbackAsset(
        '<script src="__FALLBACK_ASSET__"></script>',
        "/fallback-0123456789ab.js"
      )
    ).toBe('<script src="/fallback-0123456789ab.js"></script>');
  });
});
