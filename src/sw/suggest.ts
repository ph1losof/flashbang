import { BANGS } from "../generated/bangs-min.js";

export interface SuggestSettings {
  provider: string;
  trigger: string;
  customUrl: string | null;
}

const SUGGEST_URLS = {
  google:
    "https://suggestqueries.google.com/complete/search?client=firefox&q={}",
  ddg: "https://duckduckgo.com/ac/?q={}&type=list",
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

function bangSuggestions(query: string): Response {
  const partial = query.replace(/^!/, "").toLowerCase();
  const completions: string[] = [];
  const descriptions: string[] = [];

  for (let i = 0; i < BANG_KEYS.length && completions.length < 8; i++) {
    const k = BANG_KEYS[i];
    if (k.startsWith(partial)) {
      completions.push(`!${k}`);
      descriptions.push(HOST_CACHE[k]);
    }
  }

  return new Response(JSON.stringify([query, completions, descriptions]), {
    headers: JSON_HEADERS,
  });
}

function resolveEndpoint(provider: string, trigger: string): string | null {
  if (provider === "google") return SUGGEST_URLS.google;
  if (provider === "ddg") return SUGGEST_URLS.ddg;
  if (provider === "none") return null;
  if (trigger === "g" || trigger === "google") return SUGGEST_URLS.google;
  if (trigger === "ddg" || trigger === "duckduckgo") return SUGGEST_URLS.ddg;
  return null;
}

export async function suggest(
  query: string,
  settings: SuggestSettings,
): Promise<Response> {
  if (query.includes("!")) return bangSuggestions(query);

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
