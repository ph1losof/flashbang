import { $ } from 'bun';
import { minify } from '@minify-html/node';

await $`mkdir -p dist`;
await $`bun run build:sw`;
await $`bun run build:ui`;
await $`bun run build:css`;
let html = await Bun.file('src/ui/index.html').text();
const css = await Bun.file('dist/styles.css').text();
html = html.replace(
  '<link rel="stylesheet" href="/styles.css" />',
  `<style>${css}</style>`,
);
const minified = minify(Buffer.from(html), { minify_css: true, minify_js: true });
await Bun.write('dist/index.html', minified);

const port = Number(process.env.PORT) || 3000;
console.log(`Dev server: http://localhost:${port}`);
Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = Bun.file(`dist${path}`);
    if (await file.exists()) return new Response(file);
    return new Response(Bun.file('dist/index.html'));
  },
});
