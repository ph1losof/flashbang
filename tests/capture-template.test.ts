import { describe, expect, test } from "bun:test";
import {
  CAPTURE_ENCODE_PERCENT,
  CAPTURE_ENCODE_PLUS,
  CAPTURE_ENCODE_RAW,
  captureEncodingCode,
  compileCaptureUrl,
  isCaptureEncoding,
  MAX_CAPTURE_PATTERN_LENGTH,
  MAX_CAPTURE_TEMPLATE_LENGTH,
  parseCaptureTemplate,
  validateCaptureBang,
  validateSimpleBangUrl,
} from "../src/shared/capture-template";

describe("capture templates", () => {
  test("precompiles repeated and ordered placeholders", () => {
    expect(parseCaptureTemplate("https://example.com/$2/$1?q=$2")).toEqual([
      "https://example.com/",
      ["/", "?q=", ""],
      [2, 1, 2],
    ]);
  });

  test("compiles a safe capture template", () => {
    const compiled = compileCaptureUrl(
      "https://example.com/$1/$2",
      "(\\w+)\\s+(.*)",
      "percent"
    );
    expect(compiled?.[0]).toBe("https://example.com/");
    expect(compiled?.[2]).toEqual([1, 2]);
    expect(compiled?.[3].exec("en hello")?.slice(1)).toEqual(["en", "hello"]);
  });

  test("rejects missing and out-of-range captures", () => {
    expect(validateCaptureBang("https://example.com/{}", "(.*)")).toContain(
      "either"
    );
    expect(validateCaptureBang("https://example.com/$2", "(.*)")).toContain(
      "matching capture group"
    );
    expect(validateCaptureBang("https://$1.example.com/", "(.*)")).toContain(
      "origin"
    );
  });

  test("rejects unsafe regex constructs", () => {
    expect(validateCaptureBang("https://example.com/$1", "(a+)+$")).toContain(
      "Nested"
    );
    expect(validateCaptureBang("https://example.com/$1", "((a+))+$")).toContain(
      "Nested"
    );
    expect(validateCaptureBang("https://example.com/$1", "(a|aa)+$")).toContain(
      "ambiguous"
    );
    expect(validateCaptureBang("https://example.com/$1", "(a)\\1")).toContain(
      "Backreferences"
    );
    expect(
      validateCaptureBang("https://example.com/$1", "(?<value>a)\\k<value>")
    ).toContain("Backreferences");
  });

  test("maps and recognizes every capture encoding", () => {
    expect(captureEncodingCode("raw")).toBe(CAPTURE_ENCODE_RAW);
    expect(captureEncodingCode("plus")).toBe(CAPTURE_ENCODE_PLUS);
    expect(captureEncodingCode("percent")).toBe(CAPTURE_ENCODE_PERCENT);
    expect(captureEncodingCode(undefined)).toBe(CAPTURE_ENCODE_PERCENT);
    expect(["percent", "plus", "raw"].every(isCaptureEncoding)).toBe(true);
    expect(isCaptureEncoding("other")).toBe(false);
  });

  test("rejects capture templates and patterns beyond their limits", () => {
    expect(parseCaptureTemplate("https://example.com/$33")).toBeNull();
    expect(parseCaptureTemplate("https://example.com/no-captures")).toBeNull();
    expect(
      validateCaptureBang(
        `https://example.com/${"x".repeat(MAX_CAPTURE_TEMPLATE_LENGTH)}$1`,
        "(.*)"
      )
    ).toContain("URL template must be at most");
    expect(
      validateCaptureBang(
        "https://example.com/$1",
        `(${"a".repeat(MAX_CAPTURE_PATTERN_LENGTH)})`
      )
    ).toContain("Regex must be at most");
    expect(
      validateCaptureBang("https://example.com/$1", "a{1001}(b)")
    ).toContain("must not exceed 1000");
    expect(validateCaptureBang("https://example.com/$1", "abc")).toContain(
      "at least one capture group"
    );
    expect(
      validateCaptureBang("https://example.com/$1", "([a-z]{1,1000})")
    ).toBeNull();
    expect(
      validateCaptureBang("https://example.com/$1", "()".repeat(33))
    ).toContain("at most 32 capture groups");
  });

  test("rejects invalid regexes, protocols, and URL templates", () => {
    expect(
      validateCaptureBang("https://example.com/no-placeholder", "(.*)")
    ).toContain("capture placeholder");
    expect(validateCaptureBang("https://example.com/$1", "(")).toContain(
      "Invalid regular expression"
    );
    expect(validateCaptureBang("ftp://example.com/$1", "(.*)")).toContain(
      "http or https"
    );
    expect(validateCaptureBang("not a url/$1", "(.*)")).toContain(
      "Invalid URL template"
    );
    expect(
      compileCaptureUrl("https://example.com/{}", "(.*)", "raw")
    ).toBeNull();
  });

  test("validates simple bang URLs", () => {
    expect(validateSimpleBangUrl("https://example.com/?q={}")).toBeNull();
    expect(validateSimpleBangUrl("https://example.com/search")).toContain(
      "must contain"
    );
    expect(validateSimpleBangUrl("ftp://example.com/{}")).toContain(
      "http or https"
    );
    expect(validateSimpleBangUrl("not a url/{}")).toContain(
      "Invalid URL template"
    );
  });
});
