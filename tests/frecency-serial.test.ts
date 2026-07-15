import { describe, expect, test } from "bun:test";
import {
  parseFrecencyCompact,
  serializeFrecencyCompact,
} from "../src/shared/frecency-serial";

describe("frecency compact serialization", () => {
  test("serializes null as empty string", () => {
    expect(serializeFrecencyCompact(null)).toBe("");
  });

  test("round-trips compact key/count pairs", () => {
    const counts = Object.create({ inherited: 99 }) as Record<string, number>;
    counts.g = 10;
    counts.ddg = 3;
    const serialized = serializeFrecencyCompact(counts);
    const parsed = parseFrecencyCompact(serialized);
    expect(parsed).toEqual({ g: 10, ddg: 3 });
    expect(serialized).not.toContain("inherited");
  });

  test("ignores malformed and non-positive entries during parse", () => {
    expect(parseFrecencyCompact("g:0,ddg:-1,yt:abc,w:4,broken")).toEqual({
      w: 4,
    });
  });
});
