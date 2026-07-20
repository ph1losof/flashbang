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

const preparedSettings = prepareRedirectSettings();
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
    settings = await loadRedirectSettings(preparedSettings);
  } catch {
    resetDB();
    settings = defaultRedirectSettings();
  }
  return {
    settings,
    url: raw ? redirectRawUrl(query, settings) : redirectUrl(query, settings),
  };
}
