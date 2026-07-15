import { describe, expect, test } from "bun:test";
import {
  MAX_CUSTOM_TRIGGER_LENGTH,
  validateCustomTrigger,
} from "../src/shared/custom-trigger";

describe("custom trigger validation", () => {
  test("accepts parser-safe triggers", () => {
    for (const trigger of ["g", "github", "foo-bar", "foo.bar", "r/test"]) {
      expect(validateCustomTrigger(trigger)).toBeNull();
    }
  });

  test("rejects empty and excessively long triggers", () => {
    expect(validateCustomTrigger("")).toBe("Shortcut is required");
    expect(
      validateCustomTrigger("a".repeat(MAX_CUSTOM_TRIGGER_LENGTH))
    ).toBeNull();
    expect(
      validateCustomTrigger("a".repeat(MAX_CUSTOM_TRIGGER_LENGTH + 1))
    ).toContain(`at most ${MAX_CUSTOM_TRIGGER_LENGTH}`);
  });

  test("rejects literal parser separators", () => {
    for (const trigger of [
      "two words",
      "two\twords",
      "foo!bar",
      "foo@bar",
      "foo+bar",
      "foo,bar",
      "foo:bar",
    ]) {
      expect(validateCustomTrigger(trigger)).not.toBeNull();
    }
  });

  test("rejects percent-encoded parser separators", () => {
    for (const trigger of [
      "foo%20bar",
      "foo%21bar",
      "foo%40bar",
      "foo%2fBAR%40baz",
    ]) {
      expect(validateCustomTrigger(trigger)).toContain("encoded separators");
    }
  });

  test("rejects reserved triggers case-insensitively", () => {
    for (const trigger of [
      "settings",
      "SETTINGS",
      "__proto__",
      "constructor",
      "prototype",
    ]) {
      expect(validateCustomTrigger(trigger)).toContain("reserved");
    }
  });
});
