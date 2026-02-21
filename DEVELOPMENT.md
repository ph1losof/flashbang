# Development

## Prerequisites

- [Bun](https://bun.sh) (runtime and bundler)

## Commands

```sh
bun install        # install dependencies
bun run codegen    # fetch DDG/Kagi sources + generate bang maps
bun run build      # bundle + minify (requires codegen first)
bun run dev        # bundle + dev server on port 3000
bun run clean      # remove dist/
```

## Project structure

```
flashbang/
├── functions/
│   └── suggest.ts          # Cloudflare Pages Function for /suggest
├── config/
│   └── custom.toml         # Custom bang definitions
├── scripts/
│   ├── codegen.ts          # Fetch sources, parse, merge, generate bang maps
│   ├── build.ts            # Bundle + minify pipeline
│   └── dev.ts              # Bundle + dev server
├── src/
│   ├── generated/          # Output of Rust codegen (gitignored)
│   │   ├── bangs-min.js    # trigger→URL map for Service Worker
│   │   ├── bangs-full.js   # trigger→{name, domain, url, relevance} for UI & suggestions
│   │   └── bangs-meta.json # bang count & timestamp
│   ├── sw/
│   │   ├── sw.ts           # Service Worker lifecycle & fetch handler
│   │   ├── redirect.ts     # Bang parsing & redirect logic
│   │   ├── suggest.ts      # Bang autocomplete & search suggestions
│   │   └── idb.ts          # IndexedDB access & settings cache
│   └── ui/
│       ├── index.html       # HTML template
│       ├── app.ts           # Settings UI & initialization
│       ├── db.ts            # IndexedDB wrapper
│       ├── liquid-metal.ts  # WebGL2 shader effect
│       ├── manifest.json    # PWA manifest
│       └── opensearch.xml   # OpenSearch descriptor
├── package.json
├── uno.config.ts           # UnoCSS theme
└── LICENSE
```

## Bang codegen

`bun run codegen` fetches bang sources and generates the JavaScript bang maps that `build` and `dev` depend on:

1. **Fetch sources** — Downloads bang definitions from DuckDuckGo (`bang.js`) and Kagi (`bangs.json`) into `data/`
2. **Generate** — Parses DDG, Kagi, and custom TOML sources. Merges by trigger (deduplicates), validates URLs, and generates three files in `src/generated/`:
   - `bangs-min.js` — trigger→URL map for the Service Worker (~847 KB)
   - `bangs-full.js` — trigger→{name, domain, url, relevance} for the UI and suggestions
   - `bangs-meta.json` — bang count and timestamp

The bang data is split into two tiers so the Service Worker loads only what it needs for fast redirects, while the UI gets the full metadata for searching and display.

## Build pipeline

`bun run build` bundles the app (requires `bun run codegen` first):

1. **Bundle Service Worker** — Bun bundles `src/sw/sw.ts` with `bangs-min.js` into `dist/sw.js`. Code splitting lazy-loads `suggest.ts` on first suggestion request
2. **Bundle UI** — Bun bundles `src/ui/app.ts` with `bangs-full.js` into `dist/app.js`
3. **Generate CSS** — UnoCSS scans source files and emits atomic utility classes
4. **Inline & minify HTML** — CSS is inlined into `<style>`, HTML is minified with `@minify-html/node`
