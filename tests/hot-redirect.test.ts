import { beforeAll, describe, expect, test } from "bun:test";
import { HOT_PREFIXES, HOT_TRIGGERS } from "../src/generated/bangs-hot.js";
import { compileCaptureUrl } from "../src/shared/capture-template";
import { HOT_BOOT_VERSION } from "../src/shared/hot-boot";
import "../src/shared/locale-table-install";
import { TRIGGER_PREFIXES } from "../src/shared/trigger-prefix";
import {
  createHotBootState,
  decodeHotBootRecord,
  encodeHotBootRecord,
  hotBootSettingsNeedPublish,
  lookupGeneratedHotBang,
  materializeCompactBaseSettings,
  materializeHotFrecency,
  NO_HOT_BOOT,
  parseHotBootRecord,
} from "../src/sw/hot-redirect";
import {
  type CustomUrlParts,
  compileTriggerSyntax,
  isHotBangLookupBlocked,
  type RedirectSettings,
  redirectRawUrl,
} from "../src/sw/redirect";
import { loadTestBangData } from "./helpers/bang-data";
import {
  redirectSettings,
  redirectSettingsSnapshot,
} from "./helpers/redirect-fixtures";

const syntax = compileTriggerSyntax(";", "@")!;

function snapshot(
  custom: Record<string, CustomUrlParts> = Object.create(null),
  triggerSyntax = syntax
) {
  return redirectSettingsSnapshot({ custom, syntax: triggerSyntax });
}

function settings(
  custom: Record<string, CustomUrlParts> = Object.create(null),
  triggerSyntax = syntax
): RedirectSettings {
  return redirectSettings({
    custom,
    luckyUrl: ["https://duckduckgo.com/?q=\\", ""],
    syntax: triggerSyntax,
  });
}

