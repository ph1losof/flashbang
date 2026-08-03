const BASE_HEADERS: Record<string, string> = {
  "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

export const FALLBACK_SHELL_HEADERS: Record<string, string> = {
  "Cache-Control": "public, max-age=300",
  "No-Vary-Search": 'params=("q")',
};

// The cold resolver is reached through a dynamic import() of a string literal
// inside an inline script, so the browser's preload scanner cannot see it and
// the fetch only starts once the document has parsed and that script has run.
// Every first search needs the module, and the routed catalog shard is smaller
// than it, so this module — not the shard — is what the first redirect waits
// on. Declaring the preload lets the fetch start earlier, and Cloudflare
// replays the same header as a 103 Early Hints response ahead of the document.
//
// Only the cold module is preloaded. The rich fallback is not: a fresh profile
// never loads it, so hinting it would spend transfer on the path this is meant
// to shorten.
// `crossorigin` is required, not decorative: a module fetched through import()
// uses credentials mode "same-origin", and a bare `as=script` preload uses
// "include". Chrome refuses to match the two and downloads the module twice.
export function shellPreloadHeader(coldFallbackAsset: string): string {
  return `<${coldFallbackAsset}>; rel=preload; as=script; crossorigin`;
}

const COLD_FALLBACK_ASSET_RE = /\/cold-fallback-[a-z0-9_-]{8,}\.js/i;

export function coldFallbackAssetFromHtml(html: string): string | null {
  return html.match(COLD_FALLBACK_ASSET_RE)?.[0] ?? null;
}

// SW runtime avoids eval; keep CSP strict.
export const SW_CSP =
  "default-src 'self'; script-src 'self'; connect-src 'self'";

export const SW_HEADERS: Record<string, string> = {
  "Content-Security-Policy": SW_CSP,
  ...BASE_HEADERS,
};

export function pageHeaders(scriptSrc: string): Record<string, string> {
  return {
    "Content-Security-Policy": [
      "default-src 'self'",
      `script-src 'self'${scriptSrc ? ` ${scriptSrc}` : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "worker-src 'self'",
      "manifest-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
    ...BASE_HEADERS,
  };
}
