import { describe, expect, mock, test } from "bun:test";

mock.module("../generated/bangs-min.js", () => {
  const BANGS: Record<string, string> = Object.create(null);
  BANGS["g"] = "https://www.google.com/search?q={}";
  BANGS["ddg"] = "https://duckduckgo.com/?q={}";
  BANGS["gh"] = "https://github.com/search?q={}&type=repositories";
  BANGS["w"] = "https://en.wikipedia.org/wiki/Special:Search?search={}";
  BANGS["yt"] = "https://www.youtube.com/results?search_query={}";
  BANGS["b"] = "https://www.bing.com/search?q={}";
  BANGS["mdn"] =
    "https://developer.mozilla.org/en-US/search?q={}&topic=api&topic=js";
  return { BANGS };
});

import { redirect, type RedirectSettings } from "./redirect";

const DEFAULT_URL = "https://www.google.com/search?q={}";
const LUCKY_URL = "https://www.google.com/search?btnI&q={}";

function settings(overrides: Partial<RedirectSettings> = {}): RedirectSettings {
  return {
    defaultUrl: DEFAULT_URL,
    custom: {},
    luckyUrl: LUCKY_URL,
    ...overrides,
  };
}

function loc(r: Response): string {
  return r.headers.get("Location")!;
}

describe("parse — bang syntax patterns", () => {
  test('"!g cats" → prefix bang with term', () => {
    const r = redirect("!g cats", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?q=cats");
  });

  test('"!G CATS" → case-insensitive bang', () => {
    const r = redirect("!G CATS", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?q=CATS");
  });

  test('"!g" → prefix bang, no term → google.com origin', () => {
    const r = redirect("!g", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com");
  });

  test('"g! cats" → prefix suffix-bang', () => {
    const r = redirect("g! cats", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?q=cats");
  });

  test('"g!" → suffix-bang alone → google.com origin', () => {
    const r = redirect("g!", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com");
  });

  test('"cats !g" → trailing prefix-bang', () => {
    const r = redirect("cats !g", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?q=cats");
  });

  test('"cats g!" → trailing suffix-bang', () => {
    const r = redirect("cats g!", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?q=cats");
  });

  test('"\\cats" → backslash lucky', () => {
    const r = redirect("\\cats", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?btnI&q=cats");
  });

  test('"! cats" → leading bare bang lucky', () => {
    const r = redirect("! cats", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?btnI&q=cats");
  });

  test('"cats !" → trailing bare bang lucky', () => {
    const r = redirect("cats !", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?btnI&q=cats");
  });

  test('"cats" → no bang → default URL', () => {
    const r = redirect("cats", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?q=cats");
  });
});

describe("redirect — routing logic", () => {
  test('"!" alone → redirect to "/"', () => {
    const r = redirect("!", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("/");
  });

  test("lucky + luckyUrl + term → lucky redirect", () => {
    const r = redirect("\\hello world", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?btnI&q=hello%20world");
  });

  test("lucky without luckyUrl → falls through to default", () => {
    const r = redirect("\\cats", settings({ luckyUrl: null }));
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?q=cats");
  });

  test("custom bang overrides built-in", () => {
    const r = redirect(
      "!g cats",
      settings({ custom: { g: "https://custom.search/?q={}" } }),
    );
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://custom.search/?q=cats");
  });

  test('"!zzz cats" → unknown bang → default URL with full raw query', () => {
    const r = redirect("!zzz cats", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?q=!zzz%20cats");
  });

  test("empty term → origin extraction via new URL().origin", () => {
    const r = redirect("!gh", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://github.com");
  });

  test("empty term with unparseable URL → fallback to replace", () => {
    const r = redirect("!g", settings({ custom: { g: "not-a-url/{}" } }));
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("not-a-url/");
  });
});

describe("encode — URL encoding", () => {
  test("slashes preserved (not %2F)", () => {
    const r = redirect("!g a/b/c", settings());
    expect(loc(r)).toBe("https://www.google.com/search?q=a/b/c");
  });

  test("spaces encoded as %20", () => {
    const r = redirect("!g hello world", settings());
    expect(loc(r)).toBe("https://www.google.com/search?q=hello%20world");
  });

  test("special chars (& = ?) encoded", () => {
    const r = redirect("!g a&b=c?d", settings());
    expect(loc(r)).toBe("https://www.google.com/search?q=a%26b%3Dc%3Fd");
  });
});
