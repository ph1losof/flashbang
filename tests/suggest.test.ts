import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { TOP_K } from "../src/shared/constants";
import {
  readQueryParam,
  readSuggestQueryParams,
  readTwoQueryParams,
} from "../src/shared/raw-query";
import {
  encodeSuggestCookieValue,
  parseSuggestCookieContextValueWithValidation,
  parseSuggestCookieValueWithValidation,
} from "../src/shared/suggest-cookie";
import { type BuildNode, buildRadixTrie } from "../src/shared/trie";

interface TestBang {
  k: string;
  s: string;
  d: string;
  r: number;
}

interface FlatTrieFixture {
  EDGES: Int32Array;
  LABELS: string;
  NODES: Int32Array;
  ROOT: number;
  TERM_D_BLOB: string;
  TERM_D_ID: Uint8Array;
  TERM_D_OFF: Int32Array;
  TERM_K_BLOB: string;
  TERM_K_OFF: Int32Array;
  TERM_R: Int32Array;
  TERM_S_BLOB: string;
  TERM_S_ID: Uint8Array;
  TERM_S_OFF: Int32Array;
}

const NODE_EDGE_START = 0;
const NODE_EDGE_COUNT = 1;
const NODE_TERMINAL_INDEX = 2;
const NODE_MAX_RELEVANCE = 3;
const NODE_STRIDE = 4;

const EDGE_CHILD_INDEX = 2;
const EDGE_STRIDE = 3;

function buildTestTrie(bangs: TestBang[]): FlatTrieFixture {
  const root = buildRadixTrie(
    bangs,
    (b) => b.k,
    (b) => b.r
  );

  const nodes: number[] = [];
  const edges: number[] = [];
  let labels = "";
  const termK: string[] = [];
  const termS: string[] = [];
  const termD: string[] = [];
  const termR: number[] = [];

  function allocNode(): number {
    const idx = nodes.length / NODE_STRIDE;
    nodes.push(0, 0, -1, 0);
    return idx;
  }

  function visit(node: BuildNode<TestBang>): number {
    const idx = allocNode();
    const sorted = [...node.children.entries()].sort(
      (a, b) => b[1].maxRelevance - a[1].maxRelevance
    );
    const edgeStart = edges.length / EDGE_STRIDE;

    for (const [label] of sorted) {
      const labelStart = labels.length;
      labels += label;
      edges.push(labelStart, label.length, -1);
    }

    for (let i = 0; i < sorted.length; i++) {
      const [, child] = sorted[i];
      const childIdx = visit(child);
      edges[(edgeStart + i) * EDGE_STRIDE + EDGE_CHILD_INDEX] = childIdx;
    }

    let terminalIndex = -1;
    if (node.terminal) {
      const t = node.terminal;
      terminalIndex = termR.length;
      termK.push(t.k);
      termS.push(t.s);
      termD.push(t.d);
      termR.push(t.r);
    }

    const off = idx * NODE_STRIDE;
    nodes[off + NODE_EDGE_START] = edgeStart;
    nodes[off + NODE_EDGE_COUNT] = sorted.length;
    nodes[off + NODE_TERMINAL_INDEX] = terminalIndex;
    nodes[off + NODE_MAX_RELEVANCE] = node.maxRelevance;
    return idx;
  }

  const rootIdx = visit(root);
  if (rootIdx !== 0) {
    throw new Error(`Unexpected test trie root index ${rootIdx}`);
  }

  function packStrings(items: string[]): {
    blob: string;
    offsets: Int32Array;
  } {
    const offsets = new Int32Array(items.length + 1);
    let cursor = 0;
    for (let i = 0; i < items.length; i++) {
      cursor += items[i].length;
      offsets[i + 1] = cursor;
    }
    return { blob: items.join(""), offsets };
  }

  const packedK = packStrings(termK);
  const packedS = packStrings(termS);
  const packedD = packStrings(termD);

  return {
    LABELS: labels,
    NODES: Int32Array.from(nodes),
    EDGES: Int32Array.from(edges),
    TERM_K_BLOB: packedK.blob,
    TERM_K_OFF: packedK.offsets,
    TERM_S_BLOB: packedS.blob,
    TERM_S_ID: Uint8Array.from(termS, (_, index) => index),
    TERM_S_OFF: packedS.offsets,
    TERM_D_BLOB: packedD.blob,
    TERM_D_ID: Uint8Array.from(termD, (_, index) => index),
    TERM_D_OFF: packedD.offsets,
    TERM_R: Int32Array.from(termR),
    ROOT: rootIdx,
  };
}

const TEST_BANGS: TestBang[] = [
  { k: "b", s: "Bing", d: "www.bing.com", r: 300 },
  { k: "brave", s: "Brave", d: "search.brave.com", r: 200 },
  { k: "ddg", s: "DuckDuckGo", d: "duckduckgo.com", r: 800 },
  { k: "g", s: "Google", d: "www.google.com", r: 1000 },
  { k: "gh", s: "GitHub", d: "github.com", r: 500 },
  { k: "ghi", s: "GitHub Issues", d: "github.com", r: 100 },
  { k: "ghp", s: "GitHub PRs", d: "github.com", r: 50 },
  { k: "mdn", s: "MDN", d: "developer.mozilla.org", r: 400 },
  { k: "w", s: "Wikipedia", d: "en.wikipedia.org", r: 900 },
  { k: "yt", s: "YouTube", d: "www.youtube.com", r: 700 },
];

const TEST_TRIE = buildTestTrie(TEST_BANGS);

function terminalIndexFor(trigger: string): number {
  for (let i = 0; i < TEST_TRIE.TERM_K_OFF.length - 1; i++) {
    const value = TEST_TRIE.TERM_K_BLOB.slice(
      TEST_TRIE.TERM_K_OFF[i],
      TEST_TRIE.TERM_K_OFF[i + 1]
    );
    if (value === trigger) {
      return i;
    }
  }
  throw new Error(`Missing terminal index for !${trigger}`);
}

mock.module("./generated/bangs-trie.js", () => TEST_TRIE);
mock.module("../src/generated/bangs-trie.js", () => TEST_TRIE);

const {
  parseBangSettingsFromRequestWithCleanup,
  parseCookie,
  parsePartialBang,
  parseSettings,
  parseSettingsFromRawUrl,
  parseSettingsFromRawUrlWithCleanup,
  suggest,
} = await import("../src/suggest");
const { profileTopKCount, profileWalkPrefix, responseFromCandidates } =
  await import("../src/suggest-bang");

