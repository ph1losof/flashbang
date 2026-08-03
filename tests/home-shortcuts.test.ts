import { afterEach, describe, expect, test } from "bun:test";
import { resetDB } from "../src/shared/idb";
import type { TriggerPrefix } from "../src/shared/trigger-prefix";
import { DB } from "../src/ui/db";
import { initHome } from "../src/ui/home/index";
import { setupHomeShortcuts } from "../src/ui/home/shortcuts";
import { installBangCatalogFetch } from "./helpers/bang-catalog-fetch";
import {
  type DomHandle,
  fire,
  installDom,
  pressKey,
  readHomeHtml,
} from "./helpers/dom";
import { installFakeIndexedDb } from "./helpers/fake-indexeddb";

const FIREFOX_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0";

let homeHtml = "";
let dom: DomHandle | null = null;
let restoreIndexedDb: (() => void) | null = null;
let catalogFetch: { restore: () => void } | null = null;

interface ShortcutFixture {
  handle: DomHandle;
  input: HTMLInputElement;
  inputEvents: number;
  prefixes: [TriggerPrefix, TriggerPrefix];
}

async function setup(
  prefixes: [TriggerPrefix, TriggerPrefix] = ["!", "@"]
): Promise<ShortcutFixture> {
  homeHtml ||= await readHomeHtml();
  const handle = installDom({ html: homeHtml });
  dom = handle;
  const input = handle.document.querySelector(
    "#bang-command-input"
  ) as unknown as HTMLInputElement;
  const fixture: ShortcutFixture = {
    handle,
    input,
    inputEvents: 0,
    prefixes,
  };
  input.addEventListener("input", () => {
    fixture.inputEvents++;
  });
  setupHomeShortcuts(input, () => fixture.prefixes);
  return fixture;
}

afterEach(() => {
  catalogFetch?.restore();
  catalogFetch = null;
  resetDB();
  dom?.restore();
  dom = null;
  restoreIndexedDb?.();
  restoreIndexedDb = null;
});

