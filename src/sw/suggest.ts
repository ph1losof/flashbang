import { BANGS } from "../generated/bangs-min.js";

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

// Pre-computed sorted keys + hostname cache for fast bang suggestions
const BANG_KEYS = Object.keys(BANGS).sort((a, b) => a.length - b.length);
const HOST_CACHE: Record<string, string> = {};
for (const k of BANG_KEYS) {
  try {
    HOST_CACHE[k] = new URL(BANGS[k].replace("{}", "x")).hostname;
  } catch {
    HOST_CACHE[k] = BANGS[k];
  }
}

const JSON_HEADERS = { "Content-Type": "application/json" };

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
  const trailing = s.lastIndexOf(" !");
  if (trailing !== -1) {
    const rest = s.substring(trailing + 2);
    if (!rest.includes(" ")) return { prefix: s.substring(0, trailing + 1), partial: rest.toLowerCase() };
  } else if (s.charCodeAt(0) === 33 && !s.includes(" ")) {
    return { prefix: "", partial: s.substring(1).toLowerCase() };
  }
  return null;
}

function bangSuggestions(query: string, prefix: string, partial: string): Response {
  const completions: string[] = [];
  const descriptions: string[] = [];

  for (let i = 0; i < BANG_KEYS.length && completions.length < 8; i++) {
    const k = BANG_KEYS[i];
    if (k.startsWith(partial)) {
      completions.push(`${prefix}!${k}`);
      descriptions.push(HOST_CACHE[k]);
    }
  }

  return new Response(JSON.stringify([query, completions, descriptions]), {
    headers: JSON_HEADERS,
  });
}

function resolveEndpoint(provider: string, trigger: string): string | null {
  if (provider in SUGGEST_URLS) return SUGGEST_URLS[provider];
  if (provider === "none") return null;
  // "default" — infer from the default bang trigger
  if (trigger === "g" || trigger === "google") return SUGGEST_URLS.google;
  if (trigger === "ddg" || trigger === "duckduckgo") return SUGGEST_URLS.ddg;
  if (trigger === "b" || trigger === "bing") return SUGGEST_URLS.bing;
  if (trigger === "brave") return SUGGEST_URLS.brave;
  return null;
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
