import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { parseSuggestCookieValue } from "../src/shared/suggest-cookie";
import type { TriggerPrefix } from "../src/shared/trigger-prefix";
import { initSettings } from "../src/ui/settings/index";
import { installBangCatalogFetch } from "./helpers/bang-catalog-fetch";
import { fire } from "./helpers/dom";
import {
  createSettingsHarness,
  type SettingsHarness,
  type SettingsHarnessOptions,
} from "./helpers/settings-dom";

const FIREFOX_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0";

let harness: SettingsHarness | null = null;
let catalogFetch: { restore: () => void } | null = null;
let consoleError: ReturnType<typeof spyOn> | null = null;

interface InitFixture {
  catalogChanges: number;
  firefoxProviders: string[];
  harness: SettingsHarness;
  syntaxChanges: [TriggerPrefix, TriggerPrefix][];
}

async function setup(
  options: {
    allowUnsafeCustomSuggestUrls?: boolean;
    settings?: Record<string, string>;
    customBangs?: { trigger: string; name: string; url: string }[];
    dom?: SettingsHarnessOptions;
  } = {}
): Promise<InitFixture> {
  consoleError ??= spyOn(console, "error").mockImplementation(() => undefined);
  catalogFetch ??= installBangCatalogFetch();
  harness = await createSettingsHarness(options.dom);
  const active = harness;
  for (const [key, value] of Object.entries(options.settings ?? {})) {
    await active.db.setSetting(key, value);
  }
  for (const bang of options.customBangs ?? []) {
    await active.db.addCustomBang(bang);
  }

  const catalogChanges = { count: 0 };
  const firefoxProviders: string[] = [];
  const syntaxChanges: [TriggerPrefix, TriggerPrefix][] = [];
  await initSettings(
    active.db,
    options.allowUnsafeCustomSuggestUrls ?? true,
    () => {
      catalogChanges.count++;
    },
    (bang, snap) => syntaxChanges.push([bang, snap]),
    (provider) => firefoxProviders.push(provider)
  );
  await active.handle.settle();

  return {
    get catalogChanges() {
      return catalogChanges.count;
    },
    firefoxProviders,
    harness: active,
    syntaxChanges,
  };
}

afterEach(() => {
  consoleError?.mockRestore();
  consoleError = null;
  catalogFetch?.restore();
  catalogFetch = null;
  harness?.restore();
  harness = null;
});

function parsedCookie(
  fixture: InitFixture
): ReturnType<typeof parseSuggestCookieValue> {
  const cookie = fixture.harness.handle.document.cookie;
  const value = cookie.substring("suggest=".length, cookie.indexOf(";"));
  return parseSuggestCookieValue(value, true);
}

describe("settings initialization", () => {
  test("hydrates every control from stored settings", async () => {
    const fixture = await setup({
      settings: {
        "default-bang": "ddg",
        "suggest-provider": "brave",
        "lucky-provider": "none",
        "bang-prefix": "$",
        "snap-prefix": ":",
      },
    });

    expect(fixture.harness.query<HTMLInputElement>("#default-bang").value).toBe(
      "ddg"
    );
    expect(
      fixture.harness.query<HTMLSelectElement>("#suggest-provider").value
    ).toBe("brave");
    expect(
      fixture.harness.query<HTMLSelectElement>("#lucky-provider").value
    ).toBe("none");
    expect(fixture.harness.query<HTMLSelectElement>("#bang-prefix").value).toBe(
      "$"
    );
    expect(fixture.harness.query<HTMLSelectElement>("#snap-prefix").value).toBe(
      ":"
    );
    expect(fixture.harness.query("#bang-status").textContent).toBe(
      "DuckDuckGo"
    );
  });

  test("falls back to defaults when nothing is stored", async () => {
    const fixture = await setup();

    expect(fixture.harness.query<HTMLInputElement>("#default-bang").value).toBe(
      "g"
    );
    expect(fixture.harness.query<HTMLSelectElement>("#bang-prefix").value).toBe(
      "!"
    );
    expect(fixture.harness.query<HTMLSelectElement>("#snap-prefix").value).toBe(
      "@"
    );
  });

  test("writes a suggest cookie describing the resolved settings", async () => {
    const fixture = await setup({
      settings: { "default-bang": "ddg", "suggest-provider": "google" },
      customBangs: [
        { trigger: "me", name: "Mine", url: "https://mine.test/?q={}" },
      ],
    });

    const decoded = parsedCookie(fixture);
    expect(decoded.provider).toBe("google");
    expect(decoded.trigger).toBe("ddg");
    expect(decoded.custom).toContain("me");
  });

  test("rejects an unsafe custom provider when the build forbids it", async () => {
    const fixture = await setup({
      allowUnsafeCustomSuggestUrls: false,
      settings: {
        "suggest-provider": "custom",
        "suggest-url": "https://s.test/?q={}",
      },
    });

    expect(parsedCookie(fixture).provider).not.toBe("custom");
  });

  test("renders the stored custom bangs into the list", async () => {
    const fixture = await setup({
      customBangs: [
        { trigger: "me", name: "Mine", url: "https://mine.test/?q={}" },
      ],
    });

    expect(fixture.harness.query("#custom-list").textContent).toContain("!me");
  });

  test("forces google and locks the suggest controls on firefox", async () => {
    const fixture = await setup({ dom: { userAgent: FIREFOX_UA } });

    expect(fixture.firefoxProviders).toContain("google");
    expect(
      fixture.harness.query<HTMLSelectElement>("#suggest-provider").disabled
    ).toBe(true);
    expect(parsedCookie(fixture).provider).toBe("google");
  });
});

