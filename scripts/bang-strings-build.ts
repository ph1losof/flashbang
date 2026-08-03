import { readFileSync } from "node:fs";
import {
  align4,
  BANG_STRINGS_HEADER_WORDS,
  BANG_STRINGS_MAGIC,
  BANG_STRINGS_VERSION,
  CHECKPOINT_SIZE,
  checkpointCount,
  PREFIX_HEAD_SHIFT,
  PREFIX_LENGTH_MASK,
  splitPrefixHead,
} from "../src/shared/bang-binary-format";

export const PREFIX_IDS_PATH = "data/bang-prefixes.txt";
export const SUFFIX_IDS_PATH = "data/bang-suffixes.txt";
export const STRING_META_PATH = "data/bang-strings-meta.json";

export interface StringIdMeta {
  /** Bumped only by compaction. Any bump invalidates every index shard. */
  epoch: number;
  /** IDs below these counts live in the base chunk; the rest live in the tail. */
  basePrefixCount: number;
  baseSuffixCount: number;
}

export interface StringIdMap {
  meta: StringIdMeta;
  prefixes: string[];
  prefixIds: Map<string, number>;
  suffixes: string[];
  suffixIds: Map<string, number>;
}

const encoder = new TextEncoder();

function decodeLines(source: string): string[] {
  if (source.length === 0) {
    return [];
  }
  const lines = source.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines.map((line) => JSON.parse(line) as string);
}

