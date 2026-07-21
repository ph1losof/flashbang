import { resetDB } from "../shared/idb";
import { initializeBangData } from "../sw/bang-data";
import {
  type RedirectSettings,
  redirectRawUrl,
  redirectUrl,
} from "../sw/redirect";
import {
  defaultRedirectSettings,
  loadRedirectSettings,
  prepareRedirectSettings,
} from "../sw/redirect-settings";

declare const __BANG_DATA_ASSET__: string;

const preparedSettings = prepareRedirectSettings(__BANG_DATA_ASSET__);
void preparedSettings.catch(() => {
  // resolveFallback applies safe defaults when the early read fails.
});

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
