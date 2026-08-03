import { BANG_SHARD_COUNT, bangShardIndex } from "../shared/bang-shards";
import type { SnapTargetParts } from "../shared/snap-target";

export type BuiltinUrlParts =
  | readonly [string, string | null]
  | readonly [string, string | null, SnapTargetParts];

export type BangLookup = (
  trigger: string,
  hash: number
) => BuiltinUrlParts | null;

interface BangShardUnavailableError extends Error {
  readonly shardId: number;
}

export interface BangShardRuntime {
  ensure: (
    shardId: number,
    prefetched?: ArrayBuffer | Promise<ArrayBuffer>
  ) => Promise<void>;
  lookup: BangLookup;
  reset: () => void;
  unavailableShardId: (error: unknown) => number | null;
}

const MAGIC = 0x31424246;
const VERSION = 10;
const HEADER_WORDS = 16;
const HEADER_BYTES = HEADER_WORDS * Uint32Array.BYTES_PER_ELEMENT;
const MPH_SLOT_MULTIPLIER = 0x85ebca6b;
const MPH_BUCKET_MULTIPLIER = 0x7feb352d;
const CHECKPOINT_SHIFT = 4;
const CHECKPOINT_SIZE = 1 << CHECKPOINT_SHIFT;
const PREFIX_LENGTH_MASK = 0x1fff;
const PREFIX_HEADS = [
  "",
  "www.",
  "https://",
  "https://www.",
  "http://",
  "http://www.",
  "",
  "",
] as const;

let lookup: BangLookup | null = null;
let fallbackLookup: BangLookup | null = null;
const BANG_DATA_UNAVAILABLE = new Error("Binary bang data is not initialized");

function checkpointCount(length: number): number {
  return Math.ceil(length / CHECKPOINT_SIZE);
}

function checkpointOffset(
  lengths: Uint8Array | Uint16Array,
  checkpoints: Uint32Array,
  index: number,
  lengthMask = 0xffff
): number {
  const block = index >> CHECKPOINT_SHIFT;
  let position = checkpoints[block];
  const start = block << CHECKPOINT_SHIFT;
  for (let i = start; i < index; i++) {
    position += lengths[i] & lengthMask;
  }
  return position;
}

function validateFinalLength(
  lengths: Uint8Array | Uint16Array,
  checkpoints: Uint32Array,
  expected: number,
  lengthMask = 0xffff
): void {
  if (lengths.length === 0) {
    if (expected !== 0) {
      throw new Error("Invalid binary bang string lengths");
    }
    return;
  }
  const lastBlock = checkpoints.length - 1;
  let position = checkpoints[lastBlock];
  for (let i = lastBlock << CHECKPOINT_SHIFT; i < lengths.length; i++) {
    position += lengths[i] & lengthMask;
  }
  if (position !== expected) {
    throw new Error("Invalid binary bang string lengths");
  }
}

