import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  handleOpenSearchRequest,
  handleSuggestRequest,
} from "../src/server/handlers";
import { TOP_K } from "../src/shared/constants";
import { encodeSuggestCookieValue } from "../src/shared/suggest-cookie";

const fetchSpy = spyOn(globalThis, "fetch");

beforeEach(() => {
  fetchSpy.mockReset();
});

afterAll(() => {
  fetchSpy.mockRestore();
});

const JSON_HEADERS = { "Content-Type": "application/json" };

function req(url: string, cookie?: string): Request {
  const headers = new Headers();
  if (cookie) {
    headers.set("Cookie", cookie);
  }
  return new Request(url, { headers });
}

describe("handleSuggestRequest", () => {
  test("returns 400 when q is missing", async () => {
    const response = await handleSuggestRequest(
      req("http://localhost/suggest")
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe("Missing q parameter");
  });

  test("returns bang suggestions without remote fetch for bang-prefixed query", async () => {
    const response = await handleSuggestRequest(
      req(
        "http://localhost/suggest?q=%21",
        encodeSuggestCookieValue("default", "g", "", ["mybang"], null)
      )
    );

    expect(fetchSpy).not.toHaveBeenCalled();

    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload[0]).toBe("!");
    expect(Array.isArray(payload[1])).toBe(true);
    expect(payload[1]).toHaveLength(TOP_K);
  });

  test("blocks custom suggest provider request by default", async () => {
    const custom = "https://example.com/suggest?q={}";
    const response = await handleSuggestRequest(
      req(
        "http://localhost/suggest?q=flash",
        `suggest=${encodeSuggestCookieValue("custom", "g", custom)}`
      )
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await response.json()).toEqual(["flash", []]);
  });

  test("forwards custom suggest provider request when explicitly enabled", async () => {
    const upstream = [
      "flashbang",
      ["flashbang", "flashlight"],
      [],
      [],
      { "google:suggestdetail": {} },
    ];
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(upstream), { headers: JSON_HEADERS })
    );

    const custom = "https://example.com/suggest?q={}";
    const response = await handleSuggestRequest(
      req(
        "http://localhost/suggest?q=flash",
        `suggest=${encodeSuggestCookieValue("custom", "g", custom)}`
      ),
      { ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS: "true" }
    );

    expect(response.status).toBe(200);
    const [calledUrl] = fetchSpy.mock.calls[0];
    expect(String(calledUrl)).toBe(custom.replace("{}", "flash"));
    expect(await response.json()).toEqual(upstream);
  });

  test("uses sp query param as provider override", async () => {
    fetchSpy.mockResolvedValue(new Response("[]", { headers: JSON_HEADERS }));

    const response = await handleSuggestRequest(
      req("http://localhost/suggest?q=test&sp=ddg")
    );

    expect(response.status).toBe(200);
    const calledUrl = String(fetchSpy.mock.calls[0][0]);
    expect(calledUrl).toContain("duckduckgo.com/ac/?q=test&type=list");
    expect(calledUrl.startsWith("https://duckduckgo.com")).toBe(true);
  });

  test("cleans malformed suggest context and returns fallback payload", async () => {
    fetchSpy.mockResolvedValue(new Response("[]", { headers: JSON_HEADERS }));

    const response = await handleSuggestRequest(
      req("http://localhost/suggest?q=%21g", "suggest=custom,g,|f:%E0%A4%A")
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("suggest=custom,g,");
  });
});

describe("handleOpenSearchRequest", () => {
  test("uses the request origin when PUBLIC_ORIGIN is absent", async () => {
    const response = handleOpenSearchRequest(
      req("https://flashbang.pages.dev/opensearch.xml"),
      {}
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(
      "https://flashbang.pages.dev/suggest?q={searchTerms}"
    );
  });

  test("uses a canonical configured public origin", async () => {
    const response = handleOpenSearchRequest(
      req("http://internal:3000/opensearch.xml"),
      {
        PUBLIC_ORIGIN:
          "https://Public.Example:443/proxy/path/?ignored=true#fragment",
      }
    );
    const xml = await response.text();

    expect(response.status).toBe(200);
    expect(xml).toContain("https://public.example/icon.svg");
    expect(xml).not.toContain("internal:3000");
    expect(xml).not.toContain("proxy/path");
  });

  test("fails closed for an invalid configured scheme", async () => {
    const response = handleOpenSearchRequest(
      req("https://safe.example/opensearch.xml"),
      { PUBLIC_ORIGIN: "javascript:alert(1)" }
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Invalid PUBLIC_ORIGIN");
  });
});
