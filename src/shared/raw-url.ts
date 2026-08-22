const CH_SLASH = 47; // /
const CH_QUESTION = 63; // ?
const CH_HASH = 35; // #

export function readPathname(rawUrl: string): string {
  const schemePos = rawUrl.indexOf("://");
  let start = 0;
  if (schemePos !== -1) {
    start = rawUrl.indexOf("/", schemePos + 3);
    if (start === -1) {
      return "/";
    }
  } else if (rawUrl.charCodeAt(0) === CH_SLASH) {
    start = 0;
  } else {
    return "/";
  }

  let end = rawUrl.length;
  const qPos = rawUrl.indexOf("?", start);
  if (qPos !== -1 && qPos < end) {
    end = qPos;
  }
  const hPos = rawUrl.indexOf("#", start);
  if (hPos !== -1 && hPos < end) {
    end = hPos;
  }

  return end === start ? "/" : rawUrl.substring(start, end);
}

export function readOrigin(rawUrl: string): string {
  const schemePos = rawUrl.indexOf("://");
  if (schemePos === -1) {
    return "";
  }

  const slashPos = rawUrl.indexOf("/", schemePos + 3);
  if (slashPos === -1) {
    return rawUrl;
  }
  return rawUrl.substring(0, slashPos);
}

// A URL with no path segment ("https://example.com", "https://example.com?q=")
// is not what a spec-compliant serializer emits: it inserts the missing "/"
// ("https://example.com/?q="). Bun >=1.4 made Response.redirect do exactly
// that, so the Response the service worker returns and the raw string the
// server writes into Location would otherwise disagree for bare bangs.
//
// Call this where a URL prefix is *compiled* — settings load, codegen, origin
// caches — never per redirect: normalizing the handful of path-less prefixes
// once keeps the redirect hot path free of this scan.
export function withPathSeparator(url: string): string {
  const schemePos = url.indexOf("://");
  if (schemePos === -1) {
    return url;
  }
  for (let i = schemePos + 3; i < url.length; i++) {
    const c = url.charCodeAt(i);
    if (c === CH_SLASH) {
      return url;
    }
    if (c === CH_QUESTION || c === CH_HASH) {
      return `${url.substring(0, i)}/${url.substring(i)}`;
    }
  }
  return `${url}/`;
}