const fetchSpy = spyOn(globalThis, "fetch");

beforeEach(() => {
  fetchSpy.mockReset();
});

afterAll(() => {
  fetchSpy.mockRestore();
});

function req(cookie?: string): Request {
  const headers = new Headers();
  if (cookie) {
    headers.set("Cookie", cookie);
  }
  return new Request("http://localhost", { headers });
}

const defaultSettings = {
  bangPrefix: "!" as const,
  provider: "default",
  snapPrefix: "@" as const,
  trigger: "g",
  customUrl: null,
  frecent: {},
  custom: [],
};

describe("suggest cookie codec", () => {
  test("round-trips custom syntax and sorted context", () => {
    const encoded = encodeSuggestCookieValue(
      "custom",
      "gh",
      "https://example.com/?q={}",
      ["z", "a"],
      { gh: 3, g: 1 },
      "$",
      "~"
    );
    const parsed = parseSuggestCookieValueWithValidation(encoded, true, true);

    expect(parsed.hasInvalidContext).toBe(false);
    expect(parsed.settings).toEqual({
      bangPrefix: "$",
      provider: "custom",
      snapPrefix: "~",
      trigger: "gh",
      customUrl: "https://example.com/?q={}",
      frecent: { g: 1, gh: 3 },
      custom: ["a", "z"],
    });
  });

  test("distinguishes tolerant parsing from cleanup validation", () => {
    const malformed = "google,g,%E0%A4%A|c:%5B%22ok%22%2C1%5D|unknown:x";
    const tolerant = parseSuggestCookieValueWithValidation(
      malformed,
      true,
      false
    );
    expect(tolerant.hasInvalidContext).toBe(false);
    expect(tolerant.settings.customUrl).toBeNull();
    expect(tolerant.settings.custom).toEqual(["ok"]);

    const strict = parseSuggestCookieValueWithValidation(malformed, true, true);
    expect(strict.hasInvalidContext).toBe(true);
    expect(strict.settings.custom).toEqual(["ok"]);
  });

  test("accepts raw custom URLs and tolerates malformed custom JSON", () => {
    expect(
      parseSuggestCookieValueWithValidation(
        "custom,g,https://example.test/search|c:not-json",
        true,
        false
      ).settings
    ).toMatchObject({
      customUrl: "https://example.test/search",
      custom: [],
    });
  });

  test("flags malformed cleanup context sections", () => {
    expect(
      parseSuggestCookieContextValueWithValidation("default,g,|f:", true)
        .hasInvalidContext
    ).toBe(true);
    expect(
      parseSuggestCookieContextValueWithValidation("default,g,|c:%", true)
        .hasInvalidContext
    ).toBe(true);
    expect(
      parseSuggestCookieContextValueWithValidation("default,g,|c:%7B%7D", true)
        .hasInvalidContext
    ).toBe(true);
    expect(
      parseSuggestCookieContextValueWithValidation("default,g,|other:x", true)
        .hasInvalidContext
    ).toBe(true);
  });

  test("hydrates bang context separately and rewrites invalid context", () => {
    const untouched = { ...defaultSettings, custom: [], frecent: {} };
    expect(parseBangSettingsFromRequestWithCleanup(req(), untouched)).toEqual({
      settings: untouched,
      rewrittenSuggestCookie: null,
    });

    const valid = { ...defaultSettings, custom: [], frecent: {} };
    expect(
      parseBangSettingsFromRequestWithCleanup(
        req(
          `suggest=${encodeSuggestCookieValue("default", "g", "", ["z"], {
            gh: 2,
          })}`
        ),
        valid
      )
    ).toEqual({
      settings: { ...valid, custom: ["z"], frecent: { gh: 2 } },
      rewrittenSuggestCookie: null,
    });

    const invalid = { ...defaultSettings, custom: ["old"], frecent: { g: 1 } };
    const cleaned = parseBangSettingsFromRequestWithCleanup(
      req("suggest=custom,gh,https%3A%2F%2Fexample.com|unknown:value"),
      invalid
    );
    expect(cleaned.settings.custom).toEqual([]);
    expect(cleaned.settings.frecent).toEqual({});
    expect(cleaned.rewrittenSuggestCookie).toBe(
      "custom,gh,https%3A%2F%2Fexample.com"
    );
  });

  test("ignores embedded cookie-name matches before a real cookie", () => {
    expect(
      parseCookie(
        req("xsuggest=none,bad,;\t suggest=google,g,https%3A%2F%2Fexample.com")
      )
    ).toMatchObject({
      provider: "google",
      trigger: "g",
      customUrl: "https://example.com",
    });
  });
});

describe("buildRadixTrie", () => {
  test("splits partially matching edges and propagates maximum relevance", () => {
    const items = [
      { key: "foobar", relevance: 2 },
      { key: "fizz", relevance: 7 },
      { key: "foo", relevance: 5 },
      { key: "foobar", relevance: 9 },
    ];
    const root = buildRadixTrie(
      items,
      (item) => item.key,
      (item) => item.relevance
    );

    const f = root.children.get("f");
    expect(f?.maxRelevance).toBe(9);
    expect(f?.children.has("izz")).toBe(true);
    const foo = f?.children.get("oo");
    expect(foo?.terminal?.key).toBe("foo");
    expect(foo?.children.get("bar")?.terminal?.relevance).toBe(9);
    expect(root.maxRelevance).toBe(9);
  });
});

describe("suggest parser edge cases", () => {
  test("trims supported surrounding whitespace and rejects empty input", () => {
    expect(parsePartialBang("\t\n !GH \r\f")).toMatchObject({
      partial: "gh",
      prefix: "",
    });
    expect(parsePartialBang("\t\n\v\f\r ")).toBeNull();
  });

  test("rejects spaces inside prefix and suffix trigger fragments", () => {
    expect(parsePartialBang("!gh extra")).toBeNull();
    expect(parsePartialBang("@gh,so extra")).toBeNull();
    expect(parsePartialBang("query @gh,so extra")).toBeNull();
    expect(parsePartialBang("query !gh extra")).toBeNull();
  });

  test("applies cleanup provider overrides without invalid context", () => {
    const result = parseSettingsFromRawUrlWithCleanup(
      "https://example.test/?sp=bing",
      req("suggest=google,g,"),
      undefined
    );
    expect(result.settings.provider).toBe("bing");
    expect(result.rewrittenSuggestCookie).toBeNull();
  });

  test("uses custom provider URLs without placeholders verbatim", async () => {
    fetchSpy.mockResolvedValueOnce(new Response('["query",[]]'));
    await suggest(
      "query",
      {
        ...defaultSettings,
        provider: "custom",
        customUrl: "https://example.test/suggest",
      },
      null,
      true
    );
    expect(fetchSpy).toHaveBeenCalledWith("https://example.test/suggest");
  });

  test("rejects a non-array descriptions slot in suggestion payloads", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('["query",[],[],"not-an-array"]')
    );
    expect(
      await (
        await suggest("query", { ...defaultSettings, provider: "google" }, null)
      ).json()
    ).toEqual(["query", []]);
  });
});

