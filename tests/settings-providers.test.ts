import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { firefoxSuggestionUrl } from "../src/ui/firefox-suggest";
import {
  getProviderControls,
  type ProviderSettingsController,
  type ProviderSettingsState,
  setupProviderSettings,
} from "../src/ui/settings/providers";
import { fire, pressKey } from "./helpers/dom";
import {
  createSettingsHarness,
  type SettingsHarness,
  type SettingsHarnessOptions,
} from "./helpers/settings-dom";

const FIREFOX_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0";

let harness: SettingsHarness | null = null;
let consoleError: ReturnType<typeof spyOn> | null = null;

interface ProviderFixture {
  controller: ProviderSettingsController;
  firefoxProviders: string[];
  harness: SettingsHarness;
  luckySelect: HTMLSelectElement;
  luckyUrlInput: HTMLInputElement;
  state: ProviderSettingsState;
  suggestChanges: number;
  suggestSelect: HTMLSelectElement;
  suggestUrlInput: HTMLInputElement;
}

async function setup(
  overrides: Partial<ProviderSettingsState> = {},
  options: SettingsHarnessOptions = {}
): Promise<ProviderFixture> {
  consoleError ??= spyOn(console, "error").mockImplementation(() => undefined);
  harness = await createSettingsHarness({
    writerControls: (query) => [
      query<HTMLSelectElement>("#suggest-provider"),
      query<HTMLInputElement>("#suggest-url"),
    ],
    ...options,
  });
  const active = harness;
  const state: ProviderSettingsState = {
    bangPrefix: "!",
    defaultBang: "g",
    luckyProvider: "default",
    luckyUrl: "",
    snapPrefix: "@",
    suggestProvider: "google",
    suggestUrl: "",
    ...overrides,
  };
  const controls = getProviderControls();
  // Declared up front: the Firefox path invokes these during setup.
  const firefoxProviders: string[] = [];
  let suggestChanges = 0;
  const controller = setupProviderSettings({
    controls,
    db: active.db,
    onFirefoxSuggestProviderChange: (provider) => {
      firefoxProviders.push(provider);
    },
    onSuggestChange: () => {
      suggestChanges++;
    },
    state,
    writer: active.writer,
  });
  return {
    controller,
    firefoxProviders,
    harness: active,
    luckySelect: controls.luckySelect,
    luckyUrlInput: controls.luckyUrlInput,
    state,
    get suggestChanges() {
      return suggestChanges;
    },
    suggestSelect: controls.suggestSelect,
    suggestUrlInput: controls.suggestUrlInput,
  };
}

afterEach(() => {
  consoleError?.mockRestore();
  consoleError = null;
  harness?.restore();
  harness = null;
});

describe("provider controls", () => {
  test("syncs both selects and hides the URL inputs for named providers", async () => {
    const fixture = await setup({
      suggestProvider: "ddg",
      luckyProvider: "none",
    });

    expect(fixture.suggestSelect.value).toBe("ddg");
    expect(fixture.luckySelect.value).toBe("none");
    expect(fixture.suggestUrlInput.classList.contains("hidden")).toBe(true);
    expect(fixture.luckyUrlInput.classList.contains("hidden")).toBe(true);
    expect(fixture.controller.isFirefox).toBe(false);
  });

  test("reveals the URL input when the stored provider is custom", async () => {
    const fixture = await setup({
      suggestProvider: "custom",
      suggestUrl: "https://s.test/?q={}",
    });

    expect(fixture.suggestUrlInput.classList.contains("hidden")).toBe(false);
    expect(fixture.suggestUrlInput.value).toBe("https://s.test/?q={}");
  });

  test("persists a provider change and reports it", async () => {
    const fixture = await setup();

    fixture.suggestSelect.value = "brave";
    fire(fixture.suggestSelect, "change");
    await fixture.harness.handle.settle();

    expect(await fixture.harness.db.getSetting("suggest-provider")).toBe(
      "brave"
    );
    expect(fixture.state.suggestProvider).toBe("brave");
    expect(fixture.suggestChanges).toBeGreaterThan(0);
  });

  test("reverts the select when the write fails", async () => {
    const fixture = await setup({ suggestProvider: "google" });
    const failing = spyOn(fixture.harness.db, "setSetting").mockImplementation(
      () => Promise.reject(new Error("quota"))
    );

    fixture.suggestSelect.value = "kagi";
    fire(fixture.suggestSelect, "change");
    await fixture.harness.handle.settle();

    expect(fixture.suggestSelect.value).toBe("google");
    expect(fixture.state.suggestProvider).toBe("google");
    failing.mockRestore();
  });
});

