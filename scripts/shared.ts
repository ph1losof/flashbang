import { basename } from "node:path";
import { minify } from "@minify-html/node";
import { build as buildCSS } from "@unocss/cli";

const CUSTOM_SUGGEST_OPTION_MARKER = "<!-- custom-suggest-provider-option -->";
const CUSTOM_SUGGEST_OPTION = '<option value="custom">Custom</option>';
const BANG_DATA_ASSET_MARKER = "__BANG_DATA_ASSET__";
const FALLBACK_ASSET_MARKER = "__FALLBACK_ASSET__";
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

function configureRedirectAssets(
  html: string,
  bangDataAsset: string,
  fallbackAsset: string
): string {
  return configureFallbackAsset(
    configureBangDataAsset(html, bangDataAsset),
    fallbackAsset
  );
}

export async function bundleUI(
  allowUnsafeCustomSuggestUrls = customSuggestUrlsEnabled(),
  bangMetaAsset = "/bangs-meta.bin",
  fallbackNaming = "fallback-[hash].[ext]",
  bangDataAsset = "/bangs.bin"
) {
  const [appBuild, benchBuild, fallbackBuild] = await Promise.all([
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
  ]);
  const builds = [appBuild, benchBuild, fallbackBuild];
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
  return {
    appOutputs: appBuild.outputs,
    fallbackAsset: `/${basename(fallbackEntry.path)}`,
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
  fallbackAsset = "/fallback.js"
): Promise<void> {
  const inlineCSS = (src: string) =>
    src.replace(
      /<link rel="stylesheet" href="\/styles\.css"\s*\/?>/,
      `<style>${css}</style>`
    );

  const indexHtml = configureRedirectAssets(
    await Bun.file("src/ui/index.html").text(),
    bangDataAsset,
    fallbackAsset
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
  fallbackAsset = "/fallback.js"
): Promise<void> {
  const css = await Bun.file(`${DIST_DIR}/styles.css`).text();
  await buildHTMLAssets(
    css,
    allowUnsafeCustomSuggestUrls,
    bangDataAsset,
    fallbackAsset
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
