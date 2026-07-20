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
} from "../sw/redirect-settings";

export async function resolveFallback(
  query: string,
  bangData: ArrayBuffer,
  raw = false
): Promise<{ settings: RedirectSettings; url: string }> {
  initializeBangData(bangData);
  let settings: RedirectSettings;
  try {
    settings = (await loadRedirectSettings()).settings;
  } catch {
    resetDB();
    settings = defaultRedirectSettings();
  }
  return {
    settings,
    url: raw ? redirectRawUrl(query, settings) : redirectUrl(query, settings),
  };
}
