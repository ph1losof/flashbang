import type { SiteSuggestionShape } from "../src/shared/constants";

interface Bang {
  domain: string;
  name: string;
  trigger: string;
  url: string;
}

export interface CuratedSuggestionSite {
  shape: SiteSuggestionShape;
  url: string;
}

export interface SuggestionSiteRegistry {
  curated: Record<string, CuratedSuggestionSite>;
  mediawiki: Record<string, "/" | "/w/">;
}

const CATALOG_PATH = "data/bangs.json";
const OUTPUT_PATH = "data/suggest-sites.json";
const WORKERS = 12;
const TIMEOUT_MS = 5000;
const RETRIES = 2;
const MEDIAWIKI_PATHS = ["/", "/w/"] as const;
const USER_AGENT =
  "flashbang-suggest-resolver/1.0 (+https://github.com/ph1losof/flashbang)";
const REQUEST_HEADERS = { "User-Agent": USER_AGENT } as const;
const WIKIMEDIA_SITEMATRIX_URL =
  "https://meta.wikimedia.org/w/api.php?action=sitematrix&format=json&formatversion=2&smlimit=max&smsiteprop=url";
const NUGET_SERVICE_INDEX_URL = "https://api.nuget.org/v3/index.json";
const NUGET_AUTOCOMPLETE_FALLBACK =
  "https://azuresearch-usnc.nuget.org/autocomplete";

type MediaWikiPath = (typeof MEDIAWIKI_PATHS)[number];
export type MediaWikiProbeResult = MediaWikiPath | false | null;

export interface ResolveSuggestionOptions {
  curated?: Readonly<Record<string, CuratedSuggestionSite>>;
  previousMediawiki?: Readonly<Record<string, MediaWikiPath>>;
  wikimediaDomains?: ReadonlySet<string>;
}

// These services expose useful public suggestion/search APIs but not a
// conventional MediaWiki OpenSearch endpoint. They are keyed by the catalog's
// canonical domain so every alias inherits the capability automatically.
function curatedSites(
  nugetAutocompleteUrl = NUGET_AUTOCOMPLETE_FALLBACK
): Readonly<Record<string, CuratedSuggestionSite>> {
  return {
    "addons.mozilla.org": {
      shape: "results",
      url: "https://addons.mozilla.org/api/v5/addons/autocomplete/?q={}&app=firefox&page_size=8&lang=en-US",
    },
    "modrinth.com": {
      shape: "algolia",
      url: "https://api.modrinth.com/v2/search?query={}&limit=8",
    },
    "aur.archlinux.org": {
      shape: "strings",
      url: "https://aur.archlinux.org/rpc?v=5&type=suggest&arg={}",
    },
    "crates.io": {
      shape: "crates",
      url: "https://crates.io/api/v1/crates?q={}&per_page=8",
    },
    "github.com": {
      shape: "algolia",
      url: "https://api.github.com/search/repositories?q={}&per_page=8",
    },
    "hn.algolia.com": {
      shape: "algolia",
      url: "https://hn.algolia.com/api/v1/search?query={}&hitsPerPage=8&attributesToRetrieve=title",
    },
    "mvnrepository.com": {
      shape: "maven",
      url: "https://search.maven.org/solrsearch/select?q={}&rows=8&wt=json",
    },
    "packagist.org": {
      shape: "results",
      url: "https://packagist.org/search.json?q={}&per_page=8",
    },
    "wikipedia.org": {
      shape: "opensearch",
      url: "https://en.wikipedia.org/w/api.php?action=opensearch&search={}&format=json&limit=8",
    },
    "www.amazon.com": {
      shape: "amazon",
      url: "https://completion.amazon.com/api/2017/suggestions?limit=8&prefix={}&suggestion-type=KEYWORD&mid=ATVPDKIKX0DER&alias=aps",
    },
    "www.npmjs.com": {
      shape: "npms",
      url: "https://api.npms.io/v2/search/suggestions?q={}&size=8",
    },
    "nuget.org": {
      shape: "strings",
      url: `${nugetAutocompleteUrl}?q={}&take=8&prerelease=false`,
    },
    "www.reddit.com": {
      shape: "reddit",
      url: "https://www.reddit.com/subreddits/search.json?q={}&limit=8",
    },
    "www.youtube.com": {
      shape: "opensearch",
      url: "https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q={}",
    },
  };
}

const CURATED = curatedSites();

