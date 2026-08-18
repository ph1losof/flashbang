import { describe, expect, test } from "bun:test";
import {
  applyCanonicalUrls,
  type CanonicalOverlay,
  EMPTY_CANONICAL_OVERLAY,
} from "../scripts/codegen";
import { validateSimpleBangUrl } from "../src/shared/capture-template";

interface Bang {
  domain: string;
  name: string;
  regex?: string;
  relevance: number;
  snap?: string;
  trigger: string;
  url: string;
}

const overlay: CanonicalOverlay = await Bun.file(
  "data/bang-canonical.json"
).json();
const catalog: Bang[] = await Bun.file("data/bangs.json").json();

function bang(url: string, extra: Partial<Bang> = {}): Bang {
  return {
    domain: "example.org",
    name: "Test",
    relevance: 0,
    trigger: "t",
    url,
    ...extra,
  };
}

function overlayWith(part: Partial<CanonicalOverlay>): CanonicalOverlay {
  return { ...EMPTY_CANONICAL_OVERLAY, ...part };
}

describe("committed canonical overlay", () => {
  test("data/bangs.json already reflects every overlay entry", () => {
    const applied = new Map<string, string>([
      ...Object.entries(overlay.auto),
      ...Object.entries(overlay.approved).map(
        ([from, to]) => [from, to.url] as const
      ),
    ]);
    for (const entry of catalog) {
      expect(applied.get(entry.url) ?? entry.url).toBe(entry.url);
    }
  });

  test("every overlay key and value is a valid bang template", () => {
    for (const [from, to] of Object.entries(overlay.auto)) {
      expect(validateSimpleBangUrl(from, true)).toBeNull();
      expect(validateSimpleBangUrl(to, true)).toBeNull();
    }
    for (const [from, to] of Object.entries(overlay.approved)) {
      expect(validateSimpleBangUrl(from, true)).toBeNull();
      expect(validateSimpleBangUrl(to.url, true)).toBeNull();
    }
  });

  test("auto entries never change the snap domain", () => {
    const domain = (url: string): string => {
      const host = new URL(url.replace("{}", "x")).hostname.toLowerCase();
      return host.startsWith("www.") ? host.substring(4) : host;
    };
    for (const [from, to] of Object.entries(overlay.auto)) {
      expect(domain(to)).toBe(domain(from));
    }
  });
});

describe("applyCanonicalUrls", () => {
  test("rewrites only exact template matches", () => {
    const result = applyCanonicalUrls(
      [bang("http://x.example/?q={}"), bang("http://y.example/?q={}")],
      overlayWith({
        auto: { "http://x.example/?q={}": "https://x.example/?q={}" },
      })
    );
    expect(result[0].url).toBe("https://x.example/?q={}");
    expect(result[1].url).toBe("http://y.example/?q={}");
  });

  test("leaves domain metadata alone", () => {
    const result = applyCanonicalUrls(
      [bang("http://x.example/?q={}", { domain: "x.example" })],
      overlayWith({
        auto: { "http://x.example/?q={}": "https://x.example/?q={}" },
      })
    );
    expect(result[0].domain).toBe("x.example");
  });

  test("never rewrites capture bangs", () => {
    const result = applyCanonicalUrls(
      [bang("http://x.example/$1", { regex: "(.*)" })],
      overlayWith({ auto: { "http://x.example/$1": "https://x.example/$1" } })
    );
    expect(result[0].url).toBe("http://x.example/$1");
  });

  test("throws when a rewrite would move the snap domain", () => {
    expect(() =>
      applyCanonicalUrls(
        [bang("https://maps.google.com/maps?q={}")],
        overlayWith({
          auto: {
            "https://maps.google.com/maps?q={}":
              "https://www.google.com/maps?q={}",
          },
        })
      )
    ).toThrow("snap domain");
  });

  test("accepts a host move when the approval compensates with a snap", () => {
    const result = applyCanonicalUrls(
      [bang("https://maps.google.com/maps?q={}")],
      overlayWith({
        approved: {
          "https://maps.google.com/maps?q={}": {
            snap: "maps.google.com",
            url: "https://www.google.com/maps?q={}",
          },
        },
      })
    );
    expect(result[0].url).toBe("https://www.google.com/maps?q={}");
    expect(result[0].snap).toBe("maps.google.com");
  });

  test("drops a bad rewrite rather than the bang", () => {
    const result = applyCanonicalUrls(
      [bang("http://x.example/?q={}")],
      overlayWith({
        auto: { "http://x.example/?q={}": "javascript:alert({})" },
      })
    );
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe("http://x.example/?q={}");
  });

  test("preserves a template byte-for-byte, including trailing space", () => {
    const odd = "http://www.360skate.com/catalogsearch/result/?q={} ";
    const result = applyCanonicalUrls([bang(odd)], EMPTY_CANONICAL_OVERLAY);
    expect(result[0].url).toBe(odd);
  });

  test("an empty overlay is the identity", () => {
    const input = [
      bang("http://x.example/?q={}"),
      bang("https://y.example/?q={}"),
    ];
    expect(applyCanonicalUrls(input, EMPTY_CANONICAL_OVERLAY)).toEqual(input);
  });
});
