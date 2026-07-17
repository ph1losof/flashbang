import { describe, expect, test } from "bun:test";
import {
  decodeTriggerPrefixes,
  encodeTriggerPrefixes,
  isTriggerPrefix,
  resolveTriggerPrefixes,
  TRIGGER_PREFIXES,
} from "../src/shared/trigger-prefix";

describe("trigger prefix settings", () => {
  test("accepts exactly the supported prefix set", () => {
    for (const prefix of TRIGGER_PREFIXES) {
      expect(isTriggerPrefix(prefix)).toBe(true);
    }
    for (const value of ["", "#", "+", "ab", null, undefined]) {
      expect(isTriggerPrefix(value)).toBe(false);
    }
  });

  test("round-trips every distinct prefix pair compactly", () => {
    for (const bang of TRIGGER_PREFIXES) {
      for (const snap of TRIGGER_PREFIXES) {
        if (bang === snap) {
          continue;
        }
        const encoded = encodeTriggerPrefixes(bang, snap);
        expect(encoded).toHaveLength(2);
        expect(decodeTriggerPrefixes(encoded)).toEqual([bang, snap]);
      }
    }
  });

  test("falls back for invalid or equal persisted values", () => {
    expect(resolveTriggerPrefixes("$", "~")).toEqual(["$", "~"]);
    expect(resolveTriggerPrefixes("$", "$")).toEqual(["!", "@"]);
    expect(resolveTriggerPrefixes("#", "~")).toEqual(["!", "~"]);
    expect(decodeTriggerPrefixes("44")).toBeNull();
    expect(decodeTriggerPrefixes("99")).toBeNull();
  });
});