function isMediaWikiCandidate(bang: Bang): boolean {
  const domain = bang.domain.toLowerCase();
  const name = bang.name.toLowerCase();
  const url = bang.url.toLowerCase();
  return (
    domain.includes("wiki") ||
    name.includes("wiki") ||
    url.includes("/wiki/") ||
    url.includes("special:search") ||
    domain.endsWith("fandom.com") ||
    domain.endsWith("wikia.com")
  );
}

async function probePath(
  domain: string,
  path: (typeof MEDIAWIKI_PATHS)[number]
): Promise<"valid" | "invalid" | "unknown"> {
  const url = `https://${domain}${path}api.php?action=opensearch&search=flashbang&format=json&limit=1`;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: REQUEST_HEADERS,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.ok) {
        const payload: unknown = await response.json();
        return Array.isArray(payload) &&
          payload.length >= 2 &&
          Array.isArray(payload[1])
          ? "valid"
          : "invalid";
      }
      if (response.status === 404) {
        return "invalid";
      }
      if (
        response.status !== 429 &&
        response.status !== 408 &&
        response.status < 500
      ) {
        return "unknown";
      }
      if (attempt < RETRIES) {
        await retryDelay(response.headers.get("Retry-After"), attempt);
      }
    } catch {
      if (attempt < RETRIES) {
        await retryDelay(null, attempt);
      }
    }
  }
  return "unknown";
}

async function probeMediaWiki(domain: string): Promise<MediaWikiProbeResult> {
  // Probe both conventional locations together, then choose deterministically.
  const [root, w] = await Promise.all(
    MEDIAWIKI_PATHS.map((path) => probePath(domain, path))
  );
  if (root === "valid") {
    return "/";
  }
  if (w === "valid") {
    return "/w/";
  }
  return root === "invalid" && w === "invalid" ? false : null;
}

function retryDelay(retryAfter: string | null, attempt: number): Promise<void> {
  let delay = 150 * 2 ** attempt;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      delay = seconds * 1000;
    } else {
      const date = Date.parse(retryAfter);
      if (Number.isFinite(date)) {
        delay = Math.max(0, date - Date.now());
      }
    }
  }
  return Bun.sleep(Math.min(delay, 5000));
}

export function wikimediaDomainsFromSiteMatrix(payload: unknown): Set<string> {
  const domains = new Set<string>();
  const matrix = (payload as { sitematrix?: Record<string, unknown> } | null)
    ?.sitematrix;
  if (!matrix || typeof matrix !== "object") {
    return domains;
  }

  const addSites = (sites: unknown) => {
    if (!Array.isArray(sites)) {
      return;
    }
    for (const site of sites) {
      const url = (site as { url?: unknown } | null)?.url;
      if (typeof url !== "string") {
        continue;
      }
      try {
        domains.add(new URL(url).hostname.toLowerCase());
      } catch {
        // Ignore malformed entries instead of discarding the full matrix.
      }
    }
  };

  for (const [key, value] of Object.entries(matrix)) {
    if (key === "specials") {
      addSites(value);
    } else {
      addSites((value as { site?: unknown } | null)?.site);
    }
  }
  return domains;
}