describe("settings cross-module wiring", () => {
  test("adding a custom bang refreshes the catalog and the cookie", async () => {
    const fixture = await setup();
    const before = fixture.catalogChanges;
    const form = fixture.harness.query<HTMLFormElement>("#add-bang-form");
    (form.elements.namedItem("shortcut") as HTMLInputElement).value = "me";
    (form.elements.namedItem("name") as HTMLInputElement).value = "Mine";
    (form.elements.namedItem("url") as HTMLInputElement).value =
      "https://mine.test/?q={}";

    fire(form, "submit", { cancelable: true });
    await fixture.harness.handle.settle();

    expect(fixture.catalogChanges).toBeGreaterThan(before);
    expect(parsedCookie(fixture).custom).toContain("me");
  });

  test("changing the bang prefix reports the new syntax and redraws badges", async () => {
    const fixture = await setup({
      customBangs: [
        { trigger: "me", name: "Mine", url: "https://mine.test/?q={}" },
      ],
    });
    const bangPrefix = fixture.harness.query<HTMLSelectElement>("#bang-prefix");

    bangPrefix.value = "$";
    fire(bangPrefix, "change");
    await fixture.harness.handle.settle();

    expect(fixture.syntaxChanges.at(-1)).toEqual(["$", "@"]);
    expect(fixture.harness.query("#custom-list").textContent).toContain("$me");
    expect(fixture.harness.query("#default-bang-prefix").textContent).toBe("$");
  });

  test("committing a default bang updates the provider display", async () => {
    const fixture = await setup();
    const input = fixture.harness.query<HTMLInputElement>("#default-bang");

    input.value = "ddg";
    fire(input, "change");
    await fixture.harness.handle.settle();

    expect(await fixture.harness.db.getSetting("default-bang")).toBe("ddg");
    expect(parsedCookie(fixture).trigger).toBe("ddg");
  });

  test("an import re-reads every setting and clears stale errors", async () => {
    const fixture = await setup({ settings: { "default-bang": "g" } });
    // Leave a validation error behind so the import can be seen clearing it.
    const suggestUrl = fixture.harness.query<HTMLInputElement>("#suggest-url");
    suggestUrl.value = "not-a-url";
    fire(suggestUrl, "change");
    await fixture.harness.handle.settle();
    expect(fixture.harness.query("#settings-save-status").dataset.state).toBe(
      "error"
    );

    fixture.harness.query<HTMLInputElement>("#import-file").files = [
      new File(
        [
          JSON.stringify({
            schemaVersion: 2,
            settings: { defaultBang: "ddg", bangPrefix: "$", snapPrefix: ":" },
            customBangs: [
              { trigger: "you", name: "Yours", url: "https://you.test/?q={}" },
            ],
          }),
        ],
        "flashbang.json"
      ),
    ] as unknown as FileList & readonly File[];

    fire(fixture.harness.query("#import-file"), "change");
    await fixture.harness.handle.settle();

    expect(fixture.harness.query<HTMLInputElement>("#default-bang").value).toBe(
      "ddg"
    );
    expect(fixture.harness.query<HTMLSelectElement>("#bang-prefix").value).toBe(
      "$"
    );
    expect(fixture.harness.query("#custom-list").textContent).toContain("$you");
    expect(fixture.syntaxChanges.at(-1)).toEqual(["$", ":"]);
    expect(fixture.harness.query("#settings-save-status").dataset.state).toBe(
      "saved"
    );
  });
});
