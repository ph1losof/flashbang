import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { HOT_BOOT_SENTINEL } from "../src/shared/hot-boot";
import {
  createSettingsWriter,
  type SettingControl,
  type SettingsWriter,
} from "../src/ui/settings/write";
import { type DomHandle, installDom, readHomeHtml } from "./helpers/dom";
import {
  createServiceWorkerStub,
  type ServiceWorkerStub,
  type ServiceWorkerStubOptions,
} from "./helpers/service-worker";

let homeHtml = "";
let dom: DomHandle | null = null;
let consoleError: ReturnType<typeof spyOn> | null = null;

interface Harness {
  controls: SettingControl[];
  handle: DomHandle;
  status: HTMLElement;
  sw: ServiceWorkerStub;
  writer: SettingsWriter;
}

beforeEach(async () => {
  homeHtml ||= await readHomeHtml();
  consoleError = spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  consoleError?.mockRestore();
  consoleError = null;
  dom?.restore();
  dom = null;
});

function setup(options: ServiceWorkerStubOptions = {}): Harness {
  const sw = createServiceWorkerStub({ controller: true, ...options });
  const handle = installDom({
    html: homeHtml,
    serviceWorker: sw.navigator.serviceWorker,
  });
  dom = handle;
  const query = <T extends HTMLElement>(selector: string): T =>
    handle.document.querySelector(selector) as unknown as T;
  const controls: SettingControl[] = [
    query<HTMLInputElement>("#default-bang"),
    query<HTMLButtonElement>("#export-btn"),
  ];
  return {
    controls,
    handle,
    status: query("#settings-save-status"),
    sw,
    writer: createSettingsWriter(controls),
  };
}

function iconHidden(handle: DomHandle, selector: string): boolean {
  const icon = handle.document.querySelector(
    selector
  ) as unknown as HTMLElement;
  return icon.classList.contains("hidden");
}

describe("settings writer status rendering", () => {
  test("starts in the saved state with only the saved icon visible", () => {
    const { handle, status } = setup();

    expect(status.dataset.state).toBe("saved");
    expect(status.dataset.pending).toBe("0");
    expect(status.dataset.writeCount).toBe("0");
    expect(status.getAttribute("aria-label")).toBe("Settings saved");
    expect(status.hasAttribute("title")).toBe(false);
    expect(iconHidden(handle, "#settings-saved-icon")).toBe(false);
    expect(iconHidden(handle, "#settings-saving-icon")).toBe(true);
    expect(iconHidden(handle, "#settings-error-icon")).toBe(true);
  });

  test("shows the saving icon only once a write outlives the delay", async () => {
    const { handle, status, writer } = setup();
    let release = (): void => undefined;
    const pending = writer.run(
      () => new Promise<void>((resolve) => (release = resolve)),
      { key: "suggest-url" }
    );

    await handle.settle();
    expect(status.dataset.state).toBe("saving");
    expect(status.dataset.pending).toBe("1");
    // The spinner is deliberately withheld for fast writes.
    expect(iconHidden(handle, "#settings-saving-icon")).toBe(true);

    await handle.advance(250);
    expect(iconHidden(handle, "#settings-saving-icon")).toBe(false);
    expect(status.getAttribute("aria-label")).toBe("Saving settings");

    release();
    expect(await pending).toBe(true);
    await handle.settle();
    expect(status.dataset.state).toBe("saved");
    expect(status.dataset.writeCount).toBe("1");
    expect(iconHidden(handle, "#settings-saving-icon")).toBe(true);
  });

  test("disables controls while a write is in flight", async () => {
    const { controls, handle, writer } = setup();
    let release = (): void => undefined;
    const pending = writer.run(
      () => new Promise<void>((resolve) => (release = resolve)),
      { key: "suggest-url" }
    );

    await handle.settle();
    expect(controls.map((control) => control.disabled)).toEqual([true, true]);

    release();
    await pending;
    await handle.settle();
    expect(controls.map((control) => control.disabled)).toEqual([false, false]);
  });

  test("keeps locked controls disabled after a write settles", async () => {
    const { controls, handle, writer } = setup();
    writer.lock(controls[1]);
    expect(controls[1].disabled).toBe(true);

    expect(
      await writer.run(() => Promise.resolve(), { key: "suggest-url" })
    ).toBe(true);
    await handle.settle();

    expect(controls[0].disabled).toBe(false);
    expect(controls[1].disabled).toBe(true);
  });
});

