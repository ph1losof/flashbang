import { describe, expect, test } from "bun:test";
import "../src/shared/locale-table-install";
import { LOCALE_PATTERNS } from "../src/shared/locale-table";
import {
  LOCALE_DISABLED,
  normalizeLocaleSetting,
} from "../src/shared/locale-tag";
import {
  canonicalLocaleTag,
  localeSnapDomain,
  setActiveLocale,
  substituteLocale,
} from "../src/sw/locale";
import { buildUrl, compileUrlMode } from "../src/sw/redirect-prefix";

const WIKI = "https://{lang}.wikipedia.org/w/index.php?search=";
function wikiFor(tag: string): string {
  setActiveLocale(tag);
  return substituteLocale(WIKI);
}

describe("locale tag canonicalization", () => {
  test("accepts BCP-47 shapes and normalizes separators", () => {
    expect(canonicalLocaleTag("de")).toBe("de");
    expect(canonicalLocaleTag("de-DE")).toBe("de-de");
    expect(canonicalLocaleTag("DE_de")).toBe("de-de");
    expect(canonicalLocaleTag("  zh-Hant-TW  ")).toBe("zh-hant-tw");
  });

  test("rejects anything that could move the origin", () => {
    for (const value of [
      "de/evil.com",
      "de.evil.com",
      "de:8080",
      "de@evil.com",
      "de%2f",
      "de\\evil",
      "de-DE;q=0.9",
      "",
      "a",
      "toolongsubtag123456",
      "-de",
      "de-",
    ]) {
      expect(canonicalLocaleTag(value)).toBeNull();
    }
  });
});

describe("locale resolution", () => {
  test("resolves through truncation, aliases, and fallback", () => {
    expect(wikiFor("de-DE")).toBe(
      "https://de.wikipedia.org/w/index.php?search="
    );
    expect(wikiFor("pt-BR")).toBe(
      "https://pt.wikipedia.org/w/index.php?search="
    );
    expect(wikiFor("nb-NO")).toBe(
      "https://no.wikipedia.org/w/index.php?search="
    );
    expect(wikiFor("zh-Hant-TW")).toBe(
      "https://zh.wikipedia.org/w/index.php?search="
    );
  });

  test("falls back rather than inventing a host that does not exist", () => {
    expect(wikiFor("zz")).toBe("https://en.wikipedia.org/w/index.php?search=");
    expect(wikiFor("qq")).toBe("https://en.wikipedia.org/w/index.php?search=");
    expect(wikiFor("xh-ZA")).toBe(
      "https://xh.wikipedia.org/w/index.php?search="
    );
  });

  test("leaves unmarked prefixes untouched and does not memoize them", () => {
    const plain = "https://github.com/search?q=";
    setActiveLocale("de-DE");
    expect(substituteLocale(plain)).toBe(plain);
    expect(localeSnapDomain(plain)).toBeNull();
  });

  test("never returns a marker", () => {
    for (const tag of ["de-DE", "xh-ZA", "en-US", "zh", "qq-ZZ"]) {
      setActiveLocale(tag);
      expect(substituteLocale(WIKI)).not.toContain("{");
    }
  });

  test("reports whether the resolved chain actually changed", () => {
    setActiveLocale("de-DE");
    expect(setActiveLocale("de-DE")).toBe(false);
    expect(setActiveLocale("fr-FR")).toBe(true);
  });

  test("an unsupported override cannot select an off-table origin", () => {
    setActiveLocale("zz");
    const host = new URL(`${substituteLocale(WIKI)}x`).hostname;
    expect(host).toBe("en.wikipedia.org");
  });
});

describe("snap site filters", () => {
  test("{lang} groups keep the registrable domain", () => {
    setActiveLocale("de-DE");
    expect(localeSnapDomain(WIKI)).toBe("wikipedia.org");
  });

  test("an unmarked prefix has no snap override", () => {
    setActiveLocale("de-DE");
    expect(localeSnapDomain("https://github.com/search?q=")).toBeNull();
  });
});

describe("buildUrl locale substitution", () => {
  test("flags a marked prefix and fills the query", () => {
    const entry = [WIKI, ""] as const;
    const mode = compileUrlMode(entry[0], entry[1]);
    expect(mode & 4).not.toBe(0);
    setActiveLocale("de-DE");
    expect(buildUrl(entry, "quantum", 0, 7, mode)).toBe(
      "https://de.wikipedia.org/w/index.php?search=quantum"
    );
  });

  test("localizes a bare bang with no suffix", () => {
    const entry = ["https://{lang}.wikipedia.org/", null] as const;
    setActiveLocale("fr-FR");
    expect(buildUrl(entry, "", 0, 0)).toBe("https://fr.wikipedia.org/");
  });

  test("re-resolves after the locale changes", () => {
    const entry = [WIKI, ""] as const;
    const mode = compileUrlMode(entry[0], entry[1]);
    setActiveLocale("de-DE");
    expect(buildUrl(entry, "a", 0, 1)).toContain("de.wikipedia.org");
    setActiveLocale("es-ES");
    expect(buildUrl(entry, "a", 0, 1, mode)).toContain("es.wikipedia.org");
  });

  test("handles a repeated placeholder alongside a marker", () => {
    const entry = [WIKI, "&fallback={}"] as const;
    const mode = compileUrlMode(entry[0], entry[1]);
    expect(mode & 2).not.toBe(0);
    expect(mode & 4).not.toBe(0);
    setActiveLocale("it-IT");
    expect(buildUrl(entry, "roma", 0, 4, mode)).toBe(
      "https://it.wikipedia.org/w/index.php?search=roma&fallback=roma"
    );
  });

  test("leaves unmarked entries on the single-concatenation path", () => {
    const entry = [
      "https://github.com/search?q=",
      "&type=repositories",
    ] as const;
    const mode = compileUrlMode(entry[0], entry[1]);
    expect(mode & 4).toBe(0);
    expect(buildUrl(entry, "bun", 0, 3, mode)).toBe(
      "https://github.com/search?q=bun&type=repositories"
    );
  });
});

