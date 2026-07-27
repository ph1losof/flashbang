import { describe, expect, test } from "bun:test";
import {
  compileSnapTarget,
  MAX_SNAP_TARGET_LENGTH,
  validateSnapTarget,
} from "../src/shared/snap-target";

describe("snap targets", () => {
  test("compiles domains and path-scoped targets", () => {
    expect(compileSnapTarget("www.example.com/docs/api/")).toEqual([
      "+site:example.com/docs/api",
      "https://www.example.com/docs/api",
    ]);
  });

  test("preserves an explicit http scheme and port", () => {
    expect(compileSnapTarget("http://localhost:8080/docs")).toEqual([
      "+site:localhost:8080/docs",
      "http://localhost:8080/docs",
    ]);
  });

  test("rejects unsafe or ambiguous targets", () => {
    expect(validateSnapTarget("   ")).toContain("empty");
    expect(
      validateSnapTarget("x".repeat(MAX_SNAP_TARGET_LENGTH + 1))
    ).toContain("at most");
    expect(validateSnapTarget("javascript://example.com")).toContain(
      "http or https"
    );
    expect(validateSnapTarget("example.com/docs?q=x")).toContain("query");
    expect(validateSnapTarget("user:pass@example.com")).toContain("Invalid");
    expect(validateSnapTarget("example.com/a b")).toContain("whitespace");
    expect(compileSnapTarget("http://[")).toBeNull();
  });
});
