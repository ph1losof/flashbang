import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  TRIGGER_PREFIXES,
  type TriggerPrefix,
} from "../src/shared/trigger-prefix";
import {
  type SyntaxSettingsController,
  setupSyntaxSettings,
} from "../src/ui/settings/syntax";
import { fire } from "./helpers/dom";
import {
  createSettingsHarness,
  type SettingsHarness,
} from "./helpers/settings-dom";

let harness: SettingsHarness | null = null;
let consoleError: ReturnType<typeof spyOn> | null = null;

interface SyntaxFixture {
  changes: number;
  controller: SyntaxSettingsController;
  harness: SettingsHarness;
  state: { bangPrefix: TriggerPrefix; snapPrefix: TriggerPrefix };
}

async function setup(
  initial: { bang?: TriggerPrefix; snap?: TriggerPrefix } = {}
): Promise<SyntaxFixture> {
  consoleError ??= spyOn(console, "error").mockImplementation(() => undefined);
  harness = await createSettingsHarness();
  const state = {
    bangPrefix: initial.bang ?? ("!" as const),
    snapPrefix: initial.snap ?? ("@" as const),
  };
  const fixture: SyntaxFixture = {
    changes: 0,
    controller: setupSyntaxSettings({
      db: harness.db,
      onChange: () => {
        fixture.changes++;
      },
      state,
      writer: harness.writer,
    }),
    harness,
    state,
  };
  return fixture;
}

afterEach(() => {
  consoleError?.mockRestore();
  consoleError = null;
  harness?.restore();
  harness = null;
});

describe("syntax prefix options", () => {
  test("populates both selects with every supported prefix", async () => {
    const { controller } = await setup();

    for (const select of [controller.bangSelect, controller.snapSelect]) {
      expect(Array.from(select.options).map((option) => option.value)).toEqual([
        ...TRIGGER_PREFIXES,
      ]);
      expect(
        Array.from(select.options).map((option) => option.textContent)
      ).toEqual([...TRIGGER_PREFIXES]);
    }
  });

  test("reflects current state and disables the prefix taken by the other role", async () => {
    const { controller } = await setup({ bang: "!", snap: "@" });

    expect(controller.bangSelect.value).toBe("!");
    expect(controller.snapSelect.value).toBe("@");

    const disabledForBang = Array.from(controller.bangSelect.options)
      .filter((option) => option.disabled)
      .map((option) => option.value);
    const disabledForSnap = Array.from(controller.snapSelect.options)
      .filter((option) => option.disabled)
      .map((option) => option.value);
    expect(disabledForBang).toEqual(["@"]);
    expect(disabledForSnap).toEqual(["!"]);
  });

  test("mirrors the bang prefix into the descriptive labels", async () => {
    const { harness: active } = await setup({ bang: "$", snap: ":" });

    expect(active.query("#default-bang-prefix").textContent).toBe("$");
    expect(active.query("#lucky-leading-syntax").textContent).toBe("$ query");
    expect(active.query("#lucky-trailing-syntax").textContent).toBe("query $");
  });
});

describe("changing a syntax prefix", () => {
  test("persists the new bang prefix and reports the change", async () => {
    const fixture = await setup();

    fixture.controller.bangSelect.value = "$";
    fire(fixture.controller.bangSelect, "change");
    await fixture.harness.handle.settle();

    expect(await fixture.harness.db.getSetting("bang-prefix")).toBe("$");
    expect(fixture.state.bangPrefix).toBe("$");
    expect(fixture.changes).toBe(1);
    expect(fixture.harness.query("#default-bang-prefix").textContent).toBe("$");
  });

  test("persists the snap prefix independently", async () => {
    const fixture = await setup();

    fixture.controller.snapSelect.value = ":";
    fire(fixture.controller.snapSelect, "change");
    await fixture.harness.handle.settle();

    expect(await fixture.harness.db.getSetting("snap-prefix")).toBe(":");
    expect(fixture.state.snapPrefix).toBe(":");
    // The bang select's disabled option follows the new snap prefix.
    expect(
      Array.from(fixture.controller.bangSelect.options)
        .filter((option) => option.disabled)
        .map((option) => option.value)
    ).toEqual([":"]);
  });

  test("refuses a prefix already used by the other role and snaps back", async () => {
    const fixture = await setup({ bang: "!", snap: "@" });

    fixture.controller.bangSelect.value = "@";
    fire(fixture.controller.bangSelect, "change");
    await fixture.harness.handle.settle();

    expect(fixture.controller.bangSelect.value).toBe("!");
    expect(fixture.state.bangPrefix).toBe("!");
    expect(fixture.changes).toBe(0);
    expect(await fixture.harness.db.getSetting("bang-prefix")).toBeNull();
  });

  test("restores the committed value when the write fails", async () => {
    const fixture = await setup();
    const failing = spyOn(fixture.harness.db, "setSetting").mockImplementation(
      () => Promise.reject(new Error("quota exceeded"))
    );

    fixture.controller.bangSelect.value = "$";
    fire(fixture.controller.bangSelect, "change");
    await fixture.harness.handle.settle();

    expect(fixture.state.bangPrefix).toBe("!");
    expect(fixture.controller.bangSelect.value).toBe("!");
    expect(fixture.changes).toBe(0);
    failing.mockRestore();
  });

  test("refresh re-syncs the controls from state", async () => {
    const fixture = await setup();

    fixture.state.bangPrefix = ":";
    fixture.state.snapPrefix = "$";
    fixture.controller.refresh();

    expect(fixture.controller.bangSelect.value).toBe(":");
    expect(fixture.controller.snapSelect.value).toBe("$");
    expect(fixture.harness.query("#lucky-leading-syntax").textContent).toBe(
      ": query"
    );
  });
});
