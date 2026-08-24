import { basename } from "node:path";
import { minify } from "@minify-html/node";
import { build as buildCSS } from "@unocss/cli";
import {
  BANG_SHARD_COUNT,
  BANG_SHARD_ROUTER_SIZE,
} from "../src/shared/bang-shards";
import { SEED_CACHE_NAME } from "../src/shared/seed-cache";

const CUSTOM_SUGGEST_OPTION_MARKER = "<!-- custom-suggest-provider-option -->";
const CUSTOM_SUGGEST_OPTION = '<option value="custom">Custom</option>';
const BANG_DATA_ASSET_MARKER = "__BANG_DATA_ASSET__";
const FALLBACK_ASSET_MARKER = "__FALLBACK_ASSET__";
const COLD_FALLBACK_ASSET_MARKER = "__COLD_FALLBACK_ASSET__";
const BANG_SHARD_ROUTER_MARKER = '"__BANG_SHARD_ROUTER_JSON__"';
const BANG_SHARD_ASSETS_MARKER = '"__BANG_SHARD_ASSETS_JSON__"';
const HOT_BANG_TRIGGERS_MARKER = '"__HOT_BANG_TRIGGERS_JSON__"';
const SEED_CACHE_NAME_MARKER = "__SEED_CACHE_NAME__";
export const DIST_DIR = process.env.DIST_DIR || "dist";

export function customSuggestUrlsEnabled(
  value = process.env.ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS
): boolean {
  return value === "true";
}

export function configureCustomSuggestOption(
  html: string,
  enabled: boolean
): string {
  if (!html.includes(CUSTOM_SUGGEST_OPTION_MARKER)) {
    throw new Error("Custom suggestion provider marker is missing");
  }
  return html.replace(
    CUSTOM_SUGGEST_OPTION_MARKER,
    enabled ? CUSTOM_SUGGEST_OPTION : ""
  );
}

export function configureBangDataAsset(
  html: string,
  assetPath: string
): string {
  return html.replaceAll(BANG_DATA_ASSET_MARKER, assetPath);
}

export function configureFallbackAsset(
  html: string,
  assetPath: string
): string {
  return html.replaceAll(FALLBACK_ASSET_MARKER, assetPath);
}

export function configureColdFallbackAsset(
  html: string,
  assetPath: string
): string {
  return html.replaceAll(COLD_FALLBACK_ASSET_MARKER, assetPath);
}

export function configureBangShardLayout(
  html: string,
  router: ArrayLike<number>,
  assets: readonly string[]
): string {
  if (router.length !== BANG_SHARD_ROUTER_SIZE) {
    throw new Error(`Expected ${BANG_SHARD_ROUTER_SIZE} bang shard routes`);
  }
  const routes = Array.from(router);
  if (
    routes.some(
      (shard) =>
        !Number.isInteger(shard) || shard < 0 || shard >= BANG_SHARD_COUNT
    )
  ) {
    throw new Error("Invalid bang shard route");
  }
  if (
    assets.length !== BANG_SHARD_COUNT ||
    assets.some((asset) => !/^\/[a-z0-9_.-]+$/i.test(asset))
  ) {
    throw new Error("Invalid bang shard assets");
  }
  return html
    .replaceAll(BANG_SHARD_ROUTER_MARKER, JSON.stringify(routes))
    .replaceAll(BANG_SHARD_ASSETS_MARKER, JSON.stringify(assets));
}

export function configureHotBangTriggers(
  html: string,
  triggers: readonly string[]
): string {
  return html.replaceAll(HOT_BANG_TRIGGERS_MARKER, JSON.stringify(triggers));
}

export function configureSeedCacheName(
  html: string,
  cacheName = SEED_CACHE_NAME
): string {
  return html.replaceAll(SEED_CACHE_NAME_MARKER, cacheName);
}

