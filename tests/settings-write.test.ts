import { describe, expect, test } from "bun:test";
import {
  HOT_BOOT_SETTING_KEYS,
  writeAffectsHotBoot,
} from "../src/ui/settings/write";

async function snapshotSettingKeys(): Promise<string[]> {
  const source = await Bun.file("src/sw/redirect-settings.ts").text();
  const body = source.slice(
    source.indexOf("function compileRedirectSettingsSnapshot"),
    source.indexOf("export function defaultRedirectSettingsSnapshot")
  );
  const keys = new Set<string>();
  for (const match of body.matchAll(/settingsMap\["([a-z-]+)"\]/g)) {
    keys.add(match[1]);
  }
  return [...keys].sort();
}

describe("hot-boot setting keys", () => {
  test("covers every setting the redirect snapshot is compiled from", async () => {
    const used = await snapshotSettingKeys();
    expect(used.length).toBeGreaterThan(0);
    for (const key of used) {
      expect(
        writeAffectsHotBoot(key),
        `${key} feeds the redirect snapshot but does not republish hot boot`
      ).toBe(true);
    }
  });

  test("custom bangs and imports republish too", () => {
    expect(writeAffectsHotBoot("custom-bangs")).toBe(true);
    expect(writeAffectsHotBoot("import")).toBe(true);
  });

  test("settings that do not affect redirects are excluded", () => {
    expect(writeAffectsHotBoot("suggest-provider")).toBe(false);
    expect(writeAffectsHotBoot("suggest-url")).toBe(false);
  });

  test("the declared list is sorted and free of duplicates", () => {
    const keys = [...HOT_BOOT_SETTING_KEYS];
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(keys.length);
  });
});