async function fetchWikimediaDomains(): Promise<Set<string>> {
  const response = await fetch(WIKIMEDIA_SITEMATRIX_URL, {
    headers: REQUEST_HEADERS,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Wikimedia SiteMatrix returned ${response.status}`);
  }
  const domains = wikimediaDomainsFromSiteMatrix(await response.json());
  if (domains.size === 0) {
    throw new Error("Wikimedia SiteMatrix returned no sites");
  }
  return domains;
}

export function nugetAutocompleteUrlFromServiceIndex(
  payload: unknown
): string | null {
  const resources = (
    payload as { resources?: Array<Record<string, unknown>> } | null
  )?.resources;
  if (!Array.isArray(resources)) {
    return null;
  }
  for (const resource of resources) {
    const id = resource["@id"];
    const types = Array.isArray(resource["@type"])
      ? resource["@type"]
      : [resource["@type"]];
    if (
      typeof id === "string" &&
      types.some(
        (type) =>
          typeof type === "string" &&
          type.startsWith("SearchAutocompleteService")
      )
    ) {
      try {
        const url = new URL(id);
        return url.protocol === "https:" ? url.href.replace(/\/$/, "") : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function fetchNugetAutocompleteUrl(): Promise<string> {
  const response = await fetch(NUGET_SERVICE_INDEX_URL, {
    headers: REQUEST_HEADERS,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`NuGet service index returned ${response.status}`);
  }
  const url = nugetAutocompleteUrlFromServiceIndex(await response.json());
  if (!url) {
    throw new Error("NuGet service index has no autocomplete service");
  }
  return url;
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  task: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await task(values[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, worker)
  );
  return results;
}

function sortedRecord<T>(
  entries: Iterable<readonly [string, T]>
): Record<string, T> {
  return Object.fromEntries(
    [...entries].sort(([a], [b]) => a.localeCompare(b))
  );
}

export async function resolveSuggestionSites(
  bangs: readonly Bang[],
  probe: (domain: string) => Promise<MediaWikiProbeResult> = probeMediaWiki,
  options: ResolveSuggestionOptions = {}
): Promise<SuggestionSiteRegistry> {
  const curated = options.curated ?? CURATED;
  const wikimediaDomains = options.wikimediaDomains ?? new Set<string>();
  const previousMediawiki = options.previousMediawiki ?? {};
  const domains = new Map<string, Bang>();
  for (const bang of bangs) {
    if (!domains.has(bang.domain) && isMediaWikiCandidate(bang)) {
      domains.set(bang.domain, bang);
    }
  }
  for (const domain of Object.keys(curated)) {
    domains.delete(domain);
  }

  const mediawikiEntries = new Map<string, MediaWikiPath>();
  for (const domain of wikimediaDomains) {
    if (domains.delete(domain)) {
      mediawikiEntries.set(domain, "/w/");
    }
  }

  const candidates = [...domains.keys()].sort();
  console.log(`Probing ${candidates.length} possible MediaWiki sites`);
  const paths = await mapConcurrent(candidates, WORKERS, probe);
  for (let i = 0; i < candidates.length; i++) {
    const domain = candidates[i];
    const path = paths[i];
    if (path) {
      mediawikiEntries.set(domain, path);
    } else if (path === null && previousMediawiki[domain]) {
      mediawikiEntries.set(domain, previousMediawiki[domain]);
    }
  }

  return {
    curated: sortedRecord(Object.entries(curated)),
    mediawiki: sortedRecord(mediawikiEntries),
  };
}

function capabilityCount(registry: SuggestionSiteRegistry): number {
  return (
    Object.keys(registry.curated).length +
    Object.keys(registry.mediawiki).length
  );
}

async function main(): Promise<void> {
  const bangs: Bang[] = await Bun.file(CATALOG_PATH).json();
  const previousFile = Bun.file(OUTPUT_PATH);
  const previous: SuggestionSiteRegistry | null = (await previousFile.exists())
    ? await previousFile.json()
    : null;
  const [wikimediaDomains, nugetAutocompleteUrl] = await Promise.all([
    fetchWikimediaDomains().catch((error) => {
      console.warn(`Warning: ${error}; falling back to probes`);
      return new Set<string>();
    }),
    fetchNugetAutocompleteUrl().catch((error) => {
      console.warn(`Warning: ${error}; using the cached NuGet endpoint`);
      const cached = previous?.curated["nuget.org"]?.url;
      if (cached) {
        try {
          return (
            new URL(cached.replace("{}", "query")).origin +
            new URL(cached.replace("{}", "query")).pathname
          );
        } catch {
          // Fall through to the documented fallback endpoint.
        }
      }
      return NUGET_AUTOCOMPLETE_FALLBACK;
    }),
  ]);
  console.log(
    `Loaded ${wikimediaDomains.size} Wikimedia sites from SiteMatrix`
  );
  const registry = await resolveSuggestionSites(bangs, probeMediaWiki, {
    curated: curatedSites(nugetAutocompleteUrl),
    previousMediawiki: previous?.mediawiki,
    wikimediaDomains,
  });
  const count = capabilityCount(registry);
  if (count === 0) {
    throw new Error(
      "No suggestion sites resolved; refusing to overwrite cache"
    );
  }

  if (previous) {
    const previousCount = capabilityCount(previous);
    if (previousCount > 0 && count * 2 < previousCount) {
      throw new Error(
        `Only ${count}/${previousCount} previous site capabilities resolved; refusing to overwrite cache`
      );
    }
  }

  await Bun.write(OUTPUT_PATH, `${JSON.stringify(registry, null, 2)}\n`);
  console.log(
    `Wrote ${OUTPUT_PATH}: ${Object.keys(registry.curated).length} curated + ${Object.keys(registry.mediawiki).length} MediaWiki sites`
  );
}

if (import.meta.main) {
  await main();
}
