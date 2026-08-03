import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resetDB } from "../src/shared/idb";
import { parseSuggestCookieValue } from "../src/shared/suggest-cookie";
import { DB } from "../src/ui/db";
import { installBangCatalogFetch } from "./helpers/bang-catalog-fetch";
import {
  canvasContextFactory,
  type DomHandle,
  fire,
  installDom,
  readHomeHtml,
} from "./helpers/dom";
import { installFakeIndexedDb } from "./helpers/fake-indexeddb";
import { createServiceWorkerStub } from "./helpers/service-worker";
import { putSettingRecord } from "./helpers/shared-db";

/**
 * `src/ui/app.ts` boots the whole home page from its top level, so importing it
 * *is* the test. The page is loaded at `/settings` so the deep-link branch opens
 * the dialog, which is also what pulls in the settings module.
 */

const globals = globalThis as unknown as Record<string, unknown>;
let handle: DomHandle;
let restoreIndexedDb: (() => void) | null = null;
let catalogFetch: { restore: () => void } | null = null;
let savedAllowUnsafe: unknown;

beforeAll(async () => {
  savedAllowUnsafe = globals.__ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS__;
  globals.__ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS__ = true;
  restoreIndexedDb = installFakeIndexedDb();
  resetDB();
  catalogFetch = installBangCatalogFetch();

  await putSettingRecord({ key: "default-bang", value: "ddg" });
  await putSettingRecord({ key: "bang-prefix", value: "$" });
  // Seeded through the real DB so the record carries a name, as the app writes.
  await new DB().addCustomBang({
    trigger: "zqx",
    name: "Mine",
    url: "https://mine.test/?q={}",
  });

  const sw = createServiceWorkerStub({ controller: true });
  handle = installDom({
    html: await readHomeHtml(),
    serviceWorker: sw.navigator.serviceWorker,
    url: "https://flashbang.test/settings",
    // WebGL is unavailable, so the wordmark takes its CSS fallback.
    canvasContext: canvasContextFactory(null),
  });

  await import("../src/ui/app");
  await handle.settle();
});

afterAll(() => {
  catalogFetch?.restore();
  catalogFetch = null;
  resetDB();
  handle.restore();
  restoreIndexedDb?.();
  restoreIndexedDb = null;
  globals.__ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS__ = savedAllowUnsafe;
});

function query<T extends HTMLElement>(selector: string): T {
  const found = handle.document.querySelector(selector);
  if (!found) {
    throw new Error(`Missing element: ${selector}`);
  }
  return found as unknown as T;
}

describe("app boot", () => {
  test("marks the document ready once wiring completes", () => {
    expect(handle.document.documentElement.dataset.appReady).toBe("true");
  });

  test("publishes the suggest cookie from stored settings", () => {
    const cookie = handle.document.cookie;
    expect(cookie).toContain("suggest=");
    const parsed = parseSuggestCookieValue(
      cookie.substring("suggest=".length, cookie.indexOf(";")),
      true
    );
    expect(parsed.trigger).toBe("ddg");
    expect(parsed.custom).toContain("zqx");
  });

  test("applies the stored bang prefix to the command palette", () => {
    expect(query<HTMLInputElement>("#bang-command-input").placeholder).toBe(
      "Search bangs or enter $gh react"
    );
  });

  test("installs the vim blur shortcut", () => {
    const input = query<HTMLInputElement>("#bang-command-input");
    input.focus();

    fire(handle.document, "keydown", { key: "[", ctrlKey: true });

    expect(handle.document.activeElement).not.toBe(
      input as unknown as HTMLElement
    );
  });

  test("falls back to the CSS wordmark when WebGL is unavailable", () => {
    expect(query("#metal-canvas").style.display).toBe("none");
  });
});

describe("settings deep link", () => {
  test("opens the dialog and rewrites the URL back to the root", () => {
    expect(query("#settings-modal").classList.contains("open")).toBe(true);
    expect(query("#gear-btn").getAttribute("aria-expanded")).toBe("true");
    expect(handle.replacedStates).toEqual(["/"]);
  });

  test("initializes the settings panel on that first open", () => {
    expect(query<HTMLInputElement>("#default-bang").value).toBe("ddg");
    expect(query<HTMLSelectElement>("#bang-prefix").value).toBe("$");
    expect(query("#custom-list").textContent).toContain("$zqx");
  });

  test("the dialog closes and reopens without re-initializing", () => {
    fire(query("#modal-close"), "click");
    expect(query("#settings-modal").classList.contains("open")).toBe(false);

    fire(query("#gear-btn"), "click");
    expect(query("#settings-modal").classList.contains("open")).toBe(true);
  });
});