describe("locale table integrity", () => {
  test("every supported value produces the expected origin", () => {
    for (const pattern of LOCALE_PATTERNS) {
      const marker = "{lang}";
      expect(pattern.host).toContain(marker);
      const supported = pattern.supported.split(" ");
      for (const value of [...supported, pattern.fallback]) {
        const url = new URL(`https://${pattern.host.replace(marker, value)}/x`);
        expect(url.protocol).toBe("https:");
        expect(url.port).toBe("");
        expect(url.username).toBe("");
        expect(url.pathname).toBe("/x");
        expect(url.hostname).not.toContain("{");
      }
      expect(supported).toContain(pattern.fallback);
      for (const pair of pattern.aliases.split(" ").filter(Boolean)) {
        const [from, to] = pair.split(":");
        expect(supported).toContain(to);
        expect(supported).not.toContain(from);
      }
    }
  });

  test("every supported value is reachable through canonicalization", () => {
    for (const pattern of LOCALE_PATTERNS) {
      for (const value of pattern.supported.split(" ")) {
        expect(canonicalLocaleTag(value)).toBe(value);
      }
    }
  });

  test("host patterns are unique", () => {
    const hosts = LOCALE_PATTERNS.map((p) => p.host);
    expect(new Set(hosts).size).toBe(hosts.length);
  });
});

describe("list scanning matches exact codes only", () => {
  test("agrees with a Set for every code in every shipped list", () => {
    for (const pattern of LOCALE_PATTERNS) {
      const codes = pattern.supported.split(" ");
      const set = new Set(codes);
      for (const code of codes) {
        setActiveLocale(code);
        const host = new URL(`${substituteLocale(`https://${pattern.host}/x`)}`)
          .hostname;
        const expected = pattern.host.replace("{lang}", code);
        expect(set.has(code)).toBe(true);
        expect(host).toBe(expected);
      }
    }
  });

  test("does not match a substring of a neighbouring code", () => {
    const codes = new Set(LOCALE_PATTERNS[0].supported.split(" "));
    const collisions = ["ac", "ad", "dy", "al", "ng", "rc", "at", "zb", "cl"];
    for (const bogus of collisions) {
      expect(codes.has(bogus)).toBe(false);
      setActiveLocale(bogus);
      expect(substituteLocale("https://{lang}.wikipedia.org/")).toBe(
        "https://en.wikipedia.org/"
      );
    }
  });

  test("matches codes at both ends of the list", () => {
    const codes = LOCALE_PATTERNS[0].supported.split(" ");
    for (const code of [codes[0], codes[codes.length - 1]]) {
      setActiveLocale(code);
      expect(substituteLocale("https://{lang}.wikipedia.org/")).toBe(
        `https://${code}.wikipedia.org/`
      );
    }
  });

  test("resolves aliases without matching their prefixes", () => {
    setActiveLocale("nb");
    expect(substituteLocale("https://{lang}.wikipedia.org/")).toBe(
      "https://no.wikipedia.org/"
    );
    setActiveLocale("zh-hant");
    expect(substituteLocale("https://{lang}.wikipedia.org/")).toBe(
      "https://zh.wikipedia.org/"
    );
    setActiveLocale("z");
    expect(substituteLocale("https://{lang}.wikipedia.org/")).toBe(
      "https://en.wikipedia.org/"
    );
  });
});

describe("disabling locale substitution", () => {
  test("every site falls back to its own default edition", () => {
    setActiveLocale("de-DE");
    expect(wikiFor("de-DE")).toContain("de.wikipedia.org");
    setActiveLocale(LOCALE_DISABLED);
    for (const pattern of LOCALE_PATTERNS) {
      expect(substituteLocale(`https://${pattern.host}/x`)).toBe(
        `https://${pattern.host.replace("{lang}", pattern.fallback)}/x`
      );
    }
  });

  test("still never emits a marker", () => {
    setActiveLocale(LOCALE_DISABLED);
    expect(substituteLocale(WIKI)).not.toContain("{");
  });

  test("is reversible", () => {
    setActiveLocale(LOCALE_DISABLED);
    expect(substituteLocale(WIKI)).toContain("en.wikipedia.org");
    setActiveLocale("fr-FR");
    expect(substituteLocale(WIKI)).toContain("fr.wikipedia.org");
    setActiveLocale(LOCALE_DISABLED);
    expect(substituteLocale(WIKI)).toContain("en.wikipedia.org");
  });

  test("the sentinel can never be mistaken for a language tag", () => {
    expect(canonicalLocaleTag(LOCALE_DISABLED)).toBeNull();
    expect(normalizeLocaleSetting(LOCALE_DISABLED)).toBe(LOCALE_DISABLED);
    expect(normalizeLocaleSetting("de-DE")).toBe("de-de");
    expect(normalizeLocaleSetting("de/evil")).toBeNull();
    for (const pattern of LOCALE_PATTERNS) {
      expect(pattern.supported.split(" ")).not.toContain(LOCALE_DISABLED);
    }
  });

  test("disabled is distinct from following the browser", () => {
    setActiveLocale(null);
    const followed = substituteLocale(WIKI);
    setActiveLocale(LOCALE_DISABLED);
    expect(substituteLocale(WIKI)).toContain("en.wikipedia.org");
    expect(typeof followed).toBe("string");
  });
});