function configureRedirectAssets(
  html: string,
  bangDataAsset: string,
  fallbackAsset: string,
  coldFallbackAsset: string,
  bangShardRouter: ArrayLike<number>,
  bangShardAssets: readonly string[],
  hotBangTriggers: readonly string[]
): string {
  return configureSeedCacheName(
    configureHotBangTriggers(
      configureBangShardLayout(
        configureColdFallbackAsset(
          configureFallbackAsset(
            configureBangDataAsset(html, bangDataAsset),
            fallbackAsset
          ),
          coldFallbackAsset
        ),
        bangShardRouter,
        bangShardAssets
      ),
      hotBangTriggers
    )
  );
}

export async function bundleUI(
  allowUnsafeCustomSuggestUrls = customSuggestUrlsEnabled(),
  bangMetaAsset = "/bangs-meta.bin",
  fallbackNaming = "fallback-[hash].[ext]",
  bangDataAsset = "/bangs.bin",
  bangShardRouter: ArrayLike<number> = new Uint8Array(BANG_SHARD_ROUTER_SIZE),
  bangShardAssets: readonly string[] = []
) {
  // Built first: the cold fallback imports it by URL at runtime, so its
  // content-addressed name has to exist before that bundle is defined.
  const localeTableBuild = await Bun.build({
    entrypoints: ["src/shared/locale-table.ts"],
    outdir: DIST_DIR,
    naming: "locale-table-[hash].[ext]",
    minify: true,
    target: "browser",
    format: "esm",
  });
  if (!localeTableBuild.success) {
    throw new AggregateError(localeTableBuild.logs, "Failed to bundle UI");
  }
  const localeTableEntry = localeTableBuild.outputs.find(
    (output) => output.kind === "entry-point"
  );
  if (!localeTableEntry) {
    throw new Error("Locale table build did not emit an entry point");
  }
  const localeTableAsset = `/${basename(localeTableEntry.path)}`;
  const [appBuild, benchBuild, fallbackBuild, coldFallbackBuild] =
    await Promise.all([
      Bun.build({
        entrypoints: ["src/ui/app.ts"],
        outdir: DIST_DIR,
        naming: "app.js",
        splitting: true,
        minify: true,
        target: "browser",
        format: "esm",
        define: {
          __ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS__: JSON.stringify(
            allowUnsafeCustomSuggestUrls
          ),
          __BANG_META_ASSET__: JSON.stringify(bangMetaAsset),
        },
      }),
      Bun.build({
        entrypoints: ["src/ui/bench/index.ts"],
        outdir: DIST_DIR,
        naming: "bench.js",
        minify: true,
        target: "browser",
        format: "esm",
      }),
      Bun.build({
        entrypoints: ["src/ui/fallback.ts"],
        outdir: DIST_DIR,
        naming: fallbackNaming,
        minify: true,
        target: "browser",
        format: "esm",
        define: {
          __BANG_DATA_ASSET__: JSON.stringify(bangDataAsset),
        },
      }),
      Bun.build({
        entrypoints: ["src/ui/cold-fallback.ts"],
        outdir: DIST_DIR,
        naming: "cold-fallback-[hash].[ext]",
        minify: true,
        target: "browser",
        format: "esm",
        define: {
          __BANG_SHARD_ROUTER__: JSON.stringify(Array.from(bangShardRouter)),
          __BANG_SHARD_ASSETS__: JSON.stringify(bangShardAssets),
          __LOCALE_TABLE_ASSET__: JSON.stringify(localeTableAsset),
        },
      }),
    ]);
  const builds = [appBuild, benchBuild, fallbackBuild, coldFallbackBuild];
  const failed = builds.filter((build) => !build.success);
  if (failed.length > 0) {
    throw new AggregateError(
      failed.flatMap((build) => build.logs),
      "Failed to bundle UI"
    );
  }
  const fallbackEntry = fallbackBuild.outputs.find(
    (output) => output.kind === "entry-point"
  );
  if (!fallbackEntry) {
    throw new Error("Fallback build did not emit an entry point");
  }
  const coldFallbackEntry = coldFallbackBuild.outputs.find(
    (output) => output.kind === "entry-point"
  );
  if (!coldFallbackEntry) {
    throw new Error("Cold fallback build did not emit an entry point");
  }
  return {
    appOutputs: [...appBuild.outputs, ...coldFallbackBuild.outputs],
    fallbackAsset: `/${basename(fallbackEntry.path)}`,
    coldFallbackAsset: `/${basename(coldFallbackEntry.path)}`,
    localeTableAsset,
  };
}

