# flashbang

![Flashbang](docs/landing.png)

Turn your browser's address bar into a shortcut launcher. Type `!g kittens` to search Google, `!w dogs` for Wikipedia, `!gh react` for GitHub — over 14,000 shortcuts (called "bangs") that take you straight to the right site, instantly. No extra tabs, no round-trips, no waiting for a page to load.

Every other bang tool loads a full page before redirecting. Flashbang is the only one that skips the page entirely — a [Service Worker](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API) handles the redirect before your browser even starts rendering. The fastest, most feature-rich, and the only one with zero tracking.

> **Fully local where it matters.** Core redirects never leave your machine — the Service Worker handles them offline with no server involved. Search suggestions (bang autocomplete, web results in your address bar) are completely optional and do go through our server when enabled and used through our hosted version. That's fine by us — Cloudflare Workers make it practically free — but you should know that "fully local" applies to redirects only. There is no tracking or analytics on our end — we don't know what you search and what bangs you use. Cloudflare collects basic request counts on all hosted sites by default (this can't be turned off), but no query content or personally identifiable information is exposed to us through it.

**Try it now:** add **`https://flashbang-dyr.pages.dev?q=%s`** as a custom search engine in your browser. Optionally, set **`https://flashbang-dyr.pages.dev/suggest?q=%s`** as the suggestion URL for address bar autocomplete. That's it.

## Features

- **Built for speed** — Speed is the #1 focus of this project. A Service Worker intercepts requests before they hit the network — no page load, no framework, no unnecessary code execution. Local-only, direct redirect
- **Private** — No analytics, no tracking. All data stays on your device for the core feature - redirects
- **14,000+ bangs** — Merged from DuckDuckGo, Kagi, and custom sources. Updated daily via CI
- **Custom bangs** — Add your own bangs through the settings UI. They take priority over built-ins
- **Search suggestions** — The only bang tool with bang-aware autocomplete in your browser's native address bar. Type `!y` and the browser itself suggests `!yt` (YouTube), `!ya` (Yandex), `!yf` (Yahoo Finance) — ranked by popularity so the most-used bangs surface first. Regular queries return web search suggestions from Google, DuckDuckGo, Bing, Brave, or a custom provider. Both are unified through a single `/suggest` endpoint that plugs into your browser's built-in suggestion UI
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

> **Note:** Search suggestions require a server endpoint since browsers don't route suggestion requests through Service Workers — they are completely optional. Redirects always work offline once installed with no server needed. If you use the hosted version with suggestions enabled, those requests go through our Cloudflare Pages Function. No queries are logged or stored — self-host if you'd rather keep suggestions local too.

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

When you type `!gh react` in the address bar, the Service Worker intercepts the request before it reaches the network. It parses the bang trigger, looks it up in the bang map (checking custom bangs first, then built-ins), and responds with a 301 redirect. If no bang is found, your default search engine is used.

See [DEVELOPMENT.md](DEVELOPMENT.md) for build pipeline and project structure details.

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

Flashbang solves this by separating the two concerns entirely. A thin Service Worker handles redirects — it intercepts the navigation request before the browser even begins rendering. The settings UI is a completely separate bundle that only loads when you actually visit the page.

Rebang deserves a special mention: it has a hybrid mode where a Cloudflare Worker handles the top 1,297 bangs at the edge, falling back to client-side for the rest. But if your bang isn't in that top set, you get worse performance than unduck or unduckified (full React page load + redirect). And even when it hits the edge, you're still limited by Cloudflare's network latency on every single search. For something you use dozens of times a day, having it run locally is incomparably better — you don't rely on a hosting provider, and routing every search through a third-party edge server is arguably not great for privacy either. It's worth noting that rebang's privacy page states "zero logging", "no analytics", "no backend server", and that "all redirects happen entirely in your browser". However, their own architecture shows that every request goes through a Cloudflare Worker for a lookup — it redirects the top 1,297 bangs at the edge and falls through to the client for the rest. Plausible analytics is also present on the page, and the client fallback loads a full React app with Tailwind and heavy logic just for redirects. These observations are based on their public source code and documentation.

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
