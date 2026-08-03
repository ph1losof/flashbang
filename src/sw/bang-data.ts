import { BANG_BINARY_VERSION_INDEX } from "../shared/bang-binary-format";
import { BANG_SHARD_COUNT, bangShardIndex } from "../shared/bang-shards";
import type { SnapTargetParts } from "../shared/snap-target";
import type { BangStrings } from "./bang-strings";

/**
 * Thrown when an index shard needs string IDs the loaded store does not have
 * yet. Distinct from a decode failure: the caller refetches the store and
 * retries rather than failing the redirect.
 */
export class BangStringStoreStaleError extends Error {
  constructor(
    readonly epoch: number,
    readonly requiredPrefixCount: number,
    readonly requiredSuffixCount: number
  ) {
    super("Bang string store is stale for this index shard");
    this.name = "BangStringStoreStaleError";
  }
}

export function isBangStringStoreStale(
  error: unknown
): error is BangStringStoreStaleError {
  return error instanceof BangStringStoreStaleError;
}

const VERSION_INDEX = BANG_BINARY_VERSION_INDEX;

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

function decodeBangDataInternal(
  buffer: ArrayBuffer,
  validateGeneratedTables: boolean
): BangLookup {
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
  if (validateGeneratedTables) {
    for (const displacement of displacements) {
      if (displacement < -entryCount) {
        throw new Error("Invalid binary bang MPHF displacement");
      }
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

  if (validateGeneratedTables) {
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
  }

  const snapRows =
    snapCount < 256 ? new Uint8Array(entryCount) : new Uint16Array(entryCount);
  for (let i = 0; i < snapCount; i++) {
    snapRows[snapSlots[i]] = i + 1;
  }
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

  function tuple(index: number, trigger: string): BuiltinUrlParts {
    let value = tupleCache[index];
    if (value === undefined) {
      const suffixId = suffixIds[index];
      const tuplePrefix = prefix(prefixIds[index]);
      const tupleSuffix = suffixId === 0 ? null : suffix(suffixId - 1);
      value = [tuplePrefix, tupleSuffix];
      tupleCache[index] = value;
    }
    const snapRow = snapRows[index] - 1;
    if (snapRow === -1 || snapTrigger(snapRow) !== trigger) {
      return value;
    }
    let snapValue = snapTupleCache[index];
    if (snapValue === undefined) {
      snapValue = [value[0], value[1], snapTarget(snapTargetIds[snapRow])];
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

export function decodeBangData(buffer: ArrayBuffer): BangLookup {
  return decodeBangDataInternal(buffer, true);
}

/**
 * Decode a v11 index shard against the global string store.
 *
 * Hot path is identical in shape to the self-contained decoder: one MPH probe,
 * one fingerprint compare, one dense `tupleCache` hit. The store is only touched
 * on an entry's *first* resolution, so warm lookups never leave this shard's
 * typed arrays.
 *
 * Skew is checked exactly once, here, before the closure is published. Carrying
 * `requiredPrefixCount`/`requiredSuffixCount` in the header lets that be an O(1)
 * range check instead of a per-string bounds test on the fill path. The epoch is
 * an equality check rather than a content hash because an index shard built at
 * generation N against a store at generation N+1 is the normal, correct steady
 * state under append-only IDs — a hash pin would reject it.
 */
export function decodeIndexBangData(
  buffer: ArrayBuffer,
  strings: BangStrings
): BangLookup {
  const header = new Uint32Array(buffer, 0, HEADER_WORDS);
  if (header[0] !== MAGIC || header[1] !== VERSION_INDEX) {
    throw new Error("Unsupported binary bang index shard");
  }
  if (header[11] !== buffer.byteLength) {
    throw new Error("Truncated binary bang index shard");
  }
  const entryCount = header[2];
  const bucketCount = header[3];
  if (bucketCount === 0 || (bucketCount & (bucketCount - 1)) !== 0) {
    throw new Error("Invalid binary bang MPHF bucket count");
  }
  if (header[7] !== strings.epoch) {
    throw new BangStringStoreStaleError(header[7], header[5], header[6]);
  }
  if (header[5] > strings.prefixCount || header[6] > strings.suffixCount) {
    throw new BangStringStoreStaleError(header[7], header[5], header[6]);
  }

  const displacementWidth = header[12];
  const idWidth = header[8];
  if (idWidth !== 2 && idWidth !== 4) {
    throw new Error("Invalid binary bang index shard id width");
  }
  const snapCount = header[13];
  const snapTargetCount = header[14];
  let offset = HEADER_BYTES;
  const displacements =
    displacementWidth === 2
      ? new Int16Array(buffer, offset, bucketCount)
      : new Int32Array(buffer, offset, bucketCount);
  offset += displacements.byteLength;
  const fingerprints = new Uint16Array(buffer, offset, entryCount);
  offset += fingerprints.byteLength;
  offset = idWidth === 4 ? (offset + 3) & ~3 : (offset + 1) & ~1;
  const prefixIds =
    idWidth === 2
      ? new Uint16Array(buffer, offset, entryCount)
      : new Uint32Array(buffer, offset, entryCount);
  offset += prefixIds.byteLength;
  const suffixIds =
    idWidth === 2
      ? new Uint16Array(buffer, offset, entryCount)
      : new Uint32Array(buffer, offset, entryCount);
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
  if (offset !== header[10]) {
    throw new Error("Invalid binary bang index shard layout");
  }
  const snapTargetBlob = new Uint8Array(buffer, offset, header[15]);
  offset += header[15];
  const snapTriggerBlob = new Uint8Array(buffer, offset);

  const snapRows =
    snapCount < 256 ? new Uint8Array(entryCount) : new Uint16Array(entryCount);
  for (let i = 0; i < snapCount; i++) {
    snapRows[snapSlots[i]] = i + 1;
  }
  const decoder = new TextDecoder();
  const snapTargetCache: Array<SnapTargetParts | undefined> = [];
  const snapTriggerCache: Array<string | undefined> = [];
  const tupleCache: Array<readonly [string, string | null] | undefined> = [];
  const snapTupleCache: Array<BuiltinUrlParts | undefined> = [];
  const bucketMask = bucketCount - 1;

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

  function tuple(index: number, trigger: string): BuiltinUrlParts {
    let value = tupleCache[index];
    if (value === undefined) {
      const suffixId = suffixIds[index];
      value = [
        strings.prefix(prefixIds[index]),
        suffixId === 0 ? null : strings.suffix(suffixId - 1),
      ];
      tupleCache[index] = value;
    }
    const snapRow = snapRows[index] - 1;
    if (snapRow === -1 || snapTrigger(snapRow) !== trigger) {
      return value;
    }
    let snapValue = snapTupleCache[index];
    if (snapValue === undefined) {
      snapValue = [value[0], value[1], snapTarget(snapTargetIds[snapRow])];
      snapTupleCache[index] = snapValue;
    }
    return snapValue;
  }

  return (trigger, hash) => {
    const unsignedHash = hash >>> 0;
    let bucketHash = unsignedHash ^ (unsignedHash >>> 16);
    bucketHash = Math.imul(bucketHash, MPH_BUCKET_MULTIPLIER);
    bucketHash ^= bucketHash >>> 15;
    const displacement = displacements[bucketHash & bucketMask];
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

function decodeTrustedGeneratedBangData(buffer: ArrayBuffer): BangLookup {
  return decodeBangDataInternal(buffer, false);
}

async function defaultShardRead(asset: string): Promise<ArrayBuffer> {
  const response = await fetch(asset);
  if (!response.ok) {
    throw new Error(`Failed to load bang shard: ${response.status}`);
  }
  return response.arrayBuffer();
}

function createShardRuntime(
  router: ArrayLike<number>,
  assets: readonly string[],
  decode: (buffer: ArrayBuffer) => BangLookup,
  read: (asset: string) => Promise<ArrayBuffer> = defaultShardRead
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
        prefetched ? Promise.resolve(prefetched) : read(assets[shardId])
      )
        .then((buffer) => {
          lookups[shardId] = decode(buffer);
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

/** Self-contained v10 shards used by the minimal first-redirect fallback. */
export function createBangShardRuntime(
  router: ArrayLike<number>,
  // One content-addressed URL per shard, so a catalog change rotates only the
  // shards whose bytes moved.
  assets: readonly string[],
  read: (asset: string) => Promise<ArrayBuffer> = defaultShardRead
): BangShardRuntime {
  return createShardRuntime(
    router,
    assets,
    decodeTrustedGeneratedBangData,
    read
  );
}

/** v11 index shards resolved lazily against the append-only global store. */
export function createBangIndexRuntime(
  router: ArrayLike<number>,
  assets: readonly string[],
  // A getter lets the runtime be constructed before the store has loaded.
  strings: () => BangStrings | null,
  // The Service Worker supplies a cache-first reader for offline resolution.
  read: (asset: string) => Promise<ArrayBuffer> = defaultShardRead
): BangShardRuntime {
  return createShardRuntime(
    router,
    assets,
    (buffer) => {
      const store = strings();
      if (!store) {
        throw new Error("Bang string store is not initialized");
      }
      return decodeIndexBangData(buffer, store);
    },
    read
  );
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
