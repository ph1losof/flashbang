# flashbang

Blazingly fast, local-first bang redirects.

Flashbang turns your browser's address bar into a bang-powered launcher. Type `!g kittens` to search Google, `!w dogs` for Wikipedia, `!gh react` for GitHub - across 14,303 bangs from DuckDuckGo, Kagi, and custom sources. Everything runs locally in a Service Worker: zero network latency, no server, no tracking.

**Try it now:** add **`https://flashbang-dyr.pages.dev?q=%s`** as a custom search engine in your browser. That's it.

## What are bangs?

Bangs are shortcuts prefixed with `!` that redirect your search to a specific site. Instead of going to Google, typing your query, then navigating to the result - you type `!g query` and go straight there. DuckDuckGo popularized the concept, but their bangs require a round-trip to DDG's servers. Flashbang does it locally, instantly.

## Features

- **Local-first** - A Service Worker intercepts requests in your browser before they hit the network. Redirects happen instantly, with no round-trip to a server
- **Private** - No analytics, no tracking, no server. All data stays on your device
- **14,303 bangs** - Merged from DuckDuckGo, Kagi, and custom sources. Updated daily via CI
- **Custom bangs** - Add your own bangs through the settings UI. They take priority over built-ins
- **Search suggestions** - Bang autocomplete and search suggestions directly in your address bar. Type `!g` and see `!gh`, `!ghr`, etc. Regular queries proxy suggestions from Google, DuckDuckGo, Bing, Brave, or a custom provider — all handled locally by the Service Worker
- **OpenSearch** - Browsers auto-discover Flashbang as a search engine via `/opensearch.xml`, including the suggestions endpoint

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

### Use the hosted version

A public instance is available at **[flashbang-dyr.pages.dev](https://flashbang-dyr.pages.dev)**. Just visit it, then add it as a custom search engine in your browser:

- **Search URL:** `https://flashbang-dyr.pages.dev?q=%s`
- **Suggestion URL:** `https://flashbang-dyr.pages.dev/suggest?q=%s`

Nothing to build or deploy.

### Self-host locally

No remote hosting required. Service Workers need an HTTP origin (not `file://`), but a local server works fine:

```sh
bun run build && bunx serve dist
```

Visit the local URL once — the Service Worker installs in your browser. You can then stop the server. After that first visit, redirects work offline with no server needed. Set it as your browser's custom search engine:

- **Search URL:** `http://localhost:3000?q=%s`
- **Suggestion URL:** `http://localhost:3000/suggest?q=%s`

To pick up new bangs, pull the latest changes and re-run `bun run build`. If you host it, the daily GitHub Actions CI does this automatically.

### Deploy your own

Deploy the `dist/` folder to any static host (Cloudflare Pages, Netlify, Vercel, etc.):

1. Visit the site — your browser will auto-discover it via OpenSearch (including suggestions)
2. In your browser's search engine settings, set Flashbang as the default
3. Or manually add a custom search engine:
   - **Search URL:** `https://your-domain?q=%s`
   - **Suggestion URL:** `https://your-domain/suggest?q=%s`

The settings page has a copy button that gives you the exact search URL template.

## Settings

Open the settings modal from the gear icon on the home page.

- **Default bang** — The bang used when no `!` is in the query. Defaults to `g` (Google). Change it to `ddg`, `b`, or any valid bang trigger
- **Search suggestions** — Choose the source for address bar autocomplete: Default (matches your default bang), Google, DuckDuckGo, Bing, Brave, Custom (provide your own URL template with `{}` as query placeholder), or None
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

## Build pipeline

`bun run build` runs these phases:

1. **Fetch sources** — Downloads bang definitions from DuckDuckGo (`bang.js`) and Kagi (`bangs.json`)
2. **Rust codegen** — Parses DDG, Kagi, and custom TOML sources. Merges by trigger (deduplicates), validates URLs, and generates two JavaScript bang maps plus a metadata JSON file
3. **Bundle Service Worker** — Bun bundles `src/sw/sw.ts` with `bangs-min.js` (trigger→URL only, ~847 KB) into `dist/sw.js`. Code splitting lazy-loads `suggest.ts` on first suggestion request
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

**Suggestions** work the same way: when you type in the address bar, the browser sends a suggestion request to `/suggest?q=...`. The Service Worker intercepts it and either searches bangs locally (if the query contains `!`) or proxies to your configured suggestion provider (Google, DuckDuckGo, or custom). Bang suggestions are instant — no network needed.

## Comparison with other bang tools

|                           | **flashbang**                             | **unduck**                            | **unduckified**                       | **rebang**                                            |
| ------------------------- | ----------------------------------------- | ------------------------------------- | ------------------------------------- | ----------------------------------------------------- |
| **Redirect method**       | Service Worker intercept                  | `window.location.replace`             | `window.location.replace`             | Cloudflare Worker (edge) + client fallback            |
| **When redirect happens** | Service Worker only - nothing unnecessary | After full page loads (HTML, CSS, JS) | After full page loads (HTML, CSS, JS) | At the edge or after full page loads (React included) |
| **Sources**               | DDG + Kagi + custom                       | DDG                                   | Kagi                                  | DDG + Kagi                                            |
| **Analytics**             | None                                      | Plausible                             | Cloudflare beacon.min.js              | Plausible                                             |
| **Server required**       | No                                        | No                                    | No                                    | Yes (Cloudflare Worker)                               |
| **Search suggestions**    | Yes (bang autocomplete + configurable)    | No                                    | No                                    | No                                                    |
| **Custom bangs**          | Yes (IndexedDB faster)                    | No                                    | Yes (localStorage)                    | Yes (localStorage)                                    |
| **Build tool**            | Rust codegen + Bun                        | Vite                                  | Vite                                  | Vite                                                  |
| **Bang data strategy**    | Two-tier (min for SW, full for UI)        | Single bundle                         | Single bundle                         | Top bangs in worker, full set client-side             |
| **License**               | AGPL-3.0                                  | MIT                                   | MIT                                   | MIT                                                   |

The other tools have a fundamental architectural problem: they treat bang redirects as a page. When you type `!g kittens`, unduck, unduckified, and rebang all load a full HTML page — CSS, JavaScript, UI framework, analytics — parse your query client-side, and then redirect. That's the wrong abstraction. A bang redirect is not a page, it's a routing decision. It should never touch the rendering pipeline.

Flashbang solves this by separating the two concerns entirely. A thin Service Worker handles redirects — it intercepts the navigation request before the browser even begins rendering. No HTML, no CSS, no JS execution. Just a direct redirect from the worker thread. The settings UI is a completely separate bundle that only loads when you actually visit the page.

Flashbang has zero tracking. Some of the other tools include third-party analytics (Plausible, Cloudflare Web Analytics) — it's unclear whether these can be disabled by self-hosting.

> **Note:** Analytics information is accurate as of February 2026. These projects may have since changed their tracking behavior.

## Daily updates

A GitHub Actions workflow runs daily at 00:00 UTC to fetch the latest bang definitions from DuckDuckGo and Kagi, rebuild the generated JavaScript, and commit any changes. This keeps the bang database current without manual intervention.

## License

[AGPL-3.0](LICENSE) with an attribution requirement under Section 7(b) — see [NOTICE](NOTICE).

Derivative works that reuse the core architecture (local-first bang redirects via Service Worker) must credit flashbang in their README or documentation.
