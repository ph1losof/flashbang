import { DB_NAME, resetDB } from "../shared/idb";
import { initializeBangData } from "../sw/bang-data";
import {
  lookupGeneratedHotBang,
  materializeCompactBaseSettings,
} from "../sw/hot-redirect";
import { setActiveLocale } from "../sw/locale";
import {
  type RedirectSettings,
  redirectRawUrl,
  redirectUrl,
} from "../sw/redirect";
import {
  defaultRedirectSettings,
  defaultRedirectSettingsSnapshot,
  loadRedirectSettings,
  type PreparedRedirectSettings,
  prepareRedirectSettings,
} from "../sw/redirect-settings";

declare const __BANG_DATA_ASSET__: string;

setActiveLocale(null);

async function prepareFallbackSettings(): Promise<PreparedRedirectSettings> {
  if (typeof indexedDB.databases === "function") {
    const databases = await indexedDB.databases();
    if (!databases.some(({ name }) => name === DB_NAME)) {
      return {
        settings: null,
        snapshot: defaultRedirectSettingsSnapshot(),
      };
    }
  }
  return prepareRedirectSettings(__BANG_DATA_ASSET__);
}

const preparedSettings = prepareFallbackSettings();
void preparedSettings.catch(() => {
  // resolveFallback applies safe defaults when the early read fails.
});

export async function resolveHotFallback(
  query: string,
  raw = false
): Promise<{ settings: RedirectSettings; url: string } | null> {
  try {
    const prepared = await preparedSettings;
    const settings = materializeCompactBaseSettings(
      prepared.snapshot,
      prepared.settings
    );
    if (!settings) {
      return null;
    }
    settings.custom = prepared.snapshot.custom;
    return {
      settings,
      url: raw
        ? redirectRawUrl(query, settings, lookupGeneratedHotBang)
        : redirectUrl(query, settings, lookupGeneratedHotBang),
    };
  } catch {
    // A non-hot lookup or an unavailable settings snapshot needs the full
    // catalog path below. That path also owns IndexedDB recovery.
    return null;
  }
}

export async function resolveFallback(
  query: string,
  bangData: ArrayBuffer,
  raw = false
): Promise<{ settings: RedirectSettings; url: string }> {
  initializeBangData(bangData);
  let settings: RedirectSettings;
  try {
    settings = await loadRedirectSettings(
      preparedSettings,
      __BANG_DATA_ASSET__
    );
  } catch {
    resetDB();
    settings = defaultRedirectSettings();
  }
  return {
    settings,
    url: raw ? redirectRawUrl(query, settings) : redirectUrl(query, settings),
  };
}
