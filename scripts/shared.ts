import { minify } from "@minify-html/node";
import { $ } from "bun";

const CUSTOM_SUGGEST_OPTION_MARKER = "<!-- custom-suggest-provider-option -->";
const CUSTOM_SUGGEST_OPTION = '<option value="custom">Custom</option>';
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

export async function bundleUI(
  allowUnsafeCustomSuggestUrls = customSuggestUrlsEnabled()
) {
  const builds = await Promise.all([
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
  const failed = builds.filter((build) => !build.success);
  if (failed.length > 0) {
    throw new AggregateError(
      failed.flatMap((build) => build.logs),
      "Failed to bundle UI"
    );
  }
  return builds.flatMap((build) => build.outputs);
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
  allowUnsafeCustomSuggestUrls = customSuggestUrlsEnabled()
): Promise<void> {
  const inlineCSS = (src: string) =>
    src.replace(
      /<link rel="stylesheet" href="\/styles\.css"\s*\/?>/,
      `<style>${css}</style>`
    );

  const indexHtml = await Bun.file("src/ui/index.html").text();
  await Bun.write(
    `${DIST_DIR}/index.html`,
    minify(Buffer.from(indexHtml), { minify_css: true, minify_js: true })
  );

  for (const [name, source] of [
    ["home", "src/ui/home/index.html"],
    ["bench", "src/ui/bench/index.html"],
  ] as const) {
    const sourceHtml = await Bun.file(source).text();
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
  allowUnsafeCustomSuggestUrls = customSuggestUrlsEnabled()
): Promise<void> {
  const css = await Bun.file(`${DIST_DIR}/styles.css`).text();
  await buildHTMLAssets(css, allowUnsafeCustomSuggestUrls);
  await copyStaticAssets();
}

export async function copyStaticAssets(): Promise<void> {
  await Promise.all([
    Bun.write(`${DIST_DIR}/robots.txt`, "User-agent: *\nAllow: /\n"),
    Bun.write(`${DIST_DIR}/manifest.json`, Bun.file("src/ui/manifest.json")),
    Bun.write(`${DIST_DIR}/icon.svg`, Bun.file("src/ui/icon.svg")),
  ]);
}
