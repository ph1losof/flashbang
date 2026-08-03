import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { CustomBangRecord } from "../src/shared/capture-template";
import type { TriggerPrefix } from "../src/shared/trigger-prefix";
import { setupCustomBangs } from "../src/ui/settings/custom-bangs";
import { fire } from "./helpers/dom";
import {
  createSettingsHarness,
  type SettingsHarness,
} from "./helpers/settings-dom";

let harness: SettingsHarness | null = null;
let consoleError: ReturnType<typeof spyOn> | null = null;

interface CustomBangsFixture {
  advanced: HTMLDetailsElement;
  cancelButton: HTMLButtonElement;
  changes: CustomBangRecord[][];
  error: HTMLElement;
  form: HTMLFormElement;
  harness: SettingsHarness;
  list: HTMLElement;
  refresh: () => Promise<void>;
  submitButton: HTMLButtonElement;
}

async function setup(
  options: { seed?: CustomBangRecord[]; bangPrefix?: TriggerPrefix } = {}
): Promise<CustomBangsFixture> {
  consoleError ??= spyOn(console, "error").mockImplementation(() => undefined);
  harness = await createSettingsHarness();
  const active = harness;
  for (const bang of options.seed ?? []) {
    await active.db.addCustomBang(bang);
  }
  const changes: CustomBangRecord[][] = [];
  const refresh = setupCustomBangs(
    active.db,
    (custom) => changes.push(custom),
    active.writer.run,
    () => options.bangPrefix ?? "!"
  );
  await active.handle.settle();
  return {
    advanced: active.query<HTMLDetailsElement>("#add-bang-form details"),
    cancelButton: active.query<HTMLButtonElement>("#custom-bang-cancel"),
    changes,
    error: active.query("#custom-bang-error"),
    form: active.query<HTMLFormElement>("#add-bang-form"),
    harness: active,
    list: active.query("#custom-list"),
    refresh,
    submitButton: active.query<HTMLButtonElement>("#custom-bang-submit"),
  };
}

afterEach(() => {
  consoleError?.mockRestore();
  consoleError = null;
  harness?.restore();
  harness = null;
});

function field(fixture: CustomBangsFixture, name: string): HTMLInputElement {
  return fixture.form.elements.namedItem(name) as HTMLInputElement;
}

function fillForm(
  fixture: CustomBangsFixture,
  values: Record<string, string>
): void {
  for (const [name, value] of Object.entries(values)) {
    field(fixture, name).value = value;
  }
}

async function submit(fixture: CustomBangsFixture): Promise<void> {
  fire(fixture.form, "submit", { cancelable: true });
  await fixture.harness.handle.settle();
}

describe("rendering the custom bang list", () => {
  test("shows an empty state and reports no bangs", async () => {
    const fixture = await setup();

    expect(fixture.list.textContent).toBe("No custom bangs yet");
    expect(fixture.changes.at(-1)).toEqual([]);
  });

  test("renders a row per bang with the active prefix on the badge", async () => {
    const fixture = await setup({
      bangPrefix: "$",
      seed: [{ trigger: "me", name: "Mine", url: "https://mine.test/?q={}" }],
    });

    expect(fixture.list.textContent).toContain("$me");
    expect(fixture.list.textContent).toContain("Mine");
    expect(fixture.changes.at(-1)).toHaveLength(1);
  });

  test("tags regex and snap bangs", async () => {
    const fixture = await setup({
      seed: [
        {
          trigger: "rx",
          name: "Regex",
          url: "https://rx.test/$1",
          regex: "^(\\d+)$",
          encoding: "percent",
        },
        {
          trigger: "sn",
          name: "Snap",
          url: "https://sn.test/?q={}",
          snap: "example.com",
        },
      ],
    });

    expect(fixture.list.textContent).toContain("regex");
    expect(fixture.list.textContent).toContain("snap");
  });
});

