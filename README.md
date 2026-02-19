# flashbang

[![CI](https://github.com/ph1losof/flashbang/actions/workflows/update-bangs.yml/badge.svg)](https://github.com/ph1losof/flashbang/actions/workflows/update-bangs.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)

Blazingly fast, local-first bang redirects.

![Flashbang](docs/landing.png)

Flashbang turns your browser's address bar into a bang-powered launcher. Type `!g kittens` to search Google, `!w dogs` for Wikipedia, `!gh react` for GitHub — across over 14,000 bangs from DuckDuckGo, Kagi, and custom sources. Bangs are shortcuts prefixed with `!` that redirect your search to a specific site. DuckDuckGo popularized the concept, but their bangs require a round-trip to DDG's servers. Flashbang runs everything locally in a Service Worker: zero network latency, no server, no tracking.

**Try it now:** add **`https://flashbang-dyr.pages.dev?q=%s`** as a custom search engine in your browser. That's it.

## Features

- **Local-first** — A Service Worker intercepts requests in your browser before they hit the network. Redirects happen instantly, with no round-trip to a server
- **Private** — No analytics, no tracking, no server. All data stays on your device
- **14,000+ bangs** — Merged from DuckDuckGo, Kagi, and custom sources. Updated daily via CI
- **Custom bangs** — Add your own bangs through the settings UI. They take priority over built-ins
- **Search suggestions** — Bang autocomplete and search suggestions directly in your address bar. Type `!y` and see `!yt` (YouTube), `!ya` (Yandex), `!yf` (Yahoo Finance) — ranked by popularity so the most-used bangs surface first. Regular queries proxy to Google, DuckDuckGo, Bing, Brave, or a custom provider
- **OpenSearch** — Browsers auto-discover Flashbang as a search engine via `/opensearch.xml`, including the suggestions endpoint

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

> **Note:** Search suggestions require a server endpoint since browsers don't route suggestion requests through Service Workers. Redirects always work offline once installed.

### Use the hosted version

A public instance is available at **[flashbang-dyr.pages.dev](https://flashbang-dyr.pages.dev)**. Just visit it, then add it as a custom search engine in your browser:

- **Search URL:** `https://flashbang-dyr.pages.dev?q=%s`
- **Suggestion URL:** `https://flashbang-dyr.pages.dev/suggest?q=%s`

Nothing to build or deploy.

### Self-host locally

Service Workers need an HTTP origin (not `file://`), but a local server works fine:

```sh
bun run codegen && bun run dev
```

`bun run codegen` fetches the latest bang definitions from DuckDuckGo and Kagi and generates the JavaScript bang maps via Rust. `bun run dev` bundles everything and starts the dev server. Visit the local URL once — the Service Worker installs and redirects work offline after that. Set it as your browser's custom search engine:

- **Search URL:** `http://localhost:3000?q=%s`
- **Suggestion URL:** `http://localhost:3000/suggest?q=%s`

To pick up new bangs, pull the latest changes and re-run `bun run codegen`. If you host it, the daily GitHub Actions CI does this automatically.

### Deploy your own

Redirects work on any static host since they're handled by the Service Worker.

**Cloudflare Pages** (recommended) — supports both redirects and suggestions out of the box:

1. Deploy the repo to Cloudflare Pages with build command `bun run build` and output directory `dist`
2. The `functions/suggest.ts` Pages Function automatically handles the `/suggest` endpoint on the edge
3. Visit the site — your browser will auto-discover it via OpenSearch
4. Or manually add a custom search engine:
   - **Search URL:** `https://your-domain?q=%s`
   - **Suggestion URL:** `https://your-domain/suggest?q=%s`

**Other static hosts** (Netlify, Vercel, etc.) — redirects work, but suggestions require adding a serverless function for `/suggest`. See `functions/suggest.ts` for the implementation — it reuses `src/sw/suggest.ts` and can be adapted to any serverless platform.

The settings page has a copy button that gives you the exact search URL template.

## Settings

Open the settings modal from the gear icon on the home page.

- **Default bang** — The bang used when no `!` is in the query. Defaults to `g` (Google). Change it to `ddg`, `b`, or any valid bang trigger
- **Search suggestions** — Choose the source for address bar autocomplete: Default (matches your default bang), Google, DuckDuckGo, Bing, Brave, Custom (provide your own URL template with `{}` as query placeholder), or None
- **Custom bangs** — Add bangs with a trigger, name, and URL template (use `{}` as the query placeholder). Custom bangs override built-in ones
- **Search bangs** — Real-time search across all 14,000+ bangs by trigger, name, or domain
- **Import/Export** — Export your settings and custom bangs as JSON. Import to restore or sync across devices

All settings are stored in IndexedDB locally on your device.

## How it works

When you type `!gh react` in the address bar, the Service Worker intercepts the request before it reaches the network. It parses the bang trigger, looks it up in the bang map (checking custom bangs first, then built-ins), and responds with a 301 redirect — no HTML, no CSS, no JS execution. If no bang is found, your default search engine is used.

Search suggestions require a real server since they bypass the Service Worker (handled by a Cloudflare Pages Function). See [DEVELOPMENT.md](DEVELOPMENT.md) for build pipeline and project structure details.

## Comparison with other bang tools

|                           | **flashbang**                             | **unduck**                            | **unduckified**                       | **rebang**                                            |
| ------------------------- | ----------------------------------------- | ------------------------------------- | ------------------------------------- | ----------------------------------------------------- |
| **Redirect method**       | Service Worker intercept                  | `window.location.replace`             | `window.location.replace`             | Cloudflare Worker (edge) + client fallback            |
| **When redirect happens** | Service Worker only - nothing unnecessary | After full page loads (HTML, CSS, JS) | After full page loads (HTML, CSS, JS) | At the edge or after full page loads (React included) |
| **Sources**               | DDG + Kagi + custom                       | DDG                                   | Kagi                                  | DDG + Kagi                                            |
| **Analytics**             | None                                      | Plausible                             | Cloudflare beacon.min.js              | Plausible                                             |
| **Server required**       | No (redirects), yes (suggestions)         | No                                    | No                                    | Yes (Cloudflare Worker)                               |
| **Search suggestions**    | Yes (bang autocomplete + configurable)    | No                                    | No                                    | No                                                    |
| **Custom bangs**          | Yes (IndexedDB faster)                    | No                                    | Yes (localStorage)                    | Yes (localStorage)                                    |
| **Build tool**            | Rust codegen + Bun                        | Vite                                  | Vite                                  | Vite                                                  |
| **Bang data strategy**    | Two-tier (min for SW, full for UI)        | Single bundle                         | Single bundle                         | Top bangs in worker, full set client-side             |
| **License**               | AGPL-3.0                                  | MIT                                   | MIT                                   | MIT                                                   |

The other tools have a fundamental architectural problem: they treat bang redirects as a page. When you type `!g kittens`, unduck, unduckified, and rebang all load a full HTML page — CSS, JavaScript, UI framework, analytics — parse your query client-side, and then redirect. That's the wrong abstraction. A bang redirect is not a page, it's a routing decision. It should never touch the rendering pipeline.

Flashbang solves this by separating the two concerns entirely. A thin Service Worker handles redirects — it intercepts the navigation request before the browser even begins rendering. No HTML, no CSS, no JS execution. Just a direct redirect from the worker thread. The settings UI is a completely separate bundle that only loads when you actually visit the page.

Flashbang has zero tracking (even hosted version). Some of the other tools include third-party analytics (Plausible, Cloudflare Web Analytics) on each search - it's unclear whether these can be disabled without self-hosting.

> **Note:** Analytics information is accurate at time of writing. These projects may have since changed their tracking behavior.

## Acknowledgments

Flashbang was inspired by [unduck](https://github.com/t3dotgg/unduck) by Theo Browne, which demonstrated the value of fast client-side bang redirects. Bang data is sourced from [DuckDuckGo](https://duckduckgo.com/bang) and [Kagi](https://kagi.com).

## Daily updates

A GitHub Actions workflow runs daily at 00:00 UTC to fetch the latest bang definitions from DuckDuckGo and Kagi, rebuild the generated JavaScript, and commit any changes. This keeps the bang database current without manual intervention.

## Contributing

See [DEVELOPMENT.md](DEVELOPMENT.md) for prerequisites, build commands, and project structure.

## License

[AGPL-3.0](LICENSE) — see [NOTICE](NOTICE).
