import { REDIRECT_SETTINGS_SNAPSHOT_KEY } from "../../src/shared/constants";
import { reqToPromise } from "./fake-indexeddb";

export { REDIRECT_SETTINGS_SNAPSHOT_KEY };

export type SharedIdbModule = typeof import("../../src/shared/idb");

export interface SeedCustomBangRecord {
  trigger: string;
  url: string;
  regex?: string;
  encoding?: "percent" | "plus" | "raw";
  snap?: string;
}

export interface SeedSettingRecord {
  key: string;
  value?: string;
  snapshot?: unknown;
  version?: number;
}

export interface SeedDbData {
  customBangs?: SeedCustomBangRecord[];
  settings?: SeedSettingRecord[];
}

export interface SettingRecord<TValue = string> {
  key: string;
  value?: TValue;
  snapshot?: unknown;
  version?: number;
}

export function loadSharedIdb(): Promise<SharedIdbModule> {
  return import("../../src/shared/idb");
}

export async function resetSharedDb(): Promise<void> {
  const shared = await loadSharedIdb();
  shared.resetDB();
}

export async function openSharedDb(): Promise<IDBDatabase> {
  return (await loadSharedIdb()).openDB();
}

export async function seedDb(data: SeedDbData): Promise<void> {
  const shared = await loadSharedIdb();
  shared.resetDB();
  const db = await shared.openDB();
  const tx = db.transaction(["settings", "custom-bangs"], "readwrite");
  const settingsStore = tx.objectStore("settings");
  const customStore = tx.objectStore("custom-bangs");
  await reqToPromise(settingsStore.delete(REDIRECT_SETTINGS_SNAPSHOT_KEY));

  if (data.settings) {
    for (const row of data.settings) {
      await reqToPromise(settingsStore.put(row));
    }
  }

  if (data.customBangs) {
    for (const row of data.customBangs) {
      await reqToPromise(customStore.put(row));
    }
  }
}

export async function putSettingRecord(
  record: SeedSettingRecord
): Promise<void> {
  const db = await openSharedDb();
  await reqToPromise(
    db.transaction("settings", "readwrite").objectStore("settings").put(record)
  );
}

export async function readSettingRecord<TValue = string>(
  key: string
): Promise<SettingRecord<TValue> | undefined> {
  const db = await openSharedDb();
  return reqToPromise<SettingRecord<TValue> | undefined>(
    db.transaction("settings", "readonly").objectStore("settings").get(key)
  );
}

export async function deleteSettingRecord(key: string): Promise<void> {
  const db = await openSharedDb();
  await reqToPromise(
    db.transaction("settings", "readwrite").objectStore("settings").delete(key)
  );
}

export async function clearCustomBangs(): Promise<void> {
  const db = await openSharedDb();
  await reqToPromise(
    db
      .transaction("custom-bangs", "readwrite")
      .objectStore("custom-bangs")
      .clear()
  );
}
