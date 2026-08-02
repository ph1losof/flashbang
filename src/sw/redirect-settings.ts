import {
  type CaptureUrlParts,
  type CustomBangRecord,
  compileCaptureUrl,
} from "../shared/capture-template";
import {
  DEFAULT_LUCKY_URL,
  DEFAULT_URL,
  LUCKY_TRIGGER_PROVIDERS,
  LUCKY_URLS,
  REDIRECT_SETTINGS_SNAPSHOT_KEY,
} from "../shared/constants";
import { hashFNV1a } from "../shared/hash";
import { idbWrap, openDB } from "../shared/idb";
import { compileSnapTarget, type SnapTargetParts } from "../shared/snap-target";
import { resolveTriggerPrefixes } from "../shared/trigger-prefix";
import { lookupBang } from "./bang-data";
import { defaultRedirectSettings as createDefaultRedirectSettings } from "./default-redirect-settings";
import {
  type CustomUrlParts,
  compileTriggerSyntax,
  type RedirectSettings,
  type TriggerSyntax,
  type UrlParts,
} from "./redirect";

export function defaultRedirectSettings(): RedirectSettings {
  return createDefaultRedirectSettings();
}

const SNAPSHOT_VERSION = 2;

interface SettingRecord {
  key: string;
  value?: string;
}

export interface RedirectSettingsSnapshot {
  custom: Record<string, CustomUrlParts>;
  defaultBang: string;
  luckyProvider: string;
  luckyUrl: UrlParts | null;
  syntax?: TriggerSyntax;
}

export interface RedirectSettingsBundle {
  settings: RedirectSettings;
  snapshot: RedirectSettingsSnapshot;
}

export interface PreparedRedirectSettings {
  settings: RedirectSettings | null;
  snapshot: RedirectSettingsSnapshot;
}

interface StoredRedirectSettingsBundle {
  catalogVersion: string;
  defaultUrl: UrlParts;
  key: string;
  luckyUrl: UrlParts | null;
  snapshot: RedirectSettingsSnapshot;
  version: number;
}

function splitUrl(url: string): UrlParts {
  const idx = url.indexOf("{}");
  return idx === -1
    ? [url, null]
    : [url.substring(0, idx), url.substring(idx + 2)];
}

function attachSnapTarget(
  entry: UrlParts | CaptureUrlParts,
  snap: SnapTargetParts | null
): CustomUrlParts {
  return snap ? ([...entry, snap] as CustomUrlParts) : entry;
}

function isUrlParts(value: unknown): value is UrlParts {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    (value[1] === null || typeof value[1] === "string")
  );
}

function isBundleRecord(
  value: unknown,
  catalogVersion: string
): value is StoredRedirectSettingsBundle {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<StoredRedirectSettingsBundle>;
  const snapshot = record.snapshot as
    | Partial<RedirectSettingsSnapshot>
    | undefined;
  if (!snapshot) {
    return false;
  }
  return (
    record.key === REDIRECT_SETTINGS_SNAPSHOT_KEY &&
    record.version === SNAPSHOT_VERSION &&
    record.catalogVersion === catalogVersion &&
    isUrlParts(record.defaultUrl) &&
    (record.luckyUrl === null || isUrlParts(record.luckyUrl)) &&
    typeof snapshot.defaultBang === "string" &&
    typeof snapshot.luckyProvider === "string" &&
    Boolean(snapshot.custom) &&
    typeof snapshot.custom === "object" &&
    (snapshot.luckyUrl === null || Array.isArray(snapshot.luckyUrl)) &&
    (snapshot.syntax === undefined || Array.isArray(snapshot.syntax))
  );
}

function normalizeSnapshot(
  snapshot: RedirectSettingsSnapshot
): RedirectSettingsSnapshot {
  return {
    ...snapshot,
    custom: Object.assign(Object.create(null), snapshot.custom),
  };
}

function compileRedirectSettingsSnapshot(
  settings: readonly SettingRecord[],
  all: readonly CustomBangRecord[]
): RedirectSettingsSnapshot {
  const settingsMap: Record<string, string | undefined> = Object.create(null);
  for (const setting of settings) {
    settingsMap[setting.key] = setting.value;
  }
  const defaultBang = settingsMap["default-bang"] || "g";
  const custom: Record<string, CustomUrlParts> = Object.create(null);
  for (const entry of all) {
    const snap = entry.snap ? compileSnapTarget(entry.snap) : null;
    if (entry.regex) {
      const advanced = compileCaptureUrl(
        entry.url,
        entry.regex,
        entry.encoding
      );
      if (advanced) {
        custom[entry.trigger] = attachSnapTarget(advanced, snap);
      }
    } else {
      custom[entry.trigger] = attachSnapTarget(splitUrl(entry.url), snap);
    }
  }
  const [bangPrefix, snapPrefix] = resolveTriggerPrefixes(
    settingsMap["bang-prefix"],
    settingsMap["snap-prefix"]
  );
  const luckyProvider = settingsMap["lucky-provider"] ?? "default";
  const syntax = compileTriggerSyntax(bangPrefix, snapPrefix);
  return {
    custom,
    defaultBang,
    luckyProvider,
    luckyUrl:
      luckyProvider === "custom" && settingsMap["lucky-url"]
        ? splitUrl(settingsMap["lucky-url"])
        : null,
    ...(syntax ? { syntax } : {}),
  };
}