function recordWithCustomEntry(entry: unknown): string {
  const sourceSnapshot = snapshot();
  const state = createHotBootState(sourceSnapshot);
  const payload = btoa(
    JSON.stringify([
      "g",
      ["https://www.google.com/search?q=", ""],
      null,
      [59, 64],
      [["advanced", entry]],
      [],
      null,
    ])
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `${HOT_BOOT_VERSION}|fb-test|${state.toString(36)}|${payload}`;
}

function encodePayload(fields: readonly unknown[]): string {
  return btoa(JSON.stringify(fields))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

beforeAll(loadTestBangData);

describe("service worker hot redirects", () => {
  test("round-trips a versioned build-specific boot record", () => {
    const state = createHotBootState(snapshot());
    const record = encodeHotBootRecord("fb-test", state);
    expect(record.startsWith(`${HOT_BOOT_VERSION}|fb-test|`)).toBe(true);
    expect(record.length).toBeLessThan(32);
    expect(parseHotBootRecord(record, "fb-test")).toBe(state);
    const decoded = decodeHotBootRecord(record, "fb-test")!;
    expect(decoded.baseComplete).toBe(false);
    expect(decoded.hotBangLookup).toBe(lookupGeneratedHotBang);
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
    expect(decodeHotBootRecord(`${record}|-`, "fb-test")).toBeNull();
  });

  test("round-trips non-authoritative compact base settings", () => {
    const sourceSnapshot = snapshot();
    const compactSettings = materializeCompactBaseSettings(sourceSnapshot)!;
    const record = encodeHotBootRecord(
      "fb-test",
      createHotBootState(sourceSnapshot),
      undefined,
      compactSettings
    );
    const decoded = decodeHotBootRecord(record, "fb-test")!;

    expect(record.length).toBeLessThan(256);
    expect(decoded.baseComplete).toBe(true);
    expect(decoded.payloadComplete).toBe(false);
    expect(decoded.settings).toBeNull();
    expect(decoded.hotBangLookup).toBe(lookupGeneratedHotBang);
    expect(redirectRawUrl("plain+query", decoded.compactSettings!)).toBe(
      "https://www.google.com/search?q=plain+query"
    );
    expect(redirectRawUrl("\\lucky", decoded.compactSettings!)).toContain(
      "btnI=1"
    );
    expect(
      redirectRawUrl(
        "@gh+service+workers",
        decoded.compactSettings!,
        decoded.hotBangLookup
      )
    ).toContain("site:github.com");
    expect(decodeHotBootRecord(`${record}bad`, "fb-test")).toBeNull();
  });

  test("materializes compact base settings only from available data", () => {
    const prepared = settings();
    expect(materializeCompactBaseSettings(snapshot(), prepared)).toEqual({
      custom: Object.create(null),
      defaultUrl: prepared.defaultUrl,
      luckyUrl: prepared.luckyUrl,
      syntax: prepared.syntax,
    });

    const unknown = snapshot();
    unknown.defaultBang = "not-a-generated-hot-bang";
    expect(materializeCompactBaseSettings(unknown)).toBeNull();

    const custom = Object.assign(Object.create(null), {
      docs: ["https://docs.example/search?q=", ""],
    }) as Record<string, CustomUrlParts>;
    const customDefault = snapshot(custom);
    customDefault.defaultBang = "docs";
    expect(materializeCompactBaseSettings(customDefault)?.defaultUrl).toEqual([
      "https://docs.example/search?q=",
      "",
    ]);

    const captureDefault = snapshot(
      Object.assign(Object.create(null), {
        capture: compileCaptureUrl(
          "https://capture.example/$1",
          "^(.+)$",
          "percent"
        )!,
      })
    );
    captureDefault.defaultBang = "capture";
    expect(
      materializeCompactBaseSettings(captureDefault)?.defaultUrl[0]
    ).toContain("google.com");

    for (const [provider, expected] of [
      ["none", null],
      ["google", "google.com"],
      ["ddg", "duckduckgo.com"],
      ["kagi", "kagi.com"],
    ] as const) {
      const providerSnapshot = snapshot();
      providerSnapshot.luckyProvider = provider;
      const luckyUrl =
        materializeCompactBaseSettings(providerSnapshot)?.luckyUrl;
      if (expected) {
        expect(luckyUrl?.[0]).toContain(expected);
      } else {
        expect(luckyUrl).toBeNull();
      }
    }
    const customLucky = snapshot();
    customLucky.luckyProvider = "custom";
    customLucky.luckyUrl = ["https://lucky.example/?q=", ""];
    expect(materializeCompactBaseSettings(customLucky)?.luckyUrl).toEqual(
      customLucky.luckyUrl
    );
  });

  test("round-trips materialized settings and every custom entry", () => {
    const snappedCapture = [
      ...compileCaptureUrl(
        "https://translate.example/$1/$2",
        "^(\\w+)\\s+(.+)$",
        "plus"
      )!,
      ["+site:translate.example/docs", "https://translate.example/docs"],
    ] as CustomUrlParts;
    const custom = Object.assign(Object.create(null), {
      docs: [
        "https://docs.example/search?q=",
        "",
        ["+site:docs.example", "https://docs.example"],
      ],
      path: ["https://example.com/users/", ""],
      regex: compileCaptureUrl("https://example.com/$1", "^(.*)$", "percent")!,
      raw: compileCaptureUrl("https://example.com/raw/$1", "^(.*)$", "raw")!,
      snapped: snappedCapture,
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

    const decoded = decodeHotBootRecord(record, "fb-test")!;
    expect(decoded.state).toBe(state);
    expect(decoded.baseComplete).toBe(true);
    expect(decoded.defaultBang).toBe("sp");
    expect(decoded.frecency).toEqual({});
    expect(hotBootSettingsNeedPublish(decoded)).toBe(false);
    expect(decoded.settings!.custom.regex?.[3]).toBeInstanceOf(RegExp);
    expect(decoded.settings!.custom.raw?.[3]).toBeInstanceOf(RegExp);
    expect(decoded.settings!.custom.snapped?.[3]).toBeInstanceOf(RegExp);
    expect(redirectRawUrl("regular+query", decoded.settings!)).toBe(
      "https://startpage.com/do/metasearch.pl?query=regular+query"
    );
    expect(redirectRawUrl(";path+alice", decoded.settings!)).toBe(
      "https://example.com/users/alice"
    );
    expect(redirectRawUrl(";regex+hello%20world", decoded.settings!)).toBe(
      "https://example.com/hello%20world"
    );
    expect(redirectRawUrl(";raw+hello%2Fworld", decoded.settings!)).toBe(
      "https://example.com/raw/hello/world"
    );
    expect(
      redirectRawUrl(";snapped+french%20bonjour%20monde", decoded.settings!)
    ).toBe("https://translate.example/french/bonjour+monde");
    expect(redirectRawUrl("@docs+service+workers", decoded.settings!)).toBe(
      "https://startpage.com/do/metasearch.pl?query=service+workers+site:docs.example"
    );
    expect(redirectRawUrl("@snapped+service+workers", decoded.settings!)).toBe(
      "https://startpage.com/do/metasearch.pl?query=service+workers+site:translate.example/docs"
    );
    for (const query of [
      ";snapped+french%20bonjour%20monde",
      "french%20bonjour%20monde+;snapped",
      "french%20bonjour%20monde+snapped;",
      "service+workers+@snapped",
    ]) {
      expect(redirectRawUrl(query, decoded.settings!), query).toBe(
        redirectRawUrl(query, sourceSettings)
      );
    }
  });

  test("rejects malformed advanced entries in untrusted boot metadata", () => {
    for (const entry of [
      ["javascript:alert($1)", "^(.*)$", 1],
      ["https://example.com/$1", "^(a+)+$", 1],
      ["https://example.com/$1", "^(.*)$", 3],
      [
        "https://example.com/$1",
        "^(.*)$",
        1,
        ["+site:example.com", "javascript:alert(1)"],
      ],
      [
        "https://example.com/$1",
        "^(.*)$",
        1,
        ["+site:other.example", "https://example.com"],
      ],
    ]) {
      expect(
        decodeHotBootRecord(recordWithCustomEntry(entry), "fb-test")
      ).toBeNull();
    }
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
      redirectRawUrl(
        ";npm+react%20router",
        sourceSettings,
        decoded.hotBangLookup
      )
    ).toBe(redirectRawUrl(";npm+react%20router", sourceSettings));

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

  test("round-trips settings larger than the previous metadata limit", () => {
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
    expect(record.length).toBeGreaterThan(96 * 1024);
    expect(record.endsWith("|-")).toBe(false);
    const decoded = decodeHotBootRecord(record, "fb-test")!;
    expect(decoded.state).toBe(state);
    expect(Object.keys(decoded.settings!.custom)).toHaveLength(30);
    expect(hotBootSettingsNeedPublish(decoded)).toBe(false);
    expect(redirectRawUrl(";custom29+query", decoded.settings!)).toContain(
      "q=query"
    );
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

  test("resolves every generated hot bang through the canonical parser", () => {
    expect(HOT_TRIGGERS).toHaveLength(24);
    expect(HOT_TRIGGERS).toContain("g");
    expect(HOT_TRIGGERS).toContain("gh");
    expect(HOT_PREFIXES.every((prefix) => prefix.includes("?"))).toBe(true);
    expect(HOT_PREFIXES.every((prefix) => !prefix.includes("#"))).toBe(true);
    const fullSettings = settings();

    for (const trigger of HOT_TRIGGERS) {
      for (const raw of [
        `;${trigger}+fast%20query`,
        `%3B${trigger}%20fast+query`,
        `%3b${trigger}+fast%2Fquery+`,
      ]) {
        expect(
          redirectRawUrl(raw, fullSettings, lookupGeneratedHotBang),
          raw
        ).toContain("fast");
      }
    }
  });

  test("matches every configured literal and encoded bang marker", () => {
    for (const marker of TRIGGER_PREFIXES) {
      const snapMarker = marker === "@" ? "!" : "@";
      const markerSyntax = compileTriggerSyntax(marker, snapMarker)!;
      const fullSettings = settings();
      fullSettings.syntax = markerSyntax;
      const encoded = marker.charCodeAt(0).toString(16);
      for (const raw of [
        `${marker}gh+marker+test`,
        `%${encoded.toUpperCase()}gh%20marker+test`,
        `%${encoded.toLowerCase()}gh+marker%20test`,
      ]) {
        expect(
          redirectRawUrl(raw, fullSettings, lookupGeneratedHotBang),
          raw
        ).toContain("marker");
      }
    }
  });

  test("keeps custom overrides ahead of generated hot bangs", () => {
    const custom = Object.assign(Object.create(null), {
      gh: ["https://custom.example/?q=", ""],
    }) as Record<string, CustomUrlParts>;
    expect(
      redirectRawUrl(";gh+test", settings(custom), lookupGeneratedHotBang)
    ).toBe("https://custom.example/?q=test");
  });

  test("blocks compact generated bangs with custom overrides", () => {
    const custom = Object.assign(Object.create(null), {
      gh: ["https://custom.example/?q=", ""],
    }) as Record<string, CustomUrlParts>;
    const sourceSnapshot = snapshot(custom);
    const compact = decodeHotBootRecord(
      encodeHotBootRecord(
        "fb-test",
        createHotBootState(sourceSnapshot),
        undefined,
        materializeCompactBaseSettings(sourceSnapshot)!
      ),
      "fb-test"
    )!;

    let blocked: unknown;
    try {
      redirectRawUrl(
        ";gh+test",
        compact.compactSettings!,
        compact.hotBangLookup
      );
    } catch (error) {
      blocked = error;
    }
    expect(isHotBangLookupBlocked(blocked)).toBe(true);
  });

  test("uses hot data across canonical bare, suffix, snap, and encoded forms", () => {
    const fullSettings = settings();
    const resolve = (raw: string) =>
      redirectRawUrl(raw, fullSettings, lookupGeneratedHotBang);
    expect(resolve(";gh")).toBe("https://github.com/");
    expect(resolve(";GH+test")).toContain("q=test");
    expect(resolve("test+;gh")).toContain("q=test");
    expect(resolve("%3Bgh")).toBe("https://github.com/");
    expect(resolve("@gh+test")).toContain("site:github.com");
  });

  test("rejects hot-boot records written by an earlier wire format", () => {
    const sourceSnapshot = snapshot();
    const state = createHotBootState(sourceSnapshot);
    const legacy = `h1|fb-test|${state.toString(36)}|${encodePayload([
      "g",
      ["https://www.google.com/search?q=", ""],
      null,
      [59, 64],
      [],
      [],
    ])}`;
    expect(decodeHotBootRecord(legacy, "fb-test")).toBeNull();
    expect(parseHotBootRecord(legacy, "fb-test")).toBe(NO_HOT_BOOT);

    const shortPayload = `${HOT_BOOT_VERSION}|fb-test|${state.toString(
      36
    )}|${encodePayload([
      "g",
      ["https://www.google.com/search?q=", ""],
      null,
      [59, 64],
      [],
      [],
    ])}`;
    expect(decodeHotBootRecord(shortPayload, "fb-test")).toBeNull();
  });

  test("round-trips the locale through both payload forms", () => {
    const localized = { ...snapshot(), locale: "de-de" };
    const full = decodeHotBootRecord(
      encodeHotBootRecord(
        "fb-test",
        createHotBootState(localized),
        localized,
        settings(),
        []
      ),
      "fb-test"
    );
    expect(full?.locale).toBe("de-de");

    const compact = decodeHotBootRecord(
      encodeHotBootRecord(
        "fb-test",
        createHotBootState(localized),
        undefined,
        materializeCompactBaseSettings(localized)!,
        [],
        "de-de"
      ),
      "fb-test"
    );
    expect(compact?.locale).toBe("de-de");

    const bare = decodeHotBootRecord(
      encodeHotBootRecord("fb-test", createHotBootState(localized)),
      "fb-test"
    );
    expect(bare?.locale).toBeNull();
  });

  test("rejects a malformed locale in an untrusted record", () => {
    const sourceSnapshot = snapshot();
    const state = createHotBootState(sourceSnapshot);
    for (const bad of ["de/evil.com", "../x", "d".repeat(200), 7, {}]) {
      const raw = `${HOT_BOOT_VERSION}|fb-test|${state.toString(
        36
      )}|${encodePayload([
        "g",
        ["https://www.google.com/search?q=", ""],
        null,
        [59, 64],
        [],
        [],
        bad,
      ])}`;
      expect(decodeHotBootRecord(raw, "fb-test")).toBeNull();
    }
  });
});
