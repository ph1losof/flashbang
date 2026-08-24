import {
  BANG_SHARD_COUNT,
  bangShardIndex,
  extractBangShardTriggers,
} from "../shared/bang-shards";
import { hashFNV1a } from "../shared/hash";
import { DB_NAME } from "../shared/idb";
import { installLocaleTable, type LocaleTable } from "../shared/locale-tag";
import {
  configureBangFallbackLookup,
  createBangShardRuntime,
} from "../sw/bang-data";
import { defaultRedirectSettings } from "../sw/default-redirect-settings";
import { lookupGeneratedHotBang } from "../sw/hot-redirect";
import { localeTableUnavailable, setActiveLocale } from "../sw/locale";
import { redirectUrl } from "../sw/redirect";

declare const __BANG_SHARD_ROUTER__: readonly number[];
declare const __BANG_SHARD_ASSETS__: readonly string[];
declare const __LOCALE_TABLE_ASSET__: string;

// Held in a variable so the bundler leaves the specifier alone: a literal here
// would be resolved and inlined at build time, putting the edition table back
// on the critical path. Bun's `splitting` would emit the chunk but also a
// shared runtime shim the entry has to fetch, which is the request this
// avoids in the first place.
const localeTableAsset = __LOCALE_TABLE_ASSET__;

setActiveLocale(null);

const shardRuntime = createBangShardRuntime(
  __BANG_SHARD_ROUTER__,
  __BANG_SHARD_ASSETS__
);
const freshProfile =
  typeof indexedDB.databases === "function"
    ? indexedDB
        .databases()
        .then((databases) => !databases.some(({ name }) => name === DB_NAME))
        .catch(() => false)
    : Promise.resolve(false);

function ensureCandidateShards(
  query: string,
  missingShardId: number,
  prefetched?: ArrayBuffer | Promise<ArrayBuffer>
): Promise<void> {
  const shardIds = new Set<number>([missingShardId]);
  for (const trigger of extractBangShardTriggers(query)) {
    if (!lookupGeneratedHotBang(trigger)) {
      shardIds.add(bangShardIndex(hashFNV1a(trigger), __BANG_SHARD_ROUTER__));
    }
  }
  return Promise.all(
    [...shardIds].map((shardId) =>
      shardRuntime.ensure(
        shardId,
        shardId === missingShardId ? prefetched : undefined
      )
    )
  ).then(() => undefined);
}

export async function resolveColdFallback(
  query: string,
  bangData?: ArrayBuffer | Promise<ArrayBuffer>,
  raw = false
) {
  if (raw || !(await freshProfile)) {
    return null;
  }
  configureBangFallbackLookup(shardRuntime.lookup);
  const settings = defaultRedirectSettings();
  let prefetchedData = bangData;
  // One attempt per shard, plus the single retry a `{lang}` destination costs.
  for (let attempt = 0; attempt <= BANG_SHARD_COUNT + 1; attempt++) {
    try {
      return {
        settings,
        url: redirectUrl(query, settings, lookupGeneratedHotBang),
      };
    } catch (error) {
      if (localeTableUnavailable(error)) {
        // Only destinations with a per-language edition reach this, so the
        // edition table stays off the critical path for every other bang.
        installLocaleTable((await import(localeTableAsset)) as LocaleTable);
        continue;
      }
      const shardId = shardRuntime.unavailableShardId(error);
      if (shardId === null) {
        throw error;
      }
      await ensureCandidateShards(query, shardId, prefetchedData);
      prefetchedData = undefined;
    }
  }
  throw new Error("Bang shard resolution exceeded the catalog shard count");
}
