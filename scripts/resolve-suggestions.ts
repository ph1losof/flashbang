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
const WORKERS = 32;
const TIMEOUT_MS = 5000;
const MEDIAWIKI_PATHS = ["/", "/w/"] as const;

// These services expose useful public suggestion/search APIs but not a
// conventional MediaWiki OpenSearch endpoint. They are keyed by the catalog's
// canonical domain so every alias inherits the capability automatically.
const CURATED: Readonly<Record<string, CuratedSuggestionSite>> = {
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
    url: "https://hn.algolia.com/api/v1/search?query={}&hitsPerPage=8",
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
  "www.reddit.com": {
    shape: "reddit",
    url: "https://www.reddit.com/subreddits/search.json?q={}&limit=8",
  },
  "www.youtube.com": {
    shape: "opensearch",
    url: "https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q={}",
  },
};

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
): Promise<boolean> {
  try {
    const response = await fetch(
      `https://${domain}${path}api.php?action=opensearch&search=flashbang&format=json&limit=1`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) }
    );
    if (!response.ok) {
      return false;
    }
    const payload: unknown = await response.json();
    return (
      Array.isArray(payload) && payload.length >= 2 && Array.isArray(payload[1])
    );
  } catch {
    return false;
  }
}

async function probeMediaWiki(domain: string): Promise<"/" | "/w/" | null> {
  // Probe both conventional locations together, then choose deterministically.
  const [root, w] = await Promise.all(
    MEDIAWIKI_PATHS.map((path) => probePath(domain, path))
  );
  if (root) {
    return "/";
  }
  return w ? "/w/" : null;
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
  probe: (domain: string) => Promise<"/" | "/w/" | null> = probeMediaWiki
): Promise<SuggestionSiteRegistry> {
  const domains = new Map<string, Bang>();
  for (const bang of bangs) {
    if (!domains.has(bang.domain) && isMediaWikiCandidate(bang)) {
      domains.set(bang.domain, bang);
    }
  }
  for (const domain of Object.keys(CURATED)) {
    domains.delete(domain);
  }

  const candidates = [...domains.keys()].sort();
  console.log(`Probing ${candidates.length} possible MediaWiki sites`);
  const paths = await mapConcurrent(candidates, WORKERS, probe);
  const mediawikiEntries: Array<readonly [string, "/" | "/w/"]> = [];
  for (let i = 0; i < candidates.length; i++) {
    const path = paths[i];
    if (path) {
      mediawikiEntries.push([candidates[i], path]);
    }
  }

  return {
    curated: sortedRecord(Object.entries(CURATED)),
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
  const registry = await resolveSuggestionSites(bangs);
  const count = capabilityCount(registry);
  if (count === 0) {
    throw new Error(
      "No suggestion sites resolved; refusing to overwrite cache"
    );
  }

  const previousFile = Bun.file(OUTPUT_PATH);
  if (await previousFile.exists()) {
    const previous: SuggestionSiteRegistry = await previousFile.json();
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