function encodeLines(values: readonly string[]): string {
  return `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
}

function indexOf(values: readonly string[]): Map<string, number> {
  const ids = new Map<string, number>();
  for (let i = 0; i < values.length; i++) {
    ids.set(values[i], i);
  }
  return ids;
}

// Throws rather than regenerating a missing map: regenerating reassigns every
// ID, which yields shards that resolve to valid URLs for the wrong bangs.
// Bootstrapping is a separate explicit action.
export function loadStringIdMap(): StringIdMap {
  let meta: StringIdMeta;
  let prefixes: string[];
  let suffixes: string[];
  try {
    meta = JSON.parse(readFileSync(STRING_META_PATH, "utf8")) as StringIdMeta;
    prefixes = decodeLines(readFileSync(PREFIX_IDS_PATH, "utf8"));
    suffixes = decodeLines(readFileSync(SUFFIX_IDS_PATH, "utf8"));
  } catch (cause) {
    throw new Error(
      `Missing or unreadable bang string ID map (${STRING_META_PATH}). ` +
        "Run `bun run codegen --bootstrap-string-ids` once to create it; never " +
        "regenerate it implicitly, because reassigning IDs silently corrupts " +
        "every index shard.",
      { cause }
    );
  }
  if (
    !(
      Number.isInteger(meta.epoch) &&
      Number.isInteger(meta.basePrefixCount) &&
      Number.isInteger(meta.baseSuffixCount)
    ) ||
    meta.basePrefixCount > prefixes.length ||
    meta.baseSuffixCount > suffixes.length ||
    meta.basePrefixCount % CHECKPOINT_SIZE !== 0 ||
    meta.baseSuffixCount % CHECKPOINT_SIZE !== 0
  ) {
    throw new Error(`Invalid ${STRING_META_PATH}`);
  }
  return {
    meta,
    prefixes,
    prefixIds: indexOf(prefixes),
    suffixes,
    suffixIds: indexOf(suffixes),
  };
}

export function emptyStringIdMap(): StringIdMap {
  return {
    meta: { basePrefixCount: 0, baseSuffixCount: 0, epoch: 1 },
    prefixes: [],
    prefixIds: new Map(),
    suffixes: [],
    suffixIds: new Map(),
  };
}

// Append unseen strings at the end; existing IDs never move. New strings are
// sorted within the run first — IDs from one generation never move relative to
// each other, so this is free in stability and keeps the length array a monotone
// ramp rather than noise.
export function assignGlobalStringIds(
  map: StringIdMap,
  prefixes: Iterable<string>,
  suffixes: Iterable<string>
): { addedPrefixes: number; addedSuffixes: number } {
  const append = (
    values: Iterable<string>,
    known: Map<string, number>,
    all: string[],
    compare: (a: string, b: string) => number
  ): number => {
    const fresh: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      if (!(known.has(value) || seen.has(value))) {
        seen.add(value);
        fresh.push(value);
      }
    }
    fresh.sort(compare);
    for (const value of fresh) {
      known.set(value, all.length);
      all.push(value);
    }
    return fresh.length;
  };

  const compareText = (a: string, b: string): number => {
    if (a < b) {
      return -1;
    }
    return a > b ? 1 : 0;
  };
  const byPayload = (a: string, b: string): number => {
    const pa = splitPrefixHead(a).payload;
    const pb = splitPrefixHead(b).payload;
    const la = encoder.encode(pa).byteLength;
    const lb = encoder.encode(pb).byteLength;
    if (la !== lb) {
      return la - lb;
    }
    return compareText(pa, pb);
  };
  const byLength = (a: string, b: string): number => {
    if (a.length !== b.length) {
      return a.length - b.length;
    }
    return compareText(a, b);
  };

  return {
    addedPrefixes: append(prefixes, map.prefixIds, map.prefixes, byPayload),
    addedSuffixes: append(suffixes, map.suffixIds, map.suffixes, byLength),
  };
}

export function serializeStringIdMap(map: StringIdMap): {
  meta: string;
  prefixes: string;
  suffixes: string;
} {
  return {
    meta: `${JSON.stringify(map.meta, null, 2)}\n`,
    prefixes: encodeLines(map.prefixes),
    suffixes: encodeLines(map.suffixes),
  };
}

interface EncodedSection {
  bytes: Uint8Array[];
  byteBase: number;
  byteCount: number;
  checkpoints: number[];
  lengths: number[];
}

function encodeSection(
  values: readonly string[],
  from: number,
  to: number,
  isPrefix: boolean
): EncodedSection {
  // Absolute plane offset of `from`, so appending a chunk never rewrites the
  // checkpoints already shipped.
  let byteBase = 0;
  for (let i = 0; i < from; i++) {
    byteBase += sectionByteLength(values[i], isPrefix);
  }
  const lengths: number[] = [];
  const checkpoints: number[] = [];
  const bytes: Uint8Array[] = [];
  let position = byteBase;
  for (let i = from; i < to; i++) {
    if ((i - from) % CHECKPOINT_SIZE === 0) {
      checkpoints.push(position);
    }
    const value = values[i];
    if (isPrefix) {
      const { head, payload } = splitPrefixHead(value);
      const encoded = encoder.encode(payload);
      if (encoded.byteLength > PREFIX_LENGTH_MASK) {
        throw new Error(`Prefix payload exceeds ${PREFIX_LENGTH_MASK} bytes`);
      }
      lengths.push(encoded.byteLength | (head << PREFIX_HEAD_SHIFT));
      bytes.push(encoded);
      position += encoded.byteLength;
    } else {
      const encoded = encoder.encode(value);
      if (encoded.byteLength > 0xffff) {
        throw new Error("Suffix exceeds 65535 bytes");
      }
      lengths.push(encoded.byteLength);
      bytes.push(encoded);
      position += encoded.byteLength;
    }
  }
  return {
    byteBase,
    byteCount: position - byteBase,
    bytes,
    checkpoints,
    lengths,
  };
}

function sectionByteLength(value: string, isPrefix: boolean): number {
  return encoder.encode(isPrefix ? splitPrefixHead(value).payload : value)
    .byteLength;
}

// Encode prefix IDs [prefixFrom, prefixTo) and suffix IDs [suffixFrom,
// suffixTo). Both bounds must be CHECKPOINT_SIZE-aligned so no checkpoint block
// straddles two chunks.
export function encodeStringStoreChunk(
  map: StringIdMap,
  prefixFrom: number,
  prefixTo: number,
  suffixFrom: number,
  suffixTo: number
): Uint8Array {
  if (
    prefixFrom % CHECKPOINT_SIZE !== 0 ||
    suffixFrom % CHECKPOINT_SIZE !== 0
  ) {
    throw new Error("String store chunk bounds must be checkpoint-aligned");
  }
  const prefix = encodeSection(map.prefixes, prefixFrom, prefixTo, true);
  const suffix = encodeSection(map.suffixes, suffixFrom, suffixTo, false);
  const prefixCount = prefixTo - prefixFrom;
  const suffixCount = suffixTo - suffixFrom;

  const headerBytes = BANG_STRINGS_HEADER_WORDS * 4;
  let offset = headerBytes;
  offset += prefixCount * 2;
  offset += suffixCount * 2;
  offset = align4(offset);
  const checkpointsOffset = offset;
  offset += checkpointCount(prefixCount) * 4;
  offset += checkpointCount(suffixCount) * 4;
  const bytesOffset = offset;
  const totalBytes = bytesOffset + prefix.byteCount + suffix.byteCount;

  const buffer = new ArrayBuffer(totalBytes);
  const header = new Uint32Array(buffer, 0, BANG_STRINGS_HEADER_WORDS);
  header[0] = BANG_STRINGS_MAGIC;
  header[1] = BANG_STRINGS_VERSION;
  header[2] = map.meta.epoch;
  header[3] = prefixFrom;
  header[4] = prefixCount;
  header[5] = prefix.byteBase;
  header[6] = prefix.byteCount;
  header[7] = suffixFrom;
  header[8] = suffixCount;
  header[9] = suffix.byteBase;
  header[10] = suffix.byteCount;
  header[11] = totalBytes;

  const lengths = new Uint16Array(
    buffer,
    headerBytes,
    prefixCount + suffixCount
  );
  lengths.set(prefix.lengths, 0);
  lengths.set(suffix.lengths, prefixCount);

  const checkpoints = new Uint32Array(
    buffer,
    checkpointsOffset,
    checkpointCount(prefixCount) + checkpointCount(suffixCount)
  );
  checkpoints.set(prefix.checkpoints, 0);
  checkpoints.set(suffix.checkpoints, checkpointCount(prefixCount));

  const plane = new Uint8Array(buffer);
  let cursor = bytesOffset;
  for (const chunk of prefix.bytes) {
    plane.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  for (const chunk of suffix.bytes) {
    plane.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return plane;
}

/** Base chunk plus the appended tail. The base only changes on compaction. */
export function encodeStringStore(map: StringIdMap): {
  base: Uint8Array;
  tail: Uint8Array;
} {
  const { basePrefixCount, baseSuffixCount } = map.meta;
  return {
    base: encodeStringStoreChunk(map, 0, basePrefixCount, 0, baseSuffixCount),
    tail: encodeStringStoreChunk(
      map,
      basePrefixCount,
      map.prefixes.length,
      baseSuffixCount,
      map.suffixes.length
    ),
  };
}
