# Development

## Prerequisites

- [Bun](https://bun.sh) (runtime and bundler)

## Commands

```sh
bun install        # install dependencies
bun run check      # format + lint check (fails on issues)
bun run fix        # auto-fix format + lint issues
bun run codegen    # fetch DDG/Kagi sources + generate bang maps
bun run build      # bundle, minify + pre-compress with Brotli (requires codegen first)
bun run dev        # bundle + dev server with file watching & live reload
bun run start      # serve pre-built dist/ (run `bun run build` first)
bun test           # run tests
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
│   ├── dev.ts              # Dev server with file watching, rebuild & live reload
│   └── start.ts            # Production server (serves pre-built dist/)
├── src/
│   ├── generated/          # Output of codegen (gitignored)
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

## Tests

```sh
bun test           # run all tests
```

Tests live alongside the source files they cover:

- `src/sw/redirect.test.ts` — Bang parsing, routing logic, and URL encoding
- `src/suggest.test.ts` — Cookie parsing, bang suggestions, and provider proxying

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
5. **Pre-compress** — All static assets are compressed with Brotli (max quality) and written as `.br` files alongside the originals. The production server serves these automatically when the client supports it, falling back to uncompressed

## Dev server

`bun run dev` runs the dev server with `bun --hot` for soft module reloading:

- **Inline builds** — Uses `Bun.build()` API directly instead of shelling out to build scripts
- **File watching** — Watches `src/` recursively via `fs.watch` with 200ms debounce. Any source change triggers a full rebuild
- **Live reload** — SSE endpoint at `/__dev/events` pushes reload events to the browser. A small script is injected into HTML responses that unregisters the Service Worker, clears all caches, and reloads the page on each rebuild
- **Hot reload** — `bun --hot` enables Bun's native hot module reloading for `Bun.serve()`, so the server's fetch handler updates without process restart

## Production server

`bun run start` serves the pre-built `dist/` directory with no build step, file watching, or live reload injection. Useful for testing the production build locally. Requires `bun run build` to have been run first.

## Releasing

1. Update `version` in `package.json`
2. Add a new section to `CHANGELOG.md` under `## [X.Y.Z] - YYYY-MM-DD`
3. Commit: `chore: release vX.Y.Z`
4. Tag: `git tag -a vX.Y.Z -m "vX.Y.Z"`
5. Push: `git push && git push --tags`

The release workflow (`.github/workflows/release.yaml`) handles the rest:
runs tests, builds the project, extracts the changelog entry, and creates a
GitHub Release.
