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
import {
  type CustomUrlParts,
  compileTriggerSyntax,
  type RedirectSettings,
  type TriggerSyntax,
  type UrlParts,
} from "./redirect";

const SNAPSHOT_VERSION = 1;

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

interface StoredRedirectSettingsSnapshot {
  key: string;
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

export function defaultRedirectSettings(): RedirectSettings {
  return {
    defaultUrl: splitUrl(DEFAULT_URL),
    custom: Object.create(null),
    luckyUrl: splitUrl(DEFAULT_LUCKY_URL),
  };
}

function isSnapshotRecord(
  value: unknown
): value is StoredRedirectSettingsSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<StoredRedirectSettingsSnapshot>;
  const snapshot = record.snapshot as
    | Partial<RedirectSettingsSnapshot>
    | undefined;
  if (!snapshot) {
    return false;
  }
  return (
    record.key === REDIRECT_SETTINGS_SNAPSHOT_KEY &&
    record.version === SNAPSHOT_VERSION &&
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

function rebuildSnapshot(db: IDBDatabase): Promise<RedirectSettingsSnapshot> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["settings", "custom-bangs"], "readwrite");
    const settingsRequest = tx.objectStore("settings").getAll();
    const customRequest = tx.objectStore("custom-bangs").getAll();
    let settings: SettingRecord[] | null = null;
    let customBangs: CustomBangRecord[] | null = null;
    let snapshot: RedirectSettingsSnapshot | null = null;

    const compileWhenReady = () => {
      if (!(settings && customBangs) || snapshot) {
        return;
      }
      snapshot = compileRedirectSettingsSnapshot(settings, customBangs);
      tx.objectStore("settings").put({
        key: REDIRECT_SETTINGS_SNAPSHOT_KEY,
        snapshot,
        version: SNAPSHOT_VERSION,
      });
    };
    settingsRequest.onsuccess = () => {
      settings = settingsRequest.result as SettingRecord[];
      compileWhenReady();
    };
    customRequest.onsuccess = () => {
      customBangs = customRequest.result as CustomBangRecord[];
      compileWhenReady();
    };
    tx.oncomplete = () => {
      if (snapshot) {
        resolve(snapshot);
      } else {
        reject(new Error("IndexedDB snapshot compilation did not complete"));
      }
    };
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write aborted"));
  });
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

export async function prepareRedirectSettings(): Promise<RedirectSettingsSnapshot> {
  const db = await openDB();
  const stored = await idbWrap<StoredRedirectSettingsSnapshot | undefined>(
    db
      .transaction("settings", "readonly")
      .objectStore("settings")
      .get(REDIRECT_SETTINGS_SNAPSHOT_KEY)
  );
  if (isSnapshotRecord(stored)) {
    return normalizeSnapshot(stored.snapshot);
  }
  return rebuildSnapshot(db);
}

export async function loadRedirectSettings(
  prepared = prepareRedirectSettings()
): Promise<RedirectSettings> {
  return materializeRedirectSettings(await prepared);
}
