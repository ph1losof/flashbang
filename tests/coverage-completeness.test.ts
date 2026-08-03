import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, posix, relative, resolve } from "node:path";

/**
 * Bun only reports coverage for files some test actually loads, so a module no
 * test reaches is absent from the report rather than counted as uncovered — it
 * silently inflates the percentage instead of lowering it. This test walks the
 * import graph out of `tests/` and fails when a source module is unreachable,
 * which keeps the coverage denominator honest as new modules land.
 */

const IMPORT_SPECIFIER =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'`](\.[^"'`]+)["'`]/g;
const GENERATED = "src/generated/";

function sourceFiles(): string[] {
  return [...new Bun.Glob("src/**/*.ts").scanSync(".")]
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => !path.startsWith(GENERATED))
    .sort();
}

/** Resolves a relative specifier the way the bundler and Bun both would. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  // Strip any cache-busting or asset query the specifier carries.
  const clean = specifier.split("?")[0];
  const base = resolve(dirname(fromFile), clean);
  const candidates = [
    base,
    `${base}.ts`,
    posix.join(base, "index.ts"),
    // `.js` specifiers point at generated declarations next to a `.ts` source.
    base.replace(/\.js$/, ".ts"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && candidate.endsWith(".ts")) {
      return relative(process.cwd(), candidate).replaceAll("\\", "/");
    }
  }
  return null;
}

async function importsOf(file: string): Promise<string[]> {
  const source = await Bun.file(file).text();
  const found: string[] = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const resolved = resolveSpecifier(file, match[1]);
    if (resolved) {
      found.push(resolved);
    }
  }
  return found;
}

describe("coverage denominator", () => {
  test("every source module is reachable from the test suite", async () => {
    const sources = sourceFiles();
    expect(sources.length).toBeGreaterThan(0);

    const queue = [...new Bun.Glob("tests/**/*.ts").scanSync(".")].map((path) =>
      path.replaceAll("\\", "/")
    );
    const seen = new Set<string>(queue);
    while (queue.length > 0) {
      const file = queue.pop() as string;
      for (const dependency of await importsOf(file)) {
        if (!seen.has(dependency)) {
          seen.add(dependency);
          queue.push(dependency);
        }
      }
    }

    const unreachable = sources.filter((path) => !seen.has(path));
    expect(
      unreachable,
      `No test reaches these modules, so they are missing from the coverage report entirely: ${unreachable.join(", ")}`
    ).toEqual([]);
  });
});
