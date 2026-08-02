import { bangShardIndex } from "../shared/bang-shards";
import { DB_NAME } from "../shared/idb";
import { initializeBangData, lookupBang } from "../sw/bang-data";
import { defaultRedirectSettings } from "../sw/default-redirect-settings";
import {
  buildUrl,
  DEFAULT_BANG_MARKER,
  encodeForRedirect,
  markerWidthAt,
  originOfPrefix,
  parsePrefixBang,
  trimRawEnd,
  trimRawStart,
} from "../sw/redirect-prefix";

declare const __BANG_SHARD_ROUTER__: readonly number[];
declare const __BANG_SHARD_VERSION__: string;

const freshProfile =
  typeof indexedDB.databases === "function"
    ? indexedDB
        .databases()
        .then((databases) => !databases.some(({ name }) => name === DB_NAME))
        .catch(() => false)
    : Promise.resolve(false);

export async function resolveColdFallback(
  query: string,
  bangData?: ArrayBuffer,
  raw = false
) {
  if (raw || !(await freshProfile)) {
    return null;
  }
  const rawQuery = encodeForRedirect(query);
  const start = trimRawStart(rawQuery);
  const end = trimRawEnd(rawQuery, start);
  if (start >= end) {
    return null;
  }
  const markerWidth = markerWidthAt(rawQuery, start, end, DEFAULT_BANG_MARKER);
  if (markerWidth === 0) {
    return null;
  }
  const parsed = parsePrefixBang(rawQuery, start + markerWidth, end);
  if (parsed.kind !== "bang") {
    return null;
  }
  if (!bangData) {
    const response = await fetch(
      `/bangs-s${bangShardIndex(parsed.hash, __BANG_SHARD_ROUTER__).toString(36)}-${__BANG_SHARD_VERSION__}.bin`
    );
    if (!response.ok) {
      throw new Error(`Failed to load bang shard: ${response.status}`);
    }
    bangData = await response.arrayBuffer();
  }
  initializeBangData(bangData);
  const entry = lookupBang(parsed.trigger, parsed.hash);
  if (!entry) {
    return null;
  }
  const settings = defaultRedirectSettings();
  const url =
    parsed.termStart === null
      ? originOfPrefix(entry[0])
      : buildUrl(entry, rawQuery, parsed.termStart, end);
  return { settings, url };
}
