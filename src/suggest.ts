import { BANGS } from "./generated/bangs-full.js";
import { BANG_KEYS } from "./generated/bangs-keys.js";

export interface SuggestSettings {
  provider: string;
  trigger: string;
  customUrl: string | null;
}

const SUGGEST_URLS: Record<string, string> = {
  google:
    "https://suggestqueries.google.com/complete/search?client=firefox&q={}",
  ddg: "https://duckduckgo.com/ac/?q={}&type=list",
  bing: "https://www.bing.com/osjson.aspx?query={}",
  brave: "https://search.brave.com/api/suggest?q={}&rich=false",
};

const JSON_HEADERS = { "Content-Type": "application/json" };
const COOKIE_RE = /(?:^|;\s*)suggest=([^;]*)/;

function empty(query: string): Response {
  return new Response(JSON.stringify([query, []]), { headers: JSON_HEADERS });
}

// Returns the prefix (text before the bang) and partial trigger, or null if not a partial bang.
// "!gh"       → { prefix: "", partial: "gh" }
// "cats !gh"  → { prefix: "cats ", partial: "gh" }
// "!g cats"   → null (bang already has a query, user is done typing it)
// "g!"        → null (suffix bang, already complete)
function parsePartialBang(q: string): { prefix: string; partial: string } | null {
  const s = q.trim();
  // "!gh" — prefix bang, still typing if no space
  if (s.charCodeAt(0) === 33) {
    return s.indexOf(" ") === -1
      ? { prefix: "", partial: s.substring(1).toLowerCase() }
      : null;
  }
  // "cats !gh" — trailing partial bang
  const trailing = s.lastIndexOf(" !");
  if (trailing === -1) return null;
  const rest = s.substring(trailing + 2);
  return rest.indexOf(" ") === -1
    ? { prefix: s.substring(0, trailing + 1), partial: rest.toLowerCase() }
    : null;
}

function bangSuggestions(query: string, prefix: string, partial: string): Response {
  // Binary search to first key >= partial
  let lo = 0, hi = BANG_KEYS.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (BANG_KEYS[mid] < partial) lo = mid + 1; else hi = mid;
  }

  // Collect all prefix matches (contiguous since keys are sorted)
  const matches: [string, number][] = [];
  for (let i = lo; i < BANG_KEYS.length; i++) {
    const k = BANG_KEYS[i];
    if (!k.startsWith(partial)) break;
    matches.push([k, BANGS[k].r || 0]);
  }

  // Sort by relevance descending, take top 8
  matches.sort((a, b) => b[1] - a[1]);
  const limit = matches.length < 8 ? matches.length : 8;
  const completions: string[] = [];
  const descriptions: string[] = [];
  for (let i = 0; i < limit; i++) {
    const k = matches[i][0];
    completions.push(`${prefix}!${k}`);
    descriptions.push(BANGS[k].d);
  }

  return new Response(JSON.stringify([query, completions, descriptions]), {
    headers: JSON_HEADERS,
  });
}

function resolveEndpoint(provider: string, trigger: string): string | null {
  const url = SUGGEST_URLS[provider];
  if (url) return url;
  if (provider === "none") return null;
  // "default" — infer from the default bang trigger
  if (trigger === "g" || trigger === "google") return SUGGEST_URLS.google;
  if (trigger === "ddg" || trigger === "duckduckgo") return SUGGEST_URLS.ddg;
  if (trigger === "b" || trigger === "bing") return SUGGEST_URLS.bing;
  if (trigger === "brave") return SUGGEST_URLS.brave;
  return null;
}

export function parseCookie(request: Request): SuggestSettings {
  const header = request.headers.get("Cookie") || "";
  const match = header.match(COOKIE_RE);
  if (!match) return { provider: "default", trigger: "g", customUrl: null };
  const [provider, trigger, customUrl] = match[1].split(",");
  return {
    provider: provider || "default",
    trigger: trigger || "g",
    customUrl: customUrl ? decodeURIComponent(customUrl) : null,
  };
}

export async function suggest(
  query: string,
  settings: SuggestSettings,
): Promise<Response> {
  const bang = parsePartialBang(query);
  if (bang) return bangSuggestions(query, bang.prefix, bang.partial);

  const { provider, trigger, customUrl } = settings;
  const endpoint =
    provider === "custom" ? customUrl : resolveEndpoint(provider, trigger);

  if (!endpoint) return empty(query);

  try {
    const res = await fetch(
      endpoint.replace("{}", encodeURIComponent(query)),
    );
    return new Response(res.body, { headers: JSON_HEADERS });
  } catch {
    return empty(query);
  }
}
