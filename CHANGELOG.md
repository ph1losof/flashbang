# Changelog

## [1.0.0] - 2026-02-21

### Core

- Service Worker-based bang redirects with sub-1ms median latency — intercepts
  navigation before the browser starts rendering, no page load or server
  round-trip involved
- 14,000+ bangs merged from DuckDuckGo, Kagi, and custom TOML sources
- Minimal two-tier data split: trigger-to-URL map (~867 KB) for the Service
  Worker, full metadata for the UI — parsed once at install, kept in memory

### Features

- **Search suggestions** — bang-aware autocomplete in the browser's native
  address bar. Ranks by popularity. Web suggestions from Google, DuckDuckGo,
  Bing, Brave, or custom provider
- **Feeling Lucky** — prefix `\` or bare `!` to skip results and jump to the
  first hit. Configurable per-engine (Google, DuckDuckGo, custom URL, or
  disabled)
- **Custom bangs** — add, edit, and delete personal bangs through the settings
  UI. Stored in IndexedDB, override built-ins
- **OpenSearch** — browsers auto-discover Flashbang as a search engine via
  dynamically generated `/opensearch.xml`
- **Settings** — default bang, lucky provider, suggestion source,
  import/export, real-time search across all bangs
- **Offline support** — redirects work offline after Service Worker install;
  settings page works offline too
- **PWA** — installable as a Progressive Web App via manifest
- **Benchmarks** — built-in benchmark page at `/bench` for measuring redirect
  latency on your own hardware

### Performance

- Binary search with DuckDuckGo relevance rankings for bang lookups
- Null-prototype objects for faster property access
- Code splitting — suggestions lazy-loaded on first use
- Synchronous redirect with preload on active Service Worker
- Auto-registration and optimized Service Worker installation

### Infrastructure

- Daily CI (GitHub Actions) fetches latest bangs from DuckDuckGo and Kagi,
  regenerates code, and commits changes automatically
- Bun-native build pipeline: codegen, bundle, UnoCSS, HTML minification
- Deployable to Cloudflare Pages (recommended), any static host, or localhost
- Cloudflare Pages Function for `/suggest` endpoint
