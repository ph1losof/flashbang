import { describe, expect, test } from "bun:test";
import {
  align2,
  align4,
  CHECKPOINT_SIZE,
  checkpointCount,
  PREFIX_HEADS,
  splitPrefixHead,
} from "../src/shared/bang-binary-format";

/** Layout primitives shared by codegen, the Service Worker, and the decoders. */

describe("checkpoint layout", () => {
  test("counts one checkpoint per stride, rounding up", () => {
    expect(checkpointCount(0)).toBe(0);
    expect(checkpointCount(1)).toBe(1);
    expect(checkpointCount(CHECKPOINT_SIZE)).toBe(1);
    expect(checkpointCount(CHECKPOINT_SIZE + 1)).toBe(2);
    expect(checkpointCount(CHECKPOINT_SIZE * 3)).toBe(3);
  });
});

describe("offset alignment", () => {
  test("align2 rounds up to the next even offset", () => {
    expect([0, 1, 2, 3, 4].map(align2)).toEqual([0, 2, 2, 4, 4]);
  });

  test("align4 rounds up to the next word offset", () => {
    expect([0, 1, 2, 3, 4, 5, 8].map(align4)).toEqual([0, 4, 4, 4, 4, 8, 8]);
  });

  test("aligning an aligned offset is a no-op", () => {
    for (const offset of [0, 2, 4, 16, 64]) {
      expect(align2(offset)).toBe(offset);
    }
    for (const offset of [0, 4, 16, 64]) {
      expect(align4(offset)).toBe(offset);
    }
  });
});

describe("prefix head encoding", () => {
  test.each([
    ["https://www.example.com/?q=", 3, "example.com/?q="],
    ["https://example.com/?q=", 2, "example.com/?q="],
    ["http://www.example.com/?q=", 5, "example.com/?q="],
    ["http://example.com/?q=", 4, "example.com/?q="],
    ["www.example.com/?q=", 1, "example.com/?q="],
    ["example.com/?q=", 0, "example.com/?q="],
  ])("splits %s", (prefix, head, payload) => {
    expect(splitPrefixHead(prefix)).toEqual({ head, payload });
  });

  test("every head code rebuilds the original prefix", () => {
    for (const prefix of [
      "https://www.example.com/",
      "https://example.com/",
      "http://www.example.com/",
      "http://example.com/",
      "www.example.com/",
      "example.com/",
    ]) {
      const { head, payload } = splitPrefixHead(prefix);
      expect(`${PREFIX_HEADS[head]}${payload}`).toBe(prefix);
    }
  });
});