describe("adding a custom bang", () => {
  test("persists a simple bang and resets the form", async () => {
    const fixture = await setup();
    fillForm(fixture, {
      shortcut: "me",
      name: "Mine",
      url: "https://mine.test/?q={}",
    });

    await submit(fixture);

    expect(await fixture.harness.db.getAllCustomBangs()).toHaveLength(1);
    expect(fixture.list.textContent).toContain("!me");
    expect(field(fixture, "shortcut").value).toBe("");
    expect(fixture.error.classList.contains("hidden")).toBe(true);
  });

  test("strips a leading prefix and lowercases the trigger", async () => {
    const fixture = await setup();
    fillForm(fixture, {
      shortcut: "!ME",
      name: "Mine",
      url: "https://mine.test/?q={}",
    });

    await submit(fixture);

    expect(
      (await fixture.harness.db.getAllCustomBangs()).map((bang) => bang.trigger)
    ).toEqual(["me"]);
  });

  test("stores regex captures together with the encoding", async () => {
    const fixture = await setup();
    fillForm(fixture, {
      shortcut: "iss",
      name: "Issue",
      url: "https://git.test/issues/$1",
      regex: "^(\\d+)$",
    });
    (fixture.form.elements.namedItem("encoding") as HTMLSelectElement).value =
      "plus";

    await submit(fixture);

    const [stored] = await fixture.harness.db.getAllCustomBangs();
    expect(stored.regex).toBe("^(\\d+)$");
    expect(stored.encoding).toBe("plus");
  });

  test("stores a snap target", async () => {
    const fixture = await setup();
    fillForm(fixture, {
      shortcut: "sn",
      name: "Snap",
      url: "https://sn.test/?q={}",
      snap: "example.com",
    });

    await submit(fixture);

    const [stored] = await fixture.harness.db.getAllCustomBangs();
    expect(stored.snap).toBe("example.com");
  });

  test("rejects a reserved or malformed trigger", async () => {
    const fixture = await setup();
    fillForm(fixture, {
      shortcut: "a b",
      name: "Mine",
      url: "https://mine.test/?q={}",
    });

    await submit(fixture);

    expect(fixture.error.classList.contains("hidden")).toBe(false);
    expect(fixture.error.textContent).not.toBe("");
    expect(await fixture.harness.db.getAllCustomBangs()).toHaveLength(0);
  });

  test("silently ignores a submission missing the name or URL", async () => {
    const fixture = await setup();
    fillForm(fixture, { shortcut: "me", name: "", url: "" });

    await submit(fixture);

    expect(fixture.error.textContent).toBe("");
    expect(await fixture.harness.db.getAllCustomBangs()).toHaveLength(0);
  });

  test("rejects a URL with no query placeholder", async () => {
    const fixture = await setup();
    fillForm(fixture, {
      shortcut: "me",
      name: "Mine",
      url: "https://mine.test/search",
    });

    await submit(fixture);

    expect(fixture.error.classList.contains("hidden")).toBe(false);
    expect(await fixture.harness.db.getAllCustomBangs()).toHaveLength(0);
  });

  test("rejects an invalid snap target", async () => {
    const fixture = await setup();
    fillForm(fixture, {
      shortcut: "sn",
      name: "Snap",
      url: "https://sn.test/?q={}",
      snap: "not a domain!!",
    });

    await submit(fixture);

    expect(fixture.error.classList.contains("hidden")).toBe(false);
    expect(await fixture.harness.db.getAllCustomBangs()).toHaveLength(0);
  });

  test("keeps the form populated when the write fails", async () => {
    const fixture = await setup();
    const failing = spyOn(
      fixture.harness.db,
      "addCustomBang"
    ).mockImplementation(() => Promise.reject(new Error("quota")));
    fillForm(fixture, {
      shortcut: "me",
      name: "Mine",
      url: "https://mine.test/?q={}",
    });

    await submit(fixture);

    expect(field(fixture, "shortcut").value).toBe("me");
    failing.mockRestore();
  });
});