describe("suggest trie edge cases", () => {
  test("profiles prefix walks and rejects a partial compressed-edge mismatch", () => {
    expect(profileWalkPrefix("brx")).toBeNull();
    const root = profileWalkPrefix("");
    expect(root).not.toBeNull();
    expect(profileTopKCount(root![0], {}, false)).toBe(TOP_K);
  });

  test("keeps the top custom candidates when more than TOP_K match", async () => {
    const custom = Array.from({ length: TOP_K + 3 }, (_, index) => `x${index}`);
    const frecent = Object.fromEntries(
      custom.map((trigger, index) => [
        trigger,
        index < TOP_K ? index + 1 : 1_000_000_000 + index,
      ])
    );
    const payload = await (
      await suggest("!", { ...defaultSettings, custom, frecent })
    ).json();
    const completions = payload[1] as string[];
    expect(completions).toHaveLength(TOP_K);
    expect(completions).toContain(`!x${TOP_K + 2}`);
  });

  test("stops scanning sorted custom triggers beyond the prefix range", async () => {
    const payload = await (
      await suggest("!m", {
        ...defaultSettings,
        custom: ["a", "n", "z"],
      })
    ).json();
    expect(payload[1]).toContain("!mdn");
  });
});

describe("parseCookie", () => {
  test("no cookie → defaults", () => {
    const s = parseCookie(req());
    expect(s).toEqual({
      bangPrefix: "!",
      provider: "default",
      snapPrefix: "@",
      trigger: "g",
      customUrl: null,
      frecent: {},
      custom: [],
    });
  });

  test("all three fields parsed", () => {
    const s = parseCookie(req("suggest=google,ddg,https%3A%2F%2Fexample.com"));
    expect(s).toEqual({
      bangPrefix: "!",
      provider: "google",
      snapPrefix: "@",
      trigger: "ddg",
      customUrl: "https://example.com",
      frecent: {},
      custom: [],
    });
  });

  test("only provider and trigger, no customUrl", () => {
    const s = parseCookie(req("suggest=brave,g"));
    expect(s).toEqual({
      bangPrefix: "!",
      provider: "brave",
      snapPrefix: "@",
      trigger: "g",
      customUrl: null,
      frecent: {},
      custom: [],
    });
  });

  test("URL-encoded customUrl decoded correctly", () => {
    const s = parseCookie(
      req(
        "suggest=custom,g,https%3A%2F%2Fapi.example.com%2Fsuggest%3Fq%3D%7B%7D"
      )
    );
    expect(s.customUrl).toBe("https://api.example.com/suggest?q={}");
  });

  test("malformed customUrl encoding does not throw", () => {
    const s = parseCookie(req("suggest=custom,g,%E0%A4%A"));
    expect(s.customUrl).toBeNull();
    expect(s.provider).toBe("custom");
    expect(s.trigger).toBe("g");
  });

  test("suggest cookie extracted among other cookies", () => {
    const s = parseCookie(req("theme=dark; suggest=bing,b; lang=en"));
    expect(s).toEqual({
      bangPrefix: "!",
      provider: "bing",
      snapPrefix: "@",
      trigger: "b",
      customUrl: null,
      frecent: {},
      custom: [],
    });
  });

  test("empty cookie value → defaults for missing fields", () => {
    const s = parseCookie(req("suggest="));
    expect(s).toEqual({
      bangPrefix: "!",
      provider: "default",
      snapPrefix: "@",
      trigger: "g",
      customUrl: null,
      frecent: {},
      custom: [],
    });
  });

  test("unified suggest format parses frecency and custom together", () => {
    const cookie = `suggest=custom,ddg,https%3A%2F%2Fapi.example.com%2Fsuggest%3Fq%3D%7B%7D|f:mdn:20,gh:3|c:${encodeURIComponent(JSON.stringify(["my.site", "repo"]))}`;
    const s = parseCookie(req(cookie));
    expect(s.provider).toBe("custom");
    expect(s.trigger).toBe("ddg");
    expect(s.customUrl).toBe("https://api.example.com/suggest?q={}");
    expect(s.frecent).toEqual({ mdn: 20, gh: 3 });
    expect(s.custom).toEqual(["my.site", "repo"]);
  });

  test("unified suggest format parses configured prefixes", () => {
    const s = parseCookie(req("suggest=google,g,,45"));
    expect(s.bangPrefix).toBe(";");
    expect(s.snapPrefix).toBe("~");
  });

  test("invalid or equal configured prefixes fall back safely", () => {
    for (const syntax of ["44", "99", "x", ""]) {
      const s = parseCookie(req(`suggest=google,g,,${syntax}`));
      expect(s.bangPrefix).toBe("!");
      expect(s.snapPrefix).toBe("@");
    }
  });

  test("cookie without optional context parses core settings", () => {
    const s = parseCookie(req("suggest=google,ddg,https%3A%2F%2Fexample.com"));
    expect(s.provider).toBe("google");
    expect(s.trigger).toBe("ddg");
    expect(s.customUrl).toBe("https://example.com");
    expect(s.frecent).toEqual({});
    expect(s.custom).toEqual([]);
  });

  test("suggest cookie accepts compact and padded separators", () => {
    const compact = parseCookie(req("theme=dark;suggest=bing,b;lang=en"));
    const padded = parseCookie(req("theme=dark;   suggest=ddg,g;lang=en"));
    const leading = parseCookie(req("\t suggest=google,g"));

    expect(compact.provider).toBe("bing");
    expect(compact.trigger).toBe("b");
    expect(padded.provider).toBe("ddg");
    expect(padded.trigger).toBe("g");
    expect(leading.provider).toBe("google");
    expect(leading.trigger).toBe("g");
  });

  test("malformed suggest context is normalized", () => {
    const { settings, rewrittenSuggestCookie } =
      parseSettingsFromRawUrlWithCleanup(
        "http://localhost/suggest?q=cats",
        req("suggest=custom,g,|f:%E0%A4%A|")
      );
    expect(settings.provider).toBe("custom");
    expect(settings.frecent).toEqual({});
    expect(settings.custom).toEqual([]);
    expect(rewrittenSuggestCookie).toBe("custom,g,");
  });
});

