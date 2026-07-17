import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetDB } from "../src/shared/idb";
import { DB, SETTINGS_SCHEMA_VERSION } from "../src/ui/db";
import { resolveSuggestProvider } from "../src/ui/suggest-provider";
import { installFakeIndexedDb } from "./helpers/fake-indexeddb";

let restoreIndexedDb: (() => void) | null = null;

beforeEach(() => {
  restoreIndexedDb = installFakeIndexedDb();
  resetDB();
});

afterEach(() => {
  resetDB();
  restoreIndexedDb?.();
  restoreIndexedDb = null;
});

describe("custom bang import and export", () => {
  test("exports the current settings schema version", async () => {
    const db = new DB();

    const exported = await db.exportAll();

    expect(exported.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
  });

  test("rejects empty documents without replacing existing data", async () => {
    const db = new DB();
    await db.setSetting("default-bang", "ddg");
    await db.addCustomBang({
      trigger: "keep",
      name: "Keep",
      url: "https://example.com?q={}",
    });

    await expect(db.importAll({})).rejects.toThrow(
      "Import document contains no recognized data"
    );

    expect(await db.getSetting("default-bang")).toBe("ddg");
    expect(await db.getAllCustomBangs()).toHaveLength(1);
  });

  test("rejects invalid settings and versions before replacing data", async () => {
    const db = new DB();
    await db.setSetting("suggest-provider", "ddg");

    await expect(
      db.importAll({
        schemaVersion: SETTINGS_SCHEMA_VERSION + 1,
        settings: { suggestProvider: "none" },
        customBangs: [],
      })
    ).rejects.toThrow("Unsupported settings schema version");
    await expect(
      db.importAll({
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        settings: {
          suggestProvider: "custom",
          suggestUrl: "javascript:alert({})",
        },
        customBangs: [],
      })
    ).rejects.toThrow("Invalid suggestion URL template");

    expect(await db.getSetting("suggest-provider")).toBe("ddg");
  });

  test("rejects prototype-named settings without replacing data", async () => {
    const db = new DB();
    await db.setSetting("default-bang", "ddg");
    await db.addCustomBang({
      trigger: "keep",
      name: "Keep",
      url: "https://example.com/keep?q={}",
    });

    for (const key of ["constructor", "__proto__"]) {
      const document = JSON.parse(
        `{"settings":{"${key}":"default-bang"},"customBangs":[]}`
      );
      await expect(db.importAll(document)).rejects.toThrow(
        `Unrecognized setting: ${key}`
      );
    }

    expect(await db.getSetting("default-bang")).toBe("ddg");
    expect(await db.getAllCustomBangs()).toHaveLength(1);
  });

  test("preserves frecency while replacing configurable settings", async () => {
    const db = new DB();
    await db.setSetting("default-bang", "g");
    await db.setSetting("frecency", "123|g:5,ddg:2");

    await db.importAll({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      settings: { defaultBang: "ddg" },
      customBangs: [],
    });

    expect(await db.getSetting("default-bang")).toBe("ddg");
    expect(await db.getSetting("frecency")).toBe("123|g:5,ddg:2");
  });

  test("round-trips current-schema exports with custom provider URLs", async () => {
    const db = new DB();
    await db.setSetting("default-bang", "ddg");
    await db.setSetting("suggest-provider", "custom");
    await db.setSetting("suggest-url", "https://suggest.example/?q={}");
    await db.setSetting("lucky-provider", "custom");
    await db.setSetting("lucky-url", "https://lucky.example/?q={}");
    const exported = await db.exportAll();

    await db.setSetting("suggest-provider", "none");
    await db.setSetting("lucky-provider", "none");
    const result = await db.importAll(exported);

    expect(result.replaced).toBe(true);
    expect(
      await db.getMultipleSettings([
        "default-bang",
        "suggest-provider",
        "suggest-url",
        "lucky-provider",
        "lucky-url",
      ])
    ).toEqual([
      "ddg",
      "custom",
      "https://suggest.example/?q={}",
      "custom",
      "https://lucky.example/?q={}",
    ]);
  });

  test("round-trips distinct bang and snap prefixes", async () => {
    const db = new DB();
    await db.setSetting("bang-prefix", "$");
    await db.setSetting("snap-prefix", "~");

    const exported = await db.exportAll();
    await db.setSetting("bang-prefix", "!");
    await db.setSetting("snap-prefix", "@");
    await db.importAll(exported);

    expect(
      await db.getMultipleSettings(["bang-prefix", "snap-prefix"])
    ).toEqual(["$", "~"]);
  });

  test("rejects invalid or equal imported prefixes before replacing data", async () => {
    const db = new DB();
    await db.setSetting("default-bang", "ddg");

    for (const settings of [
      { bangPrefix: "#", snapPrefix: "@" },
      { bangPrefix: "$", snapPrefix: "$" },
    ]) {
      await expect(
        db.importAll({
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          settings,
          customBangs: [],
        })
      ).rejects.toThrow();
    }

    expect(await db.getSetting("default-bang")).toBe("ddg");
  });

  test("round-trips legacy exports with custom provider URLs", async () => {
    const db = new DB();
    const legacy = {
      settings: {
        defaultBang: "g",
        suggestProvider: "custom",
        suggestUrl: "https://suggest.example/?q={}",
        luckyProvider: "custom",
        luckyUrl: "https://lucky.example/?q={}",
      },
      customBangs: [],
      exported: "2026-01-01T00:00:00.000Z",
    };

    const result = await db.importAll(legacy);
    const exported = await db.exportAll();

    expect(result.replaced).toBe(true);
    expect(exported.settings).toEqual({
      ...legacy.settings,
      bangPrefix: null,
      snapPrefix: null,
    });
  });

  test("refuses to export malformed legacy custom settings", async () => {
    const db = new DB();
    await db.setSetting("suggest-provider", "custom");
    await db.setSetting("suggest-url", "https://example.com/no-placeholder");

    await expect(db.exportAll()).rejects.toThrow(
      "Invalid suggestion URL template"
    );
    expect(await db.getSetting("suggest-provider")).toBe("custom");
    expect(await db.getSetting("suggest-url")).toBe(
      "https://example.com/no-placeholder"
    );
  });

  test("summarizes accepted and rejected records before confirmation", async () => {
    const db = new DB();
    await db.addCustomBang({
      trigger: "keep",
      name: "Keep",
      url: "https://example.com/keep?q={}",
    });
    let confirmationSummary: unknown;

    const canceled = await db.importAll(
      {
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        settings: { defaultBang: "g" },
        customBangs: [
          {
            trigger: "valid",
            name: "Valid",
            url: "https://example.com/valid?q={}",
          },
          {
            trigger: "invalid",
            name: "Invalid",
            url: "https://example.com/missing-placeholder",
          },
        ],
      },
      (summary) => {
        confirmationSummary = summary;
        return false;
      }
    );

    expect(confirmationSummary).toEqual({
      acceptedCustomBangs: 1,
      rejectedCustomBangs: 1,
      importedSettings: 1,
      replaced: false,
    });
    expect(canceled.replaced).toBe(false);
    expect(await db.getAllCustomBangs()).toEqual([
      {
        trigger: "keep",
        name: "Keep",
        url: "https://example.com/keep?q={}",
      },
    ]);

    const imported = await db.importAll({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      settings: { defaultBang: "g" },
      customBangs: [
        {
          trigger: "valid",
          name: "Valid",
          url: "https://example.com/valid?q={}",
        },
        {
          trigger: "invalid",
          name: "Invalid",
          url: "https://example.com/missing-placeholder",
        },
      ],
    });
    expect(imported).toEqual({
      acceptedCustomBangs: 1,
      rejectedCustomBangs: 1,
      importedSettings: 1,
      replaced: true,
    });
    expect(await db.getAllCustomBangs()).toHaveLength(1);
    expect((await db.getAllCustomBangs())[0].trigger).toBe("valid");
  });

  test("accepts the shipped legacy export shape when it has recognized data", async () => {
    const db = new DB();

    const result = await db.importAll({
      settings: {
        defaultBang: "ddg",
        suggestProvider: null,
        suggestUrl: null,
        luckyProvider: null,
        luckyUrl: null,
      },
      customBangs: [],
      exported: "2026-01-01T00:00:00.000Z",
    });

    expect(result.replaced).toBe(true);
    expect(await db.getSetting("default-bang")).toBe("ddg");
  });

  test("atomically renames an existing custom bang", async () => {
    const db = new DB();
    await db.addCustomBang({
      trigger: "old",
      name: "Old",
      url: "https://example.com/old?q={}",
    });

    await db.updateCustomBang("old", {
      trigger: "new",
      name: "New",
      url: "https://example.com/new?q={}",
    });

    expect(await db.getAllCustomBangs()).toEqual([
      {
        trigger: "new",
        name: "New",
        url: "https://example.com/new?q={}",
      },
    ]);
  });

  test("round-trips capture pattern and encoding", async () => {
    const db = new DB();
    await db.importAll({
      customBangs: [
        {
          trigger: "trurl",
          name: "Translate URL",
          url: "https://example.com/$1/$2",
          regex: "(\\w+)\\s+(.*)",
          encoding: "plus",
          snap: "translate.example/docs",
        },
      ],
    });

    expect(await db.getAllCustomBangs()).toEqual([
      {
        trigger: "trurl",
        name: "Translate URL",
        url: "https://example.com/$1/$2",
        regex: "(\\w+)\\s+(.*)",
        encoding: "plus",
        snap: "translate.example/docs",
      },
    ]);
    const exported = await db.exportAll();
    expect(exported.customBangs[0].regex).toBe("(\\w+)\\s+(.*)");
    expect(exported.customBangs[0].encoding).toBe("plus");
    expect(exported.customBangs[0].snap).toBe("translate.example/docs");
  });

  test("drops unsafe imported patterns", async () => {
    const db = new DB();
    const result = await db.importAll({
      customBangs: [
        {
          trigger: "unsafe",
          name: "Unsafe",
          url: "https://example.com/$1",
          regex: "(a+)+$",
        },
      ],
    });
    expect(await db.getAllCustomBangs()).toEqual([]);
    expect(result.rejectedCustomBangs).toBe(1);
  });

  test("drops invalid imported snap targets", async () => {
    const db = new DB();
    const result = await db.importAll({
      customBangs: [
        {
          trigger: "unsafe-snap",
          name: "Unsafe Snap",
          url: "https://example.com?q={}",
          snap: "javascript://example.com",
        },
      ],
    });
    expect(await db.getAllCustomBangs()).toEqual([]);
    expect(result.rejectedCustomBangs).toBe(1);
  });

  test("drops imported bangs with invalid triggers", async () => {
    const db = new DB();
    const invalidTriggers = [
      "",
      "two words",
      "foo!bar",
      "foo@bar",
      "foo+bar",
      "foo%20bar",
      "foo%21bar",
      "foo%40bar",
      "a".repeat(65),
      "settings",
    ];
    const result = await db.importAll({
      customBangs: [
        ...invalidTriggers.map((trigger) => ({
          trigger,
          name: "Invalid",
          url: "https://example.com?q={}",
        })),
        {
          trigger: "valid",
          name: "Valid",
          url: "https://example.com?q={}",
        },
      ],
    });

    expect(await db.getAllCustomBangs()).toEqual([
      {
        trigger: "valid",
        name: "Valid",
        url: "https://example.com?q={}",
      },
    ]);
    expect(result.acceptedCustomBangs).toBe(1);
    expect(result.rejectedCustomBangs).toBe(invalidTriggers.length);
  });
});

describe("custom suggestion availability", () => {
  test("falls back to none when custom suggestions are disabled", () => {
    expect(resolveSuggestProvider("custom", false)).toBe("none");
  });

  test("preserves custom when custom suggestions are enabled", () => {
    expect(resolveSuggestProvider("custom", true)).toBe("custom");
  });

  test("does not alter built-in providers", () => {
    expect(resolveSuggestProvider("ddg", false)).toBe("ddg");
    expect(resolveSuggestProvider(null, false)).toBe("default");
  });
});
