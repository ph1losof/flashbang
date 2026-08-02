import {
  BANG_SHARD_COUNT,
  bangShardIndex,
  extractBangShardTriggers,
} from "../shared/bang-shards";
import { hashFNV1a } from "../shared/hash";
import { DB_NAME } from "../shared/idb";
import {
  type BangLookup,
  configureBangFallbackLookup,
  decodeBangData,
} from "../sw/bang-data";
import { defaultRedirectSettings } from "../sw/default-redirect-settings";
import { lookupGeneratedHotBang } from "../sw/hot-redirect";
import { redirectUrl } from "../sw/redirect";

declare const __BANG_SHARD_ROUTER__: readonly number[];
declare const __BANG_SHARD_VERSION__: string;

interface BangShardUnavailableError extends Error {
  readonly shardId: number;
}

const shardLookups: Array<BangLookup | null> = Array.from(
  { length: BANG_SHARD_COUNT },
  () => null
);
const shardUnavailableErrors = Array.from(
  { length: BANG_SHARD_COUNT },
  (_, shardId) =>
    Object.freeze(
      Object.assign(new Error(`Bang shard ${shardId} is not initialized`), {
        shardId,
      })
    ) as BangShardUnavailableError
);
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

function lookupShard(trigger: string, hash: number) {
  const shardId = bangShardIndex(hash, __BANG_SHARD_ROUTER__);
  const lookup = shardLookups[shardId];
  if (!lookup) {
    throw shardUnavailableErrors[shardId];
  }
  return lookup(trigger, hash);
}

function unavailableShardId(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const shardId = (error as Partial<BangShardUnavailableError>).shardId;
  return typeof shardId === "number" &&
    shardUnavailableErrors[shardId] === error
    ? shardId
    : null;
}

function ensureShard(
  shardId: number,
  prefetched?: ArrayBuffer | Promise<ArrayBuffer>
): Promise<void> {
  if (shardLookups[shardId]) {
    return Promise.resolve();
  }
  let promise = shardPromises[shardId];
  if (!promise) {
    promise = (
      prefetched
        ? Promise.resolve(prefetched)
        : fetch(
            `/bangs-s${shardId.toString(36)}-${__BANG_SHARD_VERSION__}.bin`
          ).then((response) => {
            if (!response.ok) {
              throw new Error(`Failed to load bang shard: ${response.status}`);
            }
            return response.arrayBuffer();
          })
    )
      .then((buffer) => {
        shardLookups[shardId] = decodeBangData(buffer);
      })
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
      shardIds.add(bangShardIndex(hashFNV1a(trigger), __BANG_SHARD_ROUTER__));
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
  configureBangFallbackLookup(lookupShard);
  const settings = defaultRedirectSettings();
  let prefetchedData = bangData;
  for (let attempt = 0; attempt <= BANG_SHARD_COUNT; attempt++) {
    try {
      return {
        settings,
        url: redirectUrl(query, settings, lookupGeneratedHotBang),
      };
    } catch (error) {
      const shardId = unavailableShardId(error);
      if (shardId === null) {
        throw error;
      }
      await ensureCandidateShards(query, shardId, prefetchedData);
      prefetchedData = undefined;
    }
  }
  throw new Error("Bang shard resolution exceeded the catalog shard count");
}
