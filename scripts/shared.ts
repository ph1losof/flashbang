import { minify } from "@minify-html/node";
import { $ } from "bun";

const CUSTOM_SUGGEST_OPTION_MARKER = "<!-- custom-suggest-provider-option -->";
const CUSTOM_SUGGEST_OPTION = '<option value="custom">Custom</option>';
const BANG_DATA_ASSET_MARKER = "__BANG_DATA_ASSET__";
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

export async function bundleUI(
  allowUnsafeCustomSuggestUrls = customSuggestUrlsEnabled()
) {
  const [appBuild, benchBuild] = await Promise.all([
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
  ]);
  const builds = [appBuild, benchBuild];
  const failed = builds.filter((build) => !build.success);
  if (failed.length > 0) {
    throw new AggregateError(
      failed.flatMap((build) => build.logs),
      "Failed to bundle UI"
    );
  }
  return {
    appOutputs: appBuild.outputs,
    benchOutputs: benchBuild.outputs,
  };
}

export async function generateCSS(quiet = false): Promise<void> {
  const output = `${DIST_DIR}/styles.css`;
  const command = $`bunx --no-install --package @unocss/cli unocss "src/ui/home/index.html" "src/ui/bench/index.html" "src/ui/**/*.ts" -o ${output} --minify`;
  if (quiet) {
    await command.quiet();
  } else {
    await command;
  }
}

export async function buildHTMLAssets(
  css: string,
  allowUnsafeCustomSuggestUrls = customSuggestUrlsEnabled(),
  bangDataAsset = "/bangs.bin"
): Promise<void> {
  const inlineCSS = (src: string) =>
    src.replace(
      /<link rel="stylesheet" href="\/styles\.css"\s*\/?>/,
      `<style>${css}</style>`
    );

  const indexHtml = configureBangDataAsset(
    await Bun.file("src/ui/index.html").text(),
    bangDataAsset
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
  bangDataAsset = "/bangs.bin"
): Promise<void> {
  const css = await Bun.file(`${DIST_DIR}/styles.css`).text();
  await buildHTMLAssets(css, allowUnsafeCustomSuggestUrls, bangDataAsset);
  await copyStaticAssets();
}

export async function copyStaticAssets(): Promise<void> {
  await Promise.all([
    Bun.write(`${DIST_DIR}/robots.txt`, "User-agent: *\nAllow: /\n"),
    Bun.write(`${DIST_DIR}/manifest.json`, Bun.file("src/ui/manifest.json")),
    Bun.write(`${DIST_DIR}/icon.svg`, Bun.file("src/ui/icon.svg")),
  ]);
}
