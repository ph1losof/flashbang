import { beforeAll, describe, expect, test } from "bun:test";
import { HOT_PREFIXES, HOT_TRIGGERS } from "../src/generated/bangs-hot.js";
import { compileCaptureUrl } from "../src/shared/capture-template";
import { TRIGGER_PREFIXES } from "../src/shared/trigger-prefix";
import {
  createHotBootState,
  decodeHotBootRecord,
  encodeHotBootRecord,
  getResolvedHotTrigger,
  hotBootSettingsNeedPublish,
  MAX_HOT_BOOT_RECORD_LENGTH,
  materializeHotFrecency,
  NO_HOT_BOOT,
  parseHotBootRecord,
  resolveHotRedirect,
} from "../src/sw/hot-redirect";
import {
  type CustomUrlParts,
  compileTriggerSyntax,
  type RedirectSettings,
  redirectRawUrl,
} from "../src/sw/redirect";
import type { RedirectSettingsSnapshot } from "../src/sw/redirect-settings";
import { loadTestBangData } from "./helpers/bang-data";

const syntax = compileTriggerSyntax(";", "@")!;

function snapshot(
  custom: Record<string, CustomUrlParts> = Object.create(null),
  triggerSyntax = syntax
): RedirectSettingsSnapshot {
  return {
    custom,
    defaultBang: "g",
    luckyProvider: "default",
    luckyUrl: null,
    syntax: triggerSyntax,
  };
}

function settings(
  custom: Record<string, CustomUrlParts> = Object.create(null),
  triggerSyntax = syntax
): RedirectSettings {
  return {
    custom,
    defaultUrl: ["https://www.google.com/search?q=", ""],
    luckyUrl: ["https://duckduckgo.com/?q=\\", ""],
    syntax: triggerSyntax,
  };
}

beforeAll(loadTestBangData);