describe("parseSettings", () => {
  test("sp query param overrides cookie provider", () => {
    const url = new URL("http://localhost/suggest?q=cats&sp=ddg");
    const r = req("suggest=google,g,");
    const s = parseSettings(url, r);
    expect(s.provider).toBe("ddg");
    expect(s.trigger).toBe("g");
  });

  test("no query params falls back to cookie", () => {
    const url = new URL("http://localhost/suggest?q=cats");
    const r = req("suggest=brave,b,");
    const s = parseSettings(url, r);
    expect(s.provider).toBe("brave");
    expect(s.trigger).toBe("b");
  });

  test("no query params and no cookie returns defaults", () => {
    const url = new URL("http://localhost/suggest?q=cats");
    const r = req();
    const s = parseSettings(url, r);
    expect(s).toEqual(defaultSettings);
  });

  test("sp does not affect other settings", () => {
    const url = new URL("http://localhost/suggest?q=cats&sp=bing");
    const r = req("suggest=google,ddg,");
    const s = parseSettings(url, r);
    expect(s.provider).toBe("bing");
    expect(s.frecent).toEqual({});
    expect(s.trigger).toBe("ddg");
  });

  test("prefix query params override cookie syntax together", () => {
    const s = parseSettings(
      new URL("http://localhost/suggest?q=%24g&bp=%24&np=~"),
      req("suggest=google,g,,01")
    );
    expect(s.bangPrefix).toBe("$");
    expect(s.snapPrefix).toBe("~");
  });
});

describe("readQueryParam", () => {
  test("returns null when URL has no query string", () => {
    expect(readQueryParam("http://localhost/suggest", "q")).toBeNull();
  });

  test("finds query param in first, middle, and last position", () => {
    expect(readQueryParam("http://localhost/suggest?q=first&sp=ddg", "q")).toBe(
      "first"
    );
    expect(readQueryParam("http://localhost/suggest?a=1&q=mid&b=2", "q")).toBe(
      "mid"
    );
    expect(readQueryParam("http://localhost/suggest?sp=ddg&q=last", "q")).toBe(
      "last"
    );
  });

  test("decodes + as space", () => {
    expect(readQueryParam("http://localhost/suggest?q=hello+world", "q")).toBe(
      "hello world"
    );
  });

  test("decodes percent-encoded values", () => {
    expect(
      readQueryParam("http://localhost/suggest?q=%2Bcats%20dogs", "q")
    ).toBe("+cats dogs");
  });

  test("decodes mixed + and %20 values", () => {
    expect(
      readQueryParam("http://localhost/suggest?q=cat+and+dog%20friend", "q")
    ).toBe("cat and dog friend");
  });

  test("decodes UTF-8 and emoji payloads", () => {
    expect(readQueryParam("http://localhost/suggest?q=caf%C3%A9", "q")).toBe(
      "café"
    );
    expect(
      readQueryParam("http://localhost/suggest?q=caf%C3%A9+%F0%9F%8D%95", "q")
    ).toBe("café 🍕");
  });

  test("tolerates malformed percent-encoding like URLSearchParams", () => {
    expect(readQueryParam("http://localhost/suggest?q=%E0%A4%A", "q")).toBe(
      "�%A"
    );
    expect(readQueryParam("http://localhost/suggest?q=%ZZ", "q")).toBe("%ZZ");
    expect(readQueryParam("http://localhost/suggest?q=abc%", "q")).toBe("abc%");
  });

  test("tolerant decoding preserves invalid escapes around plus separators", () => {
    expect(readQueryParam("https://x.test/?q=a+%ZZ", "q")).toBe("a %ZZ");
  });

  test("returns empty string for key without value", () => {
    expect(readQueryParam("http://localhost/suggest?q", "q")).toBe("");
    expect(readQueryParam("http://localhost/suggest?q=&sp=ddg", "q")).toBe("");
  });

  test("returns first occurrence when repeated", () => {
    expect(readQueryParam("http://localhost/suggest?q=one&q=two", "q")).toBe(
      "one"
    );
  });

  test("ignores fragment after query", () => {
    expect(
      readQueryParam("http://localhost/suggest?q=alpha#q=beta&sp=ddg", "q")
    ).toBe("alpha");
  });
});

describe("suggest JSON serialization", () => {
  test("preserves the OpenSearch payload shape for escaped values", async () => {
    const query = 'line1\nline2 "quoted" \\ slash';
    const prefix = 'cats "';
    const candidates = [
      {
        trigger: "",
        terminalIndex: terminalIndexFor("gh"),
        score: 42,
      },
      {
        trigger: 'lo"cal\\slash',
        terminalIndex: -1,
        score: 3,
      },
    ];

    const expected = [
      query,
      ['cats "!gh', 'cats "!lo"cal\\slash'],
      ["GitHub \u2014 github.com", ""],
      ["https://github.com", ""],
      {
        "google:suggestdetail": [
          {
            a: "GitHub \u2014 github.com",
            i: "https://github.com/favicon.ico",
          },
          {},
        ],
      },
    ];
    const response = responseFromCandidates(query, prefix, candidates);
    const current = await response.json();

    expect(current).toEqual(expected);
  });
});

describe("readTwoQueryParams", () => {
  test("returns the same parsed value when both keys are equal", () => {
    expect(
      readTwoQueryParams("https://x.test/?q=first&q=second", "q", "q")
    ).toEqual(["first", "first"]);
  });

  test("returns two nulls when the URL has no query string", () => {
    expect(readTwoQueryParams("https://x.test/path", "a", "b")).toEqual([
      null,
      null,
    ]);
  });
  test("returns both values from one query string", () => {
    expect(
      readTwoQueryParams(
        "http://localhost/suggest?q=alpha&sp=ddg&x=1",
        "q",
        "sp"
      )
    ).toEqual(["alpha", "ddg"]);
  });

  test("returns empty string for valueless keys", () => {
    expect(
      readTwoQueryParams("http://localhost/suggest?q&sp=", "q", "sp")
    ).toEqual(["", ""]);
  });

  test("returns null for missing keys", () => {
    expect(
      readTwoQueryParams("http://localhost/suggest?a=1", "q", "sp")
    ).toEqual([null, null]);
  });

  test("uses first occurrence for repeated keys", () => {
    expect(
      readTwoQueryParams(
        "http://localhost/suggest?q=first&q=second&sp=ddg&sp=bing",
        "q",
        "sp"
      )
    ).toEqual(["first", "ddg"]);
  });
});

