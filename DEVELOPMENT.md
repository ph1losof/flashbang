# Development

## Prerequisites

- [Bun](https://bun.sh) 1.3.14 (runtime, package manager, and bundler; the version is pinned in `package.json`, CI, and Docker)
- [Git](https://git-scm.com)

Playwright browsers are required for end-to-end tests (`bunx playwright install`). Maintainers also need the [GitHub CLI](https://cli.github.com) for releases and Docker for image/health-check work.

## Commands

```sh
bun install        # install dependencies
bun run check      # format + lint check (fails on issues)
bun run fix        # auto-fix format + lint issues
bun run codegen    # fetch DDG/Kagi sources, merge, and generate bang artifacts
bun run resolve:suggestions # refresh the committed site-specific autocomplete endpoint map
bun run build      # bundle, minify + pre-compress with Brotli (auto-runs codegen --from-merged if generated bang files are missing or stale)
bun run dev        # bundle + dev server with file watching & live reload (auto-runs codegen --from-merged if generated bang files are missing or stale)
bun run start      # serve pre-built dist/ (run `bun run build` first)
bun run start:bundled # serve dist/ with the bundled production server
bun run typecheck  # type-check with tsc (no emit)
bun run profile    # run performance profile benchmarks (auto-runs codegen --from-merged if generated bang files are missing or stale)
bun run profile:private # build and profile private hash redirects in Chromium, Firefox, and WebKit
bun run profile:quick  # run a shorter profiling pass
bun run profile:cpu   # write Bun CPU profiles under profiles/
bun audit          # audit dependencies for known vulnerabilities
bun test           # run unit, integration, performance, and docs tests (auto-runs codegen --from-merged if generated bang files are missing or stale)
bun run test:e2e   # run Playwright end-to-end tests (build + browser run)
bun run clean      # remove every dist*/ build tree and profiles/*.cpuprofile leftovers (--dry-run to preview)
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
│       ├── prepare-release.yaml # Version-bump pull request automation
│       ├── release.yaml       # GitHub Release and multi-architecture image publishing
│       └── update-bangs.yaml  # Daily bang-source refresh
├── functions/
│   ├── suggest.ts            # Cloudflare Pages Function for /suggest
│   └── opensearch.xml.ts     # Cloudflare Pages Function for /opensearch.xml
├── scripts/
│   ├── codegen.ts            # Fetch sources, parse, merge, generate bang artifacts
│   ├── bang-strings-build.ts # Append-only global string ID map and store encoder
│   ├── build.ts              # Bundle + minify pipeline
│   ├── clean.ts              # Remove build trees and CPU profile leftovers
│   ├── dev.ts                # Dev server with file watching, rebuild & live reload
│   ├── inline-script-hash.ts # Shared inline-script CSP hash extraction
│   ├── profile.ts            # Profiling script
│   ├── build-locale-table.ts # Regenerates the Wikimedia families in src/shared/locale-table.ts from the SiteMatrix
│   ├── resolve-suggestions.ts # Refresh per-site autocomplete endpoints
│   ├── shared.ts             # Shared HTML and static-asset build helpers
│   ├── start.ts              # Production server (serves pre-built dist/)
│   └── summarize-bang-update.ts # Daily bang-update change summary generator
├── data/
│   ├── bangs.json            # Merged bang data (committed, updated by daily automation)
│   ├── bang-router.json      # Frozen cell-to-shard table; rebuilt only by codegen --rebalance-router
│   ├── bang-prefixes.txt     # Append-only global prefix ID map (line index = ID)
│   ├── bang-suffixes.txt     # Append-only global suffix ID map (line index = ID)
│   ├── bang-strings-meta.json # String store epoch and base/tail split point
│   ├── custom-bangs.json     # Custom bang definitions
│   ├── bang-canonical.json   # Hand-maintained canonical destination overlay
│   └── suggest-sites.json # Committed domain-level autocomplete capabilities
├── src/
│   ├── suggest.ts            # Bang/snap suggestions, search suggest proxy & cookie parsing
│   ├── suggest-bang.ts        # Bang/snap suggestion matching and scoring
│   ├── opensearch.ts          # OpenSearch XML generation
│   ├── server/
│   │   ├── handlers.ts       # Production server request handlers
│   │   └── headers.ts        # CSP and security headers (shared across all targets)
│   ├── shared/
│   │   ├── bang-shards.ts      # Deterministic binary bang shard selection
│   │   ├── bang-binary-format.ts # Shared packed-catalog layout constants
│   │   ├── capture-template.ts # Capture template compilation and regex safety
│   │   ├── chars.ts           # Character classification helpers
│   │   ├── constants.ts       # Shared constants
│   │   ├── custom-trigger.ts  # Custom trigger validation and reserved names
│   │   ├── frecency-serial.ts # Compact frecency serialization
│   │   ├── hash.ts            # Shared FNV-1a hash
│   │   ├── hot-boot.ts        # Hot-boot metadata protocol constants
│   │   ├── locale-table.ts    # Registered `{lang}` host patterns and their supported editions
│   │   ├── idb.ts             # Shared IndexedDB open helper
│   │   ├── raw-query.ts       # Raw query string parsing
│   │   ├── raw-url.ts         # Raw URL pathname and origin parsing
│   │   ├── seed-cache.ts       # First-page cache handoff name
│   │   ├── snap-chain.ts      # Snap-chain limits and partial-segment parsing
│   │   ├── snap-target.ts     # Alternate snap target validation and compilation
│   │   ├── suggest-cookie.ts  # Unified suggestion cookie codec
│   │   ├── trigger-prefix.ts  # Configurable bang/snap prefix codec
│   │   ├── template.ts        # Bang URL template expansion
│   │   └── trie.ts            # Radix trie lookup
│   ├── generated/             # Output of codegen (gitignored, generated from data/bangs.json)
│   │   ├── bangs.bin          # packed trigger→URL data for Service Worker
│   │   ├── bangs-str-base.bin # global append-only string store (base chunk)
│   │   ├── bangs-str-tail.bin # global string store tail appended since the base
│   │   ├── bangs-hot.js       # generated top-relevance cold-start redirect tier
│   │   ├── bangs-sparse.js    # advanced bang and snap override lookups
│   │   ├── bangs-meta.bin     # packed trigger/name/domain catalog for UI
│   │   ├── bangs-trie-loader.js # lightweight radix-trie module loader
│   │   ├── bangs-trie.bin     # packed prefix-matched suggestion trie
│   │   ├── bangs-inputs.json  # digests of the data files this tree was generated from
│   │   └── *.d.ts             # TypeScript declarations for each generated .js file
│   ├── sw/
│   │   ├── bang-data.ts       # Binary bang decoder and regular lookup
│   │   ├── bang-strings.ts    # Global string store decoder shared by index shards
│   │   ├── default-redirect-settings.ts # I/O-free default redirect settings
│   │   ├── redirect-core.ts    # Shared allocation-free redirect resolver
│   │   ├── redirect-prefix.ts  # Shared prefix parsing and URL assembly
│   │   ├── locale.ts         # Resolves `{lang}` markers from the reader's language
│   │   ├── redirect-settings.ts # Redirect settings loading and compilation
│   │   ├── redirect.ts        # Bang/snap parsing & redirect logic (zero-copy raw + decoded paths)
│   │   ├── idb.ts             # IndexedDB access, settings cache & in-memory frecency
│   │   ├── frecency.ts        # Top-K frecency helpers used by SW
│   │   ├── hot-redirect.ts     # Registration-metadata codec and hot lookup tier
│   │   └── sw.ts              # Service Worker lifecycle & fetch handler
│   └── ui/
│       ├── index.html         # Initial registration and fallback HTML template
│       ├── app.ts             # Initialization & orchestration
│       ├── cold-fallback.ts   # Sharded first-profile redirect fallback
│       ├── fallback.ts        # Main-thread redirects for private mode or unavailable Service Workers
│       ├── bang-catalog.ts    # Shared normalized bang metadata and bounded search
│       ├── bang-meta.ts       # Packed metadata validation and cursor decoder
│       ├── firefox-suggest.ts # Shared Firefox detection and suggestion URL builder
│       ├── suggest-provider.ts # Suggestion provider feature availability
│       ├── bench/
│       │   ├── index.html     # Benchmark page
│       │   ├── index.ts       # Benchmark script
│       │   └── stats.ts       # Robust browser benchmark statistics
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
│       │   ├── locale.ts      # Content-language selection and persistence
│       │   ├── syntax.ts      # Bang/snap prefix selection and persistence
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
│   │   ├── flashbang.e2e.ts  # Playwright browser scenarios
│   │   ├── helpers.ts         # Shared Playwright lifecycle helpers
│   │   └── private-perf.e2e.ts # Manual private-redirect browser performance profile
│   ├── helpers/
│   │   └── *.ts               # Shared unit-test fixtures, fakes, and reference helpers
│   └── *.test.ts             # Unit, integration, performance, and docs checks
├── .dockerignore             # Files excluded from Docker build context
├── .gitignore                # Files excluded from version control
├── CONTRIBUTING.md           # Contribution workflow
├── DEVELOPMENT.md            # Development and architecture guide
├── Dockerfile                # Multi-stage Docker build
├── LICENSE                   # AGPL-3.0 license
├── NOTICE                    # Copyright and attribution notice
├── README.md                 # User-facing documentation
├── SECURITY.md               # Vulnerability reporting and support policy
├── biome.jsonc               # Formatting and lint configuration
├── bun.lock                  # Locked development dependencies
├── bunfig.toml               # Bun test configuration
├── package.json              # Scripts and package metadata
├── playwright.config.ts      # End-to-end test configuration
├── tsconfig.base.json        # Shared strict TypeScript options
├── tsconfig.json             # TypeScript project references
├── tsconfig.server.json      # Server and Cloudflare Function runtime types
├── tsconfig.sw.json          # Service Worker runtime types
├── tsconfig.tooling.json     # Scripts, configuration, and test types
├── tsconfig.ui.json          # Browser UI runtime types
└── uno.config.ts             # UnoCSS theme
```

Every tracked file must appear explicitly or match a glob in this tree. `tests/development-docs.test.ts` enforces completeness as part of `bun test`; the generated bang artifacts are also shown because builds depend on them even though they are gitignored.

## Type checking

`bun run typecheck` builds four referenced TypeScript projects. The UI project exposes browser DOM APIs, the Service Worker project exposes worker APIs without the DOM, the server project exposes Bun and fetch-compatible worker APIs, and the tooling project covers scripts and tests. Shared and redirect-core modules are intentionally checked in each runtime that consumes them.

## Tests

```sh
bun test           # run unit, integration, performance, and docs tests
bun run test:e2e   # run end-to-end tests (build + Playwright)
```

Unit, integration, performance, and docs tests:

- `tests/redirect.test.ts` — Bang/snap parsing, routing logic, and URL encoding
- `tests/redirect-differential.test.ts` — Raw and decoded redirect paths agree on generated queries
- `tests/redirect-perf.test.ts` — Redirect performance benchmarks
- `tests/bench-stats.test.ts` — Browser benchmark percentile, dispersion, and confidence statistics
- `tests/bang-catalog.test.ts` — Bounded UI bang-catalog search and normalization
- `tests/bang-canonical.test.ts` — Canonical destination overlay application and snap-domain guard
- `tests/capture-template.test.ts` — Capture template parsing and regex safety
- `tests/snap-target.test.ts` — Alternate snap target validation
- `tests/trigger-prefix.test.ts` — Bang/snap prefix validation and compact serialization
- `tests/suggest.test.ts` — Cookie parsing, bang/snap suggestions, and provider proxying
- `tests/locale.test.ts` — Tag canonicalization, language chains, and marker substitution
- `tests/locale-catalog.test.ts` — Locale table shape and the editions each registered pattern hosts
- `tests/locale-codegen.test.ts` — Build-time marker rules for catalog and suggestion endpoints
- `tests/locale-init.test.ts` — Substitution resolves from the browser without an explicit initialization call
- `tests/codegen-transform.test.ts` — Codegen transformation and domain extraction
- `tests/codegen-roundtrip.test.ts` — Generated lookup round trips
- `tests/codegen-input-stamp.test.ts` — Generated-data staleness detection against the recorded input digests
- `tests/string-id-compaction.test.ts` — String-ID map rebuild, epoch bump, and compaction interlocks
- `tests/build-cache.test.ts` — Deterministic Service Worker cache version inputs
- `tests/clean.test.ts` — Build-tree and profile cleanup, including dry runs
- `tests/custom-trigger.test.ts` — Custom trigger validation and reserved names
- `tests/development-docs.test.ts` — Project-tree syntax, paths, file types, and tracked-file completeness
- `tests/raw-url.test.ts` — Raw URL pathname and origin parsing
- `tests/frecency.test.ts` and `tests/frecency-serial.test.ts` — Top-K ordering and compact serialization
- `tests/handlers.test.ts` — Server-side suggest handler behavior and cookie cleanup
- `tests/headers.test.ts` and `tests/opensearch.test.ts` — Security headers and OpenSearch XML
- `tests/template.test.ts` — Simple URL-template parsing and caching
- `tests/sw-runtime.test.ts` and `tests/sw-idb.test.ts` — Service Worker lifecycle, settings, and persistence
- `tests/hot-redirect.test.ts` — Hot-boot record codec and the generated hot lookup tier
- `tests/start-cache.test.ts` — Production cache headers and Brotli negotiation
- `tests/ui-db.test.ts` — Settings import/export and custom-bang updates
- `tests/settings-write.test.ts` — Serialized settings writes and hot-boot invalidation keys
- `tests/address-bar-setup.test.ts` — Address-bar browser detection and the generated Firefox suggestion URL
- `tests/summarize-bang-update.test.ts` — Daily bang-update change summaries
- `tests/bang-binary-format.test.ts` — Packed catalog layout primitives: checkpoints, alignment, and prefix heads
- `tests/coverage-completeness.test.ts` — Every measured source module is reachable from the suite, so none drops out of the coverage report

Browser UI modules under `src/ui/` are covered by the end-to-end suite rather than
unit tests, and are excluded from coverage reporting in `bunfig.toml`.

End-to-end tests:

- `tests/e2e/flashbang.e2e.ts` — Suggest endpoint, settings persistence and import/export, warm/cold/offline redirect flows, Service Worker cache updates, and custom bang/capture/snap scenarios
- `tests/e2e/private-perf.e2e.ts` — Opt-in browser performance profile for private hash redirects

If this is your first Playwright run on a machine, install browsers once:

```sh
bunx playwright install
```

## Bang codegen

`bun run codegen` fetches bang sources and generates the bang artifacts that `build` and `dev` depend on:

1. **Fetch sources** — Downloads bang definitions from DuckDuckGo (`bang.js`) and Kagi (`bangs.json`) into `data/`
2. **Merge + validate** — Parses DDG, Kagi, and custom sources. Merges by trigger (deduplicates), applies the canonical destination overlay, validates URLs, and saves the merged result to `data/bangs.json`. That merge currently produces 14,627 unique triggers
3. **Generate** — Produces the following artifacts in `src/generated/` from the merged data:
   - `bangs.bin` — packed regular bang lookup data for the Service Worker
   - `bangs-str-base.bin` + `bangs-str-tail.bin` — the global append-only string store, split at a checkpoint boundary so the tail is the only chunk that changes on a normal catalog update
   - `bangs-hot.js` — the 24 top-relevance triggers, embedded for cold-start and worker-startup redirects
   - `bangs-sparse.js` — sparse capture and snap override lookups for the Service Worker
   - `bangs-meta.bin` — packed trigger/name/domain catalog for the UI
   - `bangs-trie-loader.js` + `bangs-trie.bin` — lightweight loader and packed radix trie for prefix-matched bang suggestions plus compact per-site autocomplete capability tags
   - plus matching `*.d.ts` declaration files for all generated modules

The `--from-merged` flag skips steps 1–2 and generates directly from the committed `data/bangs.json`. This is what CI builds use — no network fetch needed. The generated directory is gitignored; `data/bangs.json` is the committed build input.

Codegen also writes `src/generated/bangs-inputs.json`, recording a SHA-256 digest of every file the artifacts were generated from: `data/bangs.json`, `data/suggest-sites.json`, `data/bang-router.json`, and the three string-ID map files. `bun run build`, `bun run dev`, `bun run profile`, and `bun test` compare that stamp against the files on disk and re-run `codegen --from-merged` when they disagree, naming the input that changed. Schema magic and version numbers cannot catch this on their own: artifacts built from an older `data/bangs.json` carry the current schema, so without the stamp a build after `git pull` would ship the previous catalog with no warning. `data/custom-bangs.json` and `data/bang-canonical.json` are not stamped — they feed only the merge step that produces `data/bangs.json`, so editing either means re-running the full `bun run codegen`.

`data/bang-canonical.json` is the canonical destination overlay, keyed by the exact upstream URL template so aliases share one entry. It has an `approved` map that only humans write and an `auto` map reserved for machine-generated rewrites; the daily workflow commits the file but never probes the network to fill it. The overlay is applied between the merge and validation so it survives nightly regeneration of `data/bangs.json`. A rewrite that fails URL validation is dropped with a warning rather than deleting the bang, and a rewrite that would change the derived snap domain without an explicit snap compensation fails the build.

Locale markers are policed at build time. Every `{lang}` in a catalog URL or curated suggestion endpoint must be the leading host label of a host pattern registered in `src/shared/locale-table.ts`, capture bangs may not carry one, and any other unrecognized brace inside the authority fails the build. This is what keeps the set of reachable origins finite and reviewable — see [Locale table](#locale-table).

String IDs are append-only because a line index *is* the ID, so reassigning one would make shards resolve valid URLs for the wrong bangs. `bun run codegen --compact-string-ids` is the one sanctioned way to reclaim orphaned entries: it rebuilds both maps from the live catalog, bumps the epoch, and verifies a full catalog round trip in memory before writing anything. The interlocks are deliberate — it refuses to run in CI, refuses when the rebuilt map is larger, refuses to burn an epoch for fewer than `max(256, 2%)` reclaimed IDs, and requires `--confirm-epoch-bump` because the bump makes every installed client re-download the string store and its index shards. `--bootstrap-string-ids` builds the maps from scratch without bumping the epoch. `--rebalance-router` is the equivalent deliberate step for `data/bang-router.json`.

The generated data is split by consumer. The Service Worker loads the regular lookup binary plus sparse executable capture/snap lookups, the UI fetches metadata only when its catalog is first needed, and the suggestion endpoint uses the generated radix trie. `data/suggest-sites.json` is a committed, reproducible domain registry: `bun run resolve:suggestions` gets Wikimedia domains from SiteMatrix, discovers NuGet's current autocomplete service from its V3 service index, and probes only the remaining likely wiki domains with a bounded worker pool. Transient probe failures retain previously verified capabilities. Codegen assigns every alias from its canonical domain, represents MediaWiki with a two-value capability tag, and pre-splits the small curated endpoint table so request handling does no template scan. Site-specific requests share conservative global query-length, timeout, and response-size limits; upstream result parameters keep provider payloads small.

`bangs.bin` stores regular records directly in deterministic CHD-style minimal-perfect-hash slot order. Codegen derives the table from each trigger's FNV-1a hash, rejects known-key hash collisions, and emits 16- or 32-bit bucket displacements. Runtime lookup computes one slot without probing, verifies the selected trigger so unknown keys cannot produce false matches, and lazily materializes and caches URL tuples.

`bangs-meta.bin` has a versioned header, sparse capture indexes, and NUL-delimited UTF-8 trigger/name/domain fields in source order. `src/ui/bang-meta.ts` validates and cursor-decodes it when the UI catalog is first requested, avoiding an intermediate field array while preserving catalog order.

## Advanced bangs and snap targets

User-created simple bangs use a URL containing `{}`. Capture bangs instead pair a regular expression with `$1`, `$2`, and later placeholders in the URL template. `src/shared/capture-template.ts` validates pattern and template bounds, rejects unsafe constructs, prevents captures from changing the URL origin, rejects every brace other than `{}` so a user URL can never carry a `{lang}` marker, and compiles accepted records once when Service Worker settings load. Capture substitutions support percent, plus-space, and raw encoding.

Kagi `ad` metadata and the custom-bang **Snap target** field provide an alternate domain or path for snap searches without changing normal bang behavior. Bang and snap prefixes are distinct user settings selected from `!`, `@`, `$`, `:`, `;`, and `~`; defaults are `!` and `@`. `src/shared/trigger-prefix.ts` validates and compactly serializes those settings, while `src/shared/snap-target.ts` validates and compiles targets into a site filter plus bare-snap origin. Codegen emits only non-redundant built-in overrides; custom targets are attached to their precompiled IndexedDB entries.

Custom bangs are stored in the `custom-bangs` IndexedDB object store. The UI supports add, edit, atomic trigger rename, remove, import, and export. Redirect settings are also stored as a versioned compiled snapshot; every settings or custom-bang transaction atomically removes that derived record, and the next redirect rebuilds it from the source records. Existing installations migrate lazily because a missing or obsolete snapshot is rebuilt without changing the database schema. After a mutation, `notifySW("invalidate")` clears the Service Worker's in-memory settings. The suggestion cookie contains custom trigger names for autocomplete, not full custom definitions.

Settings exports carry `schemaVersion` 3 (the content-language key was added in 3). Imports accept any integer version from 1 through the current one and validate every value they carry, so an export from an older build restores without a migration step. `src/ui/settings/write.ts` serializes writes and lists the keys that invalidate the persisted hot-boot record — the bang and snap prefixes, default bang, lucky provider and URL, content language, custom bangs, and whole-file imports.

## Content Security Policy

CSP headers are defined in `src/server/headers.ts` — the single source of truth for all deployment targets. The page CSP and SW CSP differ:

- **Page CSP** — No `unsafe-eval`. Production targets use inline script hashes; only `dev.ts` uses `'unsafe-inline'` for the live-reload script
- **SW CSP** — Strict: `default-src 'self'; script-src 'self'; connect-src 'self'`. No `unsafe-eval`; SW runtime avoids eval.

On **Cloudflare Pages**, CSP is set per-path in `_headers` (not `/*`) to avoid CF Pages' additive header merging — `/*` would combine with `/sw.js`, and the browser enforces the intersection. Instead, CSP is set individually on `/`, `/index.html`, `/home.html`, `/bench.html`, and `/sw.js`.

On **self-hosted** (Docker/Railway via `start.ts`), the Bun server sets headers per-request, serving `SW_HEADERS` for `/sw.js` and page headers for everything else.

## Build pipeline

`bun run build` bundles the app:

1. **Bundle UI + fallback + bench** — Bun bundles `src/ui/app.ts` (with code splitting) to `dist/app.js` plus lazy chunks, the private/restricted-browser redirect fallback to a content-hashed `dist/fallback-*.js`, and `src/ui/bench/index.ts` to `dist/bench.js`. Every app chunk and the standalone fallback are marked as required offline dependencies regardless of size; benchmark assets are cached only when opened.
2. **Bundle Service Worker** — Bun bundles `src/sw/sw.ts` and the sparse generated lookups into `dist/sw.js`, and copies `bangs.bin` and `bangs-meta.bin` to content-hashed production paths. Codegen also groups 256 trigger-hash cells into 43 byte-balanced first-page shards and emits a 256-byte router plus one version for the complete layout; shard IDs use base-36 names. The worker resolves controlled `#q=` navigations through the same fetch path as `?q=` and returns a minimal synthetic navigation document so the private fragment is not inherited by the destination. The lookup and fallback paths are injected into the worker and first-page fallback; the metadata path is injected into the UI bundle and included in deferred precaching. Content-hashed assets receive immutable cache headers. Hashes of the binaries, versioned assets, and a preliminary Service Worker bundle determine the injected cache version. Installation activates without lookup data; activation metadata opportunistically includes non-authoritative default/lucky URLs and both syntax markers when they can be derived without more I/O, and never seeds those compact base settings into the authoritative cache. The first-page fallback opens an empty, build-specific handoff cache before registering the worker, which tells activation that a redirect is in progress without copying catalog bytes or delaying the destination. It begins its IndexedDB snapshot read as soon as the cold module evaluates and overlaps settings I/O with the selected shard request. Generated forms preload their exact shards before invoking the canonical parser once; immutable, codegen-verified shards use a trusted decoder that retains header and layout bounds checks while omitting redundant full-table scans. The redirect is issued as soon as the hot table or selected shard resolves. The complete catalog then warms behind the response under `FetchEvent.waitUntil()`; the activation handoff covers the first uncontrolled hot redirect, and controlled hot redirects schedule the same post-response warm directly. This preserves a complete offline redirect catalog after the first successful use without putting its transfer on the redirect's critical path. Rich fallback paths can still transfer an already-loaded catalog and compiled settings directly to the worker. Once settings are materialized, the worker persists a versioned registration record containing default/lucky URLs, syntax, every custom definition, and personalized hot entries; cold redirects use the canonical parser for every query form, checking personalized and generated hot entries before loading a shard or the complete catalog for a remaining built-in or advanced lookup. Previous caches remain available until all required current assets have been cached successfully.
3. **Bundle production server** — Bun bundles `scripts/start.ts` and transitive runtime modules into `<DIST_DIR>-server/server.js` (`dist-server/server.js` by default). File-loader dependencies such as the packed suggestion trie are emitted beside that entrypoint. The complete server output directory stays outside the public static tree and is copied into the runtime container as one unit. Custom builds such as `DIST_DIR=dist-e2e` use an isolated `dist-e2e-server/` output.
4. **Generate CSS** — UnoCSS scans `src/ui/**/*.ts`, `src/ui/home/index.html`, and `src/ui/bench/index.html`, emitting atomic utility classes
5. **Inline & minify HTML** — CSS is inlined into `<style>`, HTML is minified with `@minify-html/node`
6. **Generate static-host headers** — Writes `dist/_headers` with shared security headers, per-page inline-script hashes, the stricter Service Worker CSP, and the OpenSearch content type
7. **Pre-compress** — Eligible static assets, including the full bang catalogs and first-page shards, are compressed with Brotli (max quality) and written as `.br` files alongside the originals. The production server serves these automatically when the client supports it, falling back to uncompressed. Cloudflare Pages builds (`CF_PAGES=1`) instead promote the redirect catalog's Brotli bytes to its canonical content-hashed path and declare `Content-Encoding: br` plus `no-transform` in `_headers`; this prevents the platform from replacing the max-quality artifact with a larger dynamic encoding. Other static and self-hosted builds retain the ordinary identity file and `.br` sidecar.

The build fails closed on catalog performance budgets, so a regression on the first-search path cannot ship quietly. The absolute limits are 9.25 KiB Brotli for the cold fallback module (currently 9.0 KiB), 21.5 KiB Brotli for the Service Worker bundle (currently 21.1 KiB), and at most 15 index packs. Both cold-fallback and worker limits were raised from their original 7 KiB and 19 KiB to absorb locale substitution and the 790-edition table, which costs about 965 B Brotli. Two ratio budgets scale with catalog growth instead: the string store plus the largest index pack must stay under 75% of the monolithic catalog's Brotli size, and the store plus every pack must stay under 110% of it.

If generated bang artifacts are missing, carry an outdated schema, or no longer match the data files recorded in `src/generated/bangs-inputs.json`, `bun run build`, `bun run dev`, `bun run profile`, and `bun test` automatically run `bun run codegen --from-merged` first.

## Locale table

`src/shared/locale-table.ts` is committed static data: which host patterns carry
a `{lang}` marker, and exactly which editions each site actually hosts.
Nothing is inferred at runtime and no build step reaches the network.

The Wikimedia families are regenerated by hand with
`bun scripts/build-locale-table.ts`, which reads the published SiteMatrix — one
API call listing every project's live editions, which is both authoritative and
far cheaper than probing hostnames. Closed wikis are excluded, and codes no
browser could report (`simple`) are dropped, since a value the runtime can never
match is pure weight.

Readers choose between three states in settings: follow the browser (the
default), pin one language, or switch substitution off entirely. Off is stored
as the `none` sentinel — four letters with no hyphen, so the tag grammar rejects
it and it can never be confused with an ISO 639-3 code — and resolves to an
empty language chain, which leaves every site on its own default edition.

Each project keeps its own list rather than sharing one: Wikipedia has 340
editions where Wiktionary has 171, Wikisource 81, Wikibooks and Wikiquote 77
each, Wikivoyage 27, and Wikiversity 17 — 7 registered host patterns and 790
editions in total. Borrowing one list for all of them would send readers to
hosts that do not exist. That is also why the table cannot be replaced by
letting the site negotiate — measured, `wikipedia.org` ignores `Accept-Language`
entirely and sends every reader to the English edition.

20 catalog entries currently carry a marker — `!w`, `!wikt`, `!ws`, `!wq`,
`!wb`, `!wv`, `!wku` and their aliases across the seven projects — along with
one curated suggestion endpoint (`wikipedia.org`). The settings dropdown offers
the union of every supported code, 344 languages, plus **Follow browser** and
**Off**.

Each pattern also carries the registrable domain snaps should filter on, so
`@w quantum` searches `site:wikipedia.org` rather than pinning results to one
edition, while a bare `@w` still opens the reader's own edition because that
path resolves the substituted origin.

The choice travels with the reader on every path. `src/sw/locale.ts` holds the
active chain for the redirect side, resolves each pattern once per language, and
notifies its listeners so the derived origin, snap-domain, and hot-prefix caches
are dropped when the setting changes. The compiled redirect-settings snapshot
(version 3) carries the language, and materializing it activates the locale
before the default and lucky URLs are localized — so a reader whose default bang
is `!w` also gets their own edition. The persisted hot-boot record carries the
language too (which is why `HOT_BOOT_VERSION` is `h2`), so a restarted worker
resolves the same edition before IndexedDB is read. For suggestions, the value
rides in the `l:` section of the unified `suggest` cookie, and the copyable
Firefox URL carries it as `lang=` because that browser withholds cookies; the
suggest server memoizes one chain per tag, bounded at 64 entries.

## Profiling

`bun run profile` benchmarks generated lookup, redirect variants, suggestions, cookie/query parsing, first-hit isolation, metadata decoding, and generated-module evaluation. Use `bun run profile:quick` for a shorter directional pass and `bun run profile:cpu` for Bun CPU profiles.

The profiler can save and compare structured baselines:

```sh
bun run profile --save main
bun run profile --compare main --threshold 5 --fail-on-regression
```

Bare baseline names resolve under `profiles/baselines/`, which is gitignored. Reports include raw run samples, run-level percentiles, variation, and bootstrap confidence intervals. Comparisons fail closed when the runtime, CPU, suite version, run configuration, or generated-data fingerprint differs. Low single-digit nanosecond differences should still be treated as directional. The browser benchmark at `/bench` requires cross-origin-isolated timing, uses deterministic client-scoped settings, randomizes paths, measures a Service Worker no-op baseline, and verifies that the worker handled every sample. It reports both fetch round-trip measurements and a paired top-level navigation check against a same-origin direct-navigation target.

`bun run profile:private` reports no-worker private redirects, repeated fallback redirects in one context, first- and second-install redirects, worker-controlled private redirects, the public `?q=` Service Worker path, and a document-only navigation floor in Chromium, Firefox, and WebKit. Chromium also reports redirects after forcibly terminating the Service Worker. It counts fallback and bang-data requests. Set `PROFILE_COLD_RUNS` or `PROFILE_WARM_RUNS` to override its sample counts when iterating locally. Set `PROFILE_NETWORK_DELAY_MS` to add a deterministic per-request delay to cold no-worker and first-install runs.

## Frecency

The Service Worker tracks bang usage to personalize suggestion ordering. The flow:

1. **On bang or snap redirect** — `sw.ts` queues `trackBangUsage(trigger)`, which updates the bounded in-memory count map and top-eight entries. Concurrent updates are coalesced into the latest compact snapshot, and the FetchEvent remains alive until the final IndexedDB transaction commits
2. **Cookie sync** — When Cookie Store is available, `sw.ts` preserves the existing provider and custom-trigger context and writes top frecency entries into the `f:` section of the unified `suggest` cookie. The cookie's other named sections are `c:` for custom triggers and `l:` for an explicitly pinned content language; the page (`src/ui/cookie.ts`) is what writes those, and the worker re-encodes every one of them on a frecency sync so nothing the page set is dropped
3. **Suggest reads frecency** — `suggest.ts` parses the unified cookie and passes its frecency map to `bangSuggestions()`, which boosts candidates by usage count

The in-memory state (`frecencyCounts` plus `topFrecency` in `idb.ts`) is hydrated from its own IndexedDB record in parallel with redirect configuration and kept for the Service Worker lifetime. Keeping frecency separate prevents routine usage persistence from invalidating the compiled redirect-settings snapshot. `invalidateCache()` clears only redirect settings and the shared database connection; loaded frecency and pending persistence remain intact. Browser benchmark mode suppresses these side effects only for the requesting benchmark client.

**Browser cookie behavior**: Chromium-based browsers (Chrome, Edge, Arc) send cookies with suggest requests when the site is the default search engine. Firefox-based browsers (Firefox, Zen, LibreWolf) intentionally withhold cookies from OpenSearch suggest requests as a privacy decision ([bug 1624457](https://bugzilla.mozilla.org/show_bug.cgi?id=1624457)). The settings UI therefore provides a copyable Firefox suggestion URL with an explicit provider; it adds `bp` and `np` only for non-default syntax and omits the default `!`/`@` pair, and adds `lang` only when a content language is pinned. Cookie-backed custom trigger suggestions and frecency are unavailable on those requests; redirect behavior is unaffected.

## Dev server

`bun run dev` runs the dev server with `bun --hot` for soft module reloading:

- **Codegen guard** — If a required artifact under `src/generated/` is missing, outdated, or stale against `src/generated/bangs-inputs.json`, automatically runs `bun run codegen --from-merged` before the first build
- **Inline builds** — Uses `Bun.build()` API directly instead of shelling out to build scripts
- **File watching** — Watches `src/` recursively via `fs.watch` with 200ms debounce. Any source change triggers a full rebuild
- **Live reload** — SSE endpoint at `/__dev/events` pushes reload events to the browser. A small script is injected into HTML responses that unregisters the Service Worker, clears all caches, and reloads the page on each rebuild
- **Hot reload** — `bun --hot` enables Bun's native hot module reloading for `Bun.serve()`, so the server's fetch handler updates without process restart

## Production server

`bun run start` serves the pre-built `dist/` directory from TypeScript with no build step, file watching, or live reload injection. `bun run start:bundled` runs the same server from the production `dist-server/server.js` bundle. Both require `bun run build` to have been run first.

`PUBLIC_ORIGIN` optionally overrides the request origin used in `/opensearch.xml`, which is useful behind reverse proxies and TLS termination. It must be an absolute HTTP(S) URL without credentials. The URL is canonicalized to its origin, so trailing slashes, paths, queries, and fragments are discarded. When unset, the handler uses the request origin (including on Cloudflare Pages, where the optional binding is read from the Function context). An invalid configured value fails closed with a `500` response.

## Docker

The Dockerfile uses a multi-stage build to produce a minimal runtime image:

1. **Build stage** — Installs dependencies, runs `codegen --from-merged` to generate bang artifacts from `data/bangs.json`, then runs `build` to bundle and pre-compress all assets
2. **Runtime stage** — Copies `dist/` and the bundled `dist-server/` output, including the server entrypoint and its emitted packed-trie asset. Source files, generated source modules, and dev dependencies are not present in the final image

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

A CI workflow (`.github/workflows/ci.yaml`) runs on every push to `master` and every pull request targeting `master`. Its main job validates all workflow files with SHA-pinned actionlint 1.7.12, then runs codegen (`--from-merged`), typecheck, lint/format checks, `bun audit`, tests, and a full build with no external bang-source fetching. A separate matrix builds the app and runs the Playwright projects in Chromium, Firefox, and WebKit; the WebKit project intentionally selects a supported subset of scenarios. On pull requests and manual runs, a Docker job also builds and health-checks the image when Docker-relevant files changed.

A daily cron workflow (`.github/workflows/update-bangs.yaml`) fetches fresh bang sources from DDG and Kagi and verifies the merged data when it changes. It commits `data/bangs.json` and the hand-maintained `data/bang-canonical.json` to the `automation/update-bangs` branch, opens or updates a pull request targeting `master`, and dispatches CI for that branch. It does no network probing of destinations; canonical rewrites are measured and reviewed by hand before they land.

## Releasing

1. Run the **Prepare Release** workflow with the stable SemVer version without a `v` prefix. It updates `package.json`, pushes an `automation/release-vX.Y.Z` branch, opens a pull request, dispatches CI, waits for every CI job (including Playwright E2E) to pass, and only then merges the pull request. A failed CI run leaves the pull request open and the release unmerged. The README release badge reads the latest GitHub Release dynamically and needs no version bump.
2. Confirm that the generated pull request merged and the protected-branch checks passed.
3. Create and push an annotated tag from the merged `origin/master` commit:

```sh
git switch master
git pull --ff-only origin master
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

Do not create the GitHub Release manually. The tag-triggered release workflow (`.github/workflows/release.yaml`) accepts only strict stable `vX.Y.Z` tags, requires the tag version to match `package.json`, and verifies that the tagged commit is contained in `origin/master`. It then validates workflow files with SHA-pinned actionlint 1.7.12 and runs codegen (`--from-merged`), typecheck, lint/format checks, `bun audit`, the test suite, and the build. It does not rerun Playwright because protected-branch CI already covers E2E.

After validation succeeds, the workflow builds and health-checks a local image before publishing `linux/amd64` and `linux/arm64` images to `ghcr.io/<owner>/flashbang` with both the release version and `latest` tags. Published images include max-level BuildKit provenance and an SPDX SBOM, receive a GitHub artifact attestation for the multi-platform digest, and are signed and verified keylessly with Cosign using the release workflow's GitHub OIDC identity. The GitHub Release with generated notes is created only after every image publication, attestation, signing, and verification step succeeds.

Verify a published image's GitHub provenance and Cosign signature with:

```sh
gh attestation verify oci://ghcr.io/ph1losof/flashbang:<version> -R ph1losof/flashbang
cosign verify \
  --certificate-identity-regexp '^https://github.com/ph1losof/flashbang/.github/workflows/release\.yaml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/ph1losof/flashbang:<version>
```
