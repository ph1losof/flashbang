import { describe, expect, test } from "bun:test";
import { compileCaptureUrl } from "../src/shared/capture-template";
import { compileSnapTarget } from "../src/shared/snap-target";
import {
  TRIGGER_PREFIXES,
  type TriggerPrefix,
} from "../src/shared/trigger-prefix";
import {
  compileTriggerSyntax,
  type RedirectSettings,
  redirect,
  redirectRaw as redirectRawTuple,
  redirectUrl,
} from "../src/sw/redirect";
import { loadTestBangData } from "./helpers/bang-data";

await loadTestBangData();

function redirectRaw(rawQuery: string, settings: RedirectSettings): Response {
  return redirectRawTuple(rawQuery, settings)[0];
}

function redirectRawTrigger(
  rawQuery: string,
  settings: RedirectSettings
): string | null {
  return redirectRawTuple(rawQuery, settings)[1];
}

import type { CustomUrlParts, UrlParts } from "../src/sw/redirect";

const DEFAULT_URL: UrlParts = ["https://www.google.com/search?q=", ""];
const LUCKY_URL: UrlParts = ["https://www.google.com/search?btnI&q=", ""];

const TEST_BANGS: Record<string, UrlParts> = {
  b: ["https://www.bing.com/search?q=", ""],
  ddg: ["https://duckduckgo.com/?q=", ""],
  g: ["https://www.google.com/search?q=", ""],
  gh: ["https://github.com/search?q=", "&type=repositories"],
  mdn: ["https://developer.mozilla.org/en-US/search?q=", "&topic=api&topic=js"],
  so: ["https://stackoverflow.com/search?q=", ""],
  w: ["https://en.wikipedia.org/wiki/Special:Search?search=", ""],
  yt: ["https://www.youtube.com/results?search_query=", ""],
};

function testBangs(
  overrides?: Record<string, CustomUrlParts>
): Record<string, CustomUrlParts> {
  return { ...TEST_BANGS, ...overrides };
}

function splitUrl(url: string): UrlParts {
  const idx = url.indexOf("{}");
  return idx === -1
    ? [url, null]
    : [url.substring(0, idx), url.substring(idx + 2)];
}

