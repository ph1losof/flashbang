import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

mock.module("./generated/bangs-full.js", () => {
  const BANGS: Record<string, { s: string; d: string; u: string; r: number }> =
    Object.create(null);
  BANGS.b = {
    s: "Bing",
    d: "www.bing.com",
    u: "https://www.bing.com/search?q={}",
    r: 300,
  };
  BANGS.brave = {
    s: "Brave",
    d: "search.brave.com",
    u: "https://search.brave.com/search?q={}",
    r: 200,
  };
  BANGS.ddg = {
    s: "DuckDuckGo",
    d: "duckduckgo.com",
    u: "https://duckduckgo.com/?q={}",
    r: 800,
  };
  BANGS.g = {
    s: "Google",
    d: "www.google.com",
    u: "https://www.google.com/search?q={}",
    r: 1000,
  };
  BANGS.gh = {
    s: "GitHub",
    d: "github.com",
    u: "https://github.com/search?q={}",
    r: 500,
  };
  BANGS.ghi = {
    s: "GitHub Issues",
    d: "github.com",
    u: "https://github.com/search?q={}&type=issues",
    r: 100,
  };
  BANGS.ghp = {
    s: "GitHub PRs",
    d: "github.com",
    u: "https://github.com/search?q={}&type=pullrequests",
    r: 50,
  };
  BANGS.mdn = {
    s: "MDN",
    d: "developer.mozilla.org",
    u: "https://developer.mozilla.org/en-US/search?q={}",
    r: 400,
  };
  BANGS.w = {
    s: "Wikipedia",
    d: "en.wikipedia.org",
    u: "https://en.wikipedia.org/wiki/Special:Search?search={}",
    r: 900,
  };
  BANGS.yt = {
    s: "YouTube",
    d: "www.youtube.com",
    u: "https://www.youtube.com/results?search_query={}",
    r: 700,
  };
  return { BANGS };
});

mock.module("./generated/bangs-keys.js", () => ({
  BANG_KEYS: ["b", "brave", "ddg", "g", "gh", "ghi", "ghp", "mdn", "w", "yt"],
}));

import { parseCookie, suggest } from "./suggest";

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

describe("parseCookie", () => {
  test("no cookie → defaults", () => {
    const s = parseCookie(req());
    expect(s).toEqual({ provider: "default", trigger: "g", customUrl: null });
  });

  test("all three fields parsed", () => {
    const s = parseCookie(req("suggest=google,ddg,https%3A%2F%2Fexample.com"));
    expect(s).toEqual({
      provider: "google",
      trigger: "ddg",
      customUrl: "https://example.com",
    });
  });

  test("only provider and trigger, no customUrl", () => {
    const s = parseCookie(req("suggest=brave,g"));
    expect(s).toEqual({ provider: "brave", trigger: "g", customUrl: null });
  });

  test("URL-encoded customUrl decoded correctly", () => {
    const s = parseCookie(
      req(
        "suggest=custom,g,https%3A%2F%2Fapi.example.com%2Fsuggest%3Fq%3D%7B%7D"
      )
    );
    expect(s.customUrl).toBe("https://api.example.com/suggest?q={}");
  });

  test("suggest cookie extracted among other cookies", () => {
    const s = parseCookie(req("theme=dark; suggest=bing,b; lang=en"));
    expect(s).toEqual({ provider: "bing", trigger: "b", customUrl: null });
  });

  test("empty cookie value → defaults for missing fields", () => {
    const s = parseCookie(req("suggest="));
    expect(s).toEqual({ provider: "default", trigger: "g", customUrl: null });
  });
});