describe("custom provider URLs", () => {
  test("blocks switching to custom while the stored URL is invalid", async () => {
    const fixture = await setup({ suggestProvider: "google", suggestUrl: "" });

    fixture.suggestSelect.value = "custom";
    fire(fixture.suggestSelect, "change");
    await fixture.harness.handle.settle();

    expect(fixture.suggestSelect.value).toBe("google");
    expect(fixture.state.suggestProvider).toBe("google");
    expect(fixture.suggestUrlInput.getAttribute("aria-invalid")).toBe("true");
    expect(fixture.harness.query("#settings-save-status").dataset.state).toBe(
      "error"
    );
    // The input is revealed and focused so the URL can be supplied.
    expect(fixture.suggestUrlInput.classList.contains("hidden")).toBe(false);
    expect(fixture.harness.handle.document.activeElement).toBe(
      fixture.suggestUrlInput as unknown as HTMLElement
    );
  });

  test("supplying a valid URL afterwards promotes the provider to custom", async () => {
    const fixture = await setup({ suggestProvider: "google", suggestUrl: "" });
    fixture.suggestSelect.value = "custom";
    fire(fixture.suggestSelect, "change");
    await fixture.harness.handle.settle();

    fixture.suggestUrlInput.value = "https://s.test/?q={}";
    fire(fixture.suggestUrlInput, "change");
    await fixture.harness.handle.settle();

    expect(await fixture.harness.db.getSetting("suggest-url")).toBe(
      "https://s.test/?q={}"
    );
    expect(fixture.state.suggestProvider).toBe("custom");
    expect(await fixture.harness.db.getSetting("suggest-provider")).toBe(
      "custom"
    );
  });

  test("rejects a malformed URL without writing", async () => {
    const fixture = await setup();

    fixture.suggestUrlInput.value = "not-a-url";
    fire(fixture.suggestUrlInput, "change");
    await fixture.harness.handle.settle();

    expect(await fixture.harness.db.getSetting("suggest-url")).toBeNull();
    expect(fixture.suggestUrlInput.getAttribute("aria-invalid")).toBe("true");
  });

  test("rejects clearing the URL while custom is the active provider", async () => {
    const fixture = await setup({
      suggestProvider: "custom",
      suggestUrl: "https://s.test/?q={}",
    });

    fixture.suggestUrlInput.value = "";
    fire(fixture.suggestUrlInput, "change");
    await fixture.harness.handle.settle();

    expect(fixture.harness.query("#settings-save-status").dataset.state).toBe(
      "error"
    );
    expect(await fixture.harness.db.getSetting("suggest-url")).toBeNull();
  });

  test("clearing the URL is allowed for a named provider", async () => {
    const fixture = await setup({
      suggestProvider: "google",
      suggestUrl: "https://s.test/?q={}",
    });

    fixture.suggestUrlInput.value = "";
    fire(fixture.suggestUrlInput, "change");
    await fixture.harness.handle.settle();

    expect(await fixture.harness.db.getSetting("suggest-url")).toBe("");
    expect(fixture.state.suggestUrl).toBe("");
  });

  test("restores the previous URL when the write fails", async () => {
    const fixture = await setup({ suggestUrl: "https://old.test/?q={}" });
    const failing = spyOn(fixture.harness.db, "setSetting").mockImplementation(
      () => Promise.reject(new Error("quota"))
    );

    fixture.suggestUrlInput.value = "https://new.test/?q={}";
    fire(fixture.suggestUrlInput, "change");
    await fixture.harness.handle.settle();

    expect(fixture.suggestUrlInput.value).toBe("https://old.test/?q={}");
    failing.mockRestore();
  });

  test("the lucky provider URL is validated independently", async () => {
    const fixture = await setup();

    fixture.luckyUrlInput.value = "https://lucky.test/?q={}";
    fire(fixture.luckyUrlInput, "change");
    await fixture.harness.handle.settle();

    expect(await fixture.harness.db.getSetting("lucky-url")).toBe(
      "https://lucky.test/?q={}"
    );
    expect(fixture.state.luckyUrl).toBe("https://lucky.test/?q={}");
    // Lucky changes never touch the suggestion cookie.
    expect(fixture.suggestChanges).toBe(0);
  });
});

