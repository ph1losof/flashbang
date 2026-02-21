# flashbang

![Flashbang](docs/landing.png)

Turn your browser's address bar into a shortcut launcher. Type `!g kittens` to search Google, `!w dogs` for Wikipedia, `!gh react` for GitHub — over 14,000 shortcuts (called "bangs") that take you straight to the right site, instantly. No extra tabs, no round-trips, no waiting for a page to load.

Every other bang tool loads a full page before redirecting — adding hundreds of milliseconds — or routes through an edge server adding network latency. Flashbang skips the page entirely — a [Service Worker](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API) handles the redirect before your browser even starts rendering.

> **Fully local where it matters.** Core redirects never leave your machine — the Service Worker handles them offline with no server involved. Search suggestions (bang autocomplete, web results in your address bar) are completely optional and do go through our server when enabled and used through our hosted version. That's fine by us — Cloudflare Workers make it practically free — but you should know that "fully local" applies to redirects only. There is no tracking or analytics on our end — we don't know what you search and what bangs you use. Cloudflare collects basic request counts on all hosted sites by default (this can't be turned off), but no query content or personally identifiable information is exposed to us through it.

**Try it now:** add **`https://flashbang-dyr.pages.dev?q=%s`** as a custom search engine in your browser. Optionally, set **`https://flashbang-dyr.pages.dev/suggest?q=%s`** as the suggestion URL for address bar autocomplete. That's it.

## Features

- **Built for speed** — Sub-1ms median redirect latency in our testing, advertised as ~1ms to be conservative. The Service Worker intercepts requests before they hit the network, parses the bang, and responds with a 302 — no page load, no framework, no round-trip to a server. [Run the benchmark yourself](https://flashbang-dyr.pages.dev/bench) — results vary by machine
- **Private** — No analytics, no tracking. All data stays on your device for the core feature - redirects
- **14,000+ bangs** — Merged from DuckDuckGo, Kagi, and custom sources. Updated daily via CI
- **Custom bangs** — Add your own bangs through the settings UI. They take priority over built-ins
- **Search suggestions** — The only bang tool with bang-aware autocomplete in your browser's native address bar. Type `!y` and the browser itself suggests `!yt` (YouTube), `!ya` (Yandex), `!yf` (Yahoo Finance) — ranked by popularity so the most-used bangs surface first. Regular queries return web search suggestions from Google, DuckDuckGo, Bing, Brave, or a custom provider. Both are unified through a single `/suggest` endpoint that plugs into your browser's built-in suggestion UI
- **Feeling Lucky** — Prefix a query with `\`, or add a bare `!` before or after it, to skip the results page and jump straight to the first result. Works with Google's "I'm Feeling Lucky" when that's your default engine, falls back to DuckDuckGo's `\` redirect for others. Configurable per-engine or with a custom URL, or disable it entirely
- **OpenSearch** — Browsers auto-discover Flashbang as a search engine via `/opensearch.xml` (dynamically generated with the correct origin), including the suggestions endpoint

## Bang syntax

Flashbang supports 4 formats. All bangs are case-insensitive.

| Format              | Example      | Result                      |
| ------------------- | ------------ | --------------------------- |
| Prefix bang         | `!g kittens` | Google search for "kittens" |
| Suffix bang         | `kittens g!` | Google search for "kittens" |
| Prefix, query first | `kittens !g` | Google search for "kittens" |
| Suffix, bang first  | `g! kittens` | Google search for "kittens" |

If the query is just a bang with no search term (e.g. `!g`), Flashbang redirects to the service's homepage.

### Feeling Lucky

Skip the search results page and go directly to the first result. Three syntax options:

| Format       | Example     | Result                     |
| ------------ | ----------- | -------------------------- |
| Backslash    | `\kittens`  | First result for "kittens" |
| Trailing `!` | `kittens !` | First result for "kittens" |
| Leading `!`  | `! kittens` | First result for "kittens" |

The redirect destination depends on your lucky provider (configurable in settings):

- **Default (match bang)** — Uses your default search engine's native lucky feature if available (Google `btnI`, DuckDuckGo `\`), otherwise falls back to DuckDuckGo's `\` redirect
- **Google** / **DuckDuckGo** — Always use that engine's lucky redirect
- **Custom** — Provide your own URL template with `{}` as the query placeholder
- **Disabled** — Lucky syntax is treated as a normal search query

## Setup as search engine

> **Note:** Search suggestions and OpenSearch auto-discovery require a server endpoint since browsers don't route these requests through Service Workers — both are completely optional. Redirects always work offline once installed with no server needed. If you use the hosted version, these requests go through our Cloudflare Pages Functions. No queries are logged or stored — self-host if you'd rather keep them local too.

### Use the hosted version

A public instance is available at **[flashbang-dyr.pages.dev](https://flashbang-dyr.pages.dev)**. Just visit it, then add it as a custom search engine in your browser:

- **Search URL:** `https://flashbang-dyr.pages.dev?q=%s`
- **Suggestion URL:** `https://flashbang-dyr.pages.dev/suggest?q=%s` (Optional)

Nothing to build or deploy.

### Self-host locally

Service Workers need an HTTP origin (not `file://`), but a local server works fine:

```sh
bun run codegen && bun run dev
```

`bun run codegen` fetches the latest bang definitions from DuckDuckGo and Kagi and generates the JavaScript bang maps via Rust. `bun run dev` bundles everything and starts the dev server. Visit the local URL once — the Service Worker installs and redirects work offline after that. Set it as your browser's custom search engine:

- **Search URL:** `http://localhost:3000?q=%s`
- **Suggestion URL:** `http://localhost:3000/suggest?q=%s` (Optional)

To pick up new bangs, pull the latest changes and re-run `bun run codegen`. If you host it, the daily GitHub Actions CI does this automatically.

### Deploy your own

Redirects work on any static host since they're handled by the Service Worker.

**Cloudflare Pages** (recommended) — supports both redirects and suggestions out of the box:

1. Deploy the repo to Cloudflare Pages with build command `bun run build` and output directory `dist`
2. The Pages Functions automatically handle `/suggest` (search suggestions) and `/opensearch.xml` (search engine discovery with correct origin) on the edge
3. Visit the site — your browser will auto-discover it via OpenSearch
4. Or manually add a custom search engine:
   - **Search URL:** `https://your-domain?q=%s`
   - **Suggestion URL:** `https://your-domain/suggest?q=%s`

**Other static hosts** (Netlify, Vercel, etc.) — redirects work, but suggestions and dynamic OpenSearch require adding serverless functions for `/suggest` and `/opensearch.xml`. See `functions/` for the implementations — they reuse shared modules from `src/` and can be adapted to any serverless platform.

The settings page has a copy button that gives you the exact search URL template.

## Settings

Open the settings modal from the gear icon on the home page, or type **`!settings`** in the address bar to jump there directly. Type **`!`** on its own to quickly access the home page.

- **Default bang** — The bang used when no `!` is in the query. Defaults to `g` (Google). Change it to `ddg`, `b`, or any valid bang trigger
- **Feeling Lucky** — Choose how lucky redirects resolve: Default (match your default bang), Google, DuckDuckGo, Custom (your own URL template with `{}` as query placeholder), or Disabled
- **Search suggestions** — Choose the source for address bar autocomplete: Default (matches your default bang), Google, DuckDuckGo, Bing, Brave, Custom (provide your own URL template with `{}` as query placeholder), or None
- **Custom bangs** — Add bangs with a trigger, name, and URL template (use `{}` as the query placeholder). Custom bangs override built-in ones
- **Search bangs** — Real-time search across all 14,000+ bangs by trigger, name, or domain
- **Import/Export** — Export your settings and custom bangs as JSON. Import to restore or sync across devices

All settings are stored in IndexedDB locally on your device.

## How it works

When you type `!gh react` in the address bar, the Service Worker intercepts the request before it reaches the network. It parses the bang trigger, looks it up in the bang map (checking custom bangs first, then built-ins), and responds with a 302 redirect. If no bang is found, your default search engine is used.

See [DEVELOPMENT.md](DEVELOPMENT.md) for build pipeline and project structure details.

## Comparison with other bang tools

|                           | **flashbang**                             | **unduck**                            | **unduckified**                       | **rebang**                                            |
| ------------------------- | ----------------------------------------- | ------------------------------------- | ------------------------------------- | ----------------------------------------------------- |
| **Redirect method**       | Service Worker intercept                  | `window.location.replace`             | `window.location.replace`             | Cloudflare Worker (edge) + client fallback            |
| **When redirect happens** | Service Worker only - nothing unnecessary | After full page loads (HTML, CSS, JS) | After full page loads (HTML, CSS, JS) | At the edge or after full page loads (React included) |
| **Sources**               | DDG + Kagi + custom                       | DDG                                   | Kagi                                  | DDG + Kagi                                            |
| **Analytics**             | None                                      | Plausible                             | Cloudflare beacon.min.js              | Plausible                                             |
| **Server required**       | No (redirects), yes (suggestions, OpenSearch) | No                                    | No                                    | Yes (Cloudflare Worker)                               |
| **Feeling Lucky**         | Yes (configurable per-engine)             | No                                    | No                                    | No                                                    |
| **Search suggestions**    | Yes (bang autocomplete + configurable)    | No                                    | No                                    | No                                                    |
| **Custom bangs**          | Yes (IndexedDB faster)                    | No                                    | Yes (localStorage)                    | Yes (localStorage)                                    |
| **Build tool**            | Rust codegen + Bun                        | Vite                                  | Vite                                  | Vite                                                  |
| **Bang data strategy**    | Two-tier (min for SW, full for UI)        | Single bundle                         | Single bundle                         | Top bangs in worker, full set client-side             |
| **License**               | AGPL-3.0                                  | MIT                                   | MIT                                   | MIT                                                   |

Flashbang's key architectural difference: when you type `!g kittens`, unduck, unduckified, and rebang all load a full HTML page — CSS, JavaScript, UI framework, analytics — parse your query client-side, and then redirect. Flashbang's philosophy is that a bang redirect is not a page, it's a routing decision. It should never touch the rendering pipeline. A Service Worker intercepts the request before the browser begins rendering, and the settings UI is a separate bundle that only loads when you actually visit the page.

> **Note:** Comparison data is accurate at time of writing. These projects are actively developed and may have changed since.

## Acknowledgments

Flashbang was inspired by [unduck](https://github.com/t3dotgg/unduck) by Theo Browne, which demonstrated the value of fast client-side bang redirects. Bang data is sourced from [DuckDuckGo](https://duckduckgo.com/bang) and [Kagi](https://kagi.com).

## Daily updates

A GitHub Actions workflow runs daily at 00:00 UTC to fetch the latest bang definitions from DuckDuckGo and Kagi, rebuild the generated JavaScript, and commit any changes. This keeps the bang database current without manual intervention.

## Contributing

See [DEVELOPMENT.md](DEVELOPMENT.md) for prerequisites, build commands, and project structure.

## License

[AGPL-3.0](LICENSE) — see [NOTICE](NOTICE).
