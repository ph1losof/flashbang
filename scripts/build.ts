import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { basename } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";
import { ensureGeneratedBangData } from "./codegen";
import {
  assembleUIAssets,
  bundleUI,
  customSuggestUrlsEnabled,
  DIST_DIR,
  generateCSS,
} from "./shared";

const PRELIMINARY_SW_PATH = `${DIST_DIR}/sw-cache-input.js`;

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
  requiredAppAssets: readonly string[]
): ReadonlyArray<readonly [assetPath: string, filePath: string]> {
  return [
    ["/home", `${DIST_DIR}/home.html`],
    ["/bench", `${DIST_DIR}/bench.html`],
    ["/bench.js", `${DIST_DIR}/bench.js`],
    ["/app.js", `${DIST_DIR}/app.js`],
    ["/icon.svg", `${DIST_DIR}/icon.svg`],
    ["/manifest.json", `${DIST_DIR}/manifest.json`],
    ...requiredAppAssets.map(
      (assetPath) =>
        [assetPath, `${DIST_DIR}/${assetPath.substring(1)}`] as const
    ),
  ];
}

export function requiredAppAssetPaths(
  outputs: readonly { kind: string; path: string; size?: number }[]
): string[] {
  return [
    ...new Set(
      outputs
        .filter((output) => output.kind === "chunk" || output.kind === "asset")
        .map((output) => `/${basename(output.path)}`)
    ),
  ].sort();
}

async function bundleServiceWorker(
  naming: string,
  cacheVersion: string,
  requiredAppAssets: readonly string[]
): Promise<void> {
  const result = await Bun.build({
    entrypoints: ["src/sw/sw.ts"],
    outdir: DIST_DIR,
    naming,
    minify: true,
    target: "browser",
    format: "esm",
    define: {
      __CACHE_VERSION__: JSON.stringify(cacheVersion),
      __REQUIRED_APP_ASSETS__: JSON.stringify(requiredAppAssets),
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
  await rm(DIST_DIR, { recursive: true, force: true });
  await mkdir(DIST_DIR, { recursive: true });

  console.log("=== Bundle app + bench (to discover chunks) ===");
  const { appOutputs } = await bundleUI(allowUnsafeCustomSuggestUrls);
  const requiredAppAssets = requiredAppAssetPaths(appOutputs);

  if (requiredAppAssets.length) {
    console.log(`Required app assets: ${requiredAppAssets.join(", ")}`);
  }

  console.log("=== Generate CSS ===");
  await generateCSS();

  console.log("=== Inline CSS + minify HTML ===");
  await assembleUIAssets(allowUnsafeCustomSuggestUrls);
  await rm(`${DIST_DIR}/styles.css`);

  console.log("=== Compute service worker cache version ===");
  // This fixed placeholder bundle captures SW implementation and bang-data
  // changes without introducing the final cache version into its own hash.
  await bundleServiceWorker(
    "sw-cache-input.js",
    "fb-cache-version-input",
    requiredAppAssets
  );
  const cacheInputs: CacheVersionInput[] = await Promise.all(
    precacheFileInputs(requiredAppAssets).map(
      async ([assetPath, filePath]) => ({
        path: assetPath,
        bytes: await Bun.file(filePath).bytes(),
      })
    )
  );
  cacheInputs.push({
    path: "/sw.js",
    bytes: await Bun.file(PRELIMINARY_SW_PATH).bytes(),
  });
  const cacheVersion = createCacheVersion(cacheInputs);
  await rm(PRELIMINARY_SW_PATH);
  console.log(`Cache version: ${cacheVersion}`);

  console.log("=== Bundle service worker ===");
  await bundleServiceWorker("sw.js", cacheVersion, requiredAppAssets);

  console.log("=== Generate _headers with CSP ===");
  function extractScriptHashes(html: string): string[] {
    const hashes: string[] = [];
    const re = /<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/gi;
    for (const match of html.matchAll(re)) {
      if (!match[1]) {
        continue;
      }
      const hash = createHash("sha256").update(match[1]).digest("base64");
      hashes.push(`'sha256-${hash}'`);
    }
    return hashes;
  }
  const distIndex = await Bun.file(`${DIST_DIR}/index.html`).text();
  const distHome = await Bun.file(`${DIST_DIR}/home.html`).text();
  const distBench = await Bun.file(`${DIST_DIR}/bench.html`).text();
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
    `${DIST_DIR}/_headers`,
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
    DIST_DIR
  )) {
    const content = await Bun.file(`${DIST_DIR}/${file}`).bytes();

    const br = brotliCompressSync(content, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
      },
    });
    await Bun.write(`${DIST_DIR}/${file}.br`, br);
  }

  console.log("=== Done ===");
  for (const f of new Bun.Glob("*").scanSync(DIST_DIR)) {
    const size = Bun.file(`${DIST_DIR}/${f}`).size;
    const kb = (size / 1024).toFixed(1);
    console.log(`  ${f.padEnd(30)} ${kb} KB`);
  }
}

if (import.meta.main) {
  await main();
}
