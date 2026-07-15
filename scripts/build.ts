import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { brotliCompressSync, constants } from "node:zlib";
import { ensureGeneratedBangData } from "./codegen";
import {
  assembleUIAssets,
  bundleUI,
  customSuggestUrlsEnabled,
  generateCSS,
} from "./shared";

const SIZE_THRESHOLD = 50 * 1024; // 50 KB
const PRELIMINARY_SW_PATH = "dist/sw-cache-input.js";

export interface CacheVersionInput {
  bytes: Uint8Array;
  path: string;
}

export function createCacheVersion(
  inputs: readonly CacheVersionInput[]
): string {
  const hash = createHash("sha256");
  const sorted = [...inputs].sort((a, b) => {
    if (a.path === b.path) {
      return 0;
    }
    return a.path < b.path ? -1 : 1;
  });

  for (const input of sorted) {
    hash.update(
      `${input.path.length}:${input.path}:${input.bytes.byteLength}:`
    );
    hash.update(input.bytes);
  }

  return `fb-${hash.digest("hex").slice(0, 8)}`;
}

export function precacheFileInputs(
  extraAssets: readonly string[]
): ReadonlyArray<readonly [assetPath: string, filePath: string]> {
  return [
    ["/home", "dist/home.html"],
    ["/bench", "dist/bench.html"],
    ["/bench.js", "dist/bench.js"],
    ["/app.js", "dist/app.js"],
    ["/icon.svg", "dist/icon.svg"],
    ["/manifest.json", "dist/manifest.json"],
    ...extraAssets.map(
      (assetPath) => [assetPath, `dist/${assetPath.substring(1)}`] as const
    ),
  ];
}

async function bundleServiceWorker(
  naming: string,
  cacheVersion: string,
  extraAssets: readonly string[]
): Promise<void> {
  const result = await Bun.build({
    entrypoints: ["src/sw/sw.ts"],
    outdir: "dist",
    naming,
    minify: true,
    target: "browser",
    format: "esm",
    define: {
      __CACHE_VERSION__: JSON.stringify(cacheVersion),
      __EXTRA_ASSETS__: JSON.stringify(extraAssets),
      __IS_DEV__: JSON.stringify(false),
    },
  });
  if (!result.success) {
    throw new AggregateError(result.logs, `Failed to bundle ${naming}`);
  }
}

async function main(): Promise<void> {
  await ensureGeneratedBangData(true);
  const allowUnsafeCustomSuggestUrls = customSuggestUrlsEnabled();
  console.log(
    `Custom suggestion URLs: ${allowUnsafeCustomSuggestUrls ? "enabled" : "disabled"}`
  );

  // Start from a clean dist to avoid stale artifacts (e.g. orphaned .br chunks).
  await rm("dist", { recursive: true, force: true });
  await mkdir("dist", { recursive: true });

  console.log("=== Bundle app + bench (to discover chunks) ===");
  const allOutputs = await bundleUI(allowUnsafeCustomSuggestUrls);
  const extraAssets = [
    ...new Set(
      allOutputs
        .filter(
          (output) =>
            !(
              output.path.endsWith("/app.js") ||
              output.path.endsWith("/bench.js")
            ) && output.size < SIZE_THRESHOLD
        )
        .map((output) => `/${output.path.split("/").pop()!}`)
    ),
  ].sort();

  if (extraAssets.length) {
    console.log(`Extra assets: ${extraAssets.join(", ")}`);
  }

  console.log("=== Generate CSS ===");
  await generateCSS();

  console.log("=== Inline CSS + minify HTML ===");
  await assembleUIAssets(allowUnsafeCustomSuggestUrls);
  await rm("dist/styles.css");

  console.log("=== Compute service worker cache version ===");
  // This fixed placeholder bundle captures SW implementation and bang-data
  // changes without introducing the final cache version into its own hash.
  await bundleServiceWorker(
    "sw-cache-input.js",
    "fb-cache-version-input",
    extraAssets
  );
  const cacheInputs: CacheVersionInput[] = await Promise.all(
    precacheFileInputs(extraAssets).map(async ([assetPath, filePath]) => ({
      path: assetPath,
      bytes: await Bun.file(filePath).bytes(),
    }))
  );
  cacheInputs.push({
    path: "/sw.js",
    bytes: await Bun.file(PRELIMINARY_SW_PATH).bytes(),
  });
  const cacheVersion = createCacheVersion(cacheInputs);
  await rm(PRELIMINARY_SW_PATH);
  console.log(`Cache version: ${cacheVersion}`);

  console.log("=== Bundle service worker ===");
  await bundleServiceWorker("sw.js", cacheVersion, extraAssets);

  console.log("=== Generate _headers with CSP ===");
  function extractScriptHashes(html: string): string[] {
    const hashes: string[] = [];
    const re = /<script>([\s\S]*?)<\/script>/g;
    for (const match of html.matchAll(re)) {
      const hash = createHash("sha256").update(match[1]).digest("base64");
      hashes.push(`'sha256-${hash}'`);
    }
    return hashes;
  }
  const distIndex = await Bun.file("dist/index.html").text();
  const distHome = await Bun.file("dist/home.html").text();
  const distBench = await Bun.file("dist/bench.html").text();
  const scriptHashes = [
    ...extractScriptHashes(distIndex),
    ...extractScriptHashes(distHome),
    ...extractScriptHashes(distBench),
  ];
  const { pageHeaders, SW_CSP } = await import("../src/server/headers");
  const { "Content-Security-Policy": pageCsp, ...baseHeaders } = pageHeaders(
    scriptHashes.join(" ")
  );
  // CSP is set per-path (not /*) to avoid CF Pages additive header merging.
  const securityHeaders = Object.entries(baseHeaders)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n  ");
  const pageCspHeader = `Content-Security-Policy: ${pageCsp}`;
  const swCspHeader = `Content-Security-Policy: ${SW_CSP}`;
  await Bun.write(
    "dist/_headers",
    [
      "/*",
      `  ${securityHeaders}`,
      "",
      "/",
      `  ${pageCspHeader}`,
      "",
      "/index.html",
      `  ${pageCspHeader}`,
      "",
      "/home.html",
      `  ${pageCspHeader}`,
      "",
      "/bench.html",
      `  ${pageCspHeader}`,
      "",
      "/sw.js",
      `  ${swCspHeader}`,
      "",
      "/opensearch.xml",
      "  Content-Type: application/opensearchdescription+xml",
      "",
    ].join("\n")
  );

  console.log("=== Pre-compress static assets ===");
  for (const file of new Bun.Glob("*.{html,js,svg,json,txt}").scanSync(
    "dist"
  )) {
    const content = await Bun.file(`dist/${file}`).bytes();

    const br = brotliCompressSync(content, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
      },
    });
    await Bun.write(`dist/${file}.br`, br);
  }

  console.log("=== Done ===");
  for (const f of new Bun.Glob("*").scanSync("dist")) {
    const size = Bun.file(`dist/${f}`).size;
    const kb = (size / 1024).toFixed(1);
    console.log(`  ${f.padEnd(30)} ${kb} KB`);
  }
}

if (import.meta.main) {
  await main();
}
