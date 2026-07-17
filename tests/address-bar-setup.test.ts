import { describe, expect, test } from "bun:test";
import { firefoxSuggestionUrl } from "../src/ui/firefox-suggest";
import { detectAddressBarBrowser } from "../src/ui/home/address-bar-setup";

describe("address bar browser detection", () => {
  test("detects Chromium browsers before the Chrome fallback", () => {
    const chromium = "Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36";

    expect(detectAddressBarBrowser(`${chromium} Edg/126.0.0.0`)).toBe("edge");
    expect(detectAddressBarBrowser(`${chromium} EdgA/126.0.0.0`)).toBe("edge");
    expect(detectAddressBarBrowser(chromium, true)).toBe("brave");
    expect(detectAddressBarBrowser(chromium)).toBe("chrome");
  });

  test("detects Firefox and Safari", () => {
    expect(detectAddressBarBrowser("Mozilla/5.0 Firefox/128.0")).toBe(
      "firefox"
    );
    expect(
      detectAddressBarBrowser("Mozilla/5.0 Version/17.5 Safari/605.1.15")
    ).toBe("safari");
    expect(detectAddressBarBrowser("Mozilla/5.0 FxiOS/128.0")).toBe("firefox");
  });

  test("detects Edge on iOS", () => {
    expect(
      detectAddressBarBrowser("Mozilla/5.0 EdgiOS/126.0 Mobile/15E148")
    ).toBe("edge");
  });
});

describe("Firefox suggestion URL", () => {
  test("adds provider and only includes non-default syntax", () => {
    expect(
      firefoxSuggestionUrl("https://example.com", {
        bangPrefix: "!",
        provider: "google",
        snapPrefix: "@",
      })
    ).toBe("https://example.com/suggest?q=%s&sp=google");
    expect(
      firefoxSuggestionUrl("https://example.com", {
        bangPrefix: "$",
        provider: "startpage",
        snapPrefix: "~",
      })
    ).toBe("https://example.com/suggest?q=%s&sp=startpage&bp=%24&np=~");
  });
});
