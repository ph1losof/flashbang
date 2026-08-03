import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { basename } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";
import {
  FALLBACK_SHELL_HEADERS,
  pageHeaders,
  SW_CSP,
} from "../src/server/headers";
import {
  BANG_INDEX_PACK_MAGIC,
  BANG_INDEX_PACK_VERSION,
  BANG_INDEX_SHARDS_PER_PACK,
} from "../src/shared/bang-binary-format";
import { loadStringIdMap } from "./bang-strings-build";
import { ensureGeneratedBangData, generateCatalog } from "./codegen";
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

export function packBangIndexShards(
  shards: readonly Uint8Array[],
  shardsPerPack = BANG_INDEX_SHARDS_PER_PACK
): Uint8Array[] {
  if (!Number.isInteger(shardsPerPack) || shardsPerPack <= 0) {
    throw new Error("Index shards per pack must be a positive integer");
  }
  const packs: Uint8Array[] = [];
  for (let start = 0; start < shards.length; start += shardsPerPack) {
    const group = shards.slice(start, start + shardsPerPack);
    const headerBytes = (group.length + 4) * Uint32Array.BYTES_PER_ELEMENT;
    const byteLength =
      headerBytes + group.reduce((total, shard) => total + shard.byteLength, 0);
    const pack = new Uint8Array(byteLength);
    const header = new Uint32Array(pack.buffer, 0, group.length + 4);
    header[0] = BANG_INDEX_PACK_MAGIC;
    header[1] = BANG_INDEX_PACK_VERSION;
    header[2] = group.length;
    let offset = headerBytes;
    for (let i = 0; i < group.length; i++) {
      header[i + 3] = offset;
      pack.set(group[i], offset);
      offset += group[i].byteLength;
    }
    header[group.length + 3] = offset;
    packs.push(pack);
  }
  return packs;
}

export interface CatalogPerformanceSizes {
  coldFallbackBrotli: number;
  indexPackBrotli: readonly number[];
  monolithBrotli: number;
  storeBrotli: number;
  serviceWorkerBrotli: number;
}

/**
 * Keep the optimized catalog inside the measured transfer-size envelope.
 * Absolute limits protect the first-search code path; ratios scale with future
 * catalog growth and preserve the on-demand/full-offline tradeoff.
 */
export function assertCatalogPerformanceBudgets(
  sizes: CatalogPerformanceSizes
): void {
  const fail = (label: string, actual: number, limit: number): void => {
    if (actual > limit) {
      throw new Error(
        `${label} performance budget exceeded: ${actual} B > ${Math.floor(limit)} B`
      );
    }
  };
  if (sizes.indexPackBrotli.length === 0) {
    throw new Error("Catalog performance budget requires index packs");
  }
  fail("Cold fallback Brotli", sizes.coldFallbackBrotli, 7 * 1024);
  fail("Service worker Brotli", sizes.serviceWorkerBrotli, 19 * 1024);
  fail("Index pack count", sizes.indexPackBrotli.length, 15);

  const largestPack = Math.max(...sizes.indexPackBrotli);
  const allPacks = sizes.indexPackBrotli.reduce(
    (total, size) => total + size,
    0
  );
  fail(
    "First-demand catalog Brotli",
    sizes.storeBrotli + largestPack,
    sizes.monolithBrotli * 0.75
  );
  fail(
    "Full offline catalog Brotli",
    sizes.storeBrotli + allPacks,
    sizes.monolithBrotli * 1.1
  );
}

