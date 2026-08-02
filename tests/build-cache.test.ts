import { describe, expect, spyOn, test } from "bun:test";
import {
  main as buildProductionAssets,
  bundleProductionServer,
  bundleServiceWorker,
  createCacheVersion,
  isCloudflarePagesBuild,
  precacheFileInputs,
  promoteBrotliForCloudflarePages,
  requiredAppAssetPaths,
} from "../scripts/build";
import {
  bundleUI,
  configureBangDataAsset,
  configureColdFallbackAsset,
  configureCustomSuggestOption,
  configureFallbackAsset,
  configureHotBangTriggers,
  configureSeedCacheName,
  customSuggestUrlsEnabled,
} from "../scripts/shared";

interface BuildOutputFixture {
  logs?: Array<Error>;
  outputs?: Array<Partial<Bun.BuildArtifact>>;
  success?: boolean;
}

function buildOutput({
  logs = [],
  outputs = [],
  success = true,
}: BuildOutputFixture = {}): Bun.BuildOutput {
  return { logs, outputs, success } as unknown as Bun.BuildOutput;
}

describe("build cache version", () => {
  test("detects Cloudflare Pages builds exactly", () => {
    expect(isCloudflarePagesBuild("1")).toBe(true);
    expect(isCloudflarePagesBuild("true")).toBe(false);
    expect(isCloudflarePagesBuild("")).toBe(false);
  });

  test("promotes a precompressed Pages asset only when enabled", async () => {
    const assetPath = "/pages-encoded-test.bin";
    const outputPath = `dist${assetPath}`;
    const brotliPath = `${outputPath}.br`;
    await Bun.write(outputPath, "identity");
    await Bun.write(brotliPath, "compressed");
    try {
      expect(await promoteBrotliForCloudflarePages(assetPath, false)).toBe(
        false
      );
      expect(await Bun.file(outputPath).text()).toBe("identity");
      expect(await promoteBrotliForCloudflarePages(assetPath, true)).toBe(true);
      expect(await Bun.file(outputPath).text()).toBe("compressed");
      expect(await Bun.file(brotliPath).exists()).toBe(false);
    } finally {
      await Bun.file(outputPath).delete();
      if (await Bun.file(brotliPath).exists()) {
        await Bun.file(brotliPath).delete();
      }
    }
  });

  test("is deterministic regardless of input order", () => {
    const inputs = [
      { path: "/home", bytes: new TextEncoder().encode("home") },
      { path: "/sw.js", bytes: new TextEncoder().encode("worker") },
    ];

    expect(createCacheVersion(inputs)).toBe(
      createCacheVersion(inputs.toReversed())
    );
  });

  test("hashes duplicate paths deterministically", () => {
    const repeated = [
      { path: "/same", bytes: new TextEncoder().encode("first") },
      { path: "/same", bytes: new TextEncoder().encode("second") },
    ];

    expect(createCacheVersion(repeated)).toBe(createCacheVersion(repeated));
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

  test("bundles service worker with cache identity defines", async () => {
    const buildSpy = spyOn(Bun, "build").mockResolvedValue(buildOutput());
    try {
      await bundleServiceWorker(
        "sw.js",
        "fb-test",
        ["/chunk-a.js"],
        "/bangs-a.bin",
        "/fallback-a.js"
      );

      expect(buildSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          entrypoints: ["src/sw/sw.ts"],
          naming: "sw.js",
          target: "browser",
          format: "iife",
          define: expect.objectContaining({
            __BANG_DATA_ASSET__: '"/bangs-a.bin"',
            __FALLBACK_ASSET__: '"/fallback-a.js"',
            __CACHE_VERSION__: '"fb-test"',
            __REQUIRED_APP_ASSETS__: '["/chunk-a.js"]',
            __IS_DEV__: "false",
          }),
        })
      );
    } finally {
      buildSpy.mockRestore();
    }
  });

  test("surfaces service worker and server bundle failures", async () => {
    const buildSpy = spyOn(Bun, "build").mockResolvedValue(
      buildOutput({ logs: [new Error("boom")], success: false })
    );
    try {
      await expect(
        bundleServiceWorker(
          "sw.js",
          "fb-test",
          [],
          "/bangs.bin",
          "/fallback.js"
        )
      ).rejects.toThrow("Failed to bundle sw.js");
      await expect(bundleProductionServer()).rejects.toThrow(
        "Failed to bundle production server"
      );
    } finally {
      buildSpy.mockRestore();
    }
  });

  test("bundles UI and returns the emitted fallback asset", async () => {
    const buildSpy = spyOn(Bun, "build")
      .mockResolvedValueOnce(
        buildOutput({
          outputs: [{ kind: "chunk", path: "dist/chunk-12345678.js" }],
        })
      )
      .mockResolvedValueOnce(buildOutput())
      .mockResolvedValueOnce(
        buildOutput({
          outputs: [{ kind: "entry-point", path: "dist/fallback-abcdef12.js" }],
        })
      )
      .mockResolvedValueOnce(
        buildOutput({
          outputs: [
            { kind: "entry-point", path: "dist/cold-fallback-12345678.js" },
          ],
        })
      );
    try {
      const result = await bundleUI(
        true,
        "/bangs-meta-a.bin",
        "fallback-[hash].js",
        "/bangs-a.bin"
      );
      expect(result.fallbackAsset).toBe("/fallback-abcdef12.js");
      expect(result.coldFallbackAsset).toBe("/cold-fallback-12345678.js");
      expect(result.appOutputs).toHaveLength(2);
      expect(result.appOutputs[0]).toMatchObject({
        kind: "chunk",
        path: "dist/chunk-12345678.js",
      });
      expect(buildSpy).toHaveBeenCalledTimes(4);
    } finally {
      buildSpy.mockRestore();
    }
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

  test("runs the production build workflow with mocked bundles", async () => {
    const buildSpy = spyOn(Bun, "build").mockImplementation(async (config) => {
      const entry = config.entrypoints?.[0];
      const outdir = config.outdir ?? "dist";
      const naming = config.naming ?? "out.js";
      if (entry === "src/ui/app.ts") {
        const path = `${outdir}/app.js`;
        await Bun.write(path, "console.log('app')");
        return buildOutput({ outputs: [{ kind: "entry-point", path }] });
      }
      if (entry === "src/ui/bench/index.ts") {
        const path = `${outdir}/bench.js`;
        await Bun.write(path, "console.log('bench')");
        return buildOutput({ outputs: [{ kind: "entry-point", path }] });
      }
      if (entry === "src/ui/fallback.ts") {
        const path = `${outdir}/${String(naming).replace("[hash]", "abcdef12").replace("[ext]", "js")}`;
        await Bun.write(path, "console.log('fallback')");
        return buildOutput({ outputs: [{ kind: "entry-point", path }] });
      }
      if (entry === "src/ui/cold-fallback.ts") {
        const path = `${outdir}/${String(naming).replace("[hash]", "12345678").replace("[ext]", "js")}`;
        await Bun.write(path, "console.log('cold fallback')");
        return buildOutput({ outputs: [{ kind: "entry-point", path }] });
      }
      if (entry === "src/sw/sw.ts") {
        const path = `${outdir}/${naming}`;
        await Bun.write(
          path,
          `console.log(${config.define?.__CACHE_VERSION__ ?? '"sw"'})`
        );
        return buildOutput({ outputs: [{ kind: "entry-point", path }] });
      }
      if (entry === "scripts/start.ts") {
        const path = `${outdir}/server.js`;
        await Bun.write(path, "console.log('server')");
        return buildOutput({ outputs: [{ kind: "entry-point", path }] });
      }
      throw new Error(`Unexpected build entry ${entry}`);
    });
    const logSpy = spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await buildProductionAssets();
      expect(buildSpy).toHaveBeenCalledTimes(7);
      expect(await Bun.file("dist/_headers").text()).toContain("/sw.js");
      expect([...new Bun.Glob("*.br").scanSync("dist")].length).toBeGreaterThan(
        0
      );
    } finally {
      logSpy.mockRestore();
      buildSpy.mockRestore();
    }
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

  test("requires the build-time insertion marker", () => {
    expect(() =>
      configureCustomSuggestOption("<select></select>", true)
    ).toThrow("Custom suggestion provider marker is missing");
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

  test("replaces the generated cold fallback path marker", () => {
    expect(
      configureColdFallbackAsset(
        '<script src="__COLD_FALLBACK_ASSET__"></script>',
        "/cold-fallback-0123456789ab.js"
      )
    ).toBe('<script src="/cold-fallback-0123456789ab.js"></script>');
  });

  test("replaces the generated hot-trigger marker", () => {
    expect(
      configureHotBangTriggers('const hot="__HOT_BANG_TRIGGERS_JSON__"', [
        "g",
        "gh",
      ])
    ).toBe('const hot=["g","gh"]');
  });

  test("replaces the seed cache marker", () => {
    expect(
      configureSeedCacheName('caches.open("__SEED_CACHE_NAME__")', "seed-v1")
    ).toBe('caches.open("seed-v1")');
  });
});