describe("service worker hot redirects", () => {
  test("round-trips a versioned build-specific boot record", () => {
    const state = createHotBootState(snapshot());
    const record = encodeHotBootRecord("fb-test", state);
    expect(record.startsWith("h1|fb-test|")).toBe(true);
    expect(record.length).toBeLessThan(32);
    expect(parseHotBootRecord(record, "fb-test")).toBe(state);
    expect(parseHotBootRecord(record, "fb-other")).toBe(NO_HOT_BOOT);
    expect(parseHotBootRecord("true", "fb-test")).toBe(NO_HOT_BOOT);
    expect(parseHotBootRecord("h3|fb-test|not-valid!", "fb-test")).toBe(
      NO_HOT_BOOT
    );
    expect(
      hotBootSettingsNeedPublish(decodeHotBootRecord(record, "fb-test"))
    ).toBe(true);
    expect(parseHotBootRecord(`${record}|not-base64!`, "fb-test")).toBe(
      NO_HOT_BOOT
    );
    expect(decodeHotBootRecord(`${record}|not-base64!`, "fb-test")).toBeNull();
  });

  test("round-trips materialized settings and every simple custom entry", () => {
    const custom = Object.assign(Object.create(null), {
      docs: [
        "https://docs.example/search?q=",
        "",
        ["+site:docs.example", "https://docs.example"],
      ],
      path: ["https://example.com/users/", ""],
      regex: compileCaptureUrl("https://example.com/$1", "^(.*)$", "percent")!,
    }) as Record<string, CustomUrlParts>;
    const sourceSnapshot = snapshot(custom);
    sourceSnapshot.defaultBang = "sp";
    const sourceSettings: RedirectSettings = {
      custom,
      defaultUrl: ["https://startpage.com/do/metasearch.pl?query=", ""],
      luckyUrl: ["https://duckduckgo.com/?q=\\", ""],
      syntax,
    };
    const state = createHotBootState(sourceSnapshot);
    const record = encodeHotBootRecord(
      "fb-test",
      state,
      sourceSnapshot,
      sourceSettings
    );

    expect(record.length).toBeLessThan(MAX_HOT_BOOT_RECORD_LENGTH);
    const decoded = decodeHotBootRecord(record, "fb-test")!;
    expect(decoded.state).toBe(state);
    expect(decoded.defaultBang).toBe("sp");
    expect(decoded.frecency).toEqual({});
    expect(hotBootSettingsNeedPublish(decoded)).toBe(false);
    expect(decoded.settings!.custom.regex).toBeUndefined();
    expect(redirectRawUrl("regular+query", decoded.settings!)).toBe(
      "https://startpage.com/do/metasearch.pl?query=regular+query"
    );
    expect(redirectRawUrl(";path+alice", decoded.settings!)).toBe(
      "https://example.com/users/alice"
    );
    expect(redirectRawUrl("@docs+service+workers", decoded.settings!)).toBe(
      "https://startpage.com/do/metasearch.pl?query=service+workers+site:docs.example"
    );
  });

  test("round-trips and resolves eligible personalized frecency bangs", () => {
    const sourceSnapshot = snapshot();
    const sourceSettings = settings();
    const frecency = materializeHotFrecency(
      { npm: 9, gh: 8, missing: 7 },
      sourceSnapshot
    );
    expect(frecency.map(([trigger]) => trigger)).toEqual(["npm"]);

    const state = createHotBootState(sourceSnapshot);
    const record = encodeHotBootRecord(
      "fb-test",
      state,
      sourceSnapshot,
      sourceSettings,
      frecency
    );
    const decoded = decodeHotBootRecord(record, "fb-test")!;
    expect(Object.keys(decoded.frecency!)).toEqual(["npm"]);
    expect(
      resolveHotRedirect(";npm+react%20router", state, decoded.frecency)
    ).toBe(redirectRawUrl(";npm+react%20router", sourceSettings));
    expect(getResolvedHotTrigger()).toBe("npm");

    const custom = Object.assign(Object.create(null), {
      npm: ["https://custom.example/?q=", ""],
    }) as Record<string, CustomUrlParts>;
    expect(materializeHotFrecency({ npm: 9 }, snapshot(custom))).toEqual([]);
  });

  test("caps personalized frecency payloads at eight entries", () => {
    const sourceSnapshot = snapshot();
    const state = createHotBootState(sourceSnapshot);
    const frecency = Array.from(
      { length: 9 },
      (_, index) =>
        [`personal${index}`, [`https://example.com/${index}?q=`, ""]] as const
    );
    const decoded = decodeHotBootRecord(
      encodeHotBootRecord(
        "fb-test",
        state,
        sourceSnapshot,
        settings(),
        frecency
      ),
      "fb-test"
    )!;
    expect(Object.keys(decoded.frecency!)).toHaveLength(8);
  });

  test("drops the complete rich payload rather than truncating oversized settings", () => {
    const custom = Object.create(null) as Record<string, CustomUrlParts>;
    for (let i = 0; i < 30; i++) {
      custom[`custom${i}`] = [
        `https://example.com/search/${"x".repeat(3_500)}?q=`,
        "",
      ];
    }
    const sourceSnapshot = snapshot(custom);
    const state = createHotBootState(sourceSnapshot);
    const record = encodeHotBootRecord(
      "fb-test",
      state,
      sourceSnapshot,
      settings(custom)
    );
    expect(record.endsWith("|-")).toBe(true);
    const decoded = decodeHotBootRecord(record, "fb-test")!;
    expect(decoded.state).toBe(state);
    expect(decoded.settings).toBeNull();
    expect(hotBootSettingsNeedPublish(decoded)).toBe(false);
    expect(
      decodeHotBootRecord(
        `${record}${"a".repeat(MAX_HOT_BOOT_RECORD_LENGTH)}`,
        "fb-test"
      )
    ).toBeNull();
  });

  test("normalizes a snapped custom default and rejects unsafe URLs", () => {
    const custom = Object.assign(Object.create(null), {
      docs: [
        "https://docs.example/search?q=",
        "",
        ["+site:docs.example", "https://docs.example"],
      ],
    }) as Record<string, CustomUrlParts>;
    const sourceSnapshot = snapshot(custom);
    sourceSnapshot.defaultBang = "docs";
    const sourceSettings = settings(custom);
    sourceSettings.defaultUrl = custom.docs as RedirectSettings["defaultUrl"];
    const state = createHotBootState(sourceSnapshot);
    const record = encodeHotBootRecord(
      "fb-test",
      state,
      sourceSnapshot,
      sourceSettings
    );
    const decoded = decodeHotBootRecord(record, "fb-test")!;
    expect(decoded.settings?.defaultUrl).toEqual([
      "https://docs.example/search?q=",
      "",
    ]);

    sourceSettings.defaultUrl = ["javascript:alert(1)", null];
    expect(
      decodeHotBootRecord(
        encodeHotBootRecord("fb-test", state, sourceSnapshot, sourceSettings),
        "fb-test"
      )
    ).toBeNull();
  });

  test("matches the full resolver for every generated hot bang", () => {
    expect(HOT_TRIGGERS).toHaveLength(24);
    expect(HOT_TRIGGERS).toContain("g");
    expect(HOT_TRIGGERS).toContain("gh");
    expect(HOT_PREFIXES.every((prefix) => prefix.includes("?"))).toBe(true);
    expect(HOT_PREFIXES.every((prefix) => !prefix.includes("#"))).toBe(true);
    const state = createHotBootState(snapshot());
    const fullSettings = settings();

    for (const trigger of HOT_TRIGGERS) {
      for (const raw of [
        `;${trigger}+fast%20query`,
        `%3B${trigger}%20fast+query`,
        `%3b${trigger}+fast%2Fquery+`,
      ]) {
        expect(resolveHotRedirect(raw, state), raw).toBe(
          redirectRawUrl(raw, fullSettings)
        );
        expect(getResolvedHotTrigger()).toBe(trigger);
      }
    }
  });

  test("matches every configured literal and encoded bang marker", () => {
    for (const marker of TRIGGER_PREFIXES) {
      const snapMarker = marker === "@" ? "!" : "@";
      const markerSyntax = compileTriggerSyntax(marker, snapMarker)!;
      const markerSnapshot = snapshot();
      markerSnapshot.syntax = markerSyntax;
      const state = createHotBootState(markerSnapshot);
      const fullSettings = settings();
      fullSettings.syntax = markerSyntax;
      const encoded = marker.charCodeAt(0).toString(16);
      for (const raw of [
        `${marker}gh+marker+test`,
        `%${encoded.toUpperCase()}gh%20marker+test`,
        `%${encoded.toLowerCase()}gh+marker%20test`,
      ]) {
        expect(resolveHotRedirect(raw, state), raw).toBe(
          redirectRawUrl(raw, fullSettings)
        );
      }
    }
  });

  test("falls back when a generated trigger has a custom override", () => {
    const custom = Object.assign(Object.create(null), {
      gh: ["https://custom.example/?q=", ""],
    }) as Record<string, CustomUrlParts>;
    const state = createHotBootState(snapshot(custom));
    expect(resolveHotRedirect(";gh+test", state)).toBeNull();
  });

  test("rejects forms outside the allocation-free prefix fast path", () => {
    const state = createHotBootState(snapshot());
    for (const raw of [
      ";gh",
      ";gh+",
      ";GH+test",
      "+;gh+test",
      "test+;gh",
      ";unknown+test",
      "!gh+test",
    ]) {
      expect(resolveHotRedirect(raw, state), raw).toBeNull();
    }
  });
});