export function decodeBangData(buffer: ArrayBuffer): BangLookup {
  const header = new Uint32Array(buffer, 0, HEADER_WORDS);
  if (header[0] !== MAGIC || header[1] !== VERSION) {
    throw new Error("Unsupported binary bang data");
  }
  if (header[11] !== buffer.byteLength) {
    throw new Error("Truncated binary bang data");
  }

  const entryCount = header[2];
  const bucketCount = header[3];
  const fingerprintWidth = header[4];
  const prefixCount = header[5];
  const suffixCount = header[6];
  const displacementWidth = header[12];
  const snapCount = header[13];
  const snapTargetCount = header[14];
  if (entryCount === 0) {
    throw new Error("Invalid binary bang entry count");
  }
  if (bucketCount === 0 || (bucketCount & (bucketCount - 1)) !== 0) {
    throw new Error("Invalid binary bang MPHF bucket count");
  }
  if (fingerprintWidth !== Uint16Array.BYTES_PER_ELEMENT) {
    throw new Error("Invalid binary bang fingerprint width");
  }
  if (displacementWidth !== 2 && displacementWidth !== 4) {
    throw new Error("Invalid binary bang MPHF displacement width");
  }
  if (
    snapCount > entryCount ||
    snapTargetCount > snapCount ||
    (snapCount === 0) !== (snapTargetCount === 0)
  ) {
    throw new Error("Invalid binary bang snap counts");
  }
  let offset = HEADER_BYTES;

  const displacements =
    displacementWidth === 2
      ? new Int16Array(buffer, offset, bucketCount)
      : new Int32Array(buffer, offset, bucketCount);
  offset += displacements.byteLength;
  for (const displacement of displacements) {
    if (displacement < -entryCount) {
      throw new Error("Invalid binary bang MPHF displacement");
    }
  }
  const fingerprints = new Uint16Array(buffer, offset, entryCount);
  offset += fingerprints.byteLength;
  offset = (offset + 1) & ~1;
  const prefixLengths = new Uint16Array(buffer, offset, prefixCount);
  offset += prefixLengths.byteLength;
  const suffixLengths = new Uint16Array(buffer, offset, suffixCount);
  offset += suffixLengths.byteLength;
  const prefixIds = new Uint16Array(buffer, offset, entryCount);
  offset += prefixIds.byteLength;
  const suffixIds = new Uint16Array(buffer, offset, entryCount);
  offset += suffixIds.byteLength;
  const snapSlots = new Uint16Array(buffer, offset, snapCount);
  offset += snapSlots.byteLength;
  const snapTargetIds = new Uint16Array(buffer, offset, snapCount);
  offset += snapTargetIds.byteLength;
  const snapTargetLengths = new Uint16Array(
    buffer,
    offset,
    snapTargetCount * 2
  );
  offset += snapTargetLengths.byteLength;
  const snapTriggerLengths = new Uint16Array(buffer, offset, snapCount);
  offset += snapTriggerLengths.byteLength;
  offset = (offset + 3) & ~3;

  const prefixCheckpoints = new Uint32Array(
    buffer,
    offset,
    checkpointCount(prefixCount)
  );
  offset += prefixCheckpoints.byteLength;
  const suffixCheckpoints = new Uint32Array(
    buffer,
    offset,
    checkpointCount(suffixCount)
  );
  offset += suffixCheckpoints.byteLength;
  if (offset !== header[10]) {
    throw new Error("Invalid binary bang data layout");
  }

  const decoder = new TextDecoder();
  if (header[7] !== 0) {
    throw new Error("Invalid binary bang fingerprint layout");
  }
  const prefixBlob = new Uint8Array(buffer, offset, header[8]);
  offset += header[8];
  const suffixBlob = new Uint8Array(buffer, offset, header[9]);
  offset += header[9];
  const snapTargetBlob = new Uint8Array(buffer, offset, header[15]);
  offset += header[15];
  const snapTriggerBlob = new Uint8Array(buffer, offset);

  let previousSnapSlot = -1;
  for (let i = 0; i < snapCount; i++) {
    const slot = snapSlots[i];
    if (
      slot <= previousSnapSlot ||
      slot >= entryCount ||
      snapTargetIds[i] >= snapTargetCount
    ) {
      throw new Error("Invalid binary bang snap index");
    }
    previousSnapSlot = slot;
  }
  let snapTargetBytes = 0;
  for (const length of snapTargetLengths) {
    snapTargetBytes += length;
  }
  if (snapTargetBytes !== snapTargetBlob.length) {
    throw new Error("Invalid binary bang snap target lengths");
  }
  let snapTriggerBytes = 0;
  for (const length of snapTriggerLengths) {
    snapTriggerBytes += length;
  }
  if (snapTriggerBytes !== snapTriggerBlob.length) {
    throw new Error("Invalid binary bang snap trigger lengths");
  }

  validateFinalLength(
    prefixLengths,
    prefixCheckpoints,
    prefixBlob.length,
    PREFIX_LENGTH_MASK
  );
  validateFinalLength(suffixLengths, suffixCheckpoints, suffixBlob.length);

  const prefixCache: string[] = [];
  const suffixCache: string[] = [];
  const snapTargetCache: Array<SnapTargetParts | undefined> = [];
  const snapTriggerCache: Array<string | undefined> = [];
  const tupleCache: Array<readonly [string, string | null] | undefined> = [];
  const snapTupleCache: Array<BuiltinUrlParts | undefined> = [];
  const bucketMask = bucketCount - 1;

  function prefix(id: number): string {
    let value = prefixCache[id];
    if (value === undefined) {
      const prefixInfo = prefixLengths[id];
      const length = prefixInfo & PREFIX_LENGTH_MASK;
      const start = checkpointOffset(
        prefixLengths,
        prefixCheckpoints,
        id,
        PREFIX_LENGTH_MASK
      );
      value =
        PREFIX_HEADS[prefixInfo >>> 13] +
        decoder.decode(prefixBlob.subarray(start, start + length));
      prefixCache[id] = value;
    }
    return value;
  }

  function suffix(id: number): string {
    let value = suffixCache[id];
    if (value === undefined) {
      const start = checkpointOffset(suffixLengths, suffixCheckpoints, id);
      const length = suffixLengths[id];
      value =
        length === 0
          ? ""
          : decoder.decode(suffixBlob.subarray(start, start + length));
      suffixCache[id] = value;
    }
    return value;
  }

  function snapTarget(id: number): SnapTargetParts {
    let value = snapTargetCache[id];
    if (value === undefined) {
      const lengthIndex = id * 2;
      let start = 0;
      for (let i = 0; i < lengthIndex; i++) {
        start += snapTargetLengths[i];
      }
      const siteFilterLength = snapTargetLengths[lengthIndex];
      const originLength = snapTargetLengths[lengthIndex + 1];
      const originStart = start + siteFilterLength;
      value = [
        decoder.decode(
          snapTargetBlob.subarray(start, start + siteFilterLength)
        ),
        decoder.decode(
          snapTargetBlob.subarray(originStart, originStart + originLength)
        ),
      ];
      snapTargetCache[id] = value;
    }
    return value;
  }

  function snapTrigger(id: number): string {
    let value = snapTriggerCache[id];
    if (value === undefined) {
      let start = 0;
      for (let i = 0; i < id; i++) {
        start += snapTriggerLengths[i];
      }
      value = decoder.decode(
        snapTriggerBlob.subarray(start, start + snapTriggerLengths[id])
      );
      snapTriggerCache[id] = value;
    }
    return value;
  }

  function snapTargetId(index: number, trigger: string): number {
    let low = 0;
    let high = snapSlots.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const slot = snapSlots[middle];
      if (slot === index) {
        return snapTrigger(middle) === trigger ? snapTargetIds[middle] : -1;
      }
      if (slot < index) {
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return -1;
  }

  function tuple(index: number, trigger: string): BuiltinUrlParts {
    let value = tupleCache[index];
    if (value === undefined) {
      const suffixId = suffixIds[index];
      const tuplePrefix = prefix(prefixIds[index]);
      const tupleSuffix = suffixId === 0 ? null : suffix(suffixId - 1);
      value = [tuplePrefix, tupleSuffix];
      tupleCache[index] = value;
    }
    const snapId = snapTargetId(index, trigger);
    if (snapId === -1) {
      return value;
    }
    let snapValue = snapTupleCache[index];
    if (snapValue === undefined) {
      snapValue = [value[0], value[1], snapTarget(snapId)];
      snapTupleCache[index] = snapValue;
    }
    return snapValue;
  }

  return (trigger, hash) => {
    const unsignedHash = hash >>> 0;
    let bucketHash = unsignedHash ^ (unsignedHash >>> 16);
    bucketHash = Math.imul(bucketHash, MPH_BUCKET_MULTIPLIER);
    bucketHash ^= bucketHash >>> 15;
    const bucket = bucketHash & bucketMask;
    const displacement = displacements[bucket];
    const index =
      displacement < 0
        ? -displacement - 1
        : (Math.imul(unsignedHash ^ (displacement + 1), MPH_SLOT_MULTIPLIER) >>>
            0) %
          entryCount;
    return fingerprints[index] === unsignedHash >>> 16
      ? tuple(index, trigger)
      : null;
  };
}

export function createBangShardRuntime(
  router: ArrayLike<number>,
  version: string
): BangShardRuntime {
  const lookups: Array<BangLookup | null> = Array.from(
    { length: BANG_SHARD_COUNT },
    () => null
  );
  const unavailable = Array.from(
    { length: BANG_SHARD_COUNT },
    (_, shardId) =>
      Object.freeze(
        Object.assign(new Error(`Bang shard ${shardId} is not initialized`), {
          shardId,
        })
      ) as BangShardUnavailableError
  );
  const promises: Array<Promise<void> | null> = Array.from(
    { length: BANG_SHARD_COUNT },
    () => null
  );

  const shardLookup: BangLookup = (trigger, hash) => {
    const shardId = bangShardIndex(hash, router);
    const resolved = lookups[shardId];
    if (!resolved) {
      throw unavailable[shardId];
    }
    return resolved(trigger, hash);
  };

  const ensure: BangShardRuntime["ensure"] = (shardId, prefetched) => {
    if (lookups[shardId]) {
      return Promise.resolve();
    }
    let promise = promises[shardId];
    if (!promise) {
      promise = (
        prefetched
          ? Promise.resolve(prefetched)
          : fetch(`/bangs-s${shardId.toString(36)}-${version}.bin`).then(
              (response) => {
                if (!response.ok) {
                  throw new Error(
                    `Failed to load bang shard: ${response.status}`
                  );
                }
                return response.arrayBuffer();
              }
            )
      )
        .then((buffer) => {
          lookups[shardId] = decodeBangData(buffer);
        })
        .catch((error) => {
          promises[shardId] = null;
          throw error;
        });
      promises[shardId] = promise;
    }
    return promise;
  };

  return {
    ensure,
    lookup: shardLookup,
    reset() {
      lookups.fill(null);
      promises.fill(null);
    },
    unavailableShardId(error) {
      if (!error || typeof error !== "object") {
        return null;
      }
      const shardId = (error as Partial<BangShardUnavailableError>).shardId;
      return typeof shardId === "number" && unavailable[shardId] === error
        ? shardId
        : null;
    },
  };
}

export function initializeBangData(buffer: ArrayBuffer): void {
  lookup = decodeBangData(buffer);
  fallbackLookup = null;
}

export function configureBangFallbackLookup(value: BangLookup): void {
  fallbackLookup = value;
}

export function isBangDataInitialized(): boolean {
  return lookup !== null;
}

export function resetBangDataForTests(): void {
  lookup = null;
  fallbackLookup = null;
}

export function lookupBang(
  trigger: string,
  hash: number
): BuiltinUrlParts | null {
  if (lookup) {
    return lookup(trigger, hash);
  }
  if (fallbackLookup) {
    return fallbackLookup(trigger, hash);
  }
  throw BANG_DATA_UNAVAILABLE;
}

export function isBangDataUnavailable(error: unknown): boolean {
  return error === BANG_DATA_UNAVAILABLE;
}
