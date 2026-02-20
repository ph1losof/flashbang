import { $ } from "bun";
import { minify } from "@minify-html/node";
import { parseCookie } from "../src/suggest";

await $`mkdir -p dist`;
await $`bun run build:sw`;
await $`bun run build:ui`;
await $`bun run build:css`;
const css = await Bun.file("dist/styles.css").text();
const inlineCSS = (src: string) =>
  src.replace(
    '<link rel="stylesheet" href="/styles.css" />',
    `<style>${css}</style>`,
  );

let html = await Bun.file("src/ui/index.html").text();
await Bun.write(
  "dist/index.html",
  minify(Buffer.from(inlineCSS(html)), { minify_css: true, minify_js: true }),
);

let benchHtml = await Bun.file("src/ui/bench.html").text();
await Bun.write(
  "dist/bench.html",
  minify(Buffer.from(inlineCSS(benchHtml)), {
    minify_css: true,
    minify_js: true,
  }),
);

const port = Number(process.env.PORT) || 3000;
console.log(`Dev server: http://localhost:${port}`);
Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const q = url.searchParams.get("q");

    if (url.pathname === "/suggest" && q) {
      const { suggest } = await import("../src/suggest");
      return suggest(q, parseCookie(req));
    }

    if (url.pathname === "/bench")
      return new Response(Bun.file("dist/bench.html"));
    let path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(`dist${path}`);
    if (await file.exists()) return new Response(file);
    return new Response(Bun.file("dist/index.html"));
  },
});
