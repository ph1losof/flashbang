import { expect, test } from "bun:test";

/**
 * The cold first-redirect bundle leaves the per-language edition table out and
 * loads it only when a destination actually carries `{lang}`. That only holds
 * while nothing on its import graph installs the table eagerly, and a single
 * stray `locale-table` import anywhere in that graph would silently undo it —
 * the redirect would still be correct, just ~1.6 KiB heavier on every cold
 * search. Module state is process-wide and other test files install the table,
 * so this runs in a fresh process to observe the uninstalled state.
 */
function runInFreshProcess(script: string): string {
  const result = Bun.spawnSync(["bun", "-e", script], {
    cwd: process.cwd(),
    stderr: "pipe",
    stdout: "pipe",
  });
  const stderr = result.stderr.toString().trim();
  if (result.exitCode !== 0) {
    throw new Error(stderr || `bun -e exited with ${result.exitCode}`);
  }
  return result.stdout.toString().trim();
}

test("substitution reports the table as unavailable until it is installed", () => {
  const output = runInFreshProcess(`
    const { localeTableUnavailable, substituteLocale } =
      await import("./src/sw/locale.ts");
    const { installLocaleTable } = await import("./src/shared/locale-tag.ts");
    let reported = false;
    try {
      substituteLocale("https://{lang}.wikipedia.org/w/index.php?search=");
    } catch (error) {
      reported = localeTableUnavailable(error);
    }
    installLocaleTable(await import("./src/shared/locale-table.ts"));
    const resolved = substituteLocale(
      "https://{lang}.wikipedia.org/w/index.php?search="
    );
    console.log(JSON.stringify({ reported, resolved }));
  `);
  const { reported, resolved } = JSON.parse(output);
  expect(reported).toBe(true);
  expect(resolved).not.toContain("{");
  expect(resolved).toMatch(/^https:\/\/[a-z-]+\.wikipedia\.org\//);
});

test("a destination without a locale marker never needs the table", () => {
  const output = runInFreshProcess(`
    const { substituteLocale } = await import("./src/sw/locale.ts");
    console.log(substituteLocale("https://github.com/search?q="));
  `);
  expect(output).toBe("https://github.com/search?q=");
});
