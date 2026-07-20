import { initializeBangData } from "../sw/bang-data";
import { readRedirectSettings } from "../sw/idb";
import {
  type RedirectSettings,
  redirectRawUrl,
  redirectUrl,
} from "../sw/redirect";

export async function resolveFallback(
  query: string,
  bangData: ArrayBuffer,
  raw = false
): Promise<{ settings: RedirectSettings; url: string }> {
  initializeBangData(bangData);
  const settings = await readRedirectSettings();
  return {
    settings,
    url: raw ? redirectRawUrl(query, settings) : redirectUrl(query, settings),
  };
}
