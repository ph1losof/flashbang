export const BANG_BINARY_MAGIC = 0x31424246;
export const BANG_BINARY_VERSION = 10;
export const BANG_CHECKPOINT_SIZE = 16;
export const BANG_SHARD_PACK_MAGIC = 0x314b5046;
export const BANG_SHARD_PACK_VERSION = 1;
export const BANG_SHARD_PACK_HEADER_WORDS = 16;
export const BANG_SHARD_PACK_SHARD_HEADER_WORDS = 10;
export const BANG_SHARD_PACK_DIRECTORY_WORDS = 2;

const BANG_SHARD_PATH_RE = /^\/bang-shard\/([a-f0-9]{12})\/s([0-9a-z]+)\.bin$/;

const PREFIX_LENGTH_MASK = 0x1fff;
const PREFIX_WWW_FLAG = 0x2000;
const PREFIX_SCHEME_SHIFT = 14;
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

type BinaryTypedArray =
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | Int16Array
  | Int32Array;

export interface BangBinarySnapData {
  blob: Uint8Array;
  lengths: Uint16Array;
  slots: Uint16Array;
  targetCount: number;
  targetIds: Uint16Array;
  triggerBlob: Uint8Array;
  triggerLengths: Uint16Array;
}

export interface BangBinaryTables {
  displacements: Int16Array | Int32Array;
  fingerprints: Uint16Array;
  prefixIds: Uint16Array;
  snapData: BangBinarySnapData;
  suffixIds: Uint16Array;
  uniquePrefixes: readonly string[];
  uniqueSuffixes: readonly string[];
}

export interface EncodedBangStrings {
  prefixBytes: Uint8Array;
  prefixCheckpoints: Uint32Array;
  prefixLengths: Uint16Array;
  suffixBytes: Uint8Array;
  suffixCheckpoints: Uint32Array;
  suffixLengths: Uint16Array;
}

export interface BangShardPath {
  shardId: number;
  version: string;
}

export function binaryShardPackShardCount(pack: Uint8Array): number {
  if (pack.byteOffset % Uint32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error("Unaligned binary bang shard pack");
  }
  if (
    pack.byteLength <
    BANG_SHARD_PACK_HEADER_WORDS * Uint32Array.BYTES_PER_ELEMENT
  ) {
    throw new Error("Truncated binary bang shard pack header");
  }
  const header = new Uint32Array(
    pack.buffer,
    pack.byteOffset,
    BANG_SHARD_PACK_HEADER_WORDS
  );
  if (
    header[0] !== BANG_SHARD_PACK_MAGIC ||
    header[1] !== BANG_SHARD_PACK_VERSION
  ) {
    throw new Error("Unsupported binary bang shard pack");
  }
  if (header[12] !== pack.byteLength) {
    throw new Error("Truncated binary bang shard pack");
  }
  return header[2];
}

export function bangShardPackAssetPath(version: string): string {
  if (!/^[a-f0-9]{12}$/.test(version)) {
    throw new Error(`Invalid binary bang shard version: ${version}`);
  }
  return `/bangs-pack-${version}.bin`;
}

export function bangShardEndpointPath(
  version: string,
  shardId: number
): string {
  bangShardPackAssetPath(version);
  if (!Number.isInteger(shardId) || shardId < 0) {
    throw new Error(`Invalid binary bang shard id: ${shardId}`);
  }
  return `/bang-shard/${version}/s${shardId.toString(36)}.bin`;
}

export function parseBangShardPath(pathname: string): BangShardPath | null {
  const match = BANG_SHARD_PATH_RE.exec(pathname);
  if (!match) {
    return null;
  }
  const shardId = Number.parseInt(match[2], 36);
  if (
    !Number.isSafeInteger(shardId) ||
    shardId < 0 ||
    shardId.toString(36) !== match[2]
  ) {
    return null;
  }
  return { shardId, version: match[1] };
}

export function align2(value: number): number {
  return (value + 1) & ~1;
}

export function align4(value: number): number {
  return (value + 3) & ~3;
}

export function copyTypedArray(
  output: Uint8Array,
  offset: number,
  values: BinaryTypedArray
): number {
  output.set(
    new Uint8Array(values.buffer, values.byteOffset, values.byteLength),
    offset
  );
  return offset + values.byteLength;
}

function buildCheckpoints(
  lengths: Uint8Array | Uint16Array,
  lengthMask = 0xffff
): Uint32Array {
  const checkpoints = new Uint32Array(
    Math.ceil(lengths.length / BANG_CHECKPOINT_SIZE)
  );
  let position = 0;
  for (let i = 0; i < lengths.length; i++) {
    if (i % BANG_CHECKPOINT_SIZE === 0) {
      checkpoints[i / BANG_CHECKPOINT_SIZE] = position;
    }
    position += lengths[i] & lengthMask;
  }
  return checkpoints;
}

