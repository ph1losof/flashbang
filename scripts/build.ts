import { minify } from "@minify-html/node";
import { $ } from "bun";

await $`mkdir -p dist`;
for (const f of new Bun.Glob("*.js").scanSync("dist")) {
  await $`rm dist/${f}`;
}

console.log("=== Bundle service worker ===");
await Bun.build({
  entrypoints: ["src/sw/sw.ts"],
  outdir: "dist",
  naming: "sw.js",
  minify: true,
  target: "browser",
  format: "esm",
});

console.log("=== Bundle settings page ===");
await Bun.build({
  entrypoints: ["src/ui/app.ts"],
  outdir: "dist",
  naming: "app.js",
  splitting: true,
  minify: true,
  target: "browser",
  format: "esm",
});

console.log("=== Bundle bench page ===");
await Bun.build({
  entrypoints: ["src/ui/bench.ts"],
  outdir: "dist",
  naming: "bench.js",
  minify: true,
  target: "browser",
  format: "esm",
});

console.log("=== Generate CSS ===");
await $`bunx unocss "src/ui/home.html" "src/ui/bench.html" "src/ui/app.ts" "src/ui/bench.ts" "src/ui/liquid-metal.ts" -o dist/styles.css --minify`;

console.log("=== Inline CSS + minify HTML ===");
const css = await Bun.file("dist/styles.css").text();
const inlineCSS = (src: string) =>
  src.replace(
    '<link rel="stylesheet" href="/styles.css" />',
    `<style>${css}</style>`
  );

const indexHtml = await Bun.file("src/ui/index.html").text();
await Bun.write(
  "dist/index.html",
  minify(Buffer.from(indexHtml), { minify_css: true, minify_js: true })
);

const homeHtml = await Bun.file("src/ui/home.html").text();
await Bun.write(
  "dist/home.html",
  minify(Buffer.from(inlineCSS(homeHtml)), {
    minify_css: true,
    minify_js: true,
  })
);

const benchHtml = await Bun.file("src/ui/bench.html").text();
await Bun.write(
  "dist/bench.html",
  minify(Buffer.from(inlineCSS(benchHtml)), {
    minify_css: true,
    minify_js: true,
  })
);

await $`rm dist/styles.css`;
await $`cp src/ui/manifest.json dist/`;
await $`cp src/ui/icon.svg dist/`;
await $`cp src/ui/_headers dist/`;

console.log("=== Done ===");
await $`ls -lh dist/`;