describe("default provider displays", () => {
  test("labels a bang with its own provider as a match", async () => {
    const fixture = await setup({ defaultBang: "ddg" });
    fixture.luckySelect.value = "default";
    fixture.controller.updateDefaultDisplays();

    expect(fixture.harness.query("#lucky-default-prefix").textContent).toBe(
      "Match bang"
    );
    expect(
      fixture.harness
        .query("#lucky-default-display")
        .classList.contains("hidden")
    ).toBe(false);
  });

  test("labels an unmapped bang as a fallback", async () => {
    const fixture = await setup({ defaultBang: "zzzz" });
    fixture.luckySelect.value = "default";
    fixture.controller.updateDefaultDisplays();

    expect(fixture.harness.query("#lucky-default-prefix").textContent).toBe(
      "Fallback"
    );
  });

  test("hides the display when the provider is not the default", async () => {
    const fixture = await setup({ luckyProvider: "none" });

    expect(
      fixture.harness
        .query("#lucky-default-display")
        .classList.contains("hidden")
    ).toBe(true);
  });
});

describe("firefox suggestion setup", () => {
  test("locks the suggest controls and forces google", async () => {
    const fixture = await setup({}, { userAgent: FIREFOX_UA });

    expect(fixture.controller.isFirefox).toBe(true);
    expect(fixture.state.suggestProvider).toBe("google");
    expect(fixture.suggestSelect.value).toBe("google");
    expect(fixture.suggestSelect.disabled).toBe(true);
    expect(fixture.suggestUrlInput.disabled).toBe(true);
    expect(fixture.suggestSelect.classList.contains("select-locked")).toBe(
      true
    );
    expect(
      fixture.harness
        .query("#suggest-firefox-note")
        .classList.contains("hidden")
    ).toBe(false);
    expect(fixture.firefoxProviders).toEqual(["google"]);
  });

  test("builds the picker menu from the real provider options", async () => {
    const fixture = await setup({}, { userAgent: FIREFOX_UA });
    const menu = fixture.harness.query("#suggest-firefox-provider-menu");

    const values = Array.from(menu.children).map(
      (option) => (option as HTMLElement).dataset.provider
    );
    expect(values).not.toContain("default");
    expect(values).not.toContain("custom");
    expect(values).not.toContain("none");
    expect(values).toContain("ddg");
    expect(menu.children[0].getAttribute("role")).toBe("option");
  });

  test("renders the suggestion URL with the provider highlighted", async () => {
    const fixture = await setup({}, { userAgent: FIREFOX_UA });
    const url = fixture.harness.query("#suggest-firefox-url");

    expect(
      fixture.harness.query("#suggest-firefox-provider-label").textContent
    ).toBe("google");
    expect(url.textContent).toBe(
      firefoxSuggestionUrl("https://flashbang.test", {
        bangPrefix: "!",
        provider: "google",
        snapPrefix: "@",
      })
    );
  });

  test("choosing a provider updates the URL and notifies the host", async () => {
    const fixture = await setup({}, { userAgent: FIREFOX_UA });
    const menu = fixture.harness.query("#suggest-firefox-provider-menu");
    const ddg = Array.from(menu.children).find(
      (option) => (option as HTMLElement).dataset.provider === "ddg"
    ) as unknown as HTMLElement;

    fire(ddg, "click");

    expect(fixture.firefoxProviders).toEqual(["google", "ddg"]);
    expect(fixture.harness.query("#suggest-firefox-url").textContent).toContain(
      "sp=ddg"
    );
    expect(menu.classList.contains("hidden")).toBe(true);
    expect(ddg.getAttribute("aria-selected")).toBe("true");
  });

  test("hover opens the menu and leaving closes it after the grace period", async () => {
    const fixture = await setup({}, { userAgent: FIREFOX_UA });
    const wrap = fixture.harness.query("#suggest-firefox-provider-picker-wrap");
    const menu = fixture.harness.query("#suggest-firefox-provider-menu");

    fire(wrap, "pointerenter");
    expect(menu.classList.contains("hidden")).toBe(false);

    fire(wrap, "pointerleave");
    expect(menu.classList.contains("hidden")).toBe(false);
    await fixture.harness.handle.advance(150);
    expect(menu.classList.contains("hidden")).toBe(true);
  });

  test("clicking the picker pins the menu open until clicked again", async () => {
    const fixture = await setup({}, { userAgent: FIREFOX_UA });
    const picker = fixture.harness.query("#suggest-firefox-provider-picker");
    const menu = fixture.harness.query("#suggest-firefox-provider-menu");

    fire(picker, "click");
    expect(menu.classList.contains("hidden")).toBe(false);
    expect(picker.getAttribute("aria-expanded")).toBe("true");

    // A pinned menu ignores pointer-leave.
    fire(
      fixture.harness.query("#suggest-firefox-provider-picker-wrap"),
      "pointerleave"
    );
    await fixture.harness.handle.advance(200);
    expect(menu.classList.contains("hidden")).toBe(false);

    fire(picker, "click");
    expect(menu.classList.contains("hidden")).toBe(true);
  });

  test("ArrowDown pins the menu and focuses the first provider", async () => {
    const fixture = await setup({}, { userAgent: FIREFOX_UA });
    const picker = fixture.harness.query("#suggest-firefox-provider-picker");
    const menu = fixture.harness.query("#suggest-firefox-provider-menu");

    const event = pressKey(picker, "ArrowDown");

    expect(event.defaultPrevented).toBe(true);
    expect(menu.classList.contains("hidden")).toBe(false);
    expect(fixture.harness.handle.document.activeElement).toBe(
      menu.firstElementChild as unknown as HTMLElement
    );
  });

  test("Escape in the menu closes it and returns focus to the picker", async () => {
    const fixture = await setup({}, { userAgent: FIREFOX_UA });
    const picker = fixture.harness.query("#suggest-firefox-provider-picker");
    const menu = fixture.harness.query("#suggest-firefox-provider-menu");
    fire(picker, "click");

    pressKey(menu, "Escape");

    expect(menu.classList.contains("hidden")).toBe(true);
    expect(fixture.harness.handle.document.activeElement).toBe(
      picker as unknown as HTMLElement
    );
  });

  test("focusing a menu option keeps the menu open", async () => {
    const fixture = await setup({}, { userAgent: FIREFOX_UA });
    const menu = fixture.harness.query("#suggest-firefox-provider-menu");

    fire(menu.children[0] as unknown as HTMLElement, "focus");

    expect(menu.classList.contains("hidden")).toBe(false);
  });

  test("clicking outside a pinned menu closes it", async () => {
    const fixture = await setup({}, { userAgent: FIREFOX_UA });
    const menu = fixture.harness.query("#suggest-firefox-provider-menu");
    fire(fixture.harness.query("#suggest-firefox-provider-picker"), "click");

    fire(fixture.harness.query("#export-btn"), "click");

    expect(menu.classList.contains("hidden")).toBe(true);
  });

  test("copying the suggestion URL confirms then restores the label", async () => {
    const fixture = await setup({}, { userAgent: FIREFOX_UA });
    const url = fixture.harness.query("#suggest-firefox-url");

    fire(url, "click");
    await fixture.harness.handle.settle();

    expect(url.textContent).toBe("Copied suggestion URL");

    await fixture.harness.handle.advance(1_500);
    expect(url.textContent).toContain("/suggest?q=%s&sp=google");
  });

  test("reports a clipboard failure in place", async () => {
    const fixture = await setup({}, { userAgent: FIREFOX_UA });
    const clipboard = fixture.harness.handle.navigator.clipboard as {
      writeText: () => Promise<void>;
    };
    clipboard.writeText = () => Promise.reject(new Error("denied"));
    const url = fixture.harness.query("#suggest-firefox-url");

    fire(url, "click");
    await fixture.harness.handle.settle();

    expect(url.textContent).toBe("Could not copy suggestion URL");
  });

  test("refresh redraws the URL for updated prefixes", async () => {
    const fixture = await setup({}, { userAgent: FIREFOX_UA });

    fixture.state.bangPrefix = "$";
    fixture.state.snapPrefix = ":";
    fixture.controller.refresh();

    expect(fixture.harness.query("#suggest-firefox-url").textContent).toContain(
      "bp=%24&np=%3A"
    );
  });
});