export async function bundleServiceWorker(
  naming: string,
  cacheVersion: string,
  requiredAppAssets: readonly string[],
  bangDataAsset: string,
  fallbackAsset: string,
  bangShardRouter: ArrayLike<number> = [],
  bangShardAssets: readonly string[] = [],
  bangIndexAssets: readonly string[] = [],
  bangStoreAssets: readonly string[] = [],
  bangIndexShardsPerAsset = 1
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
      __BANG_SHARD_ASSETS__: JSON.stringify(bangShardAssets),
      __BANG_INDEX_ASSETS__: JSON.stringify(bangIndexAssets),
      __BANG_INDEX_SHARDS_PER_ASSET__: JSON.stringify(bangIndexShardsPerAsset),
      __BANG_STORE_ASSETS__: JSON.stringify(bangStoreAssets),
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
  const catalog = generateCatalog(
    await Bun.file("data/bangs.json").json(),
    loadStringIdMap()
  );
  const bangShardRouter = catalog.router;
  // Per-shard content hash, so only the shards whose bytes changed get a new
  // URL. A version shared across shards rotates all 43 on any catalog change.
  const contentAsset = (bytes: Uint8Array, name: string): string => {
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
    return `/${name}-${hash}.bin`;
  };
  const bangShardAssets = catalog.cold.map((bytes, shard) =>
    contentAsset(bytes, `bangs-s${shard.toString(36)}`)
  );
  const bangIndexPacks = packBangIndexShards(catalog.index);
  const bangIndexAssets = bangIndexPacks.map((bytes, pack) =>
    contentAsset(bytes, `bangs-ip${pack.toString(36)}`)
  );
  const bangStoreAssets = [
    contentAsset(catalog.storeBase, "bangs-str"),
    contentAsset(catalog.storeTail, "bangs-str"),
  ];
  await Promise.all([
    ...catalog.cold.map((bytes, shard) =>
      Bun.write(`${DIST_DIR}${bangShardAssets[shard]}`, bytes)
    ),
    ...bangIndexPacks.map((bytes, pack) =>
      Bun.write(`${DIST_DIR}${bangIndexAssets[pack]}`, bytes)
    ),
    Bun.write(`${DIST_DIR}${bangStoreAssets[0]}`, catalog.storeBase),
    Bun.write(`${DIST_DIR}${bangStoreAssets[1]}`, catalog.storeTail),
  ]);
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
    bangShardAssets
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
    bangShardAssets
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
    bangShardAssets,
    bangIndexAssets,
    bangStoreAssets,
    BANG_INDEX_SHARDS_PER_PACK
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
    bangShardAssets,
    bangIndexAssets,
    bangStoreAssets,
    BANG_INDEX_SHARDS_PER_PACK
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
      // Use exact cold-shard paths: `/bangs-s*` also matches the
      // `/bangs-str-*` string store under Pages' additive wildcard rules,
      // duplicating Content-Encoding and making a once-compressed body invalid.
      ...bangShardAssets.flatMap((asset) => [asset, ...bangDataHeaders, ""]),
      "/bangs-i*",
      ...bangDataHeaders,
      "",
      "/bangs-str-*",
      ...bangDataHeaders,
      "",
      fallbackAsset,
      "  Cache-Control: public, max-age=31536000, immutable",
      "",
      coldFallbackAsset,
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

  const brotliSize = (asset: string): number =>
    Bun.file(`${DIST_DIR}${asset}.br`).size;
  assertCatalogPerformanceBudgets({
    coldFallbackBrotli: brotliSize(coldFallbackAsset),
    indexPackBrotli: bangIndexAssets.map(brotliSize),
    monolithBrotli: brotliSize(bangDataAsset),
    serviceWorkerBrotli: brotliSize("/sw.js"),
    storeBrotli: bangStoreAssets.reduce(
      (total, asset) => total + brotliSize(asset),
      0
    ),
  });

  if (
    await promoteBrotliForCloudflarePages(bangDataAsset, pagesEncodedBangData)
  ) {
    console.log(
      `Embedded Brotli catalog for Cloudflare Pages: ${bangDataAsset}`
    );
  }
  if (pagesEncodedBangData) {
    const promoted = [
      ...bangShardAssets,
      ...bangIndexAssets,
      ...bangStoreAssets,
    ];
    for (const asset of promoted) {
      await promoteBrotliForCloudflarePages(asset, true);
    }
    console.log(
      `Embedded Brotli catalog artifacts for Cloudflare Pages: ${promoted.length}`
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