describe("readSuggestQueryParams", () => {
  test("reads provider and Firefox syntax overrides in one scan", () => {
    expect(
      readSuggestQueryParams(
        "http://localhost/suggest?np=~&q=%24gh&x=1&bp=%24&sp=ddg"
      )
    ).toEqual(["$gh", "ddg", "$", "~"]);
  });

  test("returns first values and preserves missing overrides", () => {
    expect(
      readSuggestQueryParams(
        "http://localhost/suggest?q=first&q=second&sp=ddg&sp=bing"
      )
    ).toEqual(["first", "ddg", null, null]);
  });
});

describe("parseSettingsFromRawUrl", () => {
  test("sp override applies without reading sp from URL", () => {
    const s = parseSettingsFromRawUrl(
      "http://localhost/suggest?q=cats",
      req("suggest=google,g,"),
      "bing"
    );
    expect(s.provider).toBe("bing");
    expect(s.trigger).toBe("g");
  });

  test("sp query param overrides cookie provider", () => {
    const s = parseSettingsFromRawUrl(
      "http://localhost/suggest?q=cats&sp=ddg",
      req("suggest=google,g,")
    );
    expect(s.provider).toBe("ddg");
    expect(s.trigger).toBe("g");
  });

  test("no sp query param falls back to cookie provider", () => {
    const s = parseSettingsFromRawUrl(
      "http://localhost/suggest?q=cats",
      req("suggest=brave,b,")
    );
    expect(s.provider).toBe("brave");
    expect(s.trigger).toBe("b");
  });

  test("malformed sp encoding is handled without throwing", () => {
    const s = parseSettingsFromRawUrl(
      "http://localhost/suggest?q=cats&sp=%E0%A4%A",
      req("suggest=google,g,")
    );
    expect(s.provider).toBe("�%A");
  });

  test("plain-mode parsing skips bang context while preserving core settings", () => {
    const s = parseSettingsFromRawUrl(
      "http://localhost/suggest?q=cats",
      req(
        "suggest=custom,g,https%3A%2F%2Fexample.com%2Fsearch%3Fq%3D%7B%7D|meta|gh.mdn"
      ),
      null,
      false
    );
    expect(s.provider).toBe("custom");
    expect(s.trigger).toBe("g");
    expect(s.customUrl).toBe("https://example.com/search?q={}");
    expect(s.frecent).toEqual({});
    expect(s.custom).toEqual([]);
  });
});

describe("bang suggestions — via suggest()", () => {
  test('"!gh" returns bang suggestions payload', async () => {
    const r = await suggest("!gh", defaultSettings);
    const [query, completions] = await r.json();
    expect(query).toBe("!gh");
    expect(completions.length).toBeGreaterThan(0);
    for (const completion of completions) {
      expect(completion.startsWith("!g")).toBe(true);
    }
  });

  test('"!gh" completions are bang-formatted', async () => {
    const r = await suggest("!gh", defaultSettings);
    const [, completions] = await r.json();
    for (const completion of completions) {
      expect(completion.startsWith("!")).toBe(true);
    }
  });

  test('"!gh" descriptions and suggestdetail stay aligned', async () => {
    const r = await suggest("!gh", defaultSettings);
    const data = await r.json();
    const completions = data[1] as string[];
    const descriptions = data[2] as string[];
    const urls = data[3] as string[];
    const details = data[4]["google:suggestdetail"] as Array<
      Record<string, string>
    >;
    expect(descriptions).toHaveLength(completions.length);
    expect(urls).toHaveLength(completions.length);
    expect(details).toHaveLength(completions.length);
  });

  test("google:suggestdetail length matches completions length", async () => {
    const r = await suggest("!g", defaultSettings);
    const data = await r.json();
    expect(data[4]["google:suggestdetail"]).toHaveLength(data[1].length);
  });

  test('"cats !gh" keeps the leading query prefix in completions', async () => {
    const r = await suggest("cats !gh", defaultSettings);
    const [query, completions] = await r.json();
    expect(query).toBe("cats !gh");
    for (const completion of completions) {
      expect(completion.startsWith("cats !")).toBe(true);
    }
  });

  test('"!" → matches all keys, returns max TOP_K', async () => {
    const r = await suggest("!", defaultSettings);
    const [, completions] = await r.json();
    expect(completions).toHaveLength(TOP_K);
  });

  test('"!zzz" → no matches, empty completions', async () => {
    const r = await suggest("!zzz", defaultSettings);
    const [, completions] = await r.json();
    expect(completions).toEqual([]);
  });

  test('"!g" returns suggestions scoped to bang-like completions', async () => {
    const r = await suggest("!g", defaultSettings);
    const [, completions] = await r.json();
    expect(completions.length).toBeGreaterThan(0);
    for (const completion of completions) {
      expect(completion.startsWith("!g")).toBe(true);
    }
  });
});

describe("frecency boosts", () => {
  test("frecency boost changes result order", async () => {
    const trigger = "boostme";
    const baseline = await suggest("!", {
      ...defaultSettings,
      custom: [trigger],
    });
    const [, baselineCompletions] = await baseline.json();

    const settings = {
      ...defaultSettings,
      custom: [trigger],
      frecent: { [trigger]: 200 },
    };
    const r = await suggest("!", settings);
    const [, completions] = await r.json();
    expect(completions).toContain("!boostme");
    expect(completions[0]).toBe("!boostme");
    expect(baselineCompletions[0]).not.toBe("!boostme");
  });

  test("frecency boost capped at 2000", async () => {
    const trigger = "boostme";
    const boostedAtCap = await suggest("!", {
      ...defaultSettings,
      custom: [trigger],
      frecent: { [trigger]: 200 },
    });
    const [, cappedCompletions] = await boostedAtCap.json();

    const settings = {
      ...defaultSettings,
      custom: [trigger],
      frecent: { [trigger]: 9999 },
    };
    const r = await suggest("!", settings);
    const [, maxCompletions] = await r.json();
    expect(cappedCompletions[0]).toBe("!boostme");
    expect(maxCompletions[0]).toBe("!boostme");
  });

  test("custom bang triggers appear in suggestions", async () => {
    const settings = {
      ...defaultSettings,
      custom: ["ghtest"],
    };
    const r = await suggest("!gh", settings);
    const [, completions] = await r.json();
    expect(completions).toContain("!ghtest");
  });

  test("custom bang with frecency boost ranks higher", async () => {
    const settings = {
      ...defaultSettings,
      custom: ["ghtest"],
      frecent: { ghtest: 200 },
    };
    const r = await suggest("!gh", settings);
    const [, completions] = await r.json();
    // ghtest: 0 + min(200*10, 2000) = 2000
    // gh: 500, ghi: 100, ghp: 50
    expect(completions[0]).toBe("!ghtest");
  });

  test("custom bang with no frecency has base score 0", async () => {
    const settings = {
      ...defaultSettings,
      custom: ["ghtest"],
    };
    const r = await suggest("!g", settings);
    const [, completions] = await r.json();
    expect(completions).toContain("!ghtest");
    expect(completions[0]).not.toBe("!ghtest");
  });

  test("custom bang has empty suggestdetail entry", async () => {
    const settings = {
      ...defaultSettings,
      custom: ["ghtest"],
    };
    const r = await suggest("!ghtest", settings);
    const data = await r.json();
    expect(data[1]).toEqual(["!ghtest"]);
    expect(data[2]).toEqual([""]);
    expect(data[3]).toEqual([""]);
    expect(data[4]["google:suggestdetail"]).toEqual([{}]);
  });

  test("empty frecency and custom don't affect results", async () => {
    const r1 = await suggest("!gh", defaultSettings);
    const r2 = await suggest("!gh", {
      ...defaultSettings,
      frecent: {},
      custom: [],
    });
    expect(await r1.json()).toEqual(await r2.json());
  });
});

