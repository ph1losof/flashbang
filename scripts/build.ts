import { $ } from 'bun';
import { minify } from '@minify-html/node';

const skipRust = process.env.SKIP_CODEGEN === '1';

if (!skipRust) {
  console.log('=== Fetch bang sources ===');
  await $`mkdir -p data`;
  await $`curl -sfo data/kagi.json https://raw.githubusercontent.com/kagisearch/bangs/main/data/bangs.json`;
  await $`curl -sfo data/ddg.json https://duckduckgo.com/bang.js`;

  console.log('=== Rust: merge + generate ===');
  await $`mkdir -p src/generated`;
  await $`cargo run --manifest-path build/Cargo.toml --release -- --kagi data/kagi.json --ddg data/ddg.json --custom config/custom.toml --out src/generated`;
} else {
  console.log('=== Skipping Rust codegen (using committed generated files) ===');
}

// Clean old JS build outputs
for (const f of new Bun.Glob('*.js').scanSync('dist')) await $`rm dist/${f}`;

console.log('=== Bundle service worker ===');
await Bun.build({
  entrypoints: ['src/sw/sw.ts'],
  outdir: 'dist',
  splitting: true,
  naming: {
    entry: 'sw.js',
    chunk: '[name]-[hash].js',
  },
  minify: true,
  target: 'browser',
  format: 'esm',
});

console.log('=== Bundle settings page ===');
await Bun.build({
  entrypoints: ['src/ui/app.ts'],
  outdir: 'dist',
  naming: 'app.js',
  minify: true,
  target: 'browser',
  format: 'esm',
});

console.log('=== Generate CSS ===');
await $`bunx unocss "src/ui/index.html" "src/ui/app.ts" "src/ui/liquid-metal.ts" -o dist/styles.css --minify`;

console.log('=== Inline CSS + minify HTML ===');
let html = await Bun.file('src/ui/index.html').text();
const css = await Bun.file('dist/styles.css').text();
html = html.replace(
  '<link rel="stylesheet" href="/styles.css" />',
  `<style>${css}</style>`,
);
const minified = minify(Buffer.from(html), { minify_css: true, minify_js: true });
await Bun.write('dist/index.html', minified);
await $`rm dist/styles.css`;
await $`cp src/ui/manifest.json dist/`;
await $`cp src/ui/icon.svg dist/`;
await $`cp src/ui/opensearch.xml dist/`;

console.log('=== Done ===');
await $`ls -lh dist/`;
