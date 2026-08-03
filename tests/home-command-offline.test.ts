import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { resetDB } from "../src/shared/idb";
import { createBangMeta, searchBangs } from "../src/ui/bang-catalog";
import { DB } from "../src/ui/db";
import { type DomHandle, fire, installDom, readHomeHtml } from "./helpers/dom";
import { installFakeIndexedDb } from "./helpers/fake-indexeddb";

/**
 * `loadBuiltinBangCatalog` caches its promise for the whole process, so the
 * offline path cannot be reached by failing `fetch` once another test has
 * loaded the catalog. Replacing the module is the only reliable way in.
 */
beforeAll(() => {
  mock.module("../src/ui/bang-catalog", () => ({
    createBangMeta,
    loadBuiltinBangCatalog: () =>
      Promise.reject(new Error("catalog unavailable")),
    searchBangs,
  }));
});

let dom: DomHandle | null = null;
let restoreIndexedDb: (() => void) | null = null;

afterEach(() => {
  resetDB();
  dom?.restore();
  dom = null;
  restoreIndexedDb?.();
  restoreIndexedDb = null;
});

describe("command palette without a catalog", () => {
  test("reports an unavailable index and keeps the list closed", async () => {
    const { setupBangCommand } = await import("../src/ui/home/command");
    restoreIndexedDb = installFakeIndexedDb();
    resetDB();
    const handle = installDom({ html: await readHomeHtml() });
    dom = handle;
    const input = handle.document.querySelector(
      "#bang-command-input"
    ) as unknown as HTMLInputElement;
    const results = handle.document.querySelector(
      "#bang-command-results"
    ) as unknown as HTMLElement;

    setupBangCommand(new DB());
    fire(input, "focus");
    await handle.settle();

    expect(handle.document.querySelector("#home-bang-count")?.textContent).toBe(
      "Bang index unavailable"
    );

    // Typing still must not throw or open an empty list.
    input.value = "!gh";
    fire(input, "input");
    await handle.settle();
    expect(results.textContent).toBe('No bang found for "gh"');
  });
});