describe("provider proxying — via suggest()", () => {
  test("provider=google → fetches google suggest URL", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json(["cats", ["cats and dogs"]]));
    const r = await suggest("cats", {
      ...defaultSettings,
      provider: "google",
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://www.google.com/complete/search?client=firefox&channel=fen&q=cats"
    );
    expect(await r.json()).toEqual(["cats", ["cats and dogs"]]);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(r.headers.get("Content-Type")).toBe("application/json");
  });

  test("provider=ddg → fetches duckduckgo suggest URL", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json(["cats", []]));
    await suggest("cats", { ...defaultSettings, provider: "ddg" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://duckduckgo.com/ac/?q=cats&type=list"
    );
  });

  test("provider=bing → fetches bing suggest URL", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json(["cats", []]));
    await suggest("cats", { ...defaultSettings, provider: "bing" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://www.bing.com/osjson.aspx?query=cats"
    );
  });

  test("provider=brave → fetches brave suggest URL", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json(["cats", []]));
    await suggest("cats", { ...defaultSettings, provider: "brave" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://search.brave.com/api/suggest?q=cats&rich=false"
    );
  });

  test("provider=yahoo → fetches yahoo suggest URL", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json(["cats", []]));
    await suggest("cats", { ...defaultSettings, provider: "yahoo" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://ff.search.yahoo.com/gossip?output=fxjson&command=cats"
    );
  });

  test("provider=ecosia → fetches ecosia suggest URL", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json(["cats", []]));
    await suggest("cats", { ...defaultSettings, provider: "ecosia" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://ac.ecosia.org/autocomplete?q=cats&type=list"
    );
  });

  test("provider=kagi → fetches kagi suggest URL", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json(["cats", []]));
    await suggest("cats", { ...defaultSettings, provider: "kagi" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://kagi.com/api/autosuggest?q=cats"
    );
  });

  test("provider=qwant → fetches Qwant suggest URL", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json(["cats", []]));
    await suggest("cats", { ...defaultSettings, provider: "qwant" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.qwant.com/v3/suggest/?q=cats&client=opensearch"
    );
  });

  test("provider=startpage → fetches Startpage suggest URL", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json(["cats", []]));
    await suggest("cats", { ...defaultSettings, provider: "startpage" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://www.startpage.com/osuggestions?q=cats"
    );
  });

  test("provider=yandex → fetches yandex suggest URL", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json(["cats", []]));
    await suggest("cats", { ...defaultSettings, provider: "yandex" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://suggest.yandex.com/suggest-ff.cgi?part=cats"
    );
  });

  test("provider=baidu → fetches baidu suggest URL", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json(["cats", []]));
    await suggest("cats", { ...defaultSettings, provider: "baidu" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://suggestion.baidu.com/su?wd=cats&action=opensearch"
    );
  });

  test("provider=none → empty response, no fetch", async () => {
    const query = 'cats "and" \\ dogs';
    const r = await suggest(query, { ...defaultSettings, provider: "none" });
    expect(fetchSpy).not.toHaveBeenCalled();
    const [responseQuery, completions] = await r.json();
    expect(responseQuery).toBe(query);
    expect(completions).toEqual([]);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
  });

  test("provider=default + trigger=g → resolves to google", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json(["cats", []]));
    await suggest("cats", defaultSettings);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://www.google.com/complete/search?client=firefox&channel=fen&q=cats"
    );
  });

  test("provider=default + trigger=ddg → resolves to duckduckgo", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json(["cats", []]));
    await suggest("cats", { ...defaultSettings, trigger: "ddg" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://duckduckgo.com/ac/?q=cats&type=list"
    );
  });

  test("provider=default + trigger=brave → resolves to brave", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json(["cats", []]));
    await suggest("cats", { ...defaultSettings, trigger: "brave" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://search.brave.com/api/suggest?q=cats&rich=false"
    );
  });

  test("provider=default + trigger=yahoo → resolves to yahoo", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json(["cats", []]));
    await suggest("cats", { ...defaultSettings, trigger: "yahoo" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://ff.search.yahoo.com/gossip?output=fxjson&command=cats"
    );
  });

  test("provider=default + trigger=y → resolves to yahoo", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json(["cats", []]));
    await suggest("cats", { ...defaultSettings, trigger: "y" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://ff.search.yahoo.com/gossip?output=fxjson&command=cats"
    );
  });

  test("provider=default + trigger=ecosia → resolves to ecosia", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json(["cats", []]));
    await suggest("cats", { ...defaultSettings, trigger: "ecosia" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://ac.ecosia.org/autocomplete?q=cats&type=list"
    );
  });

  test("provider=default + trigger=kagi → resolves to kagi", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json(["cats", []]));
    await suggest("cats", { ...defaultSettings, trigger: "kagi" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://kagi.com/api/autosuggest?q=cats"
    );
  });

  test("provider=default + Qwant triggers → resolves to Qwant", async () => {
    for (const trigger of ["qw", "qwant", "qwt", "qww"]) {
      fetchSpy.mockResolvedValueOnce(Response.json(["cats", []]));
      await suggest("cats", { ...defaultSettings, trigger });
      expect(fetchSpy).toHaveBeenLastCalledWith(
        "https://api.qwant.com/v3/suggest/?q=cats&client=opensearch"
      );
    }
  });

  test("provider=default + trigger=sp → resolves to Startpage", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json(["cats", []]));
    await suggest("cats", { ...defaultSettings, trigger: "sp" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://www.startpage.com/osuggestions?q=cats"
    );
  });

  test("provider=default + trigger=s → resolves to Startpage", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json(["cats", []]));
    await suggest("cats", { ...defaultSettings, trigger: "s" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://www.startpage.com/osuggestions?q=cats"
    );
  });

  test("provider=default + trigger=yandex → resolves to yandex", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json(["cats", []]));
    await suggest("cats", { ...defaultSettings, trigger: "yandex" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://suggest.yandex.com/suggest-ff.cgi?part=cats"
    );
  });

  test("provider=default + trigger=baidu → resolves to baidu", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json(["cats", []]));
    await suggest("cats", { ...defaultSettings, trigger: "baidu" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://suggestion.baidu.com/su?wd=cats&action=opensearch"
    );
  });

  test("provider=default + unknown trigger → empty", async () => {
    const r = await suggest("cats", { ...defaultSettings, trigger: "xyz" });
    expect(fetchSpy).not.toHaveBeenCalled();
    const [, completions] = await r.json();
    expect(completions).toEqual([]);
  });

  test("provider=custom + customUrl → disabled by default", async () => {
    const r = await suggest("cats", {
      ...defaultSettings,
      provider: "custom",
      customUrl: "https://my-api.com/suggest?q={}",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await r.json()).toEqual(["cats", []]);
  });

  test("provider=custom + customUrl → fetched when explicitly enabled", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json(["cats", ["result"]]));
    await suggest(
      "cats",
      {
        ...defaultSettings,
        provider: "custom",
        customUrl: "https://my-api.com/suggest?q={}",
      },
      undefined,
      true
    );
    expect(fetchSpy).toHaveBeenCalledWith("https://my-api.com/suggest?q=cats");
  });

  test("provider=custom + null customUrl → empty", async () => {
    const r = await suggest("cats", {
      ...defaultSettings,
      provider: "custom",
      customUrl: null,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    const [, completions] = await r.json();
    expect(completions).toEqual([]);
  });

  test("fetch failure → empty response", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("Network error"));
    const r = await suggest("cats", {
      ...defaultSettings,
      provider: "google",
    });
    const [query, completions] = await r.json();
    expect(query).toBe("cats");
    expect(completions).toEqual([]);
  });

  test("non-success upstream response → empty response", async () => {
    fetchSpy.mockResolvedValueOnce(
      Response.json(["cats", ["result"]], { status: 503 })
    );
    const r = await suggest("cats", {
      ...defaultSettings,
      provider: "google",
    });
    expect(await r.json()).toEqual(["cats", []]);
  });

  test("malformed upstream JSON → empty response", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("<html>unavailable</html>", {
        headers: { "Content-Type": "text/html" },
      })
    );
    const r = await suggest("cats", {
      ...defaultSettings,
      provider: "google",
    });
    expect(await r.json()).toEqual(["cats", []]);
  });

  test("invalid upstream suggestion shape → empty response", async () => {
    for (const payload of [
      { query: "cats", suggestions: ["result"] },
      ["cats", "result"],
      ["cats", ["result", 42]],
      ["cats", ["result"], "description"],
      ["cats", ["result"], [], [], []],
    ]) {
      fetchSpy.mockResolvedValueOnce(Response.json(payload));
      const r = await suggest("cats", {
        ...defaultSettings,
        provider: "google",
      });
      expect(await r.json()).toEqual(["cats", []]);
    }
  });

  test("valid optional OpenSearch metadata is preserved", async () => {
    const payload = [
      "cats",
      ["cats and dogs"],
      ["description"],
      ["https://example.com"],
      { "google:suggestdetail": [{}] },
    ];
    fetchSpy.mockResolvedValueOnce(Response.json(payload));
    const r = await suggest("cats", {
      ...defaultSettings,
      provider: "google",
    });
    expect(await r.json()).toEqual(payload);
  });

  test("valid upstream JSON text is returned without re-serialization", async () => {
    const body = '[ "cats", [ "cats and dogs" ] ]';
    fetchSpy.mockResolvedValueOnce(
      new Response(body, { headers: { "Content-Type": "application/json" } })
    );
    const r = await suggest("cats", {
      ...defaultSettings,
      provider: "google",
    });
    expect(await r.text()).toBe(body);
  });
});

