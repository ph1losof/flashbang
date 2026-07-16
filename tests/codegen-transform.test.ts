import { describe, expect, spyOn, test } from "bun:test";
import { jsEscape, jsonEscape, validateBangs } from "../scripts/codegen";

describe("codegen string escaping", () => {
  test("preserves the minimal custom escape sets", () => {
    expect(jsEscape(`a'b\\c\nd\re"f\t`)).toBe(`a\\'b\\\\c\\nd\\re"f\t`);
    expect(jsonEscape(`a"b\\c\nd\re'f\t`)).toBe(`a\\"b\\\\c\\nd\\re'f\t`);
  });
});

describe("validateBangs", () => {
  test("rejects regular bangs that fail custom URL validation", () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {
      /* Expected validation warnings. */
    });
    try {
      const result = validateBangs([
        {
          domain: "example.com",
          name: "Valid",
          relevance: 1,
          trigger: "valid",
          url: "https://example.com/search?q={}",
        },
        {
          domain: "example.com",
          name: "Missing placeholder",
          relevance: 1,
          trigger: "missing",
          url: "https://example.com/search",
        },
        {
          domain: "example.com",
          name: "Unsafe scheme",
          relevance: 1,
          trigger: "unsafe",
          url: "javascript:alert({})",
        },
        {
          domain: "flashbang",
          name: "Settings",
          relevance: 1,
          trigger: "settings",
          url: "/settings",
        },
      ]);

      expect(result.map((bang) => bang.trigger)).toEqual(["valid", "settings"]);
      expect(errorSpy).toHaveBeenCalledTimes(2);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
