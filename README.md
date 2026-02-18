# flashbang

Blazingly fast, local-first bang redirects.

Flashbang turns your browser's address bar into a bang-powered launcher. Type `!g kittens` to search Google, `!w dogs` for Wikipedia, `!gh react` for GitHub - across 14,303 bangs from DuckDuckGo, Kagi, and custom sources. Everything runs locally in a Service Worker: zero network latency, no server, no tracking.

## What are bangs?

Bangs are shortcuts prefixed with `!` that redirect your search to a specific site. Instead of going to Google, typing your query, then navigating to the result - you type `!g query` and go straight there. DuckDuckGo popularized the concept, but their bangs require a round-trip to DDG's servers. Flashbang does it locally, instantly.

## Features

- **Local-first** - A Service Worker intercepts requests in your browser before they hit the network. Redirects happen in microseconds, not milliseconds
- **Private** - No analytics, no tracking, no server. All data stays on your device
- **14,303 bangs** - Merged from DuckDuckGo, Kagi, and custom sources. Updated daily via CI
- **Custom bangs** - Add your own bangs through the settings UI. They take priority over built-ins
- **OpenSearch** - Browsers auto-discover Flashbang as a search engine via `/opensearch.xml`

## Bang syntax

Flashbang supports 4 formats. All bangs are case-insensitive.

| Format              | Example      | Result                      |
| ------------------- | ------------ | --------------------------- |
| Prefix bang         | `!g kittens` | Google search for "kittens" |
| Suffix bang         | `kittens g!` | Google search for "kittens" |
| Prefix, query first | `kittens !g` | Google search for "kittens" |
| Suffix, bang first  | `g! kittens` | Google search for "kittens" |

If the query is just a bang with no search term (e.g. `!g`), Flashbang redirects to the service's homepage.

## Setup as search engine

No remote hosting required. Service Workers need an HTTP origin (not `file://`), but a local server works fine:

```sh
bun run build && bunx serve dist
```

Visit the local URL once — the Service Worker installs in your browser. You can then stop the server. After that first visit, redirects work offline with no server needed. Set the local URL with `?q=%s` as your browser's custom search engine and you're done.

To pick up new bangs, pull the latest changes and re-run `bun run build`. If you host it, the daily GitHub Actions CI does this automatically.

If you want to host it (for sharing or syncing across devices):

1. Deploy the `dist/` folder to any static host
2. Visit the site — your browser will auto-discover it via OpenSearch
3. In your browser's search engine settings, set Flashbang as the default
4. Or manually add a custom search engine with the URL template: `https://your-domain?q=%s`

The settings page has a copy button that gives you the exact URL template.

## Settings

Open the settings modal from the gear icon on the home page.

- **Default bang** — The bang used when no `!` is in the query. Defaults to `g` (Google). Change it to `ddg`, `b`, or any valid bang trigger
- **Custom bangs** — Add bangs with a trigger, name, and URL template (use `{}` as the query placeholder). Custom bangs override built-in ones
- **Search bangs** — Real-time search across all 14,303 bangs by trigger, name, or domain
- **Import/Export** — Export your settings and custom bangs as JSON. Import to restore or sync across devices

All settings are stored in IndexedDB locally on your device.

## Development

### Prerequisites