describe("parsePartialBang — snap detection", () => {
  test('"@g" → prefix snap', () => {
    const result = parsePartialBang("@g");
    expect(result).toEqual({
      prefix: "",
      partial: "g",
      isSnap: true,
      triggerPrefix: "@",
    });
  });

  test('"@gh" → prefix snap', () => {
    const result = parsePartialBang("@gh");
    expect(result).toEqual({
      prefix: "",
      partial: "gh",
      isSnap: true,
      triggerPrefix: "@",
    });
  });

  test('"cats @g" → suffix snap', () => {
    const result = parsePartialBang("cats @g");
    expect(result).toEqual({
      prefix: "cats ",
      partial: "g",
      isSnap: true,
      triggerPrefix: "@",
    });
  });

  test('"!g" → prefix bang, not snap', () => {
    const result = parsePartialBang("!g");
    expect(result).toEqual({
      prefix: "",
      partial: "g",
      isSnap: undefined,
      triggerPrefix: "!",
    });
  });

  test('"cats !g" → suffix bang, not snap', () => {
    const result = parsePartialBang("cats !g");
    expect(result).toEqual({
      prefix: "cats ",
      partial: "g",
      isSnap: undefined,
      triggerPrefix: "!",
    });
  });

  test('"@" → prefix snap with empty partial', () => {
    const result = parsePartialBang("@");
    expect(result).toEqual({
      prefix: "",
      partial: "",
      isSnap: true,
      triggerPrefix: "@",
    });
  });

  test('"@g cats" → has space after trigger, returns null', () => {
    expect(parsePartialBang("@g cats")).toBeNull();
  });

  test('"cats" → no trigger, returns null', () => {
    expect(parsePartialBang("cats")).toBeNull();
  });

  test("configured prefixes replace default bang and snap detection", () => {
    expect(parsePartialBang("$gh", "$", "~")).toEqual({
      prefix: "",
      partial: "gh",
      isSnap: undefined,
      triggerPrefix: "$",
    });
    expect(parsePartialBang("cats ~gh", "$", "~")).toEqual({
      prefix: "cats ",
      partial: "gh",
      isSnap: true,
      triggerPrefix: "~",
    });
    expect(parsePartialBang("!gh", "$", "~")).toBeNull();
    expect(parsePartialBang("@gh", "$", "~")).toBeNull();
  });

  test('"@gh,so,m" parses the current snap-chain segment', () => {
    expect(parsePartialBang("@gh,so,m")).toEqual({
      prefix: "",
      partial: "m",
      isSnap: true,
      triggerPrefix: "@",
      chainPrefix: "gh,so,",
      selectedTriggers: ["gh", "so"],
    });
  });

  test("suffix snap chains preserve the leading query", () => {
    expect(parsePartialBang("service workers @GH,so,m")).toEqual({
      prefix: "service workers ",
      partial: "m",
      isSnap: true,
      triggerPrefix: "@",
      chainPrefix: "GH,so,",
      selectedTriggers: ["gh", "so"],
    });
  });

  test("snap-chain autocomplete rejects empty and ninth segments", () => {
    expect(parsePartialBang("@gh,,m")).toBeNull();
    expect(parsePartialBang("@b,ddg,g,gh,mdn,so,w,yt,")).toBeNull();
  });
});

