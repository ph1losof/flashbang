import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { CustomBangRecord } from "../src/shared/capture-template";
import type { TriggerPrefix } from "../src/shared/trigger-prefix";
import {
  type DefaultBangController,
  setupDefaultBangSetting,
} from "../src/ui/settings/default-bang";
import { installBangCatalogFetch } from "./helpers/bang-catalog-fetch";
import { fire, pressKey } from "./helpers/dom";
import {
  createSettingsHarness,
  type SettingsHarness,
} from "./helpers/settings-dom";

let harness: SettingsHarness | null = null;
let catalogFetch: { restore: () => void } | null = null;
let consoleError: ReturnType<typeof spyOn> | null = null;

interface DefaultBangFixture {
  commits: string[];
  controller: DefaultBangController;
  harness: SettingsHarness;
  input: HTMLInputElement;
  results: HTMLElement;
  status: HTMLElement;
}

async function setup(
  options: {
    initialBang?: string;
    initialCustom?: CustomBangRecord[];
    bangPrefix?: TriggerPrefix;
  } = {}
): Promise<DefaultBangFixture> {
  consoleError ??= spyOn(console, "error").mockImplementation(() => undefined);
  catalogFetch ??= installBangCatalogFetch();
  harness = await createSettingsHarness();
  const active = harness;
  const commits: string[] = [];
  const controller = await setupDefaultBangSetting({
    db: active.db,
    getBangPrefix: () => options.bangPrefix ?? "!",
    initialBang: options.initialBang ?? "g",
    initialCustom: options.initialCustom ?? [],
    onCommit: (trigger) => commits.push(trigger),
    runWrite: active.writer.run,
  });
  return {
    commits,
    controller,
    harness: active,
    input: active.query<HTMLInputElement>("#default-bang"),
    results: active.query("#default-bang-results"),
    status: active.query("#bang-status"),
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

async function type(fixture: DefaultBangFixture, value: string): Promise<void> {
  fixture.input.value = value;
  fire(fixture.input, "input");
  // The preview is debounced by 120ms.
  await fixture.harness.handle.advance(120);
}

/** The `data-trigger` of the currently highlighted preview row. */
function highlightedTrigger(fixture: DefaultBangFixture): string {
  const selected = fixture.results.querySelector('[aria-selected="true"]');
  if (!selected) {
    throw new Error("No preview row is highlighted");
  }
  return (selected as unknown as HTMLElement).dataset.trigger as string;
}

describe("initial default bang state", () => {
  test("shows the stored bang and its catalog name", async () => {
    const fixture = await setup({ initialBang: "ddg" });

    expect(fixture.input.value).toBe("ddg");
    expect(fixture.status.textContent).toBe("DuckDuckGo");
    expect(fixture.status.className).toContain("text-success");
  });

  test("falls back to google when the stored bang is unknown", async () => {
    const fixture = await setup({ initialBang: "not-a-bang" });

    expect(fixture.input.value).toBe("g");
    expect(fixture.status.textContent).toBe("Google");
  });

  test("custom bangs override built-ins and expose their hostname", async () => {
    const fixture = await setup({
      initialBang: "g",
      initialCustom: [
        { trigger: "g", name: "My Search", url: "https://mine.test/?q={}" },
      ],
    });

    expect(fixture.status.textContent).toBe("My Search");
    await type(fixture, "my sea");
    expect(fixture.results.textContent).toContain("mine.test");
  });

  test("regex custom bangs are not eligible as the default", async () => {
    const fixture = await setup({
      initialBang: "rx",
      initialCustom: [
        {
          trigger: "rx",
          name: "Regex",
          url: "https://rx.test/$1",
          regex: "^(.*)$",
          encoding: "percent",
        },
      ],
    });

    // The regex entry is removed from the eligible map, so "rx" cannot stick.
    expect(fixture.input.value).toBe("g");
  });

  test("a custom bang with an unparseable URL still lists as Custom", async () => {
    const fixture = await setup({
      initialCustom: [{ trigger: "zzq", name: "Broken", url: "not a url {}" }],
    });

    await type(fixture, "zzq");

    expect(fixture.results.textContent).toContain("Custom");
  });
});

describe("default bang preview list", () => {
  test("renders matches with the active bang prefix on the badge", async () => {
    const fixture = await setup({ bangPrefix: "$" });

    await type(fixture, "duckduck");

    const options = fixture.results.querySelectorAll('[role="option"]');
    expect(options.length).toBeGreaterThan(0);
    expect(options[0].textContent).toContain("$");
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    expect(fixture.input.getAttribute("aria-expanded")).toBe("true");
  });

  test("caps the preview at six results", async () => {
    const fixture = await setup();

    await type(fixture, "a");

    expect(
      fixture.results.querySelectorAll('[role="option"]').length
    ).toBeLessThanOrEqual(6);
  });

  test("ignores a leading bang prefix when searching", async () => {
    const fixture = await setup();

    await type(fixture, "!duckduckgo");

    expect(fixture.results.textContent).toContain("DuckDuckGo");
  });

  test("reports when nothing matches", async () => {
    const fixture = await setup();

    await type(fixture, "zzzzzzzzznope");

    expect(fixture.results.textContent).toBe("No matching bangs");
    expect(fixture.results.querySelectorAll('[role="option"]')).toHaveLength(0);
  });

  test("clearing the field closes the preview", async () => {
    const fixture = await setup();
    await type(fixture, "duck");
    expect(fixture.results.classList.contains("hidden")).toBe(false);

    await type(fixture, "   ");

    expect(fixture.results.classList.contains("hidden")).toBe(true);
    expect(fixture.input.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("default bang keyboard and pointer selection", () => {
  test("arrow keys wrap around the preview list", async () => {
    const fixture = await setup();
    await type(fixture, "goog");
    const options = fixture.results.querySelectorAll('[role="option"]');

    pressKey(fixture.input, "ArrowDown");
    expect(options[1].getAttribute("aria-selected")).toBe("true");
    expect(options[0].getAttribute("aria-selected")).toBe("false");

    pressKey(fixture.input, "ArrowUp");
    expect(options[0].getAttribute("aria-selected")).toBe("true");

    pressKey(fixture.input, "ArrowUp");
    expect(options[options.length - 1].getAttribute("aria-selected")).toBe(
      "true"
    );
  });

  test("ctrl+j and ctrl+k move the selection too", async () => {
    const fixture = await setup();
    await type(fixture, "goog");
    const options = fixture.results.querySelectorAll('[role="option"]');

    pressKey(fixture.input, "j", { ctrlKey: true });
    expect(options[1].getAttribute("aria-selected")).toBe("true");

    pressKey(fixture.input, "k", { ctrlKey: true });
    expect(options[0].getAttribute("aria-selected")).toBe("true");
  });

  test("Escape closes the preview without choosing", async () => {
    const fixture = await setup();
    await type(fixture, "goog");

    pressKey(fixture.input, "Escape");

    expect(fixture.results.classList.contains("hidden")).toBe(true);
    expect(fixture.commits).toHaveLength(0);
  });

  test("Enter commits the highlighted bang", async () => {
    const fixture = await setup();
    await type(fixture, "duckduckgo");
    const expected = highlightedTrigger(fixture);

    pressKey(fixture.input, "Enter");
    await fixture.harness.handle.settle();

    expect(fixture.input.value).toBe(expected);
    expect(fixture.commits).toEqual([expected]);
    expect(await fixture.harness.db.getSetting("default-bang")).toBe(expected);
  });

  test("ctrl+y commits like Enter", async () => {
    const fixture = await setup();
    await type(fixture, "duckduckgo");
    const expected = highlightedTrigger(fixture);

    pressKey(fixture.input, "y", { ctrlKey: true });
    await fixture.harness.handle.settle();

    expect(fixture.commits).toEqual([expected]);
  });

  test("keys are ignored when no preview is open", async () => {
    const fixture = await setup();

    const event = pressKey(fixture.input, "ArrowDown");

    expect(event.defaultPrevented).toBe(false);
  });

  test("hovering a row highlights it and clicking commits it", async () => {
    const fixture = await setup();
    await type(fixture, "goog");
    const options = fixture.results.querySelectorAll('[role="option"]');

    fire(options[1] as unknown as HTMLElement, "pointerenter");
    expect(options[1].getAttribute("aria-selected")).toBe("true");

    const trigger = (options[1] as unknown as HTMLElement).dataset
      .trigger as string;
    fire(options[1] as unknown as HTMLElement, "click");
    await fixture.harness.handle.settle();

    expect(fixture.commits).toEqual([trigger]);
  });

  test("pointerdown on a row does not steal focus", async () => {
    const fixture = await setup();
    await type(fixture, "goog");
    const option = fixture.results.querySelectorAll(
      '[role="option"]'
    )[0] as unknown as HTMLElement;

    const event = fire(option, "pointerdown");

    expect(event.defaultPrevented).toBe(true);
  });
});

describe("committing the default bang", () => {
  test("rejects an unknown bang with a shake and an error status", async () => {
    const fixture = await setup();

    fixture.input.value = "definitely-not-a-bang";
    fire(fixture.input, "change");
    await fixture.harness.handle.settle();

    expect(fixture.status.textContent).toBe("Unknown bang");
    expect(fixture.status.className).toContain("text-danger");
    expect(fixture.input.classList.contains("shake-anim")).toBe(true);
    expect(fixture.commits).toHaveLength(0);
  });

  test("accepts a typed bang with its prefix and normalizes case", async () => {
    const fixture = await setup();

    fixture.input.value = "!DDG";
    fire(fixture.input, "change");
    await fixture.harness.handle.settle();

    expect(fixture.commits).toEqual(["ddg"]);
    expect(fixture.status.textContent).toBe("DuckDuckGo");
    expect(fixture.input.classList.contains("flash-anim")).toBe(true);
  });

  test("restores the committed bang when the write fails", async () => {
    const fixture = await setup({ initialBang: "g" });
    const failing = spyOn(fixture.harness.db, "setSetting").mockImplementation(
      () => Promise.reject(new Error("quota"))
    );

    fixture.input.value = "ddg";
    fire(fixture.input, "change");
    await fixture.harness.handle.settle();

    expect(fixture.input.value).toBe("g");
    expect(fixture.status.textContent).toBe("Google");
    expect(fixture.status.className).toContain("text-danger");
    expect(fixture.commits).toHaveLength(0);
    failing.mockRestore();
  });
});

describe("default bang controller updates", () => {
  test("setCommitted accepts a known trigger and rejects others", async () => {
    const fixture = await setup();

    expect(fixture.controller.setCommitted("ddg")).toBe("ddg");
    expect(fixture.input.value).toBe("ddg");
    expect(fixture.status.textContent).toBe("DuckDuckGo");

    expect(fixture.controller.setCommitted("nope")).toBe("g");
    expect(fixture.input.value).toBe("g");
  });

  test("setCustomBangs keeps a still-valid selection", async () => {
    const fixture = await setup({ initialBang: "ddg" });

    expect(
      fixture.controller.setCustomBangs([
        { trigger: "mine", name: "Mine", url: "https://mine.test/?q={}" },
      ])
    ).toBe("ddg");
    expect(fixture.input.value).toBe("ddg");
  });

  test("setCustomBangs falls back when the selection disappears", async () => {
    const fixture = await setup({
      initialBang: "mine",
      initialCustom: [
        { trigger: "mine", name: "Mine", url: "https://mine.test/?q={}" },
      ],
    });
    expect(fixture.input.value).toBe("mine");

    expect(fixture.controller.setCustomBangs([])).toBe("g");
    expect(fixture.input.value).toBe("g");
    expect(fixture.status.textContent).toBe("Google");
  });
});
