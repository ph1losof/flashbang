import {
  BANG_SHARD_COUNT,
  bangShardIndex,
  extractBangShardTriggers,
} from "../shared/bang-shards";
import { hashFNV1a } from "../shared/hash";
import { DB_NAME } from "../shared/idb";
import {
  bangShardUnavailableId,
  initializeBangShard,
  isBangShardInitialized,
} from "../sw/bang-data";
import { defaultRedirectSettings } from "../sw/default-redirect-settings";
import { lookupGeneratedHotBang } from "../sw/hot-redirect";
import { redirectUrl } from "../sw/redirect";

declare const __BANG_SHARD_ASSETS__: readonly string[];

const shardPromises: Array<Promise<void> | null> = Array.from(
  { length: BANG_SHARD_COUNT },
  () => null
);
const freshProfile =
  typeof indexedDB.databases === "function"
    ? indexedDB
        .databases()
        .then((databases) => !databases.some(({ name }) => name === DB_NAME))
        .catch(() => false)
    : Promise.resolve(false);

function ensureShard(
  shardId: number,
  prefetched?: ArrayBuffer | Promise<ArrayBuffer>
): Promise<void> {
  if (isBangShardInitialized(shardId)) {
    return Promise.resolve();
  }
  let promise = shardPromises[shardId];
  if (!promise) {
    promise = (
      prefetched
        ? Promise.resolve(prefetched)
        : fetch(__BANG_SHARD_ASSETS__[shardId]).then((response) => {
            if (!response.ok) {
              throw new Error(`Failed to load bang shard: ${response.status}`);
            }
            return response.arrayBuffer();
          })
    )
      .then((buffer) => initializeBangShard(shardId, buffer))
      .catch((error) => {
        shardPromises[shardId] = null;
        throw error;
      });
    shardPromises[shardId] = promise;
  }
  return promise;
}

function ensureCandidateShards(
  query: string,
  missingShardId: number,
  prefetched?: ArrayBuffer | Promise<ArrayBuffer>
): Promise<void> {
  const shardIds = new Set<number>([missingShardId]);
  for (const trigger of extractBangShardTriggers(query)) {
    if (!lookupGeneratedHotBang(trigger)) {
      shardIds.add(bangShardIndex(hashFNV1a(trigger)));
    }
  }
  return Promise.all(
    [...shardIds].map((shardId) =>
      ensureShard(shardId, shardId === missingShardId ? prefetched : undefined)
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

  const settings = defaultRedirectSettings();
  let prefetchedData = bangData;
  for (let attempt = 0; attempt <= BANG_SHARD_COUNT; attempt++) {
    try {
      return {
        settings,
        url: redirectUrl(query, settings, lookupGeneratedHotBang),
      };
    } catch (error) {
      const shardId = bangShardUnavailableId(error);
      if (shardId === null) {
        throw error;
      }
      await ensureCandidateShards(query, shardId, prefetchedData);
      prefetchedData = undefined;
    }
  }
  throw new Error("Bang shard resolution exceeded the catalog shard count");
}