describe("settings writer hot boot coordination", () => {
  test("brackets a hot-boot write with begin and end handshakes", async () => {
    const { handle, sw, writer } = setup();
    const committed: string[] = [];

    const result = await writer.run(() => Promise.resolve(), {
      key: "default-bang",
      onCommit: () => committed.push("default-bang"),
    });
    await handle.settle();

    expect(result).toBe(true);
    expect(committed).toEqual(["default-bang"]);
    expect(sw.headerValues).toEqual([HOT_BOOT_SENTINEL]);
    expect(sw.messages.map((message) => message.data.type)).toEqual([
      "hot-boot-begin",
      "hot-boot-end",
    ]);
  });

  test.each([
    "custom-bangs",
    "bang-prefix",
    "snap-prefix",
    "default-bang",
    "lucky-provider",
    "lucky-url",
    "import",
  ])("treats %s as a hot-boot key", async (key) => {
    const { sw, writer } = setup();

    await writer.run(() => Promise.resolve(), { key });

    expect(sw.messages[0].data.type).toBe("hot-boot-begin");
  });

  test.each(["suggest-provider", "suggest-url"])(
    "leaves the worker alone for %s",
    async (key) => {
      const { sw, writer } = setup();

      await writer.run(() => Promise.resolve(), { key });

      expect(sw.messages).toHaveLength(0);
    }
  );

  test("falls back to a plain invalidation when preload is unavailable", async () => {
    const { sw, writer } = setup({ navigationPreload: false });

    await writer.run(() => Promise.resolve(), { key: "default-bang" });

    expect(sw.messages.map((message) => message.data.type)).toEqual([
      "invalidate",
    ]);
  });

  test("closes the hot-boot window even when the write throws", async () => {
    const { handle, sw, writer } = setup();
    const failures: string[] = [];

    const result = await writer.run(
      () => Promise.reject(new Error("disk full")),
      { key: "default-bang", onFailure: () => failures.push("failed") }
    );
    await handle.settle();

    expect(result).toBe(false);
    expect(failures).toEqual(["failed"]);
    expect(sw.messages.map((message) => message.data.type)).toEqual([
      "hot-boot-begin",
      "hot-boot-end",
    ]);
  });
});

describe("settings writer failures and validation", () => {
  test("surfaces a failed write as an error state naming the key", async () => {
    const { handle, status, writer } = setup();

    expect(
      await writer.run(() => Promise.reject(new Error("nope")), {
        key: "suggest-url",
      })
    ).toBe(false);
    await handle.settle();

    expect(status.dataset.state).toBe("error");
    expect(status.dataset.failed).toBe("suggest-url");
    expect(status.getAttribute("aria-label")).toBe("Could not save settings");
    expect(status.getAttribute("title")).toBe("Could not save settings");
    expect(iconHidden(handle, "#settings-error-icon")).toBe(false);
    expect(consoleError).toHaveBeenCalled();
  });

  test("a later success clears the recorded failure for that key", async () => {
    const { handle, status, writer } = setup();
    await writer.run(() => Promise.reject(new Error("nope")), {
      key: "suggest-url",
    });
    await handle.settle();

    await writer.run(() => Promise.resolve(), { key: "suggest-url" });
    await handle.settle();

    expect(status.dataset.state).toBe("saved");
    expect(status.dataset.failed).toBeUndefined();
  });

  test("validation errors take priority in the status message", () => {
    const { handle, status, writer } = setup();
    const input = handle.document.querySelector(
      "#default-bang"
    ) as unknown as HTMLInputElement;

    writer.showValidationError("suggest-url", "URL must contain {}", input);

    expect(status.dataset.state).toBe("error");
    expect(status.getAttribute("aria-label")).toBe("URL must contain {}");
    expect(input.getAttribute("aria-invalid")).toBe("true");

    writer.clearValidationError("suggest-url", input);

    expect(status.dataset.state).toBe("saved");
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });

  test("clearErrors drops both validation and write failures", async () => {
    const { handle, status, writer } = setup();
    writer.showValidationError("suggest-url", "bad");
    await writer.run(() => Promise.reject(new Error("nope")), {
      key: "default-bang",
    });
    await handle.settle();
    expect(status.dataset.state).toBe("error");

    writer.clearErrors();

    expect(status.dataset.state).toBe("saved");
    expect(status.dataset.failed).toBeUndefined();
  });

  test("defaults the key to custom-bangs when none is given", async () => {
    const { handle, status, writer } = setup();

    await writer.run(() => Promise.reject(new Error("nope")));
    await handle.settle();

    expect(status.dataset.failed).toBe("custom-bangs");
  });
});

describe("settings writer sequencing", () => {
  test("runs queued writes one at a time in submission order", async () => {
    const { handle, writer } = setup();
    const order: string[] = [];
    let releaseFirst = (): void => undefined;

    const first = writer.run(
      () =>
        new Promise<void>((resolve) => {
          order.push("first:start");
          releaseFirst = () => {
            order.push("first:end");
            resolve();
          };
        }),
      { key: "suggest-url" }
    );
    const second = writer.run(
      () => {
        order.push("second:start");
        return Promise.resolve();
      },
      { key: "suggest-provider" }
    );

    await handle.settle();
    expect(order).toEqual(["first:start"]);

    releaseFirst();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  test("a failed write does not stall the queue", async () => {
    const { writer } = setup();

    const results = await Promise.all([
      writer.run(() => Promise.reject(new Error("nope")), { key: "a" }),
      writer.run(() => Promise.resolve(), { key: "b" }),
    ]);

    expect(results).toEqual([false, true]);
  });
});

describe("unload guard", () => {
  test("blocks navigation only while a write is pending", async () => {
    const { handle, writer } = setup();

    expect(handle.fireWindow("beforeunload").defaultPrevented).toBe(false);

    let release = (): void => undefined;
    const pending = writer.run(
      () => new Promise<void>((resolve) => (release = resolve)),
      { key: "suggest-url" }
    );
    await handle.settle();

    const blocked = handle.fireWindow("beforeunload");
    expect(blocked.defaultPrevented).toBe(true);
    expect(blocked.returnValue).toBe("");

    release();
    await pending;
    await handle.settle();
    expect(handle.fireWindow("beforeunload").defaultPrevented).toBe(false);
  });
});
