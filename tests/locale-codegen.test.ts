import { describe, expect, test } from "bun:test";
import { assertLocaleMarkers, assertLocaleMarkerUrl } from "../scripts/codegen";

interface TestBang {
  domain: string;
  name: string;
  regex?: string;
  relevance: number;
  trigger: string;
  url: string;
}

function bang(url: string, extra: Partial<TestBang> = {}): TestBang {
  return {
    domain: "example.org",
    name: "Test",
    relevance: 0,
    trigger: "t",
    url,
    ...extra,
  };
}

function reject(url: string, extra: Partial<TestBang> = {}): string {
  try {
    assertLocaleMarkers([bang(url, extra)]);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`expected ${url} to be rejected`);
}

describe("assertLocaleMarkers", () => {
  test("accepts registered patterns", () => {
    expect(() =>
      assertLocaleMarkers([
        bang("https://{lang}.wikipedia.org/w/index.php?search={}"),
        bang("https://github.com/search?q={}"),
      ])
    ).not.toThrow();
  });

  test("rejects an unregistered host pattern", () => {
    expect(reject("https://{lang}.example.org/?q={}")).toContain(
      "not registered"
    );
    expect(reject("https://{lang}.evil.org/?q={}")).toContain("not registered");
  });

  test("rejects markers that do not occupy a whole host label", () => {
    expect(reject("https://evil.com{lang}.wikipedia.org/?q={}")).toContain(
      "leading host label"
    );
    expect(reject("https://{lang}evil.com/?q={}")).toContain(
      "leading host label"
    );
  });

  test("rejects markers outside the authority", () => {
    expect(reject("https://wikipedia.org/{lang}/?q={}")).toContain(
      "inside the authority"
    );
    expect(reject("https://wikipedia.org/?lang={lang}&q={}")).toContain(
      "inside the authority"
    );
  });

  test("rejects a marker that is not the leading host label", () => {
    expect(reject("https://www.example.{lang}/s?k={}")).toContain(
      "leading host label"
    );
  });

  test("rejects more than one marker", () => {
    expect(reject("https://{lang}.{lang}.wikipedia.org/?q={}")).toContain(
      "at most one"
    );
  });

  test("rejects markers on capture bangs", () => {
    expect(
      reject("https://{lang}.wikipedia.org/wiki/$1", { regex: "(.*)" })
    ).toContain("capture bangs");
  });

  test("rejects unrecognized placeholders in the authority only", () => {
    expect(reject("https://{region}.wikipedia.org/?q={}")).toContain(
      "unrecognized placeholder in the authority"
    );
    expect(() =>
      assertLocaleMarkers([
        bang(
          'https://www.congress.gov/search?q={"source":"legislation","q":"{}"}'
        ),
        bang("http://forum.a-tm.co.jp/search?q=h&j={%22k%22%3A%22{}%22}"),
      ])
    ).not.toThrow();
  });
});

describe("shipped suggestion endpoints", () => {
  test("every marked endpoint obeys the same rules as the catalog", async () => {
    const registry = (await Bun.file("data/suggest-sites.json").json()) as {
      curated: Record<string, { shape: string; url: string }>;
    };
    const marked = Object.entries(registry.curated).filter(([, site]) =>
      site.url.includes("{lang}")
    );
    expect(marked.map(([domain]) => domain)).toContain("wikipedia.org");

    for (const [domain, site] of marked) {
      expect(() =>
        assertLocaleMarkerUrl(site.url, (reason) => {
          throw new Error(`${domain}: ${reason}`);
        })
      ).not.toThrow();
    }
  });

  test("an endpoint on an unregistered host is rejected", () => {
    expect(() =>
      assertLocaleMarkerUrl("https://{lang}.example.com/api?q={}", (reason) => {
        throw new Error(reason);
      })
    ).toThrow(/not registered/);
  });
});
