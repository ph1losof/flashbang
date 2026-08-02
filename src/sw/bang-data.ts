export type BuiltinUrlParts = readonly [string, string | null];

const MAGIC = 0x31424246;
const VERSION = 8;
const HEADER_WORDS = 13;
const HEADER_BYTES = HEADER_WORDS * Uint32Array.BYTES_PER_ELEMENT;
const MPH_SLOT_MULTIPLIER = 0x85ebca6b;
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

let lookup: ((trigger: string, hash: number) => BuiltinUrlParts | null) | null =
  null;
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

export function initializeBangData(buffer: ArrayBuffer): void {
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

  validateFinalLength(
    prefixLengths,
    prefixCheckpoints,
    prefixBlob.length,
    PREFIX_LENGTH_MASK
  );
  validateFinalLength(suffixLengths, suffixCheckpoints, suffixBlob.length);

  const prefixCache: string[] = [];
  const suffixCache: string[] = [];
  const tupleCache: BuiltinUrlParts[] = [];
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

  function tuple(index: number): BuiltinUrlParts {
    let value = tupleCache[index];
    if (value === undefined) {
      const suffixId = suffixIds[index];
      value =
        suffixId === 0
          ? [prefix(prefixIds[index]), null]
          : [prefix(prefixIds[index]), suffix(suffixId - 1)];
      tupleCache[index] = value;
    }
    return value;
  }

  lookup = (_trigger, hash) => {
    const unsignedHash = hash >>> 0;
    const bucket = unsignedHash & bucketMask;
    const displacement = displacements[bucket];
    const index =
      displacement < 0
        ? -displacement - 1
        : (Math.imul(unsignedHash ^ (displacement + 1), MPH_SLOT_MULTIPLIER) >>>
            0) %
          entryCount;
    return fingerprints[index] === unsignedHash >>> 16 ? tuple(index) : null;
  };
}

export function isBangDataInitialized(): boolean {
  return lookup !== null;
}

export function resetBangDataForTests(): void {
  lookup = null;
}

export function lookupBang(
  trigger: string,
  hash: number
): BuiltinUrlParts | null {
  if (!lookup) {
    throw BANG_DATA_UNAVAILABLE;
  }
  return lookup(trigger, hash);
}

export function isBangDataUnavailable(error: unknown): boolean {
  return error === BANG_DATA_UNAVAILABLE;
}
