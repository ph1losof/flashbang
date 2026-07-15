# Development

## Prerequisites

- [Bun](https://bun.sh) (runtime and bundler)
- [Git](https://git-scm.com)

Playwright browsers are required for end-to-end tests (`bunx playwright install`). Maintainers also need the [GitHub CLI](https://cli.github.com) for releases and Docker for image/health-check work.

## Commands

```sh
bun install        # install dependencies
bun run check      # format + lint check (fails on issues)
bun run fix        # auto-fix format + lint issues
bun run codegen    # fetch DDG/Kagi sources, merge, and generate bang maps
bun run build      # bundle, minify + pre-compress with Brotli (auto-runs codegen --from-merged if generated bang files are missing)
bun run dev        # bundle + dev server with file watching & live reload (auto-runs codegen if needed)
bun run start      # serve pre-built dist/ (run `bun run build` first)
bun run typecheck  # type-check with tsc (no emit)
bun run profile    # run performance profile benchmarks (auto-runs codegen --from-merged if generated bang files are missing)
bun run profile:quick  # run a shorter profiling pass
bun run profile:cpu   # write Bun CPU profiles under profiles/
bun test           # run tests
bun run test:e2e   # run Playwright end-to-end tests (build + browser run)
bun run clean      # remove dist/
```

## Project structure

```
flashbang/
├── .github/
│   ├── codeql/
│   │   ├── actions-config.yml  # Extended CodeQL queries for GitHub Actions
│   │   └── javascript-config.yml # CodeQL scope and queries for JavaScript/TypeScript
│   ├── dependabot.yml          # Weekly Bun, GitHub Actions, and Docker updates
│   ├── images/
│   │   └── landing.png        # README screenshot
│   └── workflows/
│       ├── ci.yaml            # Typecheck, checks, tests, build, and E2E matrix
│       ├── codeql.yaml         # CodeQL analysis for application and workflow code
│       ├── release.yaml       # GitHub Release and multi-architecture image publishing
│       └── update-bangs.yaml  # Daily bang-source refresh
├── functions/
│   ├── suggest.ts            # Cloudflare Pages Function for /suggest
│   └── opensearch.xml.ts     # Cloudflare Pages Function for /opensearch.xml
├── scripts/
│   ├── codegen.ts            # Fetch sources, parse, merge, generate bang maps
│   ├── build.ts              # Bundle + minify pipeline
│   ├── dev.ts                # Dev server with file watching, rebuild & live reload
│   ├── profile.ts            # Profiling script
│   ├── shared.ts             # Shared HTML and static-asset build helpers
│   └── start.ts              # Production server (serves pre-built dist/)
├── data/
│   ├── bangs.json            # Merged bang data (committed, updated by daily automation)
│   └── custom-bangs.json     # Custom bang definitions
├── src/
│   ├── suggest.ts            # Bang/snap suggestions, search suggest proxy & cookie parsing
│   ├── suggest-bang.ts        # Bang/snap suggestion matching and scoring
│   ├── opensearch.ts          # OpenSearch XML generation
│   ├── server/
│   │   ├── handlers.ts       # Production server request handlers
│   │   └── headers.ts        # CSP and security headers (shared across all targets)
│   ├── shared/
│   │   ├── capture-template.ts # Capture template compilation and regex safety
│   │   ├── chars.ts           # Character classification helpers
│   │   ├── constants.ts       # Shared constants
│   │   ├── custom-trigger.ts  # Custom trigger validation and reserved names
│   │   ├── frecency-serial.ts # Compact frecency serialization
│   │   ├── hash.ts            # Shared FNV-1a hash
│   │   ├── idb.ts             # Shared IndexedDB open helper
│   │   ├── raw-query.ts       # Raw query string parsing
│   │   ├── raw-url.ts         # Raw URL pathname and origin parsing
│   │   ├── snap-target.ts     # Alternate snap target validation and compilation
│   │   ├── suggest-cookie.ts  # Unified suggestion cookie codec
│   │   ├── template.ts        # Bang URL template expansion
│   │   └── trie.ts            # Radix trie lookup
│   ├── generated/             # Output of codegen (gitignored, generated from data/bangs.json)
│   │   ├── bangs-min.js       # trigger→URL map for Service Worker
│   │   ├── bangs-meta.js      # trigger→{name, domain} for UI
│   │   ├── bangs-trie.js      # radix trie for prefix-matched bang suggestions
│   │   └── *.d.ts             # TypeScript declarations for each generated .js file
│   ├── sw/
│   │   ├── sw.ts              # Service Worker lifecycle & fetch handler
│   │   ├── redirect.ts        # Bang/snap parsing & redirect logic (zero-copy raw + decoded paths)
│   │   ├── idb.ts             # IndexedDB access, settings cache & in-memory frecency
│   │   └── frecency.ts        # Top-K frecency helpers used by SW
│   └── ui/
│       ├── index.html         # HTML template
│       ├── app.ts             # Initialization & orchestration
│       ├── bang-catalog.ts    # Shared normalized bang metadata and bounded search
│       ├── suggest-provider.ts # Suggestion provider feature availability
│       ├── bench/
│       │   ├── index.html     # Benchmark page
│       │   └── index.ts       # Benchmark script
│       ├── home/
│       │   ├── index.html     # Home page partial
│       │   ├── index.ts       # Homepage initialization
│       │   ├── command.ts     # Homepage bang finder and keyboard controls
│       │   ├── shortcuts.ts   # Global homepage input focus shortcuts
│       │   └── address-bar-setup.ts # Address-bar setup and copy actions
│       ├── settings/
│       │   ├── index.ts       # Settings initialization and shared state
│       │   ├── default-bang.ts # Default bang preview and persistence
│       │   ├── firefox.ts     # Firefox suggestion-provider picker
│       │   ├── providers.ts   # Suggestion and lucky provider controls
│       │   ├── transfer.ts    # Settings import and export
│       │   ├── write.ts       # Serialized writes, validation, and save status
│       │   └── custom-bangs.ts # Custom bang list and add/edit form
│       ├── clipboard.ts       # Shared Clipboard API and legacy fallback
│       ├── dom.ts             # $() selector & el() factory
│       ├── keyboard.ts        # Shared keyboard focus shortcuts
│       ├── sw-bridge.ts       # notifySW() — postMessage to Service Worker
│       ├── cookie.ts          # Suggest cookie management (provider, custom bangs)
│       ├── animations.ts      # Flash & shake CSS animations
│       ├── modal.ts           # Shared dialog lifecycle and focus trapping
│       ├── db.ts              # IndexedDB wrapper
│       ├── liquid-metal.ts    # WebGL2 shader effect
│       ├── icon.svg           # App icon
│       └── manifest.json      # PWA manifest
├── tests/
│   ├── e2e/
│   │   └── flashbang.e2e.ts  # Playwright browser scenarios
│   ├── helpers/
│   │   └── fake-indexeddb.ts # IndexedDB test double
│   └── *.test.ts             # Unit, integration, performance, and docs checks
├── .dockerignore             # Files excluded from Docker build context
├── .gitignore                # Files excluded from version control
├── CONTRIBUTING.md           # Contribution workflow
├── DEVELOPMENT.md            # Development and architecture guide
├── Dockerfile                # Multi-stage Docker build
├── LICENSE                   # AGPL-3.0 license
├── NOTICE                    # Copyright and attribution notice
├── README.md                 # User-facing documentation
├── biome.jsonc               # Formatting and lint configuration
├── bun.lock                  # Locked development dependencies
├── bunfig.toml               # Bun test configuration
├── package.json              # Scripts and package metadata
├── playwright.config.ts      # End-to-end test configuration
├── tsconfig.json             # TypeScript configuration
└── uno.config.ts             # UnoCSS theme
```

Every tracked file must appear explicitly or match a glob in this tree. `tests/development-docs.test.ts` enforces completeness as part of `bun test`; the generated bang artifacts are also shown because builds depend on them even though they are gitignored.

## Tests

```sh
bun test           # run all tests
bun run test:e2e   # run end-to-end tests (build + Playwright)
```

Unit and performance tests:

- `tests/redirect.test.ts` — Bang/snap parsing, routing logic, and URL encoding
- `tests/redirect-perf.test.ts` — Redirect performance benchmarks
- `tests/capture-template.test.ts` — Capture template parsing and regex safety
- `tests/snap-target.test.ts` — Alternate snap target validation
- `tests/suggest.test.ts` — Cookie parsing, bang/snap suggestions, and provider proxying
- `tests/codegen-transform.test.ts` — Codegen transformation and domain extraction
- `tests/codegen-roundtrip.test.ts` — Generated lookup round trips
- `tests/build-cache.test.ts` — Deterministic Service Worker cache version inputs
- `tests/custom-trigger.test.ts` — Custom trigger validation and reserved names
- `tests/development-docs.test.ts` — Project-tree syntax, paths, file types, and tracked-file completeness
- `tests/raw-url.test.ts` — Raw URL pathname and origin parsing
- `tests/frecency.test.ts` and `tests/frecency-serial.test.ts` — Top-K ordering and compact serialization
- `tests/handlers.test.ts` — Server-side suggest handler behavior and cookie cleanup
- `tests/headers.test.ts` and `tests/opensearch.test.ts` — Security headers and OpenSearch XML
- `tests/template.test.ts` — Simple URL-template parsing and caching
- `tests/sw-runtime.test.ts` and `tests/sw-idb.test.ts` — Service Worker lifecycle, settings, and persistence
- `tests/start-cache.test.ts` — Production cache headers and Brotli negotiation
- `tests/ui-db.test.ts` — Settings import/export and custom-bang updates

End-to-end tests:

- `tests/e2e/flashbang.e2e.ts` — Suggest/OpenSearch endpoints, settings persistence and import/export, warm/cold/offline redirect flows, Service Worker cache updates, and custom bang/capture/snap scenarios

If this is your first Playwright run on a machine, install browsers once:

```sh
bunx playwright install
```

## Bang codegen

`bun run codegen` fetches bang sources and generates the JavaScript bang maps that `build` and `dev` depend on:

1. **Fetch sources** — Downloads bang definitions from DuckDuckGo (`bang.js`) and Kagi (`bangs.json`) into `data/`
2. **Merge + validate** — Parses DDG, Kagi, and custom sources. Merges by trigger (deduplicates), validates URLs, and saves the merged result to `data/bangs.json`
3. **Generate** — Produces three JS files in `src/generated/` from the merged data:
   - `bangs-min.js` — packed regular lookup plus sparse capture and snap overrides for the Service Worker
   - `bangs-meta.js` — trigger→{name, domain} for the UI
   - `bangs-trie.js` — radix trie for prefix-matched bang suggestions
   - plus matching `*.d.ts` declaration files for all generated modules

The `--from-merged` flag skips steps 1–2 and generates directly from the committed `data/bangs.json`. This is what CI builds use — no network fetch needed. The generated directory is gitignored; `data/bangs.json` is the committed build input.

The bang data is split into two tiers so the Service Worker loads only what it needs for fast redirects, while the UI gets the full metadata for searching and display.

## Advanced bangs and snap targets

User-created simple bangs use a URL containing `{}`. Capture bangs instead pair a regular expression with `$1`, `$2`, and later placeholders in the URL template. `src/shared/capture-template.ts` validates pattern and template bounds, rejects unsafe constructs, prevents captures from changing the URL origin, and compiles accepted records once when Service Worker settings load. Capture substitutions support percent, plus-space, and raw encoding.

Kagi `ad` metadata and the custom-bang **Snap target** field provide an alternate domain or path for `@trigger` searches without changing normal `!trigger` behavior. `src/shared/snap-target.ts` validates and compiles targets into a site filter plus bare-snap origin. Codegen emits only non-redundant built-in overrides; custom targets are attached to their precompiled IndexedDB entries.

Custom bangs are stored in the `custom-bangs` IndexedDB object store. The UI supports add, edit, atomic trigger rename, remove, import, and export. After a mutation, `notifySW("invalidate")` clears the Service Worker's cached settings so regex and snap metadata are recompiled on the next read. The suggestion cookie contains custom trigger names for autocomplete, not full custom definitions.

## Content Security Policy

CSP headers are defined in `src/server/headers.ts` — the single source of truth for all deployment targets. The page CSP and SW CSP differ:

- **Page CSP** — No `unsafe-eval`. Production targets use inline script hashes; only `dev.ts` uses `'unsafe-inline'` for the live-reload script
- **SW CSP** — Strict: `default-src 'self'; script-src 'self'; connect-src 'self'`. No `unsafe-eval`; SW runtime avoids eval.

On **Cloudflare Pages**, CSP is set per-path in `_headers` (not `/*`) to avoid CF Pages' additive header merging — `/*` would combine with `/sw.js`, and the browser enforces the intersection. Instead, CSP is set individually on `/`, `/index.html`, `/home.html`, `/bench.html`, and `/sw.js`.

On **self-hosted** (Docker/Railway via `start.ts`), the Bun server sets headers per-request, serving `SW_HEADERS` for `/sw.js` and page headers for everything else.

## Build pipeline

`bun run build` bundles the app:

1. **Bundle UI + bench** — Bun bundles `src/ui/app.ts` (with code splitting) to `dist/app.js` plus small chunks, and bundles `src/ui/bench/index.ts` to `dist/bench.js`
2. **Bundle Service Worker** — Bun bundles `src/sw/sw.ts` (including `bangs-min.js`) into `dist/sw.js`; hashes of the UI outputs determine the injected cache version and extra precache assets
3. **Generate CSS** — UnoCSS scans `src/ui/**/*.ts` and HTML files, emitting atomic utility classes
4. **Inline & minify HTML** — CSS is inlined into `<style>`, HTML is minified with `@minify-html/node`
5. **Generate static-host headers** — Writes `dist/_headers` with shared security headers, per-page inline-script hashes, the stricter Service Worker CSP, and the OpenSearch content type
6. **Pre-compress** — Eligible text assets are compressed with Brotli (max quality) and written as `.br` files alongside the originals. The production server serves these automatically when the client supports it, falling back to uncompressed

If generated bang artifacts are missing, both `bun run build` and `bun run profile` automatically run `bun run codegen --from-merged` first.

## Profiling

`bun run profile` benchmarks generated lookup, redirect variants, suggestions, cookie/query parsing, first-hit isolation, and module evaluation. Use `bun run profile:quick` for a shorter directional pass and `bun run profile:cpu` for Bun CPU profiles.

The profiler can save and compare structured baselines:

```sh
bun run profile --save main
bun run profile --compare main --threshold 5 --fail-on-regression
```

Bare baseline names resolve under `profiles/baselines/`, which is gitignored. Reports include run-level percentiles and variation; low single-digit nanosecond differences should be treated as directional. The browser benchmark at `/bench` enables client-scoped benchmark mode so its own redirects do not update frecency.

## Frecency

The Service Worker tracks bang usage to personalize suggestion ordering. The flow:

1. **On bang or snap redirect** — `sw.ts` queues `trackBangUsage(trigger)`, which updates the in-memory count map and top-eight entries. Coalesced compact snapshots are persisted in IndexedDB across Service Worker restarts
2. **Cookie sync** — When Cookie Store is available, `sw.ts` preserves the existing provider/custom context and writes top frecency entries into the `f:` section of the unified `suggest` cookie
3. **Suggest reads frecency** — `suggest.ts` parses the unified cookie and passes its frecency map to `bangSuggestions()`, which boosts candidates by usage count

The in-memory state (`frecencyCounts` plus `topFrecency` in `idb.ts`) is loaded from IndexedDB once and kept for the Service Worker lifetime. `invalidateCache()` clears only redirect settings and the shared database connection; loaded frecency and pending persistence remain intact. Browser benchmark mode suppresses these side effects only for the requesting benchmark client.

**Browser cookie behavior**: Chromium-based browsers (Chrome, Edge, Arc) send cookies with suggest requests when the site is the default search engine. Firefox-based browsers (Firefox, Zen, LibreWolf) intentionally withhold cookies from OpenSearch suggest requests as a privacy decision ([bug 1624457](https://bugzilla.mozilla.org/show_bug.cgi?id=1624457)). The settings UI therefore provides a copyable Firefox suggestion URL with an explicit provider. Cookie-backed custom trigger suggestions and frecency are unavailable on those requests; redirect behavior is unaffected.

## Dev server

`bun run dev` runs the dev server with `bun --hot` for soft module reloading:

- **Codegen guard** — If `src/generated/bangs-min.js` is missing, automatically runs `bun run codegen` before the first build
- **Inline builds** — Uses `Bun.build()` API directly instead of shelling out to build scripts
- **File watching** — Watches `src/` recursively via `fs.watch` with 200ms debounce. Any source change triggers a full rebuild
- **Live reload** — SSE endpoint at `/__dev/events` pushes reload events to the browser. A small script is injected into HTML responses that unregisters the Service Worker, clears all caches, and reloads the page on each rebuild
- **Hot reload** — `bun --hot` enables Bun's native hot module reloading for `Bun.serve()`, so the server's fetch handler updates without process restart

## Production server

`bun run start` serves the pre-built `dist/` directory with no build step, file watching, or live reload injection. Useful for testing the production build locally. Requires `bun run build` to have been run first.

`PUBLIC_ORIGIN` optionally overrides the request origin used in `/opensearch.xml`, which is useful behind reverse proxies and TLS termination. It must be an absolute HTTP(S) URL without credentials. The URL is canonicalized to its origin, so trailing slashes, paths, queries, and fragments are discarded. When unset, the handler uses the request origin (including on Cloudflare Pages, where the optional binding is read from the Function context). An invalid configured value fails closed with a `500` response.

## Docker

The Dockerfile uses a multi-stage build to produce a minimal runtime image:

1. **Build stage** — Installs dependencies, runs `codegen --from-merged` to generate bang maps from `data/bangs.json`, then runs `build` to bundle and pre-compress all assets
2. **Runtime stage** — Copies `dist/`, `scripts/start.ts`, and only the source modules needed at runtime for dynamic `/suggest` and `/opensearch.xml` handling (plus generated trie data). Dev dependencies are not installed in the final image

The production server exposes `GET /health`, and the runtime image defines a Docker `HEALTHCHECK` against that endpoint.

```sh
docker build -t flashbang .
docker run -p 3000:3000 flashbang
```

The port is configurable via the `PORT` environment variable:

```sh
docker run -p 8080:8080 -e PORT=8080 flashbang
```

Static assets are served with Brotli pre-compression when the client supports it, falling back to uncompressed. No runtime compression overhead.

## CI

A CI workflow (`.github/workflows/ci.yaml`) runs on every push and pull request to `master`. Its main job runs codegen (`--from-merged`), typecheck, lint/format checks, tests, and a full build with no external bang-source fetching. A separate matrix builds the app and runs the Playwright suite in Chromium, Firefox, and WebKit.

A daily cron workflow (`.github/workflows/update-bangs.yaml`) fetches fresh bang sources from DDG and Kagi, merges them, and commits the updated `data/bangs.json` when there are changes.

## Releasing

1. Update `version` in `package.json`
2. Run `bun run typecheck`, `bun run check`, `bun test`, `bun run build`, and the relevant Playwright tests
3. Commit and push: `chore: bump version to X.Y.Z`
4. Write GitHub release notes following the previous release's structure, including a `vOLD...vNEW` compare link
5. Create the tag and release: `gh release create vX.Y.Z --target master --title vX.Y.Z --notes-file <path> --latest`

The release workflow (`.github/workflows/release.yaml`) handles the rest:
runs codegen (`--from-merged`), typecheck, lint/format checks, tests, and build, then creates or updates the GitHub Release without replacing existing custom notes.

Before publishing, the workflow builds a local image, runs it, and requires Docker's built-in container health status to become `healthy`. It then pushes `linux/amd64` and `linux/arm64` images to `ghcr.io/<owner>/flashbang` with both the release version and `latest` tags.