function settings(overrides: Partial<RedirectSettings> = {}): RedirectSettings {
  const { custom, ...rest } = overrides;
  return {
    defaultUrl: DEFAULT_URL,
    custom: testBangs(custom),
    luckyUrl: LUCKY_URL,
    ...rest,
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

describe("parse — configurable bang and snap prefixes", () => {
  function syntaxSettings(
    bangPrefix: TriggerPrefix,
    snapPrefix: TriggerPrefix
  ): RedirectSettings {
    return settings({
      syntax: compileTriggerSyntax(bangPrefix, snapPrefix),
    });
  }

  for (const bangPrefix of TRIGGER_PREFIXES) {
    for (const snapPrefix of TRIGGER_PREFIXES) {
      if (bangPrefix === snapPrefix) {
        continue;
      }
      test(`${bangPrefix} bangs and ${snapPrefix} snaps match default syntax`, () => {
        const customSyntax = syntaxSettings(bangPrefix, snapPrefix);
        expect(loc(redirect(`${bangPrefix}g cats`, customSyntax))).toBe(
          "https://www.google.com/search?q=cats"
        );
        expect(loc(redirect(`g${bangPrefix} cats`, customSyntax))).toBe(
          "https://www.google.com/search?q=cats"
        );
        expect(loc(redirect(`cats ${bangPrefix}g`, customSyntax))).toBe(
          "https://www.google.com/search?q=cats"
        );
        expect(loc(redirect(`cats g${bangPrefix}`, customSyntax))).toBe(
          "https://www.google.com/search?q=cats"
        );
        expect(loc(redirect(`${snapPrefix}g cats`, customSyntax))).toBe(
          "https://www.google.com/search?q=cats+site:google.com"
        );
        expect(loc(redirect(`cats ${snapPrefix}g`, customSyntax))).toBe(
          "https://www.google.com/search?q=cats+site:google.com"
        );
      });
    }
  }

  test("selected bang prefix controls bare lucky syntax", () => {
    const customSyntax = syntaxSettings("$", "~");
    expect(loc(redirect("$ cats", customSyntax))).toBe(
      "https://www.google.com/search?btnI&q=cats"
    );
    expect(loc(redirect("cats $", customSyntax))).toBe(
      "https://www.google.com/search?btnI&q=cats"
    );
    expect(loc(redirect("\\cats", customSyntax))).toBe(
      "https://www.google.com/search?btnI&q=cats"
    );
    expect(loc(redirect("! cats", customSyntax))).toBe(
      "https://www.google.com/search?q=!+cats"
    );
  });

  test("replaced default prefixes remain ordinary query text", () => {
    const customSyntax = syntaxSettings("$", "~");
    expect(loc(redirect("!g cats", customSyntax))).toBe(
      "https://www.google.com/search?q=!g+cats"
    );
    expect(loc(redirect("@g cats", customSyntax))).toBe(
      "https://www.google.com/search?q=@g+cats"
    );
  });

  test("percent-encoded configured prefixes resolve without decoding", () => {
    const customSyntax = syntaxSettings("$", ";");
    expect(loc(redirectRaw("%24g+cats", customSyntax))).toBe(
      "https://www.google.com/search?q=cats"
    );
    expect(loc(redirectRaw("%3Bg+cats", customSyntax))).toBe(
      "https://www.google.com/search?q=cats+site:google.com"
    );
    expect(loc(redirectRaw("cats+%24g", customSyntax))).toBe(
      "https://www.google.com/search?q=cats"
    );
    expect(loc(redirectRaw("cats+%3bg", customSyntax))).toBe(
      "https://www.google.com/search?q=cats+site:google.com"
    );
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
    expect(loc(r)).toBe("https://www.google.com/search?btnI&q=hello+world");
  });

  test("lucky without luckyUrl → falls through to default", () => {
    const r = redirect("\\cats", settings({ luckyUrl: null }));
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?q=cats");
  });

  test("custom bang overrides built-in", () => {
    const r = redirect(
      "!g cats",
      settings({ custom: { g: splitUrl("https://custom.search/?q={}") } })
    );
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://custom.search/?q=cats");
  });

  test("fills every placeholder in a built-in template", () => {
    const placeholderCounts: Record<string, number> = {
      bla: 2,
      bnbr: 2,
      eventful: 2,
      infobae: 2,
      mpgpure: 3,
      pagesjaunes: 2,
      patft: 3,
      pluggedin: 2,
      reittiopas: 2,
      skb: 2,
      wynk: 2,
      yesasia: 2,
    };
    for (const [trigger, count] of Object.entries(placeholderCounts)) {
      const location = loc(redirect(`!${trigger} needle`, settings()));
      expect(location.match(/needle/g)?.length).toBe(count);
      expect(location).not.toMatch(/(?:\{|%7B)(?:\}|%7D)/i);
    }
    expect(loc(redirect("!infobae cats and dogs", settings()))).toBe(
      "https://www.infobae.com/search/cats%20and%20dogs/?q=cats+and+dogs"
    );
  });

  test('"!zzz cats" → unknown bang → default URL with full raw query', () => {
    const r = redirect("!zzz cats", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?q=!zzz+cats");
  });

  test("empty term → origin extraction via new URL().origin", () => {
    const r = redirect("!gh", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://github.com");
  });

  test("empty term with unparseable URL → fallback to replace", () => {
    const r = redirect(
      "!g",
      settings({ custom: { g: splitUrl("not-a-url/{}") } })
    );
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("not-a-url/");
  });

  test("bare custom bang strips a query without an intervening slash", () => {
    const r = redirect(
      "!g",
      settings({ custom: { g: splitUrl("https://custom.search?q={}") } })
    );
    expect(loc(r)).toBe("https://custom.search");
  });
});

describe("redirect — capture bangs", () => {
  test("built-in ktr fills and percent-encodes both captures", () => {
    expect(
      redirectUrl(
        "!ktr japanese https://example.com/article?q=hello world",
        settings()
      )
    ).toBe(
      "https://translate.kagi.com/japanese/https%3A%2F%2Fexample.com%2Farticle%3Fq%3Dhello%20world"
    );
  });

  test("built-in ktr supports suffix syntax", () => {
    expect(redirectUrl("japanese https://example.com ktr!", settings())).toBe(
      "https://translate.kagi.com/japanese/https%3A%2F%2Fexample.com"
    );
  });

  test("capture bang without a term opens its origin", () => {
    expect(redirectUrl("!ktr", settings())).toBe("https://translate.kagi.com");
  });

  test("capture no-match falls back to the full default query", () => {
    expect(redirectUrl("!ktr japanese", settings())).toBe(
      "https://www.google.com/search?q=!ktr+japanese"
    );
    expect(redirectRawTrigger("!ktr+japanese", settings())).toBeNull();
  });

  test("oversized capture input bypasses regex execution", () => {
    const query = `!ktr+japanese+${"a".repeat(2049)}`;
    expect(redirectRawTrigger(query, settings())).toBeNull();
    expect(loc(redirectRaw(query, settings()))).toBe(
      `https://www.google.com/search?q=${query}`
    );
  });

  test("custom capture bang overrides a built-in", () => {
    const advanced = compileCaptureUrl(
      "https://custom.example/$1?q=$2",
      "(\\w+)\\s+(.*)",
      "plus"
    )!;
    const s = settings({
      custom: { ktr: advanced },
    });
    expect(redirectUrl("!ktr en hello world", s)).toBe(
      "https://custom.example/en?q=hello+world"
    );
  });

  test("custom raw captures are substituted without encoding", () => {
    const advanced = compileCaptureUrl(
      "https://example.com/search?$1",
      "(.*)",
      "raw"
    )!;
    const s = settings({
      custom: { raw: advanced },
    });
    expect(redirectUrl("!raw q=hello&lang=en", s)).toBe(
      "https://example.com/search?q=hello&lang=en"
    );
  });

  test("capture bangs work as snaps", () => {
    expect(redirectUrl("@ktr translation", settings())).toBe(
      "https://www.google.com/search?q=translation+site:translate.kagi.com"
    );
  });

  test("invalid percent encoding does not execute a capture regex", () => {
    expect(
      redirectRaw("!ktr+japanese+%E0%A4%A", settings()).headers.get("Location")
    ).toBe("https://www.google.com/search?q=!ktr+japanese+%E0%A4%A");
  });
});

describe("encode — URL encoding", () => {
  test("query-param: %2F passed through", () => {
    const r = redirect("!g a/b/c", settings());
    expect(loc(r)).toBe("https://www.google.com/search?q=a%2Fb%2Fc");
  });

  test("query-param: + passed through", () => {
    const r = redirect("!g hello world", settings());
    expect(loc(r)).toBe("https://www.google.com/search?q=hello+world");
  });

  test("special chars (& = ?) encoded", () => {
    const r = redirect("!g a&b=c?d", settings());
    expect(loc(r)).toBe("https://www.google.com/search?q=a%26b%3Dc%3Fd");
  });
});

describe("redirectRaw — bang syntax patterns (+ as space)", () => {
  test('"!g+cats" → prefix bang with term', () => {
    const r = redirectRaw("!g+cats", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?q=cats");
  });

  test('"!G+CATS" → case-insensitive bang', () => {
    const r = redirectRaw("!G+CATS", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?q=CATS");
  });

  test('"!g" → prefix bang, no term → google.com origin', () => {
    const r = redirectRaw("!g", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com");
  });

  test('"g!+cats" → prefix suffix-bang', () => {
    const r = redirectRaw("g!+cats", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?q=cats");
  });

  test('"g!" → suffix-bang alone → google.com origin', () => {
    const r = redirectRaw("g!", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com");
  });

  test('"cats+!g" → trailing prefix-bang', () => {
    const r = redirectRaw("cats+!g", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?q=cats");
  });

  test('"cats+g!" → trailing suffix-bang', () => {
    const r = redirectRaw("cats+g!", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?q=cats");
  });

  test('"\\cats" → backslash lucky', () => {
    const r = redirectRaw("\\cats", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?btnI&q=cats");
  });

  test('"!+cats" → leading bare bang lucky', () => {
    const r = redirectRaw("!+cats", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?btnI&q=cats");
  });

  test('"cats+!" → trailing bare bang lucky', () => {
    const r = redirectRaw("cats+!", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?btnI&q=cats");
  });

  test('"cats" → no bang → default URL', () => {
    const r = redirectRaw("cats", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?q=cats");
  });
});

describe("redirectRaw — bang syntax patterns (%20 as space)", () => {
  test('"!g%20cats" → prefix bang with term', () => {
    const r = redirectRaw("!g%20cats", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?q=cats");
  });

  test('"g!%20cats" → prefix suffix-bang', () => {
    const r = redirectRaw("g!%20cats", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?q=cats");
  });

  test('"cats%20!g" → trailing prefix-bang', () => {
    const r = redirectRaw("cats%20!g", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?q=cats");
  });

  test('"cats%20g!" → trailing suffix-bang', () => {
    const r = redirectRaw("cats%20g!", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?q=cats");
  });

  test('"!%20cats" → leading bare bang lucky', () => {
    const r = redirectRaw("!%20cats", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?btnI&q=cats");
  });

  test('"cats%20!" → trailing bare bang lucky', () => {
    const r = redirectRaw("cats%20!", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?btnI&q=cats");
  });
});

describe("redirectRaw — routing logic", () => {
  test('"!" alone → redirect to "/"', () => {
    const r = redirectRaw("!", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("/");
  });

  test("empty string → redirect to /", () => {
    const r = redirectRaw("", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("/");
  });

  test("only spaces → redirect to /", () => {
    const r = redirectRaw("+++", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("/");
  });

  test("lucky + luckyUrl + term → lucky redirect", () => {
    const r = redirectRaw("\\hello+world", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?btnI&q=hello+world");
  });

  test("lucky without luckyUrl → falls through to default", () => {
    const r = redirectRaw("\\cats", settings({ luckyUrl: null }));
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?q=cats");
  });

  test("custom bang overrides built-in", () => {
    const r = redirectRaw(
      "!g+cats",
      settings({ custom: { g: splitUrl("https://custom.search/?q={}") } })
    );
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://custom.search/?q=cats");
  });

  test('"!zzz+cats" → unknown bang → default URL with full query', () => {
    const r = redirectRaw("!zzz+cats", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?q=!zzz+cats");
  });

  test("empty term → origin extraction via new URL().origin", () => {
    const r = redirectRaw("!gh", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://github.com");
  });

  test("empty term with unparseable URL → fallback to replace", () => {
    const r = redirectRaw(
      "!g",
      settings({ custom: { g: splitUrl("not-a-url/{}") } })
    );
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("not-a-url/");
  });
});

describe("redirectRaw — query-param-safe encoding", () => {
  test("query-param: + passed through", () => {
    const r = redirectRaw("!g+hello+world", settings());
    expect(loc(r)).toBe("https://www.google.com/search?q=hello+world");
  });

  test("query-param: %2F passed through", () => {
    const r = redirectRaw("!g+a%2Fb%2Fc", settings());
    expect(loc(r)).toBe("https://www.google.com/search?q=a%2Fb%2Fc");
  });

  test("query-param: %2f (lowercase) passed through", () => {
    const r = redirectRaw("!g+a%2fb", settings());
    expect(loc(r)).toBe("https://www.google.com/search?q=a%2fb");
  });

  test("special chars stay percent-encoded", () => {
    const r = redirectRaw("!g+a%26b%3Dc%3Fd", settings());
    expect(loc(r)).toBe("https://www.google.com/search?q=a%26b%3Dc%3Fd");
  });

  test("multi-byte encoded chars pass through", () => {
    const r = redirectRaw("!g+%E4%B8%AD%E6%96%87", settings());
    expect(loc(r)).toBe("https://www.google.com/search?q=%E4%B8%AD%E6%96%87");
  });
});

describe("redirectRaw — path-based template fixup", () => {
  const pathBang = { pathb: ["https://example.com/user/", ""] as UrlParts };
  const fragBang = { fragb: ["https://example.com/#q=", ""] as UrlParts };

  test("+ converted to %20 for path-based template", () => {
    const r = redirectRaw("!pathb+hello+world", settings({ custom: pathBang }));
    expect(loc(r)).toBe("https://example.com/user/hello%20world");
  });

  test("%2F converted to / for path-based template", () => {
    const r = redirectRaw("!pathb+a%2Fb%2Fc", settings({ custom: pathBang }));
    expect(loc(r)).toBe("https://example.com/user/a/b/c");
  });

  test("%2f (lowercase) converted to / for path-based template", () => {
    const r = redirectRaw("!pathb+a%2fb", settings({ custom: pathBang }));
    expect(loc(r)).toBe("https://example.com/user/a/b");
  });

  test("no fixup needed for path-based template without + or %2F", () => {
    const r = redirectRaw("!pathb+username", settings({ custom: pathBang }));
    expect(loc(r)).toBe("https://example.com/user/username");
  });

  test("mixed + and %2F fixup for path-based template", () => {
    const r = redirectRaw(
      "!pathb+hello+a%2Fb+world",
      settings({ custom: pathBang })
    );
    expect(loc(r)).toBe("https://example.com/user/hello%20a/b%20world");
  });

  test("fragment-based template gets fixup", () => {
    const r = redirectRaw("!fragb+hello+world", settings({ custom: fragBang }));
    expect(loc(r)).toBe("https://example.com/#q=hello%20world");
  });
});

describe("redirectRaw — leading/trailing space trimming", () => {
  test("leading + trimmed", () => {
    const r = redirectRaw("+!g+cats", settings());
    expect(loc(r)).toBe("https://www.google.com/search?q=cats");
  });

  test("trailing + trimmed", () => {
    const r = redirectRaw("!g+cats+", settings());
    expect(loc(r)).toBe("https://www.google.com/search?q=cats");
  });

  test("leading %20 trimmed", () => {
    const r = redirectRaw("%20!g+cats", settings());
    expect(loc(r)).toBe("https://www.google.com/search?q=cats");
  });

  test("trailing %20 trimmed", () => {
    const r = redirectRaw("!g+cats%20", settings());
    expect(loc(r)).toBe("https://www.google.com/search?q=cats");
  });
});

describe("redirectRaw — %21 encoded bang", () => {
  test('"%21gh" → prefix bang → github.com', () => {
    const r = redirectRaw("%21gh", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://github.com");
  });

  test('"%21g+cats" → prefix bang with term', () => {
    const r = redirectRaw("%21g+cats", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?q=cats");
  });

  test('"g%21+cats" → prefix suffix-bang', () => {
    const r = redirectRaw("g%21+cats", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?q=cats");
  });

  test('"cats+%21g" → trailing prefix-bang', () => {
    const r = redirectRaw("cats+%21g", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?q=cats");
  });

  test('"cats+g%21" → trailing suffix-bang', () => {
    const r = redirectRaw("cats+g%21", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?q=cats");
  });

  test('"%21+cats" → leading bare bang lucky', () => {
    const r = redirectRaw("%21+cats", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?btnI&q=cats");
  });

  test('"cats+%21" → trailing bare bang lucky', () => {
    const r = redirectRaw("cats+%21", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?btnI&q=cats");
  });

  test('"%21" alone → redirect to "/"', () => {
    const r = redirectRaw("%21", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("/");
  });
});

describe("redirectRaw ↔ redirect cross-validation", () => {
  const queries: [string, string][] = [
    ["!g cats", "!g+cats"],
    ["!G CATS", "!G+CATS"],
    ["!g", "!g"],
    ["g! cats", "g!+cats"],
    ["g!", "g!"],
    ["cats !g", "cats+!g"],
    ["cats g!", "cats+g!"],
    ["\\cats", "\\cats"],
    ["! cats", "!+cats"],
    ["cats !", "cats+!"],
    ["cats", "cats"],
    ["!g hello world", "!g+hello+world"],
    ["!g a/b/c", "!g+a%2Fb%2Fc"],
    ["!", "!"],
    ["!gh", "!gh"],
    ["!gh", "%21gh"],
    ["!zzz cats", "!zzz+cats"],
  ];

  for (const [decoded, raw] of queries) {
    test(`"${decoded}" ↔ "${raw}" produce identical Location`, () => {
      const s = settings();
      expect(loc(redirectRaw(raw, s))).toBe(loc(redirect(decoded, s)));
    });
  }
});

describe("redirectUrl ↔ redirect parity", () => {
  const queries = [
    "!g cats",
    "!G CATS",
    "!g",
    "g! cats",
    "g!",
    "cats !g",
    "cats g!",
    "\\cats",
    "! cats",
    "cats !",
    "cats",
    "!g hello world",
    "!g a/b/c",
    "!",
    "!gh",
    "!zzz cats",
  ];

  for (const query of queries) {
    test(`"${query}" returns same Location as redirect()`, () => {
      const s = settings();
      expect(redirectUrl(query, s)).toBe(loc(redirect(query, s)));
    });
  }
});

// --- Snap (@) tests ---

describe("snap — prefix @trigger patterns", () => {
  test('"@w quantum" → default search with site:en.wikipedia.org', () => {
    const r = redirect("@w quantum", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe(
      "https://www.google.com/search?q=quantum+site:en.wikipedia.org"
    );
  });

  test('"@gh api" → default search with site:github.com', () => {
    const r = redirect("@gh api", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?q=api+site:github.com");
  });

  test('"@G CATS" → case-insensitive, site:google.com (www stripped)', () => {
    const r = redirect("@G CATS", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?q=CATS+site:google.com");
  });

  test('"@yt music video" → site:youtube.com (www stripped)', () => {
    const r = redirect("@yt music video", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe(
      "https://www.google.com/search?q=music+video+site:youtube.com"
    );
  });

  test('"@mdn array methods" → site:developer.mozilla.org, uses default URL not bang URL', () => {
    const r = redirect("@mdn array methods", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe(
      "https://www.google.com/search?q=array+methods+site:developer.mozilla.org"
    );
  });

  test('"@w" → bare snap, no query → origin redirect', () => {
    const r = redirect("@w", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://en.wikipedia.org");
  });

  test('"@g" → bare snap → google.com origin (www stripped from domain, but origin preserved)', () => {
    const r = redirect("@g", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com");
  });

  test('"@zzz cats" → unknown trigger → default search', () => {
    const r = redirect("@zzz cats", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?q=@zzz+cats");
  });

  test('"@ cats" → bare @ with space → default search', () => {
    const r = redirect("@ cats", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?q=@+cats");
  });

  test('"@" → bare @ → home', () => {
    const r = redirectRaw("@", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("/");
  });
});

describe("snap — suffix query @trigger patterns", () => {
  test('"headphones @w" → site:en.wikipedia.org', () => {
    const r = redirect("headphones @w", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe(
      "https://www.google.com/search?q=headphones+site:en.wikipedia.org"
    );
  });

  test('"python async @gh" → site:github.com', () => {
    const r = redirect("python async @gh", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe(
      "https://www.google.com/search?q=python+async+site:github.com"
    );
  });

  test('"headphones @zzz" → unknown trigger → default search', () => {
    const r = redirect("headphones @zzz", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?q=headphones+@zzz");
  });
});

describe("snap chains", () => {
  test("prefix chains preserve target order", () => {
    expect(redirectUrl("@gh,so,mdn,w service workers", settings())).toBe(
      "https://www.google.com/search?q=service+workers+(site:github.com+OR+site:stackoverflow.com+OR+site:developer.mozilla.org+OR+site:en.wikipedia.org)"
    );
  });

  test("suffix chains use the snap prefix once", () => {
    expect(redirectUrl("service workers @gh,so,mdn,w", settings())).toBe(
      "https://www.google.com/search?q=service+workers+(site:github.com+OR+site:stackoverflow.com+OR+site:developer.mozilla.org+OR+site:en.wikipedia.org)"
    );
  });

  test("raw chains accept literal and percent-encoded commas", () => {
    const expected =
      "https://www.google.com/search?q=workers+(site:github.com+OR+site:stackoverflow.com)";
    expect(loc(redirectRaw("@gh,so+workers", settings()))).toBe(expected);
    expect(loc(redirectRaw("%40gh%2Cso+workers", settings()))).toBe(expected);
    expect(loc(redirectRaw("workers+%40gh%2cso", settings()))).toBe(expected);
  });

  test("chains support custom bangs and custom snap paths", () => {
    const docsSnap = compileSnapTarget("docs.example.com/reference")!;
    const custom: Record<string, CustomUrlParts> = {
      docs: ["https://search.example.com?q=", "", docsSnap],
      docsalias: ["https://other.example.com?q=", "", docsSnap],
    };
    expect(redirectUrl("@docs,docsalias,gh arrays", settings({ custom }))).toBe(
      "https://www.google.com/search?q=arrays+(site:docs.example.com/reference+OR+site:github.com)"
    );
  });

  test("duplicate normalized targets are removed in first-seen order", () => {
    const custom: Record<string, CustomUrlParts> = {
      github: splitUrl("https://github.com/search?q={}"),
    };
    expect(redirectUrl("@gh,github,so,gh query", settings({ custom }))).toBe(
      "https://www.google.com/search?q=query+(site:github.com+OR+site:stackoverflow.com)"
    );
  });

  test("a chain containing only one unique target uses one site filter", () => {
    expect(redirectUrl("@gh,gh query", settings())).toBe(
      "https://www.google.com/search?q=query+site:github.com"
    );
  });

  test("eight targets are accepted", () => {
    expect(redirectUrl("@b,ddg,g,gh,mdn,so,w,yt query", settings())).toBe(
      "https://www.google.com/search?q=query+(site:bing.com+OR+site:duckduckgo.com+OR+site:google.com+OR+site:github.com+OR+site:developer.mozilla.org+OR+site:stackoverflow.com+OR+site:en.wikipedia.org+OR+site:youtube.com)"
    );
  });

  test("more than eight targets fall back with the original query", () => {
    expect(redirectUrl("@b,ddg,g,gh,mdn,so,w,yt,gh query", settings())).toBe(
      "https://www.google.com/search?q=%40b%2Cddg%2Cg%2Cgh%2Cmdn%2Cso%2Cw%2Cyt%2Cgh+query"
    );
  });

  test("every trigger must be valid and segments cannot be empty", () => {
    expect(redirectUrl("@gh,missing query", settings())).toBe(
      "https://www.google.com/search?q=%40gh%2Cmissing+query"
    );
    expect(redirectUrl("@gh,,so query", settings())).toBe(
      "https://www.google.com/search?q=%40gh%2C%2Cso+query"
    );
  });

  test("a bare chain searches its site expression", () => {
    expect(redirectUrl("@gh,so", settings())).toBe(
      "https://www.google.com/search?q=(site:github.com+OR+site:stackoverflow.com)"
    );
  });

  test("configured snap prefixes work for chains", () => {
    const customSyntax = settings({
      syntax: compileTriggerSyntax("$", "~"),
    });
    expect(redirectUrl("~gh,so query", customSyntax)).toBe(
      "https://www.google.com/search?q=query+(site:github.com+OR+site:stackoverflow.com)"
    );
    expect(redirectUrl("@gh,so query", customSyntax)).toBe(
      "https://www.google.com/search?q=%40gh%2Cso+query"
    );
  });

  test("chains report the first trigger for frecency", () => {
    expect(redirectRawTrigger("@gh,so+query", settings())).toBe("gh");
  });
});

describe("snap — raw URL-encoded patterns", () => {
  test('"%40w+quantum" → same as @w quantum', () => {
    const r = redirectRaw("%40w+quantum", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe(
      "https://www.google.com/search?q=quantum+site:en.wikipedia.org"
    );
  });

  test('"@w+quantum" → literal @, same result', () => {
    const r = redirectRaw("@w+quantum", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe(
      "https://www.google.com/search?q=quantum+site:en.wikipedia.org"
    );
  });

  test('"headphones+%40w" → suffix snap with encoded @', () => {
    const r = redirectRaw("headphones+%40w", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe(
      "https://www.google.com/search?q=headphones+site:en.wikipedia.org"
    );
  });

  test('"headphones+@w" → suffix snap with literal @', () => {
    const r = redirectRaw("headphones+@w", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe(
      "https://www.google.com/search?q=headphones+site:en.wikipedia.org"
    );
  });

  test('"%40" → bare encoded @ → home', () => {
    const r = redirectRaw("%40", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("/");
  });

  test('"%40w" → bare encoded snap → origin', () => {
    const r = redirectRaw("%40w", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://en.wikipedia.org");
  });
});

describe("snap — bang takes precedence over snap", () => {
  test('"!g @w cats" → bang wins, searches google for @w cats', () => {
    const r = redirect("!g @w cats", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?q=@w+cats");
  });

  test('"!g cats" still works as bang', () => {
    const r = redirect("!g cats", settings());
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?q=cats");
  });
});

describe("snap — custom bangs work as snaps", () => {
  test('"@mysite test" → site:mysite.com with custom bang', () => {
    const custom: Record<string, readonly [string, string | null]> =
      Object.create(null);
    custom.mysite = splitUrl("https://mysite.com/s?q={}");
    const r = redirect("@mysite test", settings({ custom }));
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://www.google.com/search?q=test+site:mysite.com");
  });

  test('"@mysite" → bare snap with custom bang → origin', () => {
    const custom: Record<string, readonly [string, string | null]> =
      Object.create(null);
    custom.mysite = splitUrl("https://mysite.com/s?q={}");
    const r = redirect("@mysite", settings({ custom }));
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("https://mysite.com");
  });

  test("custom snap extracts a host before query parameters", () => {
    const custom: Record<string, UrlParts> = Object.create(null);
    custom.mysite = splitUrl("https://mysite.com?q={}");
    expect(loc(redirect("@mysite test", settings({ custom })))).toBe(
      "https://www.google.com/search?q=test+site:mysite.com"
    );
  });

  test("custom snap target overrides the URL-derived domain and path", () => {
    const snap = compileSnapTarget("docs.example.com/reference")!;
    const custom: Record<string, CustomUrlParts> = {
      docs: ["https://search.example.com?q=", "", snap],
    };
    const s = settings({ custom });
    expect(loc(redirect("@docs arrays", s))).toBe(
      "https://www.google.com/search?q=arrays+site:docs.example.com/reference"
    );
    expect(loc(redirect("@docs", s))).toBe(
      "https://docs.example.com/reference"
    );
    expect(loc(redirect("!docs arrays", s))).toBe(
      "https://search.example.com?q=arrays"
    );
    expect(loc(redirect("!docs", s))).toBe("https://search.example.com");
  });

  test("custom capture and snap metadata share one compiled tuple", () => {
    const capture = compileCaptureUrl(
      "https://translate.example/$1/$2",
      "(\\w+)\\s+(.*)",
      "percent"
    )!;
    const snap = compileSnapTarget("translate.example/docs")!;
    const entry = [...capture, snap] as CustomUrlParts;
    const s = settings({ custom: { multi: entry } });
    expect(loc(redirect("!multi ja hello", s))).toBe(
      "https://translate.example/ja/hello"
    );
    expect(loc(redirect("@multi hello", s))).toBe(
      "https://www.google.com/search?q=hello+site:translate.example/docs"
    );
  });
});

describe("snap — Kagi alternate domains", () => {
  test("uses ad for snap searches without changing normal bangs", () => {
    expect(loc(redirect("@hn story", settings()))).toBe(
      "https://www.google.com/search?q=story+site:news.ycombinator.com"
    );
    expect(loc(redirect("@hn", settings()))).toBe(
      "https://news.ycombinator.com"
    );
    expect(loc(redirect("!hn", settings()))).toBe("https://hn.algolia.com");
    expect(loc(redirect("@hn", settings()))).toBe(
      "https://news.ycombinator.com"
    );
  });

  test("preserves path-scoped ad values", () => {
    expect(loc(redirect("@nr nix flake", settings()))).toBe(
      "https://www.google.com/search?q=nix+flake+site:github.com/NixOS/nixpkgs"
    );
  });
});

describe("snap — frecency tracking", () => {
  test('"@w quantum" returns trigger for frecency', () => {
    const trigger = redirectRawTrigger("@w+quantum", settings());
    expect(trigger).toBe("w");
  });

  test('"headphones+@gh" returns trigger for frecency', () => {
    const trigger = redirectRawTrigger("headphones+@gh", settings());
    expect(trigger).toBe("gh");
  });

  test('"@w" bare snap returns trigger for frecency', () => {
    const trigger = redirectRawTrigger("@w", settings());
    expect(trigger).toBe("w");
  });

  test('"@zzz+cats" unknown snap returns null trigger', () => {
    const trigger = redirectRawTrigger("@zzz+cats", settings());
    expect(trigger).toBeNull();
  });
});

describe("snap — default URL with suffix", () => {
  test("snap uses default URL suffix when present", () => {
    const s = settings({
      defaultUrl: ["https://search.example.com/q?s=", "&lang=en"],
    });
    const r = redirect("@w quantum", s);
    expect(r.status).toBe(302);
    expect(loc(r)).toBe(
      "https://search.example.com/q?s=quantum+site:en.wikipedia.org&lang=en"
    );
  });
});

describe("snap — redirectUrl consistency", () => {
  const queries = ["@w quantum", "@gh api", "@w", "@zzz cats", "cats @w"];

  for (const query of queries) {
    test(`"${query}" returns same Location as redirect()`, () => {
      const s = settings();
      expect(redirectUrl(query, s)).toBe(loc(redirect(query, s)));
    });
  }
});
