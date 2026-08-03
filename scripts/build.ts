import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { basename } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";
import {
  FALLBACK_SHELL_HEADERS,
  pageHeaders,
  SW_CSP,
} from "../src/server/headers";
import { ensureGeneratedBangData, generateBinaryShards } from "./codegen";
import { extractInlineScriptHashes } from "./inline-script-hash";
import {
  assembleUIAssets,
  bundleUI,
  customSuggestUrlsEnabled,
  DIST_DIR,
  generateCSS,
} from "./shared";

const PRELIMINARY_SW_PATH = `${DIST_DIR}/sw-cache-input.js`;
const SERVER_DIST_DIR = `${DIST_DIR}-server`;

export function isCloudflarePagesBuild(value = process.env.CF_PAGES): boolean {
  return value === "1";
}

export async function promoteBrotliForCloudflarePages(
  assetPath: string,
  enabled = isCloudflarePagesBuild()
): Promise<boolean> {
  if (!enabled) {
    return false;
  }
  if (!(assetPath.startsWith("/") && !assetPath.includes(".."))) {
    throw new Error(`Invalid Pages asset path: ${assetPath}`);
  }
  const outputPath = `${DIST_DIR}${assetPath}`;
  const brotliPath = `${outputPath}.br`;
  if (!(await Bun.file(brotliPath).exists())) {
    throw new Error(`Missing precompressed Pages asset: ${brotliPath}`);
  }
  await Bun.write(outputPath, Bun.file(brotliPath));
  await rm(brotliPath);
  return true;
}

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
  requiredAppAssets: readonly string[],
  bangDataAsset = "/bangs.bin",
  fallbackAsset = "/fallback.js"
): ReadonlyArray<readonly [assetPath: string, filePath: string]> {
  return [
    [bangDataAsset, `${DIST_DIR}${bangDataAsset}`],
    ["/home", `${DIST_DIR}/home.html`],
    ["/bench", `${DIST_DIR}/bench.html`],
    ["/bench.js", `${DIST_DIR}/bench.js`],
    ["/app.js", `${DIST_DIR}/app.js`],
    [fallbackAsset, `${DIST_DIR}${fallbackAsset}`],
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

export async function bundleServiceWorker(
  naming: string,
  cacheVersion: string,
  requiredAppAssets: readonly string[],
  bangDataAsset: string,
  fallbackAsset: string,
  bangShardRouter: ArrayLike<number> = [],
  bangShardVersion = ""
): Promise<void> {
  const result = await Bun.build({
    entrypoints: ["src/sw/sw.ts"],
    outdir: DIST_DIR,
    naming,
    minify: true,
    target: "browser",
    format: "iife",
    define: {
      __BANG_DATA_ASSET__: JSON.stringify(bangDataAsset),
      __BANG_SHARD_ROUTER__: JSON.stringify(Array.from(bangShardRouter)),
      __BANG_SHARD_VERSION__: JSON.stringify(bangShardVersion),
      __FALLBACK_ASSET__: JSON.stringify(fallbackAsset),
      __CACHE_VERSION__: JSON.stringify(cacheVersion),
      __REQUIRED_APP_ASSETS__: JSON.stringify(requiredAppAssets),
      __IS_DEV__: JSON.stringify(false),
    },
  });
  if (!result.success) {
    throw new AggregateError(result.logs, `Failed to bundle ${naming}`);
  }
}

export async function bundleProductionServer(): Promise<void> {
  const result = await Bun.build({
    entrypoints: ["scripts/start.ts"],
    outdir: SERVER_DIST_DIR,
    naming: "server.js",
    minify: true,
    target: "bun",
    format: "esm",
    loader: { ".bin": "file" },
    define: { __BUNDLED_BANG_TRIE__: "true" },
  });
  if (!result.success) {
    throw new AggregateError(result.logs, "Failed to bundle production server");
  }
}

export async function main(): Promise<void> {
  await ensureGeneratedBangData(true);
  const allowUnsafeCustomSuggestUrls = customSuggestUrlsEnabled();
  console.log(
    `Custom suggestion URLs: ${allowUnsafeCustomSuggestUrls ? "enabled" : "disabled"}`
  );

  // Start from a clean dist to avoid stale artifacts (e.g. orphaned .br chunks).
  await Promise.all([
    rm(DIST_DIR, { recursive: true, force: true }),
    rm(SERVER_DIST_DIR, { recursive: true, force: true }),
  ]);
  await Promise.all([
    mkdir(DIST_DIR, { recursive: true }),
    mkdir(SERVER_DIST_DIR, { recursive: true }),
  ]);
  const bangDataBytes = await Bun.file("src/generated/bangs.bin").bytes();
  const bangDataHash = createHash("sha256")
    .update(bangDataBytes)
    .digest("hex")
    .slice(0, 12);
  const bangDataAsset = `/bangs-${bangDataHash}.bin`;
  await Bun.write(`${DIST_DIR}${bangDataAsset}`, bangDataBytes);
  const { router: bangShardRouter, shards: bangShardBytes } =
    generateBinaryShards(await Bun.file("data/bangs.json").json());
  const bangShardHash = createHash("sha256").update(bangShardRouter);
  for (const bytes of bangShardBytes) {
    bangShardHash.update(`${bytes.byteLength}:`);
    bangShardHash.update(bytes);
  }
  const bangShardVersion = bangShardHash.digest("hex").slice(0, 12);
  const bangShardAssets = bangShardBytes.map(
    (_, shard) => `/bangs-s${shard.toString(36)}-${bangShardVersion}.bin`
  );
  await Promise.all(
    bangShardBytes.map((bytes, shard) =>
      Bun.write(`${DIST_DIR}${bangShardAssets[shard]}`, bytes)
    )
  );
  const bangMetaBytes = await Bun.file("src/generated/bangs-meta.bin").bytes();
  const bangMetaHash = createHash("sha256")
    .update(bangMetaBytes)
    .digest("hex")
    .slice(0, 12);
  const bangMetaAsset = `/bangs-meta-${bangMetaHash}.bin`;
  await Bun.write(`${DIST_DIR}${bangMetaAsset}`, bangMetaBytes);

  console.log("=== Bundle app + bench (to discover chunks) ===");
  const { appOutputs, fallbackAsset, coldFallbackAsset } = await bundleUI(
    allowUnsafeCustomSuggestUrls,
    bangMetaAsset,
    "fallback-[hash].[ext]",
    bangDataAsset,
    bangShardRouter,
    bangShardVersion
  );
  const requiredAppAssets = [
    ...requiredAppAssetPaths(appOutputs),
    bangMetaAsset,
    coldFallbackAsset,
  ].sort();

  if (requiredAppAssets.length) {
    console.log(`Required app assets: ${requiredAppAssets.join(", ")}`);
  }

  console.log("=== Generate CSS ===");
  await generateCSS();

  console.log("=== Inline CSS + minify HTML ===");
  await assembleUIAssets(
    allowUnsafeCustomSuggestUrls,
    bangDataAsset,
    fallbackAsset,
    coldFallbackAsset,
    bangShardRouter,
    bangShardVersion
  );
  await rm(`${DIST_DIR}/styles.css`);

  const [distIndex, distHome, distBench] = await Promise.all(
    ["index.html", "home.html", "bench.html"].map((name) =>
      Bun.file(`${DIST_DIR}/${name}`).text()
    )
  );
  const scriptHashes = [distIndex, distHome, distBench].flatMap(
    extractInlineScriptHashes
  );
  console.log("=== Compute service worker cache version ===");
  // This fixed placeholder bundle captures SW implementation and bang-data
  // changes without introducing the final cache version into its own hash.
  await bundleServiceWorker(
    "sw-cache-input.js",
    "fb-cache-version-input",
    requiredAppAssets,
    bangDataAsset,
    fallbackAsset,
    bangShardRouter,
    bangShardVersion
  );
  const cacheInputs: CacheVersionInput[] = await Promise.all(
    precacheFileInputs(requiredAppAssets, bangDataAsset, fallbackAsset).map(
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
  await bundleServiceWorker(
    "sw.js",
    cacheVersion,
    requiredAppAssets,
    bangDataAsset,
    fallbackAsset,
    bangShardRouter,
    bangShardVersion
  );

  console.log("=== Bundle production server ===");
  await bundleProductionServer();

  console.log("=== Generate _headers with CSP ===");
  const { "Content-Security-Policy": pageCsp, ...baseHeaders } = pageHeaders(
    scriptHashes.join(" ")
  );
  // CSP is set per-path (not /*) to avoid CF Pages additive header merging.
  const securityHeaders = Object.entries(baseHeaders)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n  ");
  const pageCspHeader = `Content-Security-Policy: ${pageCsp}`;
  const swCspHeader = `Content-Security-Policy: ${SW_CSP}`;
  const fallbackShellHeaders = Object.entries(FALLBACK_SHELL_HEADERS).map(
    ([key, value]) => `  ${key}: ${value}`
  );
  const pagesEncodedBangData = isCloudflarePagesBuild();
  const bangDataHeaders = pagesEncodedBangData
    ? [
        "  Cache-Control: public, max-age=31536000, immutable, no-transform",
        "  Content-Encoding: br",
        "  Content-Type: application/octet-stream",
      ]
    : ["  Cache-Control: public, max-age=31536000, immutable"];
  await Bun.write(
    `${DIST_DIR}/_headers`,
    [
      "/*",
      `  ${securityHeaders}`,
      "",
      "/",
      `  ${pageCspHeader}`,
      ...fallbackShellHeaders,
      "",
      "/index.html",
      `  ${pageCspHeader}`,
      ...fallbackShellHeaders,
      "",
      "/home.html",
      `  ${pageCspHeader}`,
      "",
      "/bench.html",
      `  ${pageCspHeader}`,
      "",
      "/bench",
      `  ${pageCspHeader}`,
      "",
      "/sw.js",
      `  ${swCspHeader}`,
      "",
      bangDataAsset,
      ...bangDataHeaders,
      "",
      bangMetaAsset,
      "  Cache-Control: public, max-age=31536000, immutable",
      "",
      fallbackAsset,
      "  Cache-Control: public, max-age=31536000, immutable",
      "",
      "/opensearch.xml",
      "  Content-Type: application/opensearchdescription+xml",
      "",
    ].join("\n")
  );

  console.log("=== Pre-compress static assets ===");
  for (const file of new Bun.Glob("*.{bin,html,js,svg,json,txt}").scanSync(
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

  if (
    await promoteBrotliForCloudflarePages(bangDataAsset, pagesEncodedBangData)
  ) {
    console.log(
      `Embedded Brotli catalog for Cloudflare Pages: ${bangDataAsset}`
    );
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
