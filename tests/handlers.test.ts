import { describe, expect, test } from "bun:test";
import {
  handleOpenSearchRequest,
  handleSuggestRequest,
} from "../src/server/handlers";
import { TOP_K } from "../src/shared/constants";
import { encodeSuggestCookieValue } from "../src/shared/suggest-cookie";
import { installManagedFetchSpy, requestWithCookie } from "./helpers/http";

const fetchSpy = installManagedFetchSpy();

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("handleSuggestRequest", () => {
  test("returns 400 when q is missing", async () => {
    const response = await handleSuggestRequest(
      requestWithCookie("http://localhost/suggest")
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe("Missing q parameter");
  });

  test("returns bang suggestions without remote fetch for bang-prefixed query", async () => {
    const response = await handleSuggestRequest(
      requestWithCookie(
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

  test("uses URL-backed Firefox syntax without cookies", async () => {
    const bangResponse = await handleSuggestRequest(
      requestWithCookie(
        "http://localhost/suggest?q=%24gh&sp=google&bp=%24&np=~"
      )
    );
    const [, bangCompletions] = await bangResponse.json();
    expect(bangCompletions.length).toBeGreaterThan(0);
    expect(
      bangCompletions.every((value: string) => value.startsWith("$"))
    ).toBe(true);

    const snapResponse = await handleSuggestRequest(
      requestWithCookie("http://localhost/suggest?q=~gh&sp=google&bp=%24&np=~")
    );
    const [, snapCompletions] = await snapResponse.json();
    expect(snapCompletions.length).toBeGreaterThan(0);
    expect(
      snapCompletions.every((value: string) => value.startsWith("~"))
    ).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("blocks custom suggest provider request by default", async () => {
    const custom = "https://example.com/suggest?q={}";
    const response = await handleSuggestRequest(
      requestWithCookie(
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
      requestWithCookie(
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
      requestWithCookie("http://localhost/suggest?q=test&sp=ddg")
    );

    expect(response.status).toBe(200);
    const calledUrl = String(fetchSpy.mock.calls[0][0]);
    expect(calledUrl).toContain("duckduckgo.com/ac/?q=test&type=list");
    expect(calledUrl.startsWith("https://duckduckgo.com")).toBe(true);
  });

  test("enables site-specific forwarding only with its URL flag", async () => {
    fetchSpy.mockResolvedValueOnce(
      Response.json({ items: [{ full_name: "facebook/react" }] })
    );

    const response = await handleSuggestRequest(
      requestWithCookie(
        "http://localhost/suggest?q=%21gh%20react&sp=google&site_specific_forward=1"
      )
    );

    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      "https://api.github.com/search/repositories?q=react&per_page=8"
    );
    expect((await response.json())[1]).toEqual(["!gh facebook/react"]);
  });

  test("does not site-forward a built-in trigger overridden by a custom bang", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json(["react", ["react docs"]]));

    const response = await handleSuggestRequest(
      requestWithCookie(
        "http://localhost/suggest?q=%21gh%20react&sp=google&site_specific_forward=1",
        `suggest=${encodeSuggestCookieValue("google", "g", "", ["gh"], null)}`
      )
    );

    expect(String(fetchSpy.mock.calls[0][0])).toContain("google.com/complete");
    expect((await response.json())[1]).toEqual(["!gh react docs"]);
  });

  test("cleans malformed suggest context and returns fallback payload", async () => {
    fetchSpy.mockResolvedValue(new Response("[]", { headers: JSON_HEADERS }));

    const response = await handleSuggestRequest(
      requestWithCookie(
        "http://localhost/suggest?q=%21g",
        "suggest=custom,g,|f:%E0%A4%A"
      )
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
      requestWithCookie("https://flashbang.pages.dev/opensearch.xml"),
      {}
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(
      "https://flashbang.pages.dev/suggest?q={searchTerms}"
    );
  });

  test("uses a canonical configured public origin", async () => {
    const response = handleOpenSearchRequest(
      requestWithCookie("http://internal:3000/opensearch.xml"),
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
      requestWithCookie("https://safe.example/opensearch.xml"),
      { PUBLIC_ORIGIN: "javascript:alert(1)" }
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Invalid PUBLIC_ORIGIN");
  });
});
