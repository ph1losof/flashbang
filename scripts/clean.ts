import { type Dirent, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Build trees: `dist/` plus every `DIST_DIR` variant and its `-server`
 * sibling. Experiment builds (`dist-perf-shards32`, `dist-e2e`, ...) otherwise
 * accumulate indefinitely and make the profiler's artifact fingerprints harder
 * to trust, since a stale tree looks exactly like a fresh one.
 */
const BUILD_TREE = /^dist(-.+)?$/;
/**
 * `bun run profile:cpu` leftovers. Saved baselines live in
 * `profiles/baselines/` and are never regenerable from a later build, so the
 * sweep only touches files sitting directly in `profiles/`.
 */
const CPU_PROFILE = /\.(?:cpuprofile|md)$/;

/** Root-level build output directories, oldest naming conventions included. */
export function buildTrees(root = "."): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && BUILD_TREE.test(entry.name))
    .map((entry) => join(root, entry.name))
    .sort();
}

/** CPU profile artifacts, excluding anything under `profiles/baselines/`. */
export function cpuProfiles(dir = "profiles"): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && CPU_PROFILE.test(entry.name))
    .map((entry) => join(dir, entry.name))
    .sort();
}

function bytesOf(path: string): number {
  const info = statSync(path, { throwIfNoEntry: false });
  if (!info) {
    return 0;
  }
  if (info.isFile()) {
    return info.size;
  }
  let total = 0;
  for (const entry of readdirSync(path, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (entry.isFile()) {
      const file = statSync(join(entry.parentPath, entry.name), {
        throwIfNoEntry: false,
      });
      total += file?.size ?? 0;
    }
  }
  return total;
}

function formatBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

function clean(dryRun: boolean): void {
  const targets = [...buildTrees(), ...cpuProfiles()];
  if (targets.length === 0) {
    console.log("Nothing to clean.");
    return;
  }

  let freed = 0;
  for (const target of targets) {
    const size = bytesOf(target);
    freed += size;
    console.log(
      `  ${dryRun ? "would remove" : "removed"} ${target}  ${formatBytes(size)}`
    );
    if (!dryRun) {
      rmSync(target, { recursive: true, force: true });
    }
  }
  console.log(
    `${dryRun ? "Would free" : "Freed"} ${formatBytes(freed)} across ${targets.length} path${targets.length === 1 ? "" : "s"}.`
  );
}

// Guarded: importing this module must never delete anything.
if (import.meta.main) {
  clean(process.argv.includes("--dry-run"));
}