export async function generateCSS(): Promise<void> {
  const output = `${DIST_DIR}/styles.css`;
  await buildCSS({
    patterns: [
      "src/ui/home/index.html",
      "src/ui/bench/index.html",
      "src/ui/**/*.ts",
    ],
    outFile: output,
    minify: true,
  });
}

export async function buildHTMLAssets(
  css: string,
  allowUnsafeCustomSuggestUrls = customSuggestUrlsEnabled(),
  bangDataAsset = "/bangs.bin",
  fallbackAsset = "/fallback.js",
  coldFallbackAsset = "/cold-fallback.js",
  bangShardRouter: ArrayLike<number> = new Uint8Array(BANG_SHARD_ROUTER_SIZE),
  bangShardAssets: readonly string[] = []
): Promise<void> {
  const { HOT_TRIGGERS } = await import("../src/generated/bangs-hot.js");
  const inlineCSS = (src: string) =>
    src.replace(
      /<link rel="stylesheet" href="\/styles\.css"\s*\/?>/,
      `<style>${css}</style>`
    );

  const indexHtml = configureRedirectAssets(
    await Bun.file("src/ui/index.html").text(),
    bangDataAsset,
    fallbackAsset,
    coldFallbackAsset,
    bangShardRouter,
    bangShardAssets,
    HOT_TRIGGERS
  );
  await Bun.write(
    `${DIST_DIR}/index.html`,
    minify(Buffer.from(indexHtml), { minify_css: true, minify_js: true })
  );

  for (const [name, source] of [
    ["home", "src/ui/home/index.html"],
    ["bench", "src/ui/bench/index.html"],
  ] as const) {
    const sourceHtml = configureBangDataAsset(
      await Bun.file(source).text(),
      bangDataAsset
    );
    const html =
      name === "home"
        ? configureCustomSuggestOption(sourceHtml, allowUnsafeCustomSuggestUrls)
        : sourceHtml;
    await Bun.write(
      `${DIST_DIR}/${name}.html`,
      minify(Buffer.from(inlineCSS(html)), {
        minify_css: true,
        minify_js: true,
      })
    );
  }
}

export async function assembleUIAssets(
  allowUnsafeCustomSuggestUrls = customSuggestUrlsEnabled(),
  bangDataAsset = "/bangs.bin",
  fallbackAsset = "/fallback.js",
  coldFallbackAsset = "/cold-fallback.js",
  bangShardRouter: ArrayLike<number> = new Uint8Array(BANG_SHARD_ROUTER_SIZE),
  bangShardAssets: readonly string[] = []
): Promise<void> {
  const css = await Bun.file(`${DIST_DIR}/styles.css`).text();
  await buildHTMLAssets(
    css,
    allowUnsafeCustomSuggestUrls,
    bangDataAsset,
    fallbackAsset,
    coldFallbackAsset,
    bangShardRouter,
    bangShardAssets
  );
  await copyStaticAssets();
}

export async function copyStaticAssets(): Promise<void> {
  await Promise.all([
    Bun.write(`${DIST_DIR}/robots.txt`, "User-agent: *\nAllow: /\n"),
    Bun.write(`${DIST_DIR}/manifest.json`, Bun.file("src/ui/manifest.json")),
    Bun.write(`${DIST_DIR}/icon.svg`, Bun.file("src/ui/icon.svg")),
  ]);
}
