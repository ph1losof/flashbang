import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { resetDB } from "../src/shared/idb";
import type { TriggerPrefix } from "../src/shared/trigger-prefix";
import { DB } from "../src/ui/db";
import {
  type BangCommandController,
  setupBangCommand,
} from "../src/ui/home/command";
import { installBangCatalogFetch } from "./helpers/bang-catalog-fetch";
import {
  type DomHandle,
  fire,
  installDom,
  pressKey,
  readHomeHtml,
  setElementSize,
} from "./helpers/dom";
import { installFakeIndexedDb } from "./helpers/fake-indexeddb";

let homeHtml = "";
let dom: DomHandle | null = null;
let restoreIndexedDb: (() => void) | null = null;
let catalogFetch: { restore: () => void } | null = null;

interface CommandFixture {
  badge: HTMLButtonElement;
  controller: BangCommandController;
  count: HTMLElement;
  db: DB;
  form: HTMLFormElement;
  handle: DomHandle;
  input: HTMLInputElement;
  results: HTMLElement;
}

async function setup(
  options: {
    customBangs?: { trigger: string; name: string; url: string }[];
    idleCallback?: boolean;
  } = {}
): Promise<CommandFixture> {
  homeHtml ||= await readHomeHtml();
  restoreIndexedDb = installFakeIndexedDb();
  resetDB();
  catalogFetch = installBangCatalogFetch();
  const handle = installDom({
    html: homeHtml,
    idleCallback: options.idleCallback,
  });
  dom = handle;
  const db = new DB();
  for (const bang of options.customBangs ?? []) {
    await db.addCustomBang(bang);
  }
  const query = <T extends HTMLElement>(selector: string): T =>
    handle.document.querySelector(selector) as unknown as T;
  return {
    badge: query<HTMLButtonElement>("#bang-command-selected"),
    controller: setupBangCommand(db),
    count: query("#home-bang-count"),
    db,
    form: query<HTMLFormElement>("#bang-command-form"),
    handle,
    input: query<HTMLInputElement>("#bang-command-input"),
    results: query("#bang-command-results"),
  };
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

/** Focuses the input, loading the catalog, then types `value`. */
async function type(fixture: CommandFixture, value: string): Promise<void> {
  fire(fixture.input, "focus");
  await fixture.handle.settle();
  fixture.input.value = value;
  fire(fixture.input, "input");
  await fixture.handle.settle();
}

function options(fixture: CommandFixture): HTMLElement[] {
  return fixture.results.querySelectorAll(
    '[role="option"]'
  ) as unknown as HTMLElement[];
}

describe("loading the command catalog", () => {
  test("loads on focus and reports the shortcut count", async () => {
    const fixture = await setup();

    fire(fixture.input, "focus");
    await fixture.handle.settle();

    expect(fixture.count.textContent).toMatch(/^[\d,.]+ shortcuts$/);
  });

  test("loads once when the form is first hovered", async () => {
    const fixture = await setup();

    fire(fixture.form, "pointerenter");
    fire(fixture.form, "pointerenter");
    await fixture.handle.settle();

    expect(fixture.count.textContent).toContain("shortcuts");
  });

  test("an idle callback warms the catalog without interaction", async () => {
    const fixture = await setup();

    await fixture.handle.settle();

    expect(fixture.count.textContent).toContain("shortcuts");
  });

  test("falls back to a timer when requestIdleCallback is missing", async () => {
    const fixture = await setup({ idleCallback: false });

    await fixture.handle.advance(800);

    expect(fixture.count.textContent).toContain("shortcuts");
  });

  test("merges custom bangs over built-ins and appends new ones", async () => {
    const fixture = await setup({
      customBangs: [
        { trigger: "g", name: "My Google", url: "https://mine.test/?q={}" },
        { trigger: "zqx", name: "Mine Only", url: "https://only.test/?q={}" },
      ],
    });

    await type(fixture, "!g");
    expect(fixture.results.textContent).toContain("My Google");

    await type(fixture, "!zqx");
    expect(fixture.results.textContent).toContain("Mine Only");
    expect(fixture.results.textContent).toContain("only.test");
  });

  test("labels a custom bang with an unparseable URL as custom", async () => {
    const fixture = await setup({
      customBangs: [{ trigger: "zqx", name: "Broken", url: "not a url {}" }],
    });

    await type(fixture, "!zqx");

    expect(fixture.results.textContent).toContain("custom");
  });

  test("survives a custom bang read failure", async () => {
    const fixture = await setup();
    const failing = spyOn(fixture.db, "getAllCustomBangs").mockImplementation(
      () => Promise.reject(new Error("blocked"))
    );

    fire(fixture.input, "focus");
    await fixture.handle.settle();

    expect(fixture.count.textContent).toContain("shortcuts");
    failing.mockRestore();
  });
});

describe("parsing the command input", () => {
  test("a leading bang prefix searches bangs", async () => {
    const fixture = await setup();

    await type(fixture, "!goog");

    expect(options(fixture).length).toBeGreaterThan(0);
    expect(fixture.input.getAttribute("aria-expanded")).toBe("true");
  });

  test("a bare term searches without a marker", async () => {
    const fixture = await setup();

    await type(fixture, "google");

    expect(options(fixture).length).toBeGreaterThan(0);
  });

  test("an empty input closes the list", async () => {
    const fixture = await setup();
    await type(fixture, "!goog");

    await type(fixture, "");

    expect(fixture.results.classList.contains("hidden")).toBe(true);
  });

  test("a trailing marker after terms searches the tail", async () => {
    const fixture = await setup();

    await type(fixture, "react docs !gh");

    expect(options(fixture).length).toBeGreaterThan(0);
    // Selecting keeps the leading terms as the query.
    fire(options(fixture)[0], "click");
    expect(fixture.input.value).toBe("react docs");
  });

  test("whitespace after a marker closes the list", async () => {
    const fixture = await setup();

    await type(fixture, "!gh react");

    expect(fixture.results.classList.contains("hidden")).toBe(true);
  });

  test("multi word input with no marker closes the list", async () => {
    const fixture = await setup();

    await type(fixture, "two words");

    expect(fixture.results.classList.contains("hidden")).toBe(true);
  });

  test("reports when nothing matches", async () => {
    const fixture = await setup();

    await type(fixture, "!zzzzzzzznope");

    expect(fixture.results.textContent).toBe(
      'No bang found for "zzzzzzzznope"'
    );
  });

  test("caps the list at seven rows", async () => {
    const fixture = await setup();

    await type(fixture, "!a");

    expect(options(fixture).length).toBeLessThanOrEqual(7);
  });
});

describe("snap chains", () => {
  test("a snap prefix with commas offers the next link", async () => {
    const fixture = await setup();

    await type(fixture, "@gh,goog");

    const rows = options(fixture);
    expect(rows.length).toBeGreaterThan(0);
    // The badge carries the whole chain so far.
    expect(rows[0].textContent).toContain("@gh,");
  });

  test("already chosen links are filtered out of the suggestions", async () => {
    const fixture = await setup();

    await type(fixture, "@gh,gh");

    const badges = options(fixture).map(
      (row) => row.querySelector("code")?.textContent
    );
    expect(badges.length).toBeGreaterThan(0);
    expect(badges).not.toContain("@gh,gh");
  });

  test("commas after a bang prefix are not a chain", async () => {
    const fixture = await setup();

    await type(fixture, "!gh,goog");

    expect(fixture.results.classList.contains("hidden")).toBe(true);
  });

  test("an empty chain segment is rejected", async () => {
    const fixture = await setup();

    await type(fixture, "@gh,,");

    expect(fixture.results.classList.contains("hidden")).toBe(true);
  });

  test("selecting a chain link keeps the chain prefix", async () => {
    const fixture = await setup();
    await type(fixture, "@gh,goog");

    fire(options(fixture)[0], "click");

    expect(
      fixture.handle.document.querySelector("#bang-command-selected-text")
        ?.textContent
    ).toMatch(/^@gh,/);
    expect(fixture.badge.getAttribute("aria-label")).toContain("snap chain");
  });
});

describe("keyboard navigation", () => {
  test("arrow keys wrap through the list", async () => {
    const fixture = await setup();
    await type(fixture, "!goog");
    const rows = options(fixture);

    pressKey(fixture.input, "ArrowDown");
    expect(rows[1].getAttribute("aria-selected")).toBe("true");

    pressKey(fixture.input, "ArrowUp");
    expect(rows[0].getAttribute("aria-selected")).toBe("true");

    pressKey(fixture.input, "ArrowUp");
    expect(rows[rows.length - 1].getAttribute("aria-selected")).toBe("true");
  });

  test("Tab and Shift+Tab move the selection", async () => {
    const fixture = await setup();
    await type(fixture, "!goog");
    const rows = options(fixture);

    pressKey(fixture.input, "Tab");
    expect(rows[1].getAttribute("aria-selected")).toBe("true");

    pressKey(fixture.input, "Tab", { shiftKey: true });
    expect(rows[0].getAttribute("aria-selected")).toBe("true");
  });

  test("ctrl+j and ctrl+k move the selection", async () => {
    const fixture = await setup();
    await type(fixture, "!goog");
    const rows = options(fixture);

    pressKey(fixture.input, "j", { ctrlKey: true });
    expect(rows[1].getAttribute("aria-selected")).toBe("true");

    pressKey(fixture.input, "k", { ctrlKey: true });
    expect(rows[0].getAttribute("aria-selected")).toBe("true");
  });

  test("hovering a row selects it", async () => {
    const fixture = await setup();
    await type(fixture, "!goog");
    const rows = options(fixture);

    fire(rows[2], "pointerenter");

    expect(rows[2].getAttribute("aria-selected")).toBe("true");
    expect(fixture.input.getAttribute("aria-activedescendant")).toBe(
      rows[2].id
    );
  });

  test("Enter commits the highlighted bang", async () => {
    const fixture = await setup();
    await type(fixture, "!goog");

    const event = pressKey(fixture.input, "Enter");

    expect(event.defaultPrevented).toBe(true);
    expect(fixture.badge.classList.contains("hidden")).toBe(false);
    expect(fixture.results.classList.contains("hidden")).toBe(true);
  });

  test("ctrl+y commits like Enter", async () => {
    const fixture = await setup();
    await type(fixture, "!goog");

    pressKey(fixture.input, "y", { ctrlKey: true });

    expect(fixture.badge.classList.contains("hidden")).toBe(false);
  });

  test("Escape closes the list", async () => {
    const fixture = await setup();
    await type(fixture, "!goog");

    pressKey(fixture.input, "Escape");

    expect(fixture.results.classList.contains("hidden")).toBe(true);
  });

  test("navigation keys do nothing with no list open", async () => {
    const fixture = await setup();

    expect(pressKey(fixture.input, "ArrowDown").defaultPrevented).toBe(false);
  });
});

describe("the selected bang badge", () => {
  test("selecting shows the badge and reserves room in the input", async () => {
    const fixture = await setup();
    setElementSize(fixture.badge, 40);
    await type(fixture, "!goog");

    fire(options(fixture)[0], "click");

    expect(fixture.badge.classList.contains("flex")).toBe(true);
    expect(fixture.input.style.paddingLeft).toBe("56px");
    expect(fixture.input.placeholder).toContain("Search with");
    expect(fixture.badge.title).toMatch(/^Remove !/);
  });

  test("typing while a bang is selected keeps the list closed", async () => {
    const fixture = await setup();
    await type(fixture, "!goog");
    fire(options(fixture)[0], "click");

    fixture.input.value = "react";
    fire(fixture.input, "input");
    await fixture.handle.settle();

    expect(fixture.results.classList.contains("hidden")).toBe(true);
  });

  test("Backspace in an empty input clears the selection", async () => {
    const fixture = await setup();
    await type(fixture, "!goog");
    fire(options(fixture)[0], "click");
    fixture.input.value = "";

    const event = pressKey(fixture.input, "Backspace");

    expect(event.defaultPrevented).toBe(true);
    expect(fixture.badge.classList.contains("hidden")).toBe(true);
    expect(fixture.input.style.paddingLeft).toBeUndefined();
  });

  test("Escape clears the selection before closing the list", async () => {
    const fixture = await setup();
    await type(fixture, "!goog");
    fire(options(fixture)[0], "click");

    pressKey(fixture.input, "Escape");

    expect(fixture.badge.classList.contains("hidden")).toBe(true);
  });

  test("clicking the badge clears it and reopens the list", async () => {
    const fixture = await setup();
    await type(fixture, "!goog");
    fire(options(fixture)[0], "click");
    fixture.input.value = "goog";

    fire(fixture.badge, "click");
    await fixture.handle.settle();

    expect(fixture.badge.classList.contains("hidden")).toBe(true);
    expect(fixture.results.classList.contains("hidden")).toBe(false);
  });
});

describe("submitting the command", () => {
  test("navigates with the plain terms", async () => {
    const fixture = await setup();
    fixture.input.value = "  react docs  ";

    fire(fixture.form, "submit", { cancelable: true });

    expect(fixture.handle.assignedUrls).toEqual(["/?q=react%20docs"]);
  });

  test("prefixes the selected bang onto the query", async () => {
    const fixture = await setup();
    await type(fixture, "!goog");
    fire(options(fixture)[0], "click");
    fixture.input.value = "react";

    fire(fixture.form, "submit", { cancelable: true });

    expect(fixture.handle.assignedUrls[0]).toBe("/?q=!goog%20react");
  });

  test("submits a bare selected bang with no terms", async () => {
    const fixture = await setup();
    await type(fixture, "!goog");
    fire(options(fixture)[0], "click");

    fire(fixture.form, "submit", { cancelable: true });

    expect(fixture.handle.assignedUrls[0]).toBe("/?q=!goog");
  });

  test("an empty command does not navigate", async () => {
    const fixture = await setup();

    fire(fixture.form, "submit", { cancelable: true });

    expect(fixture.handle.assignedUrls).toHaveLength(0);
  });
});

describe("dismissing the list", () => {
  test("blurring away from the form closes the list", async () => {
    const fixture = await setup();
    await type(fixture, "!goog");

    fire(fixture.input, "blur");
    await fixture.handle.advance(0);

    expect(fixture.results.classList.contains("hidden")).toBe(true);
  });

  test("blurring onto a row inside the form keeps it open", async () => {
    const fixture = await setup();
    await type(fixture, "!goog");
    options(fixture)[0].focus();

    fire(fixture.input, "blur");
    await fixture.handle.advance(0);

    expect(fixture.results.classList.contains("hidden")).toBe(false);
  });

  test("a pointer press outside the form closes the list", async () => {
    const fixture = await setup();
    await type(fixture, "!goog");

    fire(fixture.handle.document.body, "pointerdown");

    expect(fixture.results.classList.contains("hidden")).toBe(true);
  });

  test("a pointer press inside the form leaves it open", async () => {
    const fixture = await setup();
    await type(fixture, "!goog");

    fire(fixture.input, "pointerdown");

    expect(fixture.results.classList.contains("hidden")).toBe(false);
  });
});

describe("controller updates", () => {
  test("setPrefixes rewrites the placeholder and reopens matches", async () => {
    const fixture = await setup();
    await type(fixture, "goog");

    fixture.controller.setPrefixes("$" as TriggerPrefix, ":" as TriggerPrefix);
    await fixture.handle.settle();

    expect(fixture.input.placeholder).toBe("Search bangs or enter $gh react");
    expect(fixture.results.classList.contains("hidden")).toBe(false);
  });

  test("setPrefixes clears a selected bang", async () => {
    const fixture = await setup();
    await type(fixture, "!goog");
    fire(options(fixture)[0], "click");

    fixture.controller.setPrefixes("$" as TriggerPrefix, ":" as TriggerPrefix);

    expect(fixture.badge.classList.contains("hidden")).toBe(true);
    expect(fixture.input.placeholder).toBe("Search bangs or enter $gh react");
  });

  test("setPrefixes with an empty input just closes the list", async () => {
    const fixture = await setup();
    await type(fixture, "!goog");
    fixture.input.value = "";

    fixture.controller.setPrefixes("$" as TriggerPrefix, ":" as TriggerPrefix);

    expect(fixture.results.classList.contains("hidden")).toBe(true);
  });

  test("refresh reloads the catalog and picks up new custom bangs", async () => {
    const fixture = await setup();
    fire(fixture.input, "focus");
    await fixture.handle.settle();
    await fixture.db.addCustomBang({
      trigger: "zqx",
      name: "Added Later",
      url: "https://later.test/?q={}",
    });

    await fixture.controller.refresh();
    await fixture.handle.settle();
    fixture.input.value = "!zqx";
    fire(fixture.input, "input");
    await fixture.handle.settle();

    expect(fixture.results.textContent).toContain("Added Later");
  });
});
