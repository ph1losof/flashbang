import {
  type CustomBangRecord,
  isCaptureEncoding,
  validateCaptureBang,
  validateSimpleBangUrl,
} from "../shared/capture-template";
import {
  LUCKY_URLS,
  REDIRECT_SETTINGS_SNAPSHOT_KEY,
  SUGGEST_URLS,
} from "../shared/constants";
import { validateCustomTrigger } from "../shared/custom-trigger";
import { idbWrap, openDB } from "../shared/idb";
import { validateSnapTarget } from "../shared/snap-target";
import {
  DEFAULT_BANG_PREFIX,
  DEFAULT_SNAP_PREFIX,
  isTriggerPrefix,
} from "../shared/trigger-prefix";

export const SETTINGS_SCHEMA_VERSION = 2;

const VALID_SETTING_KEYS = new Map([
  ["defaultBang", "default-bang"],
  ["suggestProvider", "suggest-provider"],
  ["suggestUrl", "suggest-url"],
  ["luckyProvider", "lucky-provider"],
  ["luckyUrl", "lucky-url"],
  ["bangPrefix", "bang-prefix"],
  ["snapPrefix", "snap-prefix"],
]);
const CONFIGURABLE_SETTING_KEYS = [...VALID_SETTING_KEYS.values()];

const SUGGEST_PROVIDERS = new Set([
  "default",
  "custom",
  "none",
  ...Object.keys(SUGGEST_URLS),
]);
const LUCKY_PROVIDERS = new Set([
  "default",
  "custom",
  "none",
  ...Object.keys(LUCKY_URLS),
]);
const DOCUMENT_KEYS = new Set([
  "schemaVersion",
  "settings",
  "customBangs",
  "exported",
]);
const CUSTOM_BANG_KEYS = new Set([
  "trigger",
  "name",
  "url",
  "regex",
  "snap",
  "encoding",
]);

export interface ImportResult {
  acceptedCustomBangs: number;
  rejectedCustomBangs: number;
  importedSettings: number;
  replaced: boolean;
}

interface PreparedImport extends ImportResult {
  customBangs: CustomBangRecord[];
  settings: Array<{ key: string; value: string }>;
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write aborted"));
  });
}