describe("editing a custom bang", () => {
  test("loads the row into the form and switches to save mode", async () => {
    const fixture = await setup({
      seed: [
        {
          trigger: "rx",
          name: "Regex",
          url: "https://rx.test/$1",
          regex: "^(\\d+)$",
          encoding: "plus",
          snap: "example.com",
        },
      ],
    });

    fire(
      fixture.list.querySelectorAll("button")[0] as unknown as HTMLElement,
      "click"
    );

    expect(field(fixture, "shortcut").value).toBe("rx");
    expect(field(fixture, "name").value).toBe("Regex");
    expect(field(fixture, "regex").value).toBe("^(\\d+)$");
    expect(field(fixture, "snap").value).toBe("example.com");
    expect(
      (fixture.form.elements.namedItem("encoding") as HTMLSelectElement).value
    ).toBe("plus");
    expect(fixture.advanced.open).toBe(true);
    expect(fixture.submitButton.textContent).toBe("Save Changes");
    expect(fixture.cancelButton.classList.contains("hidden")).toBe(false);
  });

  test("leaves the advanced panel closed for a simple bang", async () => {
    const fixture = await setup({
      seed: [{ trigger: "me", name: "Mine", url: "https://mine.test/?q={}" }],
    });

    fire(
      fixture.list.querySelectorAll("button")[0] as unknown as HTMLElement,
      "click"
    );

    expect(fixture.advanced.open).toBe(false);
  });

  test("saving an edit can rename the trigger", async () => {
    const fixture = await setup({
      seed: [{ trigger: "me", name: "Mine", url: "https://mine.test/?q={}" }],
    });
    fire(
      fixture.list.querySelectorAll("button")[0] as unknown as HTMLElement,
      "click"
    );
    fillForm(fixture, { shortcut: "you", name: "Yours" });

    await submit(fixture);

    const stored = await fixture.harness.db.getAllCustomBangs();
    expect(stored.map((bang) => bang.trigger)).toEqual(["you"]);
    expect(stored[0].name).toBe("Yours");
    expect(fixture.submitButton.textContent).toBe("Add Bang");
    expect(fixture.cancelButton.classList.contains("hidden")).toBe(true);
  });

  test("cancel restores the add-mode form", async () => {
    const fixture = await setup({
      seed: [{ trigger: "me", name: "Mine", url: "https://mine.test/?q={}" }],
    });
    fire(
      fixture.list.querySelectorAll("button")[0] as unknown as HTMLElement,
      "click"
    );

    fire(fixture.cancelButton, "click");

    expect(field(fixture, "shortcut").value).toBe("");
    expect(fixture.submitButton.textContent).toBe("Add Bang");
    expect(fixture.advanced.open).toBe(false);
  });
});

describe("removing a custom bang", () => {
  test("removes the row and reports the new list", async () => {
    const fixture = await setup({
      seed: [
        { trigger: "me", name: "Mine", url: "https://mine.test/?q={}" },
        { trigger: "you", name: "Yours", url: "https://yours.test/?q={}" },
      ],
    });

    const removeButtons = fixture.list.querySelectorAll(".btn-danger");
    fire(removeButtons[0] as unknown as HTMLElement, "click");
    await fixture.harness.handle.settle();

    expect(
      (await fixture.harness.db.getAllCustomBangs()).map((bang) => bang.trigger)
    ).toEqual(["you"]);
    expect(fixture.changes.at(-1)?.map((bang) => bang.trigger)).toEqual([
      "you",
    ]);
  });

  test("re-enables the button when the removal fails", async () => {
    const fixture = await setup({
      seed: [{ trigger: "me", name: "Mine", url: "https://mine.test/?q={}" }],
    });
    const failing = spyOn(
      fixture.harness.db,
      "removeCustomBang"
    ).mockImplementation(() => Promise.reject(new Error("quota")));
    const removeButton = fixture.list.querySelectorAll(
      ".btn-danger"
    )[0] as unknown as HTMLButtonElement;

    fire(removeButton, "click");
    await fixture.harness.handle.settle();

    expect(removeButton.disabled).toBe(false);
    failing.mockRestore();
  });

  test("removing the bang under edit resets the form", async () => {
    const fixture = await setup({
      seed: [{ trigger: "me", name: "Mine", url: "https://mine.test/?q={}" }],
    });
    fire(
      fixture.list.querySelectorAll("button")[0] as unknown as HTMLElement,
      "click"
    );
    expect(fixture.submitButton.textContent).toBe("Save Changes");

    fire(
      fixture.list.querySelectorAll(".btn-danger")[0] as unknown as HTMLElement,
      "click"
    );
    await fixture.harness.handle.settle();

    expect(fixture.submitButton.textContent).toBe("Add Bang");
    expect(field(fixture, "shortcut").value).toBe("");
  });

  test("the returned refresh clears edit state and redraws", async () => {
    const fixture = await setup({
      seed: [{ trigger: "me", name: "Mine", url: "https://mine.test/?q={}" }],
    });
    fire(
      fixture.list.querySelectorAll("button")[0] as unknown as HTMLElement,
      "click"
    );

    await fixture.refresh();

    expect(fixture.submitButton.textContent).toBe("Add Bang");
    expect(fixture.list.textContent).toContain("!me");
  });
});