- [Bun](https://bun.sh) (runtime and bundler)
- [Rust](https://rustup.rs) (for the bang codegen tool)

### Commands

```sh
bun install        # install dependencies
bun run build      # full production build
bun run dev        # dev server on port 3000
bun run clean      # remove dist/
```

### Project structure

```
flashbang/
├── build/                  # Rust CLI tool for bang processing
│   └── src/
│       ├── main.rs         # CLI entry point
│       ├── merge.rs        # Bang source merging & dedup
│       ├── codegen.rs      # JavaScript code generation
│       ├── validate.rs     # Bang validation
│       └── sources/        # Parsers for DDG, Kagi, custom TOML
├── config/
│   └── custom.toml         # Custom bang definitions
├── scripts/
│   ├── build.ts            # Full build pipeline
│   └── dev.ts              # Dev server
├── src/
│   ├── generated/          # Output of Rust codegen (gitignored)
│   │   ├── bangs-min.js    # trigger→URL map for Service Worker
│   │   ├── bangs-full.js   # trigger→{name, domain, url} for UI
│   │   └── bangs-meta.json # bang count & timestamp
│   ├── sw/
│   │   ├── sw.ts           # Service Worker lifecycle & fetch handler
│   │   └── redirect.ts     # Bang parsing & redirect logic
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

## Build pipeline

`bun run build` runs these phases:

1. **Fetch sources** — Downloads bang definitions from DuckDuckGo (`bang.js`) and Kagi (`bangs.json`)
2. **Rust codegen** — Parses DDG, Kagi, and custom TOML sources. Merges by trigger (deduplicates), validates URLs, and generates two JavaScript bang maps plus a metadata JSON file
3. **Bundle Service Worker** — Bun bundles `src/sw/sw.ts` with `bangs-min.js` (trigger→URL only, ~847 KB) into `dist/sw.js`
4. **Bundle UI** — Bun bundles `src/ui/app.ts` with `bangs-full.js` (full metadata for search) into `dist/app.js`
5. **Generate CSS** — UnoCSS scans source files and emits atomic utility classes
6. **Inline & minify HTML** — CSS is inlined into `<style>`, HTML is minified with `@minify-html/node`

The bang data is split into two bundles so the Service Worker loads only what it needs for fast redirects, while the UI gets the full metadata for searching.

## How it works

1. You set Flashbang as your browser's default search engine
2. When you type `!gh react` in the address bar, your browser navigates to `https://flashbang.example.com?q=!gh react`
3. The Service Worker intercepts this request before it reaches the network
4. `redirect.ts` parses the query, extracts the bang trigger (`gh`) and search term (`react`)
5. It looks up `gh` in the bang map — first checking custom bangs (from IndexedDB), then the built-in 14,303 bangs
6. It finds the URL template `https://github.com/search?q={}`, replaces `{}` with the encoded search term
7. The Service Worker responds with a 301 redirect to `https://github.com/search?q=react`
8. If no bang is found, the default bang is used (Google by default)

The entire flow happens locally - no request ever leaves your browser until the final redirect.

## Comparison with other bang tools

|                           | **flashbang**                             | **unduck**                            | **unduckified**                       | **rebang**                                            |
| ------------------------- | ----------------------------------------- | ------------------------------------- | ------------------------------------- | ----------------------------------------------------- |
| **Redirect method**       | Service Worker intercept                  | `window.location.replace`             | `window.location.replace`             | Cloudflare Worker (edge) + client fallback            |
| **When redirect happens** | Service Worker only - nothing unnecessary | After full page loads (HTML, CSS, JS) | After full page loads (HTML, CSS, JS) | At the edge or after full page loads (React included) |
| **Sources**               | DDG + Kagi + custom                       | DDG                                   | Kagi                                  | DDG + Kagi                                            |
| **Analytics**             | None                                      | Plausible                             | Cloudflare beacon.min.js              | Plausible                                             |
| **Server required**       | No                                        | No                                    | No                                    | Yes (Cloudflare Worker)                               |
| **Custom bangs**          | Yes (IndexedDB faster)                    | No                                    | Yes (localStorage)                    | Yes (localStorage)                                    |
| **Build tool**            | Rust codegen + Bun                        | Vite                                  | Vite                                  | Vite                                                  |
| **Bang data strategy**    | Two-tier (min for SW, full for UI)        | Single bundle                         | Single bundle                         | Top bangs in worker, full set client-side             |
| **License**               | AGPL-3.0                                  | MIT                                   | MIT                                   | MIT                                                   |

Flashbang is the fastest of all these tools. Unlike every other implementation, Flashbang is split into two independent parts: a thin Service Worker that handles redirects, and a separate settings UI for managing bangs and configuration. The other tools ship a single monolithic bundle — HTML, CSS, JavaScript, UI framework — that loads in full on every query, even though the only thing needed is a redirect. Flashbang's Service Worker intercepts the navigation request before the browser even begins rendering. No HTML, no CSS, no JS execution. Just a direct redirect from the worker thread. The settings UI only loads when you actually visit the page.

Flashbang is also the only one with zero tracking. The others inject third-party analytics scripts (Plausible, Cloudflare) some of them run on every page load — including during redirects. For a tool whose entire purpose is to be fast and private, injecting analytics is a betrayal of user trust: it adds latency to every request and leaks your search queries to third parties.

> **Note:** Analytics information is accurate as of February 2026. These projects may have since changed their tracking behavior, please feel free to check by yourself. What we know if flashbang is going to stay the way it is right now.

## Daily updates

A GitHub Actions workflow runs daily at 00:00 UTC to fetch the latest bang definitions from DuckDuckGo and Kagi, rebuild the generated JavaScript, and commit any changes. This keeps the bang database current without manual intervention.

## License

[AGPL-3.0](LICENSE) with an attribution requirement under Section 7(b) — see [NOTICE](NOTICE).

Derivative works that reuse the core architecture (local-first bang redirects via Service Worker) must credit flashbang in their README or documentation.
