import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildTrees, cpuProfiles } from "../scripts/clean";

const root = mkdtempSync(join(tmpdir(), "flashbang-clean-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function dir(...parts: string[]): string {
  const path = join(root, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

function file(parent: string, name: string): void {
  writeFileSync(join(parent, name), "x");
}

describe("buildTrees", () => {
  test("matches dist and every dist-* variant, and nothing else", () => {
    for (const name of [
      "dist",
      "dist-server",
      "dist-e2e",
      "dist-perf-shards32-e2e-server",
    ]) {
      dir(name);
    }
    // Neighbours that share a prefix or a name but are not build output.
    dir("distribution-notes");
    dir("src");
    file(root, "dist-notes.txt");

    expect(buildTrees(root)).toEqual([
      join(root, "dist"),
      join(root, "dist-e2e"),
      join(root, "dist-perf-shards32-e2e-server"),
      join(root, "dist-server"),
    ]);
  });
});

describe("cpuProfiles", () => {
  test("collects CPU profile artifacts but spares saved baselines", () => {
    const profiles = dir("profiles");
    file(profiles, "CPU.123.456.cpuprofile");
    file(profiles, "CPU.123.456.md");
    // Baselines are gitignored and unrecoverable from a later build.
    const baselines = dir("profiles", "baselines");
    file(baselines, "pre-ad.json");
    file(baselines, "notes.md");

    expect(cpuProfiles(profiles)).toEqual([
      join(profiles, "CPU.123.456.cpuprofile"),
      join(profiles, "CPU.123.456.md"),
    ]);
  });

  test("returns nothing when the profiles directory is absent", () => {
    expect(cpuProfiles(join(root, "no-such-dir"))).toEqual([]);
  });
});