export function defaultRedirectSettingsSnapshot(): RedirectSettingsSnapshot {
  return compileRedirectSettingsSnapshot([], []);
}

export function materializeRedirectSettings(
  snapshot: RedirectSettingsSnapshot
): RedirectSettings {
  const customDefault = snapshot.custom[snapshot.defaultBang];
  let defaultEntry: UrlParts | null;
  if (customDefault) {
    defaultEntry =
      customDefault.length < 5 ? (customDefault as UrlParts) : null;
  } else {
    defaultEntry = lookupBang(
      snapshot.defaultBang,
      hashFNV1a(snapshot.defaultBang)
    );
  }
  const defaultUrl = defaultEntry || splitUrl(DEFAULT_URL);
  const effectiveDefaultBang = defaultEntry ? snapshot.defaultBang : "g";
  let luckyUrl: UrlParts | null;
  switch (snapshot.luckyProvider) {
    case "none":
      luckyUrl = null;
      break;
    case "google":
      luckyUrl = splitUrl(LUCKY_URLS.google);
      break;
    case "ddg":
      luckyUrl = splitUrl(LUCKY_URLS.ddg);
      break;
    case "kagi":
      luckyUrl = splitUrl(LUCKY_URLS.kagi);
      break;
    case "custom":
      luckyUrl = snapshot.luckyUrl;
      break;
    default:
      luckyUrl = splitUrl(
        LUCKY_URLS[LUCKY_TRIGGER_PROVIDERS[effectiveDefaultBang]] ||
          DEFAULT_LUCKY_URL
      );
      break;
  }
  return {
    defaultUrl,
    custom: snapshot.custom,
    luckyUrl,
    ...(snapshot.syntax ? { syntax: snapshot.syntax } : {}),
  };
}

async function rebuildSnapshot(
  db: IDBDatabase
): Promise<RedirectSettingsSnapshot> {
  const tx = db.transaction(["settings", "custom-bangs"], "readonly");
  const [settings, customBangs] = await Promise.all([
    idbWrap<SettingRecord[]>(tx.objectStore("settings").getAll()),
    idbWrap<CustomBangRecord[]>(tx.objectStore("custom-bangs").getAll()),
  ]);
  return compileRedirectSettingsSnapshot(settings, customBangs);
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write aborted"));
  });
}

export async function deleteRedirectSettingsSnapshot(): Promise<void> {
  const db = await openDB();
  const tx = db.transaction("settings", "readwrite");
  const done = transactionDone(tx);
  tx.objectStore("settings").delete(REDIRECT_SETTINGS_SNAPSHOT_KEY);
  await done;
}

export async function prepareRedirectSettings(
  catalogVersion = ""
): Promise<PreparedRedirectSettings> {
  const db = await openDB();
  const stored = await idbWrap<StoredRedirectSettingsBundle | undefined>(
    db
      .transaction("settings", "readonly")
      .objectStore("settings")
      .get(REDIRECT_SETTINGS_SNAPSHOT_KEY)
  );
  if (isBundleRecord(stored, catalogVersion)) {
    const snapshot = normalizeSnapshot(stored.snapshot);
    return {
      settings: {
        custom: snapshot.custom,
        defaultUrl: stored.defaultUrl,
        luckyUrl: stored.luckyUrl,
        ...(snapshot.syntax ? { syntax: snapshot.syntax } : {}),
      },
      snapshot,
    };
  }
  return { settings: null, snapshot: await rebuildSnapshot(db) };
}

export function createRedirectSettingsBundle(
  snapshot: RedirectSettingsSnapshot
): RedirectSettingsBundle {
  return { settings: materializeRedirectSettings(snapshot), snapshot };
}

export async function persistRedirectSettingsBundle(
  bundle: RedirectSettingsBundle,
  catalogVersion = ""
): Promise<void> {
  const db = await openDB();
  const tx = db.transaction("settings", "readwrite");
  const done = transactionDone(tx);
  tx.objectStore("settings").put({
    catalogVersion,
    defaultUrl: bundle.settings.defaultUrl,
    key: REDIRECT_SETTINGS_SNAPSHOT_KEY,
    luckyUrl: bundle.settings.luckyUrl,
    snapshot: bundle.snapshot,
    version: SNAPSHOT_VERSION,
  } satisfies StoredRedirectSettingsBundle);
  await done;
}

export async function loadRedirectSettings(
  prepared = prepareRedirectSettings(),
  catalogVersion = ""
): Promise<RedirectSettings> {
  const value = await prepared;
  if (value.settings) {
    return value.settings;
  }
  const bundle = createRedirectSettingsBundle(value.snapshot);
  void persistRedirectSettingsBundle(bundle, catalogVersion).catch(() => {
    /* The next load can rebuild a failed derived cache write. */
  });
  return bundle.settings;
}