function invalidateRedirectSettingsSnapshot(
  tx: IDBTransaction
): Promise<undefined> {
  return idbWrap(
    tx.objectStore("settings").delete(REDIRECT_SETTINGS_SNAPSHOT_KEY)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function prepareImport(data: unknown): PreparedImport {
  if (!isRecord(data)) {
    throw new Error("Invalid import document");
  }
  for (const key of Object.keys(data)) {
    if (!DOCUMENT_KEYS.has(key)) {
      throw new Error(`Unrecognized import field: ${key}`);
    }
  }

  const versioned = Object.hasOwn(data, "schemaVersion");
  if (
    versioned &&
    data.schemaVersion !== 1 &&
    data.schemaVersion !== SETTINGS_SCHEMA_VERSION
  ) {
    throw new Error("Unsupported settings schema version");
  }
  const hasSettings = Object.hasOwn(data, "settings");
  const hasCustomBangs = Object.hasOwn(data, "customBangs");
  if (!(hasSettings || hasCustomBangs)) {
    throw new Error("Import document contains no recognized data");
  }
  if (Object.hasOwn(data, "exported") && typeof data.exported !== "string") {
    throw new Error("Invalid export timestamp");
  }

  const settings: Array<{ key: string; value: string }> = [];
  let importedSettings = 0;
  let suggestProvider: string | null = null;
  let suggestUrl: string | null = null;
  let luckyProvider: string | null = null;
  let luckyUrl: string | null = null;
  let bangPrefix = DEFAULT_BANG_PREFIX;
  let snapPrefix = DEFAULT_SNAP_PREFIX;
  if (hasSettings) {
    if (!isRecord(data.settings)) {
      throw new Error("Invalid settings data");
    }
    const entries = Object.entries(data.settings);
    if (entries.length === 0 && !hasCustomBangs) {
      throw new Error("Import document contains no recognized data");
    }
    for (const [exportKey, value] of entries) {
      const idbKey = VALID_SETTING_KEYS.get(exportKey);
      if (!idbKey) {
        throw new Error(`Unrecognized setting: ${exportKey}`);
      }
      if (value !== null && typeof value !== "string") {
        throw new Error(`Invalid value for setting: ${exportKey}`);
      }
      importedSettings++;
      if (value === null) {
        continue;
      }
      if (exportKey === "defaultBang") {
        if (
          value !== value.trim().toLowerCase() ||
          validateCustomTrigger(value)
        ) {
          throw new Error("Invalid default bang");
        }
      } else if (exportKey === "suggestProvider") {
        if (!SUGGEST_PROVIDERS.has(value)) {
          throw new Error("Invalid suggestion provider");
        }
        suggestProvider = value;
      } else if (exportKey === "luckyProvider") {
        if (!LUCKY_PROVIDERS.has(value)) {
          throw new Error("Invalid lucky provider");
        }
        luckyProvider = value;
      } else if (exportKey === "suggestUrl") {
        suggestUrl = value;
        const error = value ? validateSimpleBangUrl(value) : null;
        if (error) {
          throw new Error(`Invalid suggestion URL template: ${error}`);
        }
      } else if (exportKey === "luckyUrl") {
        luckyUrl = value;
        const error = value ? validateSimpleBangUrl(value) : null;
        if (error) {
          throw new Error(`Invalid lucky URL template: ${error}`);
        }
      } else if (exportKey === "bangPrefix") {
        if (!isTriggerPrefix(value)) {
          throw new Error("Invalid bang prefix");
        }
        bangPrefix = value;
      } else if (exportKey === "snapPrefix") {
        if (!isTriggerPrefix(value)) {
          throw new Error("Invalid snap prefix");
        }
        snapPrefix = value;
      }
      if (value) {
        settings.push({ key: idbKey, value });
      }
    }
  }
  if (suggestProvider === "custom" && !suggestUrl) {
    throw new Error("Custom suggestion provider requires a URL template");
  }
  if (luckyProvider === "custom" && !luckyUrl) {
    throw new Error("Custom lucky provider requires a URL template");
  }
  if (bangPrefix === snapPrefix) {
    throw new Error("Bang and snap prefixes must be different");
  }

  const customBangs: CustomBangRecord[] = [];
  let rejectedCustomBangs = 0;
  const triggers = new Set<string>();
  if (hasCustomBangs) {
    if (!Array.isArray(data.customBangs)) {
      throw new Error("Invalid custom bangs data");
    }
    for (const item of data.customBangs) {
      if (!isRecord(item)) {
        rejectedCustomBangs++;
        continue;
      }
      const unknownField = Object.keys(item).some(
        (key) => !CUSTOM_BANG_KEYS.has(key)
      );
      const trigger = item.trigger;
      const name = item.name;
      const url = item.url;
      const regex = item.regex;
      const snap = item.snap;
      const encoding = item.encoding;
      if (
        unknownField ||
        typeof trigger !== "string" ||
        trigger !== trigger.trim().toLowerCase() ||
        validateCustomTrigger(trigger) ||
        triggers.has(trigger) ||
        typeof name !== "string" ||
        !name.trim() ||
        typeof url !== "string" ||
        (regex !== undefined && (typeof regex !== "string" || !regex)) ||
        (snap !== undefined && (typeof snap !== "string" || !snap)) ||
        (encoding !== undefined && !isCaptureEncoding(encoding)) ||
        (encoding !== undefined && regex === undefined)
      ) {
        rejectedCustomBangs++;
        continue;
      }
      const urlError = regex
        ? validateCaptureBang(url, regex)
        : validateSimpleBangUrl(url);
      const validationError =
        urlError ?? (snap ? validateSnapTarget(snap) : null);
      if (validationError) {
        rejectedCustomBangs++;
        continue;
      }
      triggers.add(trigger);
      customBangs.push({
        trigger,
        name,
        url,
        ...(regex
          ? {
              regex,
              encoding: isCaptureEncoding(encoding) ? encoding : "percent",
            }
          : {}),
        ...(snap ? { snap } : {}),
      });
    }
  }

  return {
    acceptedCustomBangs: customBangs.length,
    rejectedCustomBangs,
    importedSettings,
    replaced: false,
    customBangs,
    settings,
  };
}

export class DB {
  private readonly dbp: Promise<IDBDatabase> = openDB();

  private async store(name: string, mode: IDBTransactionMode = "readonly") {
    const db = await this.dbp;
    return db.transaction(name, mode).objectStore(name);
  }

  async getMultipleSettings(keys: string[]): Promise<(string | null)[]> {
    const db = await this.dbp;
    const tx = db.transaction("settings", "readonly");
    const store = tx.objectStore("settings");
    const results = await Promise.all(
      keys.map((key) =>
        idbWrap<{ key: string; value: string } | undefined>(store.get(key))
      )
    );
    return results.map((r) => r?.value ?? null);
  }

  async getSetting(key: string): Promise<string | null> {
    const s = await this.store("settings");
    const r = await idbWrap<{ key: string; value: string } | undefined>(
      s.get(key)
    );
    return r?.value ?? null;
  }

  async setSetting(key: string, value: string) {
    const db = await this.dbp;
    const tx = db.transaction("settings", "readwrite");
    const done = transactionDone(tx);
    await Promise.all([
      idbWrap(tx.objectStore("settings").put({ key, value })),
      invalidateRedirectSettingsSnapshot(tx),
      done,
    ]);
  }

  async getAllCustomBangs(): Promise<CustomBangRecord[]> {
    const s = await this.store("custom-bangs");
    return idbWrap<CustomBangRecord[]>(s.getAll());
  }

  async addCustomBang(bang: CustomBangRecord) {
    const triggerError = validateCustomTrigger(bang.trigger);
    if (triggerError) {
      throw new Error(triggerError);
    }
    const db = await this.dbp;
    const tx = db.transaction(["settings", "custom-bangs"], "readwrite");
    const done = transactionDone(tx);
    await Promise.all([
      idbWrap(tx.objectStore("custom-bangs").put(bang)),
      invalidateRedirectSettingsSnapshot(tx),
      done,
    ]);
  }

  async updateCustomBang(previousTrigger: string, bang: CustomBangRecord) {
    const triggerError = validateCustomTrigger(bang.trigger);
    if (triggerError) {
      throw new Error(triggerError);
    }
    const db = await this.dbp;
    const tx = db.transaction(["settings", "custom-bangs"], "readwrite");
    const done = transactionDone(tx);
    const s = tx.objectStore("custom-bangs");
    const ops: Promise<unknown>[] = [];
    if (previousTrigger !== bang.trigger) {
      ops.push(idbWrap(s.delete(previousTrigger)));
    }
    ops.push(idbWrap(s.put(bang)));
    await Promise.all([...ops, invalidateRedirectSettingsSnapshot(tx), done]);
  }

  async removeCustomBang(trigger: string) {
    const db = await this.dbp;
    const tx = db.transaction(["settings", "custom-bangs"], "readwrite");
    const done = transactionDone(tx);
    await Promise.all([
      idbWrap(tx.objectStore("custom-bangs").delete(trigger)),
      invalidateRedirectSettingsSnapshot(tx),
      done,
    ]);
  }

  async exportAll() {
    const db = await this.dbp;
    const tx = db.transaction(["settings", "custom-bangs"], "readonly");
    const settingsStore = tx.objectStore("settings");
    const [
      defaultBang,
      suggestProvider,
      suggestUrl,
      luckyProvider,
      luckyUrl,
      bangPrefix,
      snapPrefix,
      customBangs,
    ] = await Promise.all([
      idbWrap<{ key: string; value: string } | undefined>(
        settingsStore.get("default-bang")
      ),
      idbWrap<{ key: string; value: string } | undefined>(
        settingsStore.get("suggest-provider")
      ),
      idbWrap<{ key: string; value: string } | undefined>(
        settingsStore.get("suggest-url")
      ),
      idbWrap<{ key: string; value: string } | undefined>(
        settingsStore.get("lucky-provider")
      ),
      idbWrap<{ key: string; value: string } | undefined>(
        settingsStore.get("lucky-url")
      ),
      idbWrap<{ key: string; value: string } | undefined>(
        settingsStore.get("bang-prefix")
      ),
      idbWrap<{ key: string; value: string } | undefined>(
        settingsStore.get("snap-prefix")
      ),
      idbWrap<CustomBangRecord[]>(tx.objectStore("custom-bangs").getAll()),
    ]);
    const result = {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      settings: {
        defaultBang: defaultBang?.value ?? null,
        suggestProvider: suggestProvider?.value ?? null,
        suggestUrl: suggestUrl?.value ?? null,
        luckyProvider: luckyProvider?.value ?? null,
        luckyUrl: luckyUrl?.value ?? null,
        bangPrefix: bangPrefix?.value ?? null,
        snapPrefix: snapPrefix?.value ?? null,
      },
      customBangs,
      exported: new Date().toISOString(),
    };
    const preflight = prepareImport(result);
    if (preflight.rejectedCustomBangs > 0) {
      throw new Error(
        `Cannot export: ${preflight.rejectedCustomBangs} custom bangs are invalid`
      );
    }
    return result;
  }

  async importAll(
    data: unknown,
    confirmReplace?: (summary: ImportResult) => boolean | Promise<boolean>
  ): Promise<ImportResult> {
    const prepared = prepareImport(data);
    const summary: ImportResult = {
      acceptedCustomBangs: prepared.acceptedCustomBangs,
      rejectedCustomBangs: prepared.rejectedCustomBangs,
      importedSettings: prepared.importedSettings,
      replaced: false,
    };
    if (confirmReplace && !(await confirmReplace(summary))) {
      return summary;
    }
    const db = await this.dbp;
    const tx = db.transaction(["settings", "custom-bangs"], "readwrite");
    const done = transactionDone(tx);
    const settingsStore = tx.objectStore("settings");
    const customStore = tx.objectStore("custom-bangs");
    const ops: Promise<unknown>[] = [];
    try {
      ops.push(invalidateRedirectSettingsSnapshot(tx));
      for (const key of CONFIGURABLE_SETTING_KEYS) {
        ops.push(idbWrap(settingsStore.delete(key)));
      }
      ops.push(idbWrap(customStore.clear()));
      for (const setting of prepared.settings) {
        ops.push(idbWrap(settingsStore.put(setting)));
      }
      for (const bang of prepared.customBangs) {
        ops.push(idbWrap(customStore.put(bang)));
      }
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // The transaction may already have aborted after the setup error.
      }
      await done.catch(() => undefined);
      throw error;
    }
    await Promise.all([...ops, done]);
    return { ...summary, replaced: true };
  }
}

export async function readCustomBangs(db: DB): Promise<string[]> {
  const customBangs = await db.getAllCustomBangs();
  return customBangs.map((b) => b.trigger);
}
