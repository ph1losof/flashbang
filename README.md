# flashbang

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://dash.cloudflare.com/?to=/:account/workers-and-pages) [![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/flashbang?referralCode=cxTxcH&utm_medium=integration&utm_source=template&utm_campaign=generic)

![Flashbang](.github/images/landing.png)

Turn your browser's address bar into a shortcut launcher. Type `!g kittens` to search Google, `!w dogs` for Wikipedia, `!gh react` for GitHub — over 14,000 shortcuts (called "bangs") that take you straight to the right site, instantly. No extra tabs, no round-trips, no waiting for a page to load. Or use **snaps** — type `@w quantum` to search your default engine restricted to Wikipedia, `@gh api` for GitHub-only results.

Every other bang tool loads a full page before redirecting — adding hundreds of milliseconds — or routes through an edge server adding network latency. Flashbang skips the page entirely — a [Service Worker](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API) handles the redirect before your browser even starts rendering.

### Try it now

Visit **[flashbang-dyr.pages.dev](https://flashbang-dyr.pages.dev)** — if your browser supports [OpenSearch](https://developer.mozilla.org/en-US/docs/Web/OpenSearch), flashbang will appear in your search engine list automatically. Otherwise, add **`https://flashbang-dyr.pages.dev?q=%s`** as a custom search engine in your browser. Optionally, set **`https://flashbang-dyr.pages.dev/suggest?q=%s`** as the suggestion URL for address bar autocomplete. That's it.

> **Note for Microsoft Edge users:** Edge needs a one-time setup tweak (the auto-discovered entry has to be deleted and re-added manually) — see [Browser quirks](#browser-quirks). Without it, your default search engine gets overwritten after the first bang you use.

### Already using DuckDuckGo, Brave, or Kagi?

All three support bangs natively — but every query still round-trips through their servers before redirecting, adding significant network latency you can feel. Flashbang's Service Worker resolves the bang locally in sub 1ms and redirects before any network request leaves your machine. You also get bang-aware search suggestions in your address bar, custom bangs, feeling lucky, and it works in any browser — not just the one your engine ships with.

### Privacy

> Core redirects never leave your machine — the Service Worker handles them offline with no server involved. Search suggestions are completely optional and go through our server when enabled on the hosted version. One same-site cookie (`suggest`) stores your configured suggestion provider, default bang, selected bang/snap prefixes, optional custom suggestion URL, custom bang trigger names, and compact top bang usage counts so the server can proxy and personalize suggestions. The frecency section contains only bang triggers and hit counts (e.g. `g:50.yt:30`), never query content. No accounts, no sessions, no personal data. There is no tracking or analytics — we don't know what you search or what bangs you use. Cloudflare Pages exposes basic request counts in its dashboard as a platform feature we did not opt into and cannot disable. It contains no query content or personally identifiable information.
>
> If you'd rather not trust our server at all, Flashbang is fully self-hostable. Deploy to Cloudflare Pages/Railway in minutes or `docker run` it on any VPS — a single command gets you a fully private instance. See [Setup](#setup-as-search-engine) for details.

## Features

- **Built for speed** — Advertised as sub-1ms to be conservative, since technically, it could fall anywhere in this range, in my tests I have achieved median of `0.14ms` on `/bench` page in Chrome's Incognito window. That's the overhead Flashbang adds before your browser starts loading the destination — network time to reach the target site is the same regardless of which tool you use. The Service Worker intercepts requests before they hit the network, parses the bang, and responds with a 302 — no page load, no framework, no round-trip to a server. Don't trust our numbers? [Run the benchmark yourself](https://flashbang-dyr.pages.dev/bench) — results vary by machine
- **Zero runtime deps** — Ships without production npm dependencies; redirects run on plain browser APIs in the Service Worker
- **Private** — No analytics, no tracking. All data stays on your device for the core feature - redirects
- **14,000+ bangs** — Merged from DuckDuckGo, Kagi, and custom sources. Updated daily via automated CI
- **Custom bangs** — Add your own bangs through the settings UI. They take priority over built-ins
- **Configurable syntax** — Choose distinct bang and snap prefixes from `!`, `@`, `$`, `:`, `;`, and `~`. Defaults are `!` for bangs and `@` for snaps. The selected bang prefix also controls bare Feeling Lucky forms; leading `\query` always remains available
- **Search suggestions** — The only bang tool with bang-aware autocomplete in your browser's native address bar. Type `!y` and the browser itself suggests `!yt` (YouTube), `!ya` (Yandex), `!yf` (Yahoo Finance) — ranked by a combination of global popularity and your personal usage frequency. Regular queries can use Google, DuckDuckGo, Bing, Brave, Yahoo, Ecosia, Kagi, Qwant, Startpage, Yandex, or Baidu. Self-hosted deployments can explicitly opt into custom providers. Both are unified through a single `/suggest` endpoint that plugs into your browser's built-in suggestion UI. Firefox-based browsers also render bang descriptions, site names, and favicons inline in the dropdown via `google:suggestdetail`. See [Browser quirks](#browser-quirks) for rendering and cookie differences across browsers
- **Frecency** — The Service Worker tracks which bangs and snaps you use and how often, entirely in-memory on the redirect path. Your most-used triggers are promoted in autocomplete suggestions so they surface first. Compact snapshots are persisted to IndexedDB across Service Worker restarts. Suggestion personalization is available in Chromium-based browsers; it is not available in Firefox-based browsers — see [Browser quirks](#browser-quirks)
- **Snaps** — Type `@trigger query` to search your default engine with results restricted to that trigger's domain via `site:`. For example, `@w quantum` searches Google for `quantum site:en.wikipedia.org`. Works in prefix (`@w quantum`) and suffix (`quantum @w`) positions. A bare snap (`@w`) redirects to the trigger's homepage. Snaps reuse bang triggers; entries without a resolvable web domain, such as the internal `settings` shortcut, fall back to a normal search
- **Feeling Lucky** — Prefix a query with `\`, or add the selected bang prefix before or after it, to skip the results page and jump straight to the first result. The bang prefix defaults to `!`; selecting another prefix replaces those bare `!` forms, while `\` remains available. The default mode matches Google, DuckDuckGo, or Kagi when one of those is your default engine, and falls back to DuckDuckGo for other engines. You can also select a provider, use a custom URL, or disable it entirely
- **OpenSearch** — Browsers auto-discover Flashbang as a search engine via `/opensearch.xml`, including the suggestions endpoint. The XML is dynamically generated at request time using the current origin, so it works out of the box on any self-hosted domain or `localhost` — no hardcoded URLs to change

## Configurable syntax

Settings lets you select different prefixes for bangs and snaps from `!`, `@`, `$`, `:`, `;`, and `~`. Changing a prefix replaces that syntax rather than adding an alias. For example, with `$` for bangs and `~` for snaps, use `$gh react`, `react $gh`, `~w quantum`, and `quantum ~w`; `!gh` and `@w` become ordinary search text. The examples below use the default `!` and `@` prefixes.

## Bang syntax

Flashbang supports 4 formats. All bangs are case-insensitive.

| Format              | Example      | Result                      |
| ------------------- | ------------ | --------------------------- |
| Prefix bang         | `!g kittens` | Google search for "kittens" |
| Suffix bang         | `kittens g!` | Google search for "kittens" |
| Prefix, query first | `kittens !g` | Google search for "kittens" |
| Suffix, bang first  | `g! kittens` | Google search for "kittens" |

If the query is just a bang with no search term (e.g. `!g`), Flashbang redirects to the service's homepage.

## Snap syntax

By default, snaps use `@` instead of `!` to perform a **site-restricted search** — your query goes to your default search engine with `site:domain` appended. Any bang trigger with a resolvable web domain works as a snap. All snaps are case-insensitive.

| Format      | Example      | Result                                                    |
| ----------- | ------------ | --------------------------------------------------------- |
| Prefix snap | `@w quantum` | Default engine search for "quantum site:en.wikipedia.org" |
| Suffix snap | `quantum @w` | Default engine search for "quantum site:en.wikipedia.org" |
| Bare snap   | `@gh`        | Redirect to github.com homepage                           |

If a query contains both a bang (`!`) and a snap (`@`), the bang takes precedence. Unknown snap triggers, and triggers without a resolvable web domain, fall back to a normal default search.

### Feeling Lucky

Skip the search results page and go directly to the first result. The table uses the default bang prefix; if you change it, the leading/trailing bare marker changes with it. Leading backslash remains fixed.

| Format       | Example     | Result                     |
| ------------ | ----------- | -------------------------- |
| Backslash    | `\kittens`  | First result for "kittens" |
| Trailing `!` | `kittens !` | First result for "kittens" |
| Leading `!`  | `! kittens` | First result for "kittens" |

The redirect destination depends on your lucky provider (configurable in settings):

- **Default (match bang)** — Uses your default search engine's native lucky feature if available (Google `btnI`, DuckDuckGo `\`), otherwise falls back to DuckDuckGo's `\` redirect
- **Google** / **DuckDuckGo** / **Kagi** — Always use that engine's lucky redirect
- **Custom** — Provide your own URL template with `{}` as the query placeholder
- **Disabled** — Lucky syntax is treated as a normal search query

## Setup as search engine

> **Note:** Search suggestions and OpenSearch auto-discovery require a server endpoint since browsers don't route these requests through Service Workers — both are completely optional. Redirects always work offline once installed with no server needed. If you use the hosted version, these requests go through our Cloudflare Pages Functions. No queries are logged or stored — self-host if you'd rather keep them local too.

### Suggestion URL parameters

The suggestion endpoint accepts cookie-independent query parameters for the suggestion provider and shortcut syntax:

- `sp` selects the suggestion provider
- `bp` selects the bang prefix
- `np` selects the snap prefix

`bp` and `np` must be supplied together, must differ, and each accepts `!`, `@`, `$`, `:`, `;`, or `~`. Invalid pairs safely fall back to cookie or default settings. Provider values are:

```text
google, ddg, bing, brave, yahoo, ecosia, kagi, qwant, startpage, yandex, baidu, none
```

Example Firefox suggestion URL with provider and syntax overrides:

```text
https://flashbang-dyr.pages.dev/suggest?q=%s&sp=ddg&bp=%24&np=~
```

**Why this exists:** in Chromium-based browsers, cookies are sent with suggest requests and settings configured in the UI are picked up automatically, so these overrides are rarely needed. Firefox-based browsers withhold cookies; the settings UI therefore generates a copyable URL containing `sp`, and adds `bp` plus `np` when the selected syntax differs from the default `!`/`@` pair. See [Browser quirks](#browser-quirks) for details.

### Use the hosted version

A public instance is available at **[flashbang-dyr.pages.dev](https://flashbang-dyr.pages.dev)**. Just visit it, then add it as a custom search engine in your browser:

- **Search URL:** `https://flashbang-dyr.pages.dev?q=%s`
- **Suggestion URL:** `https://flashbang-dyr.pages.dev/suggest?q=%s` (Optional)

Nothing to build or deploy.

### Browser quirks

These apply equally to the hosted version and any self-hosted instance — worth a quick read before adding flashbang as your default.

- **Microsoft Edge — bang destinations hijack the default search.** After you use a bang like `!gm`, Edge auto-registers the destination (Google Maps, GitHub, etc.) as a separate search engine with the _same_ shortcut as flashbang (the host). When two engines share a shortcut, Edge picks the most-recently-used one for default searches — so your plain queries start going to Google Maps. Not observed in Chrome or Firefox.

  **Fix** — in `edge://settings/searchEngines`:
  1. Delete the auto-discovered flashbang entry.
  2. Click **Add** and re-add it manually:
     - **Search engine:** `flashbang`
     - **Shortcut:** something short and unique like `f`
     - **URL with %s:** `https://flashbang-dyr.pages.dev?q=%s` (or your self-hosted URL)
  3. Set it as your default.

  **Important:** _editing_ the auto-discovered entry's Shortcut doesn't persist — Edge re-derives it from `/opensearch.xml` on restart and reverts to the host. The delete-and-readd step is what makes the fix stick, because a manually-added entry is independent of the discovery XML.

- **Firefox / Zen / LibreWolf — no frecency, no custom bangs in suggestions.** Firefox-based browsers intentionally [withhold cookies from OpenSearch suggest requests](https://bugzilla.mozilla.org/show_bug.cgi?id=1624457) as a privacy measure. Flashbang's custom bang trigger names and frecency data are carried by the unified `suggest` cookie, so those features remain unavailable on these requests. Provider and bang/snap prefix settings can be embedded directly with `sp`, `bp`, and `np`; the settings UI generates the complete URL — see [Suggestion URL parameters](#suggestion-url-parameters).

- **Chromium — plain-text suggestions only.** Chrome, Edge, Arc, and other Chromium-based browsers don't render rich suggestion details (descriptions, favicons, entity images) for search-type suggestions from custom search engines; they're shown as plain text. Firefox-based browsers render the rich data passed through `google:suggestdetail`. This is a Chromium limitation, not flashbang's.

### Deploy your own

**Cloudflare Pages** (recommended) — supports both redirects and suggestions out of the box:

1. Deploy the repo to Cloudflare Pages with build command `bun run codegen --from-merged && bun run build` and output directory `dist`
2. The Pages Functions automatically handle `/suggest` (search suggestions) and `/opensearch.xml` (search engine discovery with correct origin) on the edge
3. Visit the site — your browser will auto-discover it via OpenSearch
4. Or manually add a custom search engine:
   - **Search URL:** `https://your-domain?q=%s`
   - **Suggestion URL:** `https://your-domain/suggest?q=%s`

**Railway** — detects the Dockerfile and deploys automatically:

1. Connect your repo on [Railway](https://railway.app)
2. Railway builds the Docker image and sets the `PORT` environment variable automatically
3. Connect domain (you can auto-generate it in settings)
4. Add a custom search engine:
   - **Search URL:** `https://your-app.up.railway.app?q=%s`
   - **Suggestion URL:** `https://your-app.up.railway.app/suggest?q=%s`

For deployments behind a reverse proxy or TLS terminator, set `PUBLIC_ORIGIN` to the browser-visible URL (for example, `https://search.example.com`). OpenSearch uses this value instead of the request URL. It must be an absolute `http://` or `https://` URL without credentials; any trailing slash, path, query, or fragment is discarded. If it is unset, Flashbang uses the request origin, preserving the default Cloudflare Pages behavior. If it is set but invalid, `/opensearch.xml` returns `500` rather than publishing incorrect or unsafe URLs.

Custom suggestion URLs are disabled by default because they allow the server to proxy requests to arbitrary destinations. A trusted self-hosted deployment can opt into the previous behavior by setting `ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS=true` during both the build and at runtime. The setting is compiled into the UI, so changing it requires rebuilding and redeploying. Do not enable this on a public instance.

**Other static hosts** (Netlify, Vercel, etc.) — redirects work, but suggestions and dynamic OpenSearch require adding serverless functions for `/suggest` and `/opensearch.xml`. See `functions/` for the implementations — they reuse shared modules from `src/` and can be adapted to any serverless platform.

### Self-host with Docker (recommended)

Run your own instance on any VPS. No dependencies to install — just Docker:

```sh
docker build -t flashbang .
docker run -p 3000:3000 flashbang
```

To include custom suggestion URLs in a private Docker deployment, build with `docker build --build-arg ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS=true -t flashbang .`. The image uses the same value as its runtime default.

The image uses a multi-stage build — fetches bang sources, builds assets, and produces a minimal runtime image. Static assets are pre-compressed with Brotli at build time and served automatically, falling back to uncompressed for clients that don't support it. The port is configurable via the `PORT` environment variable (`-e PORT=8080`); `PUBLIC_ORIGIN` configures the browser-visible origin when running behind a reverse proxy (for example, `-e PUBLIC_ORIGIN=https://search.example.com`).

For a remote deployment, terminate TLS with a reverse proxy or hosting provider and expose Flashbang over HTTPS. Browsers only enable Service Workers in secure contexts (HTTPS or localhost), and Flashbang's suggestion settings cookie is `Secure`. Plain HTTP on a VPS will not provide worker redirects or persistent suggestion settings. Set the HTTPS origin as your browser's custom search engine:

- **Search URL:** `https://search.example.com?q=%s`
- **Suggestion URL:** `https://search.example.com/suggest?q=%s`

### Self-host without Docker

Requires [Bun](https://bun.sh). Service Workers require HTTPS except on `localhost`; a local HTTP server works because browsers treat localhost as a secure context:

```sh
bun run codegen && bun run build && bun run start
```

`bun run codegen` fetches the latest bang definitions from DuckDuckGo and Kagi and generates the JavaScript bang maps. `bun run build` bundles, minifies, and pre-compresses all static assets with Brotli into `dist/`. `bun run start` serves the production build locally. Visit the local URL once — the Service Worker installs and redirects work offline after that. Set it as your browser's custom search engine:

If generated bang artifacts are missing, `bun run build` and `bun run profile` automatically run `bun run codegen --from-merged` before continuing.

- **Search URL:** `http://localhost:3000?q=%s`
- **Suggestion URL:** `http://localhost:3000/suggest?q=%s` (Optional)

To pick up new bangs, pull the latest changes and re-run `bun run codegen`. If you host it, the daily GitHub Actions CI does this automatically.

The settings page has a copy button that gives you the exact search URL template.

## Settings

Open the settings modal from the gear icon on the home page, or type **`!settings`** in the address bar to jump there directly. Type **`!`** on its own to quickly access the home page.

- **Shortcut syntax** — Choose distinct bang and snap prefixes from `!`, `@`, `$`, `:`, `;`, and `~`. Defaults are `!` and `@`
- **Default bang** — The built-in bang used when no selected bang prefix is in the query. Defaults to `g` (Google). Change it to `ddg`, `b`, or any other built-in trigger
- **Feeling Lucky** — Choose how lucky redirects resolve: Default (match Google, DuckDuckGo, or Kagi when selected as the default bang, otherwise fall back to DuckDuckGo), Google, DuckDuckGo, Kagi, Custom (your own URL template with `{}` as query placeholder), or Disabled
- **Search suggestions** — Choose the source for address bar autocomplete: Default (match a supported default bang, otherwise return no regular-query suggestions), Google, DuckDuckGo, Bing, Brave, Yahoo, Ecosia, Kagi, Qwant, Startpage, Yandex, Baidu, Custom (self-hosted deployments with `ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS=true` only), or None
- **Custom bangs** — Add bangs with a trigger, name, and URL template (use `{}` as the query placeholder). Advanced bangs can match the query with a regular expression, substitute `$1`, `$2`, etc., and set a separate domain or path for `@snap` searches. Custom bangs override built-in ones
- **Search bangs** — Real-time search across all 14,000+ bangs by trigger, name, or domain
- **Import/Export** — Export your settings and custom bangs as JSON. Import to restore or sync across devices

All settings are stored in IndexedDB locally on your device.

For example, a capture bang with URL `https://translate.example/$1/$2` and regex `(\w+)\s+(.*)` turns `!trurl ja https://example.com` into a URL containing `ja` and the encoded source URL. Capture values can use percent, plus-space, or raw encoding.

An optional snap target such as `docs.example.com/api` makes `@mybang query` search only that domain and path, while `!mybang query` continues to use the bang's normal URL.

## How it works

When you type `!gh react` (or the equivalent with your selected bang prefix) in the address bar, the Service Worker intercepts the request before it reaches the network. It parses the bang trigger, looks it up in the bang map (checking custom bangs first, then built-ins), and responds with a 302 redirect. Snaps work the same way with their separately selected prefix — the Service Worker resolves the trigger's domain and redirects to your default search engine with `site:domain` appended. If no bang or snap is found, your default search engine is used.

See [DEVELOPMENT.md](DEVELOPMENT.md) for build pipeline and project structure details.

## Comparison with other bang tools

|                             | **flashbang**                                 | **unduck**                       | **unduckified**                  | **rebang**                                             |
| --------------------------- | --------------------------------------------- | -------------------------------- | -------------------------------- | ------------------------------------------------------ |
| **Redirect method**         | Service Worker intercept                      | `window.location.replace`        | `window.location.replace`        | Cloudflare Worker (edge) + client fallback             |
| **When redirect happens**   | Before page renders (Service Worker)          | After page loads (HTML, CSS, JS) | After page loads (HTML, CSS, JS) | At the edge or after page loads (HTML, CSS, JS, React) |
| **Sources**                 | DDG + Kagi + custom                           | DDG                              | Kagi                             | DDG + Kagi                                             |
| **Analytics**               | None†                                         | Plausible                        | None‡                            | Plausible+Vercel Analytics+Vercel Speed Insights       |
| **Server required**         | No (redirects), yes (suggestions, OpenSearch) | No                               | No                               | Yes (Cloudflare Worker)                                |
| **Snaps (site: search)**    | Yes (`@trigger`)                              | No                               | No                               | No                                                     |
| **Feeling Lucky**           | Yes (configurable per-engine)                 | No                               | No                               | No                                                     |
| **Search suggestions**      | Yes (bang autocomplete + configurable)        | No                               | No                               | No                                                     |
| **OpenSearch**              | Yes (dynamic, self-host friendly)             | No                               | Yes                              | Yes                                                    |
| **Custom bangs**            | Yes (IndexedDB faster)                        | No                               | Yes (localStorage)               | Yes (localStorage)                                     |
| **Build tool**              | Bun                                           | Vite                             | Vite                             | Vite                                                   |
| **Bang data for redirects** | ~843 KB (packed trigger→URL lookup)           | 2.7 MB (full metadata)           | 1.5 MB (full metadata)           | ~200 KB inline + 1.5 MB lazy-loaded                    |
| **Parsed on**               | SW thread (once per worker lifetime)          | Main thread (every page load)    | Main thread (every page load)    | Main thread (every page load) or edge worker           |
| **License**                 | AGPL-3.0                                      | MIT                              | MIT                              | MIT                                                    |

† Flashbang doesn't include any analytics scripts or tracking. Cloudflare Pages exposes basic request counts in its dashboard for all hosted sites — this is a platform-level
metric we did not opt into and cannot disable. It is not Cloudflare Web Analytics.

‡ Unlike the unavoidable aggregate request counts exposed by Cloudflare Pages which applies both for flashbang and unduckified, issue [#13](https://github.com/taciturnaxolotl/unduckified/issues/13) in the Unduckified repository shows Cloudflare injecting `beacon.min.js`, which [Cloudflare documents as its Web Analytics beacon](https://developers.cloudflare.com/web-analytics/data-metrics/data-origin-and-collection/).
The author claims that Web Analytics have been disabled, but `beacon.min.js` is still being loaded, indicating that an analytics-related Cloudflare script remains present.

> **Note:** Comparison data is accurate at time of writing. These projects are actively developed and may have changed since.

## Why is it faster?

Every other bang tool (unduck, unduckified) — works the same way: your browser navigates to their page, loads HTML, parses and executes JavaScript (including a 1.5–2.7 MB bang database), and only then calls `window.location.replace()` to send you to your destination. You see it happen: there is a screen flash, their page briefly appears or flickers, and then you arrive where you wanted to go. That blank-page flash is the browser loading and executing their redirect page. It typically takes 100–500ms depending on your device, and it happens on every single redirect — even with all assets cached.

Flashbang works differently. A [Service Worker](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API) intercepts your navigation **before the browser starts rendering any page**. It parses the bang from the raw URL, looks it up in an in-memory map, and responds with a `302 redirect` — all in under 1ms. No page loads. No JavaScript bundle to parse. No white flash. Your browser goes straight from the address bar to your destination nearly as if you'd typed the URL directly.

The packed bang database (trigger→URL lookup, currently ~708 KiB uncompressed) is loaded into typed-array views when the Service Worker starts and stays in memory across navigations for that worker lifetime. The settings UI is a separate bundle that only loads when you visit the homepage. During a redirect, the hot path is a lightweight parser and a minimal-perfect-hash lookup; settings persistence and frecency updates are handled outside the response path.

That lookup path is pre-optimized by `scripts/codegen.ts` at build time. Instead of shipping a large plain JSON/object map, codegen splits bang URLs into deduplicated prefix/suffix tables, packs trigger/prefix/suffix lengths into typed arrays, and deterministically builds a CHD-style minimal perfect hash from each trigger's FNV-1a hash. Records are emitted directly in perfect-hash slot order, so lookup needs no sparse table or probe loop. The Service Worker verifies the selected trigger and lazily materializes and caches URL parts only for matched entries.

### Will I actually notice the difference?

Yes. Try it yourself: open unduck or unduckified, type `!g cats`, and watch the screen. You'll likely see a white flash or brief page load before Google appears. This is evident by the issues opened in unduckified repo [#6](https://github.com/taciturnaxolotl/unduckified/issues/6) and in unduck repo [#70](https://github.com/T3-Content/unduck/issues/70), [#141](https://github.com/T3-Content/unduck/issues/141). Now do the same with Flashbang. The browser navigates directly to Google — there is no intermediate page to see. The difference is immediately obvious, especially on mobile devices or environments where JavaScript parse time is higher.

[Run the benchmark yourself](https://flashbang-dyr.pages.dev/bench) to see measured redirect latency on your device.

## Acknowledgments

Flashbang was inspired by [unduck](https://github.com/t3dotgg/unduck) by Theo Browne, which demonstrated the value of fast client-side bang redirects. Bang data is sourced from [DuckDuckGo](https://duckduckgo.com/bang) and [Kagi](https://kagi.com).

## Daily updates

A GitHub Actions workflow runs every 24 hours at 00:00 UTC to fetch the latest bang definitions from DuckDuckGo and Kagi, rebuild the generated JSON, and commit any changes. This keeps the bang database current without manual intervention.

## Contributing

See [DEVELOPMENT.md](DEVELOPMENT.md) for prerequisites, build commands, and project structure.

## License

[AGPL-3.0](LICENSE) — see [NOTICE](NOTICE).

Flashbang is designed to be self-hosted and most of projects in this space bundle analytics. AGPL ensures that anyone who deploys a modified version must share their changes — protecting end users from forks that quietly add tracking or degrade privacy. The project introduces a genuinely novel approach (Service Worker intercept, two-tier bang data, bang-aware suggestions), and AGPL ensures derivatives contribute back rather than just extract.
