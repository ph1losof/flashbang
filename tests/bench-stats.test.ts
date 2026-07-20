import { describe, expect, test } from "bun:test";
import { computeStats } from "../src/ui/bench/stats";

describe("benchmark statistics", () => {
  test("uses an averaged median and nearest-rank percentile", () => {
    const stats = computeStats([4, 1, 3, 2]);

    expect(stats.median).toBe(2.5);
    expect(stats.mean).toBe(2.5);
    expect(stats.p95).toBe(4);
    expect(stats.mad).toBe(1);
    expect(stats.medianCiLow).toBe(1);
    expect(stats.medianCiHigh).toBe(4);
  });

  test("selects the nearest-rank p95 without an off-by-one", () => {
    const stats = computeStats(
      Array.from({ length: 100 }, (_, index) => index + 1)
    );

    expect(stats.median).toBe(50.5);
    expect(stats.p95).toBe(95);
  });

  test("rejects empty samples", () => {
    expect(() => computeStats([])).toThrow("empty benchmark sample");
  });
});
