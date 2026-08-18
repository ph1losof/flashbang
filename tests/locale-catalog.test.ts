import { describe, expect, test } from "bun:test";
import { LOCALE_DISABLED, LOCALE_PATTERNS } from "../src/shared/locale-table";
import { setActiveLocale } from "../src/sw/locale";
import { redirectRawUrl } from "../src/sw/redirect";
import { loadTestBangData } from "./helpers/bang-data";
import { redirectSettings } from "./helpers/redirect-fixtures";

await loadTestBangData();

const settings = redirectSettings({ custom: Object.create(null) });

function resolve(raw: string): string | null {
  return redirectRawUrl(raw, settings);
}

describe("locale substitution against the real catalog", () => {
  test("!w resolves to the reader's own Wikipedia edition", () => {
    setActiveLocale("de-DE");
    expect(resolve("!w+quantum")).toBe(
      "https://de.wikipedia.org/w/index.php?search=quantum"
    );
    setActiveLocale("fr-FR");
    expect(resolve("!w+quantum")).toBe(
      "https://fr.wikipedia.org/w/index.php?search=quantum"
    );
    setActiveLocale("zz");
    expect(resolve("!w+quantum")).toBe(
      "https://en.wikipedia.org/w/index.php?search=quantum"
    );
  });

  test("every Wikipedia alias shares the substitution", () => {
    setActiveLocale("es-ES");
    for (const trigger of ["w", "wiki", "wikipedia"]) {
      expect(resolve(`!${trigger}+gato`)).toBe(
        "https://es.wikipedia.org/w/index.php?search=gato"
      );
    }
  });

  test("no catalog redirect ever emits a literal marker", () => {
    for (const tag of ["de-DE", "xh-ZA", "pt-BR", "nb-NO"]) {
      setActiveLocale(tag);
      for (const raw of ["!w+x", "!wiki+x", "!w", "@w+x", "!g+x"]) {
        expect(resolve(raw) ?? "").not.toContain("{");
      }
    }
  });

  test("@w keeps searching all of Wikipedia, not one edition", () => {
    setActiveLocale("de-DE");
    expect(resolve("@w+katze")).toContain("site:wikipedia.org");
    expect(resolve("@w+katze")).not.toContain("site:de.wikipedia.org");
  });

  test("a locale change is not served from a stale cache", () => {
    setActiveLocale("de-DE");
    expect(resolve("!w+a")).toContain("de.wikipedia.org");
    setActiveLocale("it-IT");
    expect(resolve("!w+a")).toContain("it.wikipedia.org");
    expect(resolve("!w")).toContain("it.wikipedia.org");
  });
});

function referenceWikipediaUrl(tag: string, term: string): string {
  const pattern = LOCALE_PATTERNS.find(
    (candidate) => candidate.host === "{lang}.wikipedia.org"
  );
  if (!pattern) {
    throw new Error("wikipedia pattern missing from the locale table");
  }
  const supported = pattern.supported.split(" ");
  const aliases = new Map(
    pattern.aliases
      .split(" ")
      .filter(Boolean)
      .map((pair) => pair.split(":") as [string, string])
  );
  const canonical = tag.trim().toLowerCase().replaceAll("_", "-");
  const parts = canonical.split("-");
  let value = pattern.fallback;
  for (let end = parts.length; end > 0; end--) {
    const candidate = parts.slice(0, end).join("-");
    const mapped = aliases.get(candidate) ?? candidate;
    if (supported.includes(mapped)) {
      value = mapped;
      break;
    }
  }
  return `https://${value}.wikipedia.org/w/index.php?search=${term}`;
}

describe("expanded edition coverage", () => {
  test("serves languages that previously fell back to English", () => {
    const cases: Array<[string, string]> = [
      ["yi-001", "yi"],
      ["ceb-PH", "ceb"],
      ["war-PH", "war"],
      ["min-ID", "min"],
      ["sh-BA", "sh"],
      ["lb-LU", "lb"],
      ["oc-FR", "oc"],
      ["scn-IT", "scn"],
      ["nds-DE", "nds"],
      ["my-MM", "my"],
    ];
    for (const [tag, edition] of cases) {
      setActiveLocale(tag);
      expect(resolve("!w+x")).toBe(
        `https://${edition}.wikipedia.org/w/index.php?search=x`
      );
    }
  });

  test("Wiktionary follows the reader's language too", () => {
    setActiveLocale("de-DE");
    expect(resolve("!wt+Haus")).toContain("de.wiktionary.org");
    expect(resolve("!wikt+Haus")).toContain("de.wiktionary.org");
    setActiveLocale("xh-ZA");
    expect(resolve("!w+x")).toContain("xh.wikipedia.org");
    expect(resolve("!wt+x")).toContain("en.wiktionary.org");
  });

  test("explicitly language-pinned bangs are untouched", () => {
    setActiveLocale("de-DE");
    expect(resolve("!wen+x")).toContain("en.wikipedia.org");
    expect(resolve("!wifr+x")).toContain("fr.wiktionary.org");
  });

  test("@wt still searches all of Wiktionary", () => {
    setActiveLocale("de-DE");
    expect(resolve("@wt+x")).toContain("site:wiktionary.org");
  });
});

describe("disabling the feature", () => {
  test("real catalog bangs revert to the site default", () => {
    setActiveLocale("de-DE");
    expect(resolve("!w+quantum")).toContain("de.wikipedia.org");
    setActiveLocale(LOCALE_DISABLED);
    expect(resolve("!w+quantum")).toBe(
      "https://en.wikipedia.org/w/index.php?search=quantum"
    );
    expect(resolve("!wt+Haus")).toContain("en.wiktionary.org");
    expect(resolve("!g+x")).toContain("google.com");
  });

  test("snaps are unaffected by disabling", () => {
    setActiveLocale(LOCALE_DISABLED);
    expect(resolve("@w+katze")).toContain("site:wikipedia.org");
  });
});

describe("locale substitution differential fuzz", () => {
  test("agrees with an independent eager implementation", () => {
    const tags = [
      "de-DE",
      "de",
      "fr-CA",
      "pt-BR",
      "pt",
      "nb-NO",
      "nn-NO",
      "zh-Hant-TW",
      "zh",
      "xh-ZA",
      "qq",
      "en-US",
      "es-419",
      "sr-Latn-RS",
      "iw-IL",
      "in-ID",
      "simple",
      "la",
      "uz-Cyrl-UZ",
      "ja-JP",
      "ko-KR",
      "ru-RU",
      "ar-EG",
    ];
    const terms = ["a", "quantum", "hello+world", "%C3%BCber", "1", "x%2Fy"];
    for (const tag of tags) {
      setActiveLocale(tag);
      for (const term of terms) {
        expect(resolve("!g+z")).toContain("google.com");
        expect(resolve(`!w+${term}`)).toBe(referenceWikipediaUrl(tag, term));
        expect(resolve(`!wikipedia+${term}`)).toBe(
          referenceWikipediaUrl(tag, term)
        );
      }
    }
  });

  test("alternating locales never serve a stale memo", () => {
    const order = ["de-DE", "fr-FR", "de-DE", "es-ES", "fr-FR", "it-IT"];
    for (const tag of order) {
      setActiveLocale(tag);
      expect(resolve("!w+x")).toBe(referenceWikipediaUrl(tag, "x"));
    }
  });
});