describe("snap suggestions — via suggest()", () => {
  test('"@gh" returns snap suggestions with @ prefix', async () => {
    const r = await suggest("@gh", defaultSettings);
    const [query, completions] = await r.json();
    expect(query).toBe("@gh");
    expect(completions.length).toBeGreaterThan(0);
    for (const completion of completions) {
      expect(completion.startsWith("@g")).toBe(true);
    }
  });

  test('"@gh" completions use @ not !', async () => {
    const r = await suggest("@gh", defaultSettings);
    const [, completions] = await r.json();
    for (const completion of completions) {
      expect(completion.startsWith("@")).toBe(true);
      expect(completion.startsWith("!")).toBe(false);
    }
  });

  test("configured prefixes replace completion syntax", async () => {
    const bangResponse = await suggest("$gh", {
      ...defaultSettings,
      bangPrefix: "$",
      snapPrefix: "~",
    });
    const [, bangCompletions] = await bangResponse.json();
    expect(bangCompletions.length).toBeGreaterThan(0);
    expect(
      bangCompletions.every((value: string) => value.startsWith("$"))
    ).toBe(true);

    const snapResponse = await suggest("~gh", {
      ...defaultSettings,
      bangPrefix: "$",
      snapPrefix: "~",
    });
    const [, snapCompletions] = await snapResponse.json();
    expect(snapCompletions.length).toBeGreaterThan(0);
    expect(
      snapCompletions.every((value: string) => value.startsWith("~"))
    ).toBe(true);
  });

  test('"cats @gh" keeps the leading query prefix with @ completions', async () => {
    const r = await suggest("cats @gh", defaultSettings);
    const [query, completions] = await r.json();
    expect(query).toBe("cats @gh");
    for (const completion of completions) {
      expect(completion.startsWith("cats @")).toBe(true);
    }
  });

  test('"@" → matches all keys, returns max TOP_K', async () => {
    const r = await suggest("@", defaultSettings);
    const [, completions] = await r.json();
    expect(completions).toHaveLength(TOP_K);
    for (const completion of completions) {
      expect(completion.startsWith("@")).toBe(true);
    }
  });

  test('"@zzz" → no matches, empty completions', async () => {
    const r = await suggest("@zzz", defaultSettings);
    const [, completions] = await r.json();
    expect(completions).toEqual([]);
  });

  test("snap suggestions have same metadata structure as bang suggestions", async () => {
    const r = await suggest("@gh", defaultSettings);
    const data = await r.json();
    const completions = data[1] as string[];
    const descriptions = data[2] as string[];
    const urls = data[3] as string[];
    const details = data[4]["google:suggestdetail"] as Array<
      Record<string, string>
    >;
    expect(descriptions).toHaveLength(completions.length);
    expect(urls).toHaveLength(completions.length);
    expect(details).toHaveLength(completions.length);
  });

  test("snap-chain suggestions complete only the current segment", async () => {
    const r = await suggest("@gh,so,m", {
      ...defaultSettings,
      custom: ["maps", "medium"],
    });
    const [, completions] = await r.json();
    expect(completions).toContain("@gh,so,mdn");
    expect(completions).toContain("@gh,so,maps");
    expect(completions).toContain("@gh,so,medium");
    expect(
      completions.every((completion: string) =>
        completion.startsWith("@gh,so,m")
      )
    ).toBe(true);
  });

  test("suffix snap-chain suggestions preserve the query", async () => {
    const r = await suggest("service workers @gh,so,m", defaultSettings);
    const [, completions] = await r.json();
    expect(completions).toContain("service workers @gh,so,mdn");
  });

  test("already-selected triggers are omitted from chain suggestions", async () => {
    const settings = {
      ...defaultSettings,
      frecent: { gh: 200 },
    };
    const baseline = await suggest("@g", settings);
    const [, baselineCompletions] = await baseline.json();
    expect(baselineCompletions).toContain("@gh");

    const r = await suggest("@gh,so,g", settings);
    const [, completions] = await r.json();
    expect(completions).not.toContain("@gh,so,gh");
    expect(completions.length).toBeGreaterThan(0);
  });

  test("custom triggers complete snap-chain segments", async () => {
    const r = await suggest("@gh,so,m", {
      ...defaultSettings,
      custom: ["mapillary", "mysite"],
    });
    const [, completions] = await r.json();
    expect(completions).toContain("@gh,so,mapillary");
    expect(completions).toContain("@gh,so,mysite");
  });

  test("configured snap prefixes appear only once in chain completions", async () => {
    const r = await suggest("~gh,so,m", {
      ...defaultSettings,
      bangPrefix: "$",
      snapPrefix: "~",
    });
    const [, completions] = await r.json();
    expect(completions).toContain("~gh,so,mdn");
    expect(
      completions.every((completion: string) => completion.indexOf("~", 1) < 0)
    ).toBe(true);
  });
});

describe("snap JSON serialization", () => {
  test("snap responseFromCandidates uses @ prefix", async () => {
    const candidates = [
      {
        trigger: "",
        terminalIndex: terminalIndexFor("gh"),
        score: 42,
      },
    ];
    const response = responseFromCandidates("@gh", "", candidates, "@");
    const data = await response.json();
    expect(data[1][0]).toBe("@gh");
  });
});
