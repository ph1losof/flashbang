import { describe, expect, test } from "bun:test";
import {
  buildTopFrecency,
  type TopFrecencyEntry,
  updateTopFrecencyOnIncrement,
} from "../src/sw/frecency";

function serializeTop(top: readonly TopFrecencyEntry[]): string {
  if (top.length === 0) {
    return "";
  }
  let out = `${top[0].trigger}:${top[0].count}`;
  for (let i = 1; i < top.length; i++) {
    out += `.${top[i].trigger}:${top[i].count}`;
  }
  return out;
}

function baselineCookie(counts: Record<string, number>, limit: number): string {
  const sorted = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
  if (sorted.length === 0) {
    return "";
  }
  let out = `${sorted[0][0]}:${sorted[0][1]}`;
  for (let i = 1; i < sorted.length; i++) {
    out += `.${sorted[i][0]}:${sorted[i][1]}`;
  }
  return out;
}

describe("frecency top-k helpers", () => {
  test("buildTopFrecency sorts by count desc then trigger asc and caps limit", () => {
    const top = buildTopFrecency(
      { yt: 5, g: 10, ddg: 10, npm: 3, z: 1, bad: 0 },
      4
    );
    expect(top).toEqual([
      { trigger: "ddg", count: 10 },
      { trigger: "g", count: 10 },
      { trigger: "yt", count: 5 },
      { trigger: "npm", count: 3 },
    ]);
    expect(buildTopFrecency({ g: 1 }, 0)).toEqual([]);
  });

  test("updateTopFrecencyOnIncrement inserts and reorders incrementally", () => {
    const top: TopFrecencyEntry[] = [];

    updateTopFrecencyOnIncrement(top, "yt", 1, 3);
    updateTopFrecencyOnIncrement(top, "g", 1, 3);
    updateTopFrecencyOnIncrement(top, "g", 2, 3);
    updateTopFrecencyOnIncrement(top, "ddg", 2, 3);
    updateTopFrecencyOnIncrement(top, "npm", 1, 3);

    expect(top).toEqual([
      { trigger: "ddg", count: 2 },
      { trigger: "g", count: 2 },
      { trigger: "npm", count: 1 },
    ]);
  });

  test("incremental top-k matches baseline full sort for randomized updates", () => {
    const triggers = ["g", "yt", "ddg", "gh", "npm", "w", "mdn", "so", "x"];
    const counts: Record<string, number> = {};
    const top = buildTopFrecency(counts, 8);

    // Fixed pseudo-random sequence for deterministic test behavior.
    let seed = 42;
    const nextRand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed;
    };

    for (let i = 0; i < 5000; i++) {
      const trigger = triggers[nextRand() % triggers.length];
      const next = (counts[trigger] || 0) + 1;
      counts[trigger] = next;
      updateTopFrecencyOnIncrement(top, trigger, next, 8);

      const incremental = serializeTop(top);
      const baseline = baselineCookie(counts, 8);
      expect(incremental).toBe(baseline);
    }
  });
});
