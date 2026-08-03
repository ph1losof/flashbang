import {
  BANG_SHARD_COUNT,
  bangShardIndex,
  extractBangShardTriggers,
} from "../shared/bang-shards";
import { hashFNV1a } from "../shared/hash";
import { DB_NAME } from "../shared/idb";
import {
  configureBangFallbackLookup,
  createBangShardRuntime,
} from "../sw/bang-data";
import { defaultRedirectSettings } from "../sw/default-redirect-settings";
import { lookupGeneratedHotBang } from "../sw/hot-redirect";
import { redirectUrl } from "../sw/redirect";

declare const __BANG_SHARD_ROUTER__: readonly number[];
declare const __BANG_SHARD_VERSION__: string;

const shardRuntime = createBangShardRuntime(
  __BANG_SHARD_ROUTER__,
  __BANG_SHARD_VERSION__
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
  for (let attempt = 0; attempt <= BANG_SHARD_COUNT; attempt++) {
    try {
      return {
        settings,
        url: redirectUrl(query, settings, lookupGeneratedHotBang),
      };
    } catch (error) {
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