export function orderStringsByLength(values: readonly string[]): {
  ordered: string[];
  remap: number[];
} {
  const indexes = values.map((_, index) => index);
  indexes.sort((a, b) => {
    const lengthDifference = values[a].length - values[b].length;
    if (lengthDifference !== 0) {
      return lengthDifference;
    }
    if (values[a] < values[b]) {
      return -1;
    }
    return values[a] > values[b] ? 1 : 0;
  });

  const ordered = new Array<string>(values.length);
  const remap = new Array<number>(values.length);
  for (let id = 0; id < indexes.length; id++) {
    const oldId = indexes[id];
    ordered[id] = values[oldId];
    remap[oldId] = id;
  }
  return { ordered, remap };
}

export function encodeBangStrings({
  uniquePrefixes,
  uniqueSuffixes,
}: Pick<
  BangBinaryTables,
  "uniquePrefixes" | "uniqueSuffixes"
>): EncodedBangStrings {
  const encoder = new TextEncoder();
  const prefixPayloads = new Array<string>(uniquePrefixes.length);
  const prefixLengths = Uint16Array.from(uniquePrefixes, (value, index) => {
    let payload = value;
    let scheme = 0;
    if (payload.startsWith("https://")) {
      scheme = 1;
      payload = payload.substring(8);
    } else if (payload.startsWith("http://")) {
      scheme = 2;
      payload = payload.substring(7);
    }
    let flags = scheme << PREFIX_SCHEME_SHIFT;
    if (payload.startsWith("www.")) {
      flags |= PREFIX_WWW_FLAG;
      payload = payload.substring(4);
    }
    const length = encoder.encode(payload).byteLength;
    if (length > PREFIX_LENGTH_MASK) {
      throw new Error(
        `Binary bang format requires encoded prefix payload length <= ${PREFIX_LENGTH_MASK}, got ${length}`
      );
    }
    prefixPayloads[index] = payload;
    return length | flags;
  });
  const prefixBytes = encoder.encode(prefixPayloads.join(""));
  const suffixLengths = Uint16Array.from(uniqueSuffixes, (value) => {
    const length = encoder.encode(value).byteLength;
    if (length > 0xffff) {
      throw new Error(
        `Binary bang format requires encoded suffix length <= 65535, got ${length}`
      );
    }
    return length;
  });
  const suffixBytes = encoder.encode(uniqueSuffixes.join(""));
  return {
    prefixBytes,
    prefixCheckpoints: buildCheckpoints(prefixLengths, PREFIX_LENGTH_MASK),
    prefixLengths,
    suffixBytes,
    suffixCheckpoints: buildCheckpoints(suffixLengths),
    suffixLengths,
  };
}

export function serializeBangBinary({
  displacements,
  fingerprints,
  prefixIds,
  snapData,
  suffixIds,
  uniquePrefixes,
  uniqueSuffixes,
}: BangBinaryTables): Uint8Array {
  const entryCount = fingerprints.length;
  const {
    prefixBytes,
    prefixCheckpoints,
    prefixLengths,
    suffixBytes,
    suffixCheckpoints,
    suffixLengths,
  } = encodeBangStrings({ uniquePrefixes, uniqueSuffixes });

  const headerWords = 16;
  const headerBytes = headerWords * Uint32Array.BYTES_PER_ELEMENT;
  let numericEnd = headerBytes + displacements.byteLength;
  numericEnd += fingerprints.byteLength;
  numericEnd = align2(numericEnd);
  numericEnd +=
    prefixLengths.byteLength +
    suffixLengths.byteLength +
    prefixIds.byteLength +
    suffixIds.byteLength +
    snapData.slots.byteLength +
    snapData.targetIds.byteLength +
    snapData.lengths.byteLength +
    snapData.triggerLengths.byteLength;
  numericEnd = align4(numericEnd);
  numericEnd += prefixCheckpoints.byteLength + suffixCheckpoints.byteLength;
  const totalBytes =
    numericEnd +
    prefixBytes.byteLength +
    suffixBytes.byteLength +
    snapData.blob.byteLength +
    snapData.triggerBlob.byteLength;
  const output = new Uint8Array(new ArrayBuffer(totalBytes));
  new Uint32Array(output.buffer, 0, headerWords).set([
    BANG_BINARY_MAGIC,
    BANG_BINARY_VERSION,
    entryCount,
    displacements.length,
    fingerprints.BYTES_PER_ELEMENT,
    uniquePrefixes.length,
    uniqueSuffixes.length,
    0,
    prefixBytes.byteLength,
    suffixBytes.byteLength,
    numericEnd,
    totalBytes,
    displacements.BYTES_PER_ELEMENT,
    snapData.slots.length,
    snapData.targetCount,
    snapData.blob.byteLength,
  ]);

  let offset = headerBytes;
  offset = copyTypedArray(output, offset, displacements);
  offset = copyTypedArray(output, offset, fingerprints);
  offset = align2(offset);
  offset = copyTypedArray(output, offset, prefixLengths);
  offset = copyTypedArray(output, offset, suffixLengths);
  offset = copyTypedArray(output, offset, prefixIds);
  offset = copyTypedArray(output, offset, suffixIds);
  offset = copyTypedArray(output, offset, snapData.slots);
  offset = copyTypedArray(output, offset, snapData.targetIds);
  offset = copyTypedArray(output, offset, snapData.lengths);
  offset = copyTypedArray(output, offset, snapData.triggerLengths);
  offset = align4(offset);
  offset = copyTypedArray(output, offset, prefixCheckpoints);
  offset = copyTypedArray(output, offset, suffixCheckpoints);
  output.set(prefixBytes, offset);
  offset += prefixBytes.byteLength;
  output.set(suffixBytes, offset);
  offset += suffixBytes.byteLength;
  output.set(snapData.blob, offset);
  offset += snapData.blob.byteLength;
  output.set(snapData.triggerBlob, offset);
  return output;
}