describe("home keyboard shortcuts", () => {
  test("slash focuses the command input", async () => {
    const fixture = await setup();

    const event = pressKey(fixture.handle.document.body, "/");

    expect(fixture.handle.document.activeElement).toBe(
      fixture.input as unknown as HTMLElement
    );
    expect(event.defaultPrevented).toBe(true);
  });

  test.each([
    ["meta", { metaKey: true }],
    ["ctrl", { ctrlKey: true }],
  ])("%s+k focuses the command input", async (_label, modifier) => {
    const fixture = await setup();

    const event = pressKey(fixture.handle.document.body, "k", modifier);

    expect(fixture.handle.document.activeElement).toBe(
      fixture.input as unknown as HTMLElement
    );
    expect(event.defaultPrevented).toBe(true);
  });

  test("the bang prefix key focuses and inserts itself", async () => {
    const fixture = await setup();

    const event = pressKey(fixture.handle.document.body, "!");

    expect(fixture.handle.document.activeElement).toBe(
      fixture.input as unknown as HTMLElement
    );
    expect(fixture.input.value).toBe("!");
    expect(fixture.inputEvents).toBe(1);
    expect(event.defaultPrevented).toBe(true);
  });

  test("the snap prefix key inserts at the caret", async () => {
    const fixture = await setup();
    fixture.input.value = "ab";
    fixture.input.selectionStart = 1;
    fixture.input.selectionEnd = 1;

    pressKey(fixture.handle.document.body, "@");

    expect(fixture.input.value).toBe("a@b");
  });

  test("custom prefixes replace the defaults", async () => {
    const fixture = await setup(["$", ":"]);

    pressKey(fixture.handle.document.body, "$");
    expect(fixture.input.value).toBe("$");

    pressKey(fixture.handle.document.body, "!");
    expect(fixture.input.value).toBe("$");
  });

  test("g then i focuses the input", async () => {
    const fixture = await setup();

    pressKey(fixture.handle.document.body, "g");
    const event = pressKey(fixture.handle.document.body, "i");

    expect(fixture.handle.document.activeElement).toBe(
      fixture.input as unknown as HTMLElement
    );
    expect(event.defaultPrevented).toBe(true);
  });

  test("the g chord expires after 700ms", async () => {
    const fixture = await setup();
    pressKey(fixture.handle.document.body, "g");

    await fixture.handle.advance(700);
    const event = pressKey(fixture.handle.document.body, "i");

    expect(event.defaultPrevented).toBe(false);
    expect(fixture.handle.document.activeElement).not.toBe(
      fixture.input as unknown as HTMLElement
    );
  });

  test("a held g does not arm the chord", async () => {
    const fixture = await setup();

    pressKey(fixture.handle.document.body, "g", { repeat: true });
    const event = pressKey(fixture.handle.document.body, "i");

    expect(event.defaultPrevented).toBe(false);
  });

  test("an unrelated key disarms the chord", async () => {
    const fixture = await setup();
    pressKey(fixture.handle.document.body, "g");

    pressKey(fixture.handle.document.body, "x");
    const event = pressKey(fixture.handle.document.body, "i");

    expect(event.defaultPrevented).toBe(false);
  });

  test("a modified g does not arm the chord", async () => {
    const fixture = await setup();

    pressKey(fixture.handle.document.body, "g", { ctrlKey: true });
    const event = pressKey(fixture.handle.document.body, "i");

    expect(event.defaultPrevented).toBe(false);
  });

  test("shortcuts stay out of the way while typing in a field", async () => {
    const fixture = await setup();
    const other = fixture.handle.document.querySelector(
      "#default-bang"
    ) as unknown as HTMLInputElement;
    other.focus();

    for (const key of ["/", "!", "@", "g"]) {
      const event = pressKey(other, key);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(fixture.handle.document.activeElement).toBe(
      other as unknown as HTMLElement
    );
  });

  test("ctrl+k still works from inside a field", async () => {
    const fixture = await setup();
    const other = fixture.handle.document.querySelector(
      "#default-bang"
    ) as unknown as HTMLInputElement;
    other.focus();

    pressKey(other, "k", { ctrlKey: true });

    expect(fixture.handle.document.activeElement).toBe(
      fixture.input as unknown as HTMLElement
    );
  });

  test("inserting a prefix appends when there is no selection", async () => {
    const fixture = await setup();
    fixture.input.value = "react";
    fixture.input.selectionStart = null;
    fixture.input.selectionEnd = null;

    pressKey(fixture.handle.document.body, "!");

    expect(fixture.input.value).toBe("react!");
  });
});

describe("home controller", () => {
  async function setupHome(
    settings: Record<string, string> = {},
    userAgent?: string
  ): Promise<{ db: DB; handle: DomHandle }> {
    homeHtml ||= await readHomeHtml();
    restoreIndexedDb = installFakeIndexedDb();
    resetDB();
    catalogFetch = installBangCatalogFetch();
    const handle = installDom({ html: homeHtml, userAgent });
    dom = handle;
    const db = new DB();
    for (const [key, value] of Object.entries(settings)) {
      await db.setSetting(key, value);
    }
    return { db, handle };
  }

  test("applies the stored prefixes to the command placeholder", async () => {
    const { db, handle } = await setupHome({
      "bang-prefix": "$",
      "snap-prefix": ":",
    });

    initHome(db);
    await handle.settle();

    expect(
      (
        handle.document.querySelector(
          "#bang-command-input"
        ) as unknown as HTMLInputElement
      ).placeholder
    ).toBe("Search bangs or enter $gh react");
  });

  test("falls back to the default prefixes when none are stored", async () => {
    const { db, handle } = await setupHome();

    initHome(db);
    await handle.settle();

    expect(
      (
        handle.document.querySelector(
          "#bang-command-input"
        ) as unknown as HTMLInputElement
      ).placeholder
    ).toBe("Search bangs or enter !gh react");
  });

  test("setPrefixes updates the command palette and the suggestion URL", async () => {
    const { db, handle } = await setupHome({}, FIREFOX_UA);
    const home = initHome(db);
    await handle.settle();
    // The Firefox suggestion URL only applies once the setup sheet is opened.
    fire(handle.document.querySelector("#open-setup") as never, "click");
    await handle.settle();
    const suggestUrl = handle.document.querySelector(
      "#setup-suggest-url"
    ) as unknown as HTMLInputElement;
    const before = suggestUrl.value;

    home.setPrefixes("$", ":");
    await handle.settle();

    expect(
      (
        handle.document.querySelector(
          "#bang-command-input"
        ) as unknown as HTMLInputElement
      ).placeholder
    ).toBe("Search bangs or enter $gh react");
    expect(suggestUrl.value).not.toBe(before);
    expect(suggestUrl.value).toContain("bp=%24");
  });

  test("setFirefoxSuggestProvider rewrites the suggestion URL", async () => {
    const { db, handle } = await setupHome({}, FIREFOX_UA);
    const home = initHome(db);
    await handle.settle();
    fire(handle.document.querySelector("#open-setup") as never, "click");
    await handle.settle();
    const suggestUrl = handle.document.querySelector(
      "#setup-suggest-url"
    ) as unknown as HTMLInputElement;

    home.setFirefoxSuggestProvider("ddg");
    await handle.settle();

    expect(suggestUrl.value).toContain("sp=ddg");
  });

  test("refreshCatalog reloads the command palette entries", async () => {
    const { db, handle } = await setupHome();
    const home = initHome(db);
    await handle.settle();
    await db.addCustomBang({
      trigger: "zqx",
      name: "Added Later",
      url: "https://later.test/?q={}",
    });

    await home.refreshCatalog();
    await handle.settle();
    const input = handle.document.querySelector(
      "#bang-command-input"
    ) as unknown as HTMLInputElement;
    input.value = "!zqx";
    fire(input, "input");
    await handle.settle();

    expect(
      handle.document.querySelector("#bang-command-results")?.textContent
    ).toContain("Added Later");
  });
});
