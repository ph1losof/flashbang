export type BuiltinUrlParts = readonly [string, string | null];

const MAGIC = 0x31424246;
const VERSION = 2;
const HEADER_WORDS = 13;
const HEADER_BYTES = HEADER_WORDS * Uint32Array.BYTES_PER_ELEMENT;
const MPH_SLOT_MULTIPLIER = 0x85ebca6b;

let lookup: ((trigger: string, hash: number) => BuiltinUrlParts | null) | null =
  null;

function offsets(lengths: Uint8Array | Uint16Array): Uint32Array {
  const result = new Uint32Array(lengths.length + 1);
  let position = 0;
  for (let i = 0; i < lengths.length; i++) {
    result[i] = position;
    position += lengths[i];
  }
  result[lengths.length] = position;
  return result;
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
  const triggerLengthWidth = header[4];
  const prefixCount = header[5];
  const suffixCount = header[6];
  const displacementWidth = header[12];
  if (entryCount === 0) {
    throw new Error("Invalid binary bang entry count");
  }
  if (bucketCount === 0 || (bucketCount & (bucketCount - 1)) !== 0) {
    throw new Error("Invalid binary bang MPHF bucket count");
  }
  if (triggerLengthWidth !== 1 && triggerLengthWidth !== 2) {
    throw new Error("Invalid binary bang trigger length width");
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
  const triggerLengths =
    triggerLengthWidth === 1
      ? new Uint8Array(buffer, offset, entryCount)
      : new Uint16Array(buffer, offset, entryCount);
  offset += triggerLengths.byteLength;
  offset = (offset + 1) & ~1;
  const prefixLengths = new Uint16Array(buffer, offset, prefixCount);
  offset += prefixLengths.byteLength;
  const suffixLengths = new Uint16Array(buffer, offset, suffixCount);
  offset += suffixLengths.byteLength;
  const prefixIds = new Uint16Array(buffer, offset, entryCount);
  offset += prefixIds.byteLength;
  const suffixIds = new Uint16Array(buffer, offset, entryCount);
  offset += suffixIds.byteLength;
  if (offset !== header[10]) {
    throw new Error("Invalid binary bang data layout");
  }

  const decoder = new TextDecoder();
  const triggerBlob = decoder.decode(new Uint8Array(buffer, offset, header[7]));
  offset += header[7];
  const prefixBlob = decoder.decode(new Uint8Array(buffer, offset, header[8]));
  offset += header[8];
  const suffixBlob = decoder.decode(new Uint8Array(buffer, offset, header[9]));

  const triggerOffsets = offsets(triggerLengths);
  const prefixOffsets = offsets(prefixLengths);
  const suffixOffsets = offsets(suffixLengths);
  const prefixCache: string[] = [];
  const suffixCache: string[] = [];
  const tupleCache: BuiltinUrlParts[] = [];
  const bucketMask = bucketCount - 1;

  function prefix(id: number): string {
    let value = prefixCache[id];
    if (value === undefined) {
      value = prefixBlob.substring(prefixOffsets[id], prefixOffsets[id + 1]);
      prefixCache[id] = value;
    }
    return value;
  }

  function suffix(id: number): string {
    let value = suffixCache[id];
    if (value === undefined) {
      value = suffixBlob.substring(suffixOffsets[id], suffixOffsets[id + 1]);
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

  lookup = (trigger, hash) => {
    const unsignedHash = hash >>> 0;
    const bucket = unsignedHash & bucketMask;
    const displacement = displacements[bucket];
    const index =
      displacement < 0
        ? -displacement - 1
        : (Math.imul(unsignedHash ^ (displacement + 1), MPH_SLOT_MULTIPLIER) >>>
            0) %
          entryCount;
    return triggerLengths[index] === trigger.length &&
      triggerBlob.startsWith(trigger, triggerOffsets[index])
      ? tuple(index)
      : null;
  };
}

export function isBangDataInitialized(): boolean {
  return lookup !== null;
}

export function lookupBang(
  trigger: string,
  hash: number
): BuiltinUrlParts | null {
  if (!lookup) {
    throw new Error("Binary bang data is not initialized");
  }
  return lookup(trigger, hash);
}
