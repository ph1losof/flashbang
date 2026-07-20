import { initializeBangData } from "../sw/bang-data";
import { readRedirectSettings } from "../sw/idb";
import { redirectRawUrl, redirectUrl } from "../sw/redirect";

export async function redirectWithoutServiceWorker(
  query: string,
  bangData: ArrayBuffer,
  raw = false
): Promise<void> {
  initializeBangData(bangData);
  const settings = await readRedirectSettings();
  location.replace(
    raw ? redirectRawUrl(query, settings) : redirectUrl(query, settings)
  );
}
