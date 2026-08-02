import type { RedirectSettings, UrlParts } from "./redirect-core";

function splitUrl(url: string): UrlParts {
  const idx = url.indexOf("{}");
  return idx === -1
    ? [url, null]
    : [url.substring(0, idx), url.substring(idx + 2)];
}

export function defaultRedirectSettings(): RedirectSettings {
  return {
    defaultUrl: splitUrl("https://www.google.com/search?q={}"),
    custom: Object.create(null),
    luckyUrl: splitUrl("https://duckduckgo.com/?q=\\{}"),
  };
}