function decodePackedStrings(
  lengths: Uint16Array,
  blob: Uint8Array,
  prefixes: boolean
): string[] {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const values = new Array<string>(lengths.length);
  let offset = 0;
  for (let id = 0; id < lengths.length; id++) {
    const encodedLength = lengths[id];
    const length = prefixes
      ? encodedLength & PREFIX_LENGTH_MASK
      : encodedLength;
    const end = offset + length;
    if (end > blob.byteLength) {
      throw new Error("Truncated binary bang shard pack string data");
    }
    const payload = decoder.decode(blob.subarray(offset, end));
    values[id] = prefixes
      ? PREFIX_HEADS[encodedLength >>> 13] + payload
      : payload;
    offset = end;
  }
  if (offset !== blob.byteLength) {
    throw new Error("Invalid binary bang shard pack string lengths");
  }
  return values;
}

function localizePackedStringIds(
  ids: Uint16Array,
  globalValues: readonly string[],
  optional: boolean
): { ids: Uint16Array; values: string[] } {
  const globalIds = [
    ...new Set(
      Array.from(ids)
        .filter((id) => !optional || id !== 0)
        .map((id) => (optional ? id - 1 : id))
    ),
  ];
  const ordered = orderStringsByLength(
    globalIds.map((globalId) => {
      const value = globalValues[globalId];
      if (value === undefined) {
        throw new Error("Invalid binary bang shard pack string id");
      }
      return value;
    })
  );
  const localByGlobal = new Map<number, number>();
  for (let oldId = 0; oldId < globalIds.length; oldId++) {
    localByGlobal.set(globalIds[oldId], ordered.remap[oldId]);
  }
  return {
    ids: Uint16Array.from(ids, (id) => {
      if (optional && id === 0) {
        return 0;
      }
      const local = localByGlobal.get(optional ? id - 1 : id);
      if (local === undefined) {
        throw new Error("Invalid binary bang shard pack string mapping");
      }
      return optional ? local + 1 : local;
    }),
    values: ordered.ordered,
  };
}

