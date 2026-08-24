import { canonicalLocaleTag } from "../src/shared/locale-tag";

const SITEMATRIX_URL =
  "https://meta.wikimedia.org/w/api.php?action=sitematrix&format=json&formatversion=2&smlimit=max&smsiteprop=url|code";

const PROJECTS = [
  "wikipedia.org",
  "wiktionary.org",
  "wikisource.org",
  "wikibooks.org",
  "wikiquote.org",
  "wikivoyage.org",
  "wikiversity.org",
] as const;

interface SiteMatrixSite {
  closed?: boolean;
  url: string;
}
interface SiteMatrixEntry {
  code?: string;
  site?: SiteMatrixSite[];
}

export function editionsFromSiteMatrix(
  matrix: Record<string, unknown>
): Map<string, string[]> {
  const found = new Map<string, Set<string>>();
  for (const [key, value] of Object.entries(matrix)) {
    if (key === "count" || key === "specials") {
      continue;
    }
    const entry = value as SiteMatrixEntry;
    const code = (entry.code ?? "").toLowerCase();
    if (!code) {
      continue;
    }
    for (const site of entry.site ?? []) {
      if (site.closed) {
        continue;
      }
      const host = site.url.replace("https://", "");
      if (!host.startsWith(`${code}.`)) {
        continue;
      }
      const family = host.slice(code.length + 1);
      if (canonicalLocaleTag(code) !== code) {
        continue;
      }
      const set = found.get(family) ?? new Set<string>();
      set.add(code);
      found.set(family, set);
    }
  }
  return new Map(
    [...found].map(([family, codes]) => [family, [...codes].sort()])
  );
}

if (import.meta.main) {
  const response = await fetch(SITEMATRIX_URL);
  const payload = (await response.json()) as {
    sitematrix: Record<string, unknown>;
  };
  const editions = editionsFromSiteMatrix(payload.sitematrix);
  for (const family of PROJECTS) {
    const codes = editions.get(family);
    if (!codes) {
      console.error(`No live editions found for ${family}`);
      continue;
    }
    console.log(`  // ${family}: ${codes.length} live editions`);
    console.log(`  "${codes.join(" ")}",`);
  }
}