describe("bang suggestions — via suggest()", () => {
  test('"!gh" → suggestions [gh, ghi, ghp] sorted by relevance desc', async () => {
    const r = await suggest("!gh", {
      provider: "default",
      trigger: "g",
      customUrl: null,
    });
    const [query, completions, _descriptions] = await r.json();
    expect(query).toBe("!gh");
    expect(completions).toEqual(["!gh", "!ghi", "!ghp"]);
  });

  test('"!gh" completions formatted as ["!gh", "!ghi", "!ghp"]', async () => {
    const r = await suggest("!gh", {
      provider: "default",
      trigger: "g",
      customUrl: null,
    });
    const [, completions] = await r.json();
    expect(completions).toEqual(["!gh", "!ghi", "!ghp"]);
  });

  test('"!gh" descriptions are domains from BANGS[k].d', async () => {
    const r = await suggest("!gh", {
      provider: "default",
      trigger: "g",
      customUrl: null,
    });
    const data = await r.json();
    expect(data[2]).toEqual(["github.com", "github.com", "github.com"]);
  });

  test('"cats !gh" → trailing partial, prefix "cats " in completions', async () => {
    const r = await suggest("cats !gh", {
      provider: "default",
      trigger: "g",
      customUrl: null,
    });
    const [query, completions] = await r.json();
    expect(query).toBe("cats !gh");
    expect(completions).toEqual(["cats !gh", "cats !ghi", "cats !ghp"]);
  });

  test('"!" → matches all keys, returns max 8', async () => {
    const r = await suggest("!", {
      provider: "default",
      trigger: "g",
      customUrl: null,
    });
    const [, completions] = await r.json();
    expect(completions).toHaveLength(8);
  });

  test('"!zzz" → no matches, empty completions', async () => {
    const r = await suggest("!zzz", {
      provider: "default",
      trigger: "g",
      customUrl: null,
    });
    const [, completions] = await r.json();
    expect(completions).toEqual([]);
  });

  test('"!g" → exact match included (g is a prefix of gh/ghi/ghp too)', async () => {
    const r = await suggest("!g", {
      provider: "default",
      trigger: "g",
      customUrl: null,
    });
    const [, completions] = await r.json();
    expect(completions).toContain("!g");
    expect(completions).toContain("!gh");
    expect(completions).toContain("!ghi");
    expect(completions).toContain("!ghp");
  });
});

describe("provider proxying — via suggest()", () => {
  test("provider=google → fetches google suggest URL", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json(["cats", ["cats and dogs"]]));
    const r = await suggest("cats", {
      provider: "google",
      trigger: "g",
      customUrl: null,
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://suggestqueries.google.com/complete/search?client=firefox&q=cats"
    );
    expect(r.headers.get("Content-Type")).toBe("application/json");
  });

  test("provider=ddg → fetches duckduckgo suggest URL", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json(["cats", []]));
    await suggest("cats", { provider: "ddg", trigger: "g", customUrl: null });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://duckduckgo.com/ac/?q=cats&type=list"
    );
  });

  test("provider=bing → fetches bing suggest URL", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json(["cats", []]));
    await suggest("cats", { provider: "bing", trigger: "g", customUrl: null });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://www.bing.com/osjson.aspx?query=cats"
    );
  });

  test("provider=brave → fetches brave suggest URL", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json(["cats", []]));
    await suggest("cats", { provider: "brave", trigger: "g", customUrl: null });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://search.brave.com/api/suggest?q=cats&rich=false"
    );
  });

  test("provider=none → empty response, no fetch", async () => {
    const r = await suggest("cats", {
      provider: "none",
      trigger: "g",
      customUrl: null,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    const [query, completions] = await r.json();
    expect(query).toBe("cats");
    expect(completions).toEqual([]);
  });

  test("provider=default + trigger=g → resolves to google", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json(["cats", []]));
    await suggest("cats", {
      provider: "default",
      trigger: "g",
      customUrl: null,
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://suggestqueries.google.com/complete/search?client=firefox&q=cats"
    );
  });

  test("provider=default + trigger=ddg → resolves to duckduckgo", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json(["cats", []]));
    await suggest("cats", {
      provider: "default",
      trigger: "ddg",
      customUrl: null,
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://duckduckgo.com/ac/?q=cats&type=list"
    );
  });

  test("provider=default + trigger=brave → resolves to brave", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json(["cats", []]));
    await suggest("cats", {
      provider: "default",
      trigger: "brave",
      customUrl: null,
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://search.brave.com/api/suggest?q=cats&rich=false"
    );
  });

  test("provider=default + unknown trigger → empty", async () => {
    const r = await suggest("cats", {
      provider: "default",
      trigger: "xyz",
      customUrl: null,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    const [, completions] = await r.json();
    expect(completions).toEqual([]);
  });

  test("provider=custom + customUrl → fetches customUrl", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json(["cats", ["result"]]));
    await suggest("cats", {
      provider: "custom",
      trigger: "g",
      customUrl: "https://my-api.com/suggest?q={}",
    });
    expect(fetchSpy).toHaveBeenCalledWith("https://my-api.com/suggest?q=cats");
  });

  test("provider=custom + null customUrl → empty", async () => {
    const r = await suggest("cats", {
      provider: "custom",
      trigger: "g",
      customUrl: null,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    const [, completions] = await r.json();
    expect(completions).toEqual([]);
  });

  test("fetch failure → empty response", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("Network error"));
    const r = await suggest("cats", {
      provider: "google",
      trigger: "g",
      customUrl: null,
    });
    const [query, completions] = await r.json();
    expect(query).toBe("cats");
    expect(completions).toEqual([]);
  });
});