export function materializeBinaryShard(
  pack: Uint8Array,
  shardId: number
): Uint8Array {
  const shardCount = binaryShardPackShardCount(pack);
  const header = new Uint32Array(
    pack.buffer,
    pack.byteOffset,
    BANG_SHARD_PACK_HEADER_WORDS
  );
  if (!Number.isInteger(shardId) || shardId < 0 || shardId >= shardCount) {
    throw new Error(`Invalid binary bang shard id: ${shardId}`);
  }
  const directory = new Uint32Array(
    pack.buffer,
    pack.byteOffset + header[10],
    shardCount * BANG_SHARD_PACK_DIRECTORY_WORDS
  );
  const blockOffset = directory[shardId * BANG_SHARD_PACK_DIRECTORY_WORDS];
  const blockLength = directory[shardId * BANG_SHARD_PACK_DIRECTORY_WORDS + 1];
  if (blockOffset + blockLength > pack.byteLength) {
    throw new Error("Truncated binary bang shard pack block");
  }

  let offset = header[8];
  const prefixLengths = new Uint16Array(
    pack.buffer,
    pack.byteOffset + offset,
    header[4]
  );
  offset += prefixLengths.byteLength;
  const suffixLengths = new Uint16Array(
    pack.buffer,
    pack.byteOffset + offset,
    header[5]
  );
  offset = align4(offset + suffixLengths.byteLength);
  offset += (header[13] + header[14]) * Uint32Array.BYTES_PER_ELEMENT;
  if (offset !== header[9]) {
    throw new Error("Invalid binary bang shard pack string layout");
  }
  const prefixBlob = pack.subarray(offset, offset + header[6]);
  offset += header[6];
  const suffixBlob = pack.subarray(offset, offset + header[7]);
  const globalPrefixes = decodePackedStrings(prefixLengths, prefixBlob, true);
  const globalSuffixes = decodePackedStrings(suffixLengths, suffixBlob, false);

  const blockHeader = new Uint32Array(
    pack.buffer,
    pack.byteOffset + blockOffset,
    BANG_SHARD_PACK_SHARD_HEADER_WORDS
  );
  if (blockHeader[8] !== blockLength) {
    throw new Error("Invalid binary bang shard pack block length");
  }
  const entryCount = blockHeader[0];
  const bucketCount = blockHeader[1];
  const displacementWidth = blockHeader[2];
  const snapCount = blockHeader[3];
  const snapTargetCount = blockHeader[4];
  if (displacementWidth !== 2 && displacementWidth !== 4) {
    throw new Error("Invalid binary bang shard pack displacement width");
  }
  let blockCursor =
    blockOffset +
    BANG_SHARD_PACK_SHARD_HEADER_WORDS * Uint32Array.BYTES_PER_ELEMENT;
  const displacements =
    displacementWidth === 2
      ? new Int16Array(pack.buffer, pack.byteOffset + blockCursor, bucketCount)
      : new Int32Array(pack.buffer, pack.byteOffset + blockCursor, bucketCount);
  blockCursor += displacements.byteLength;
  const fingerprints = new Uint16Array(
    pack.buffer,
    pack.byteOffset + blockCursor,
    entryCount
  );
  blockCursor += fingerprints.byteLength;
  const globalPrefixIds = new Uint16Array(
    pack.buffer,
    pack.byteOffset + blockCursor,
    entryCount
  );
  blockCursor += globalPrefixIds.byteLength;
  const globalSuffixIds = new Uint16Array(
    pack.buffer,
    pack.byteOffset + blockCursor,
    entryCount
  );
  blockCursor += globalSuffixIds.byteLength;
  const snapSlots = new Uint16Array(
    pack.buffer,
    pack.byteOffset + blockCursor,
    snapCount
  );
  blockCursor += snapSlots.byteLength;
  const snapTargetIds = new Uint16Array(
    pack.buffer,
    pack.byteOffset + blockCursor,
    snapCount
  );
  blockCursor += snapTargetIds.byteLength;
  const snapTargetLengths = new Uint16Array(
    pack.buffer,
    pack.byteOffset + blockCursor,
    snapTargetCount * 2
  );
  blockCursor += snapTargetLengths.byteLength;
  const snapTriggerLengths = new Uint16Array(
    pack.buffer,
    pack.byteOffset + blockCursor,
    snapCount
  );
  blockCursor = align4(blockCursor + snapTriggerLengths.byteLength);
  if (blockCursor !== blockOffset + blockHeader[7]) {
    throw new Error("Invalid binary bang shard pack block layout");
  }
  const snapTargetBlob = pack.subarray(
    blockCursor,
    blockCursor + blockHeader[5]
  );
  blockCursor += blockHeader[5];
  const snapTriggerBlob = pack.subarray(
    blockCursor,
    blockCursor + blockHeader[6]
  );
  if (blockCursor + blockHeader[6] !== blockOffset + blockLength) {
    throw new Error("Invalid binary bang shard pack snap data");
  }

  const prefixes = localizePackedStringIds(
    globalPrefixIds,
    globalPrefixes,
    false
  );
  const suffixes = localizePackedStringIds(
    globalSuffixIds,
    globalSuffixes,
    true
  );
  return serializeBangBinary({
    displacements,
    fingerprints,
    prefixIds: prefixes.ids,
    snapData: {
      blob: snapTargetBlob,
      lengths: snapTargetLengths,
      slots: snapSlots,
      targetCount: snapTargetCount,
      targetIds: snapTargetIds,
      triggerBlob: snapTriggerBlob,
      triggerLengths: snapTriggerLengths,
    },
    suffixIds: suffixes.ids,
    uniquePrefixes: prefixes.values,
    uniqueSuffixes: suffixes.values,
  });
}
