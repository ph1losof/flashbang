/**
 * Wires the fake DOM, a fake IndexedDB, and a service worker stub together so
 * the settings modules can be exercised the way `initSettings` runs them.
 */

import { resetDB } from "../../src/shared/idb";
import { DB } from "../../src/ui/db";
import {
  createSettingsWriter,
  type SettingControl,
  type SettingsWriter,
} from "../../src/ui/settings/write";
import {
  type DomHandle,
  type InstallDomOptions,
  installDom,
  readHomeHtml,
} from "./dom";
import { installFakeIndexedDb } from "./fake-indexeddb";
import {
  createServiceWorkerStub,
  type ServiceWorkerStub,
  type ServiceWorkerStubOptions,
} from "./service-worker";

let cachedHomeHtml: string | null = null;

/** Reads and caches the home page markup shared by every settings test. */
export async function homeHtml(): Promise<string> {
  cachedHomeHtml ??= await readHomeHtml();
  return cachedHomeHtml;
}

export interface SettingsHarness {
  db: DB;
  handle: DomHandle;
  /** Typed `document.querySelector` that throws on a missing selector. */
  query: <T extends HTMLElement>(selector: string) => T;
  restore: () => void;
  sw: ServiceWorkerStub;
  writer: SettingsWriter;
}

export interface SettingsHarnessOptions extends InstallDomOptions {
  serviceWorkerOptions?: ServiceWorkerStubOptions;
  /** Controls handed to the settings writer; defaults to none. */
  writerControls?: (query: SettingsHarness["query"]) => SettingControl[];
}

/**
 * Installs everything a settings test needs. Always call `restore()` from
 * `afterEach`, which also resets the shared IndexedDB handle.
 */
export async function createSettingsHarness(
  options: SettingsHarnessOptions = {}
): Promise<SettingsHarness> {
  const { serviceWorkerOptions, writerControls, html, ...domOptions } = options;
  const restoreIndexedDb = installFakeIndexedDb();
  resetDB();

  const sw = createServiceWorkerStub({
    controller: true,
    ...serviceWorkerOptions,
  });
  const handle = installDom({
    html: html ?? (await homeHtml()),
    serviceWorker: sw.navigator.serviceWorker,
    ...domOptions,
  });

  const query = <T extends HTMLElement>(selector: string): T => {
    const found = handle.document.querySelector(selector);
    if (!found) {
      throw new Error(`Missing fixture element: ${selector}`);
    }
    return found as unknown as T;
  };

  return {
    db: new DB(),
    handle,
    query,
    restore() {
      resetDB();
      handle.restore();
      restoreIndexedDb();
    },
    sw,
    writer: createSettingsWriter(writerControls?.(query) ?? []),
  };
}

/** Every settings key `initSettings` reads, in the order it reads them. */
export const SETTINGS_KEYS = [
  "default-bang",
  "suggest-provider",
  "suggest-url",
  "lucky-provider",
  "lucky-url",
  "bang-prefix",
  "snap-prefix",
] as const;
