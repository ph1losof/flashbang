// Packed catalog layout, shared by codegen, the SW decoders and the test helper.
//
// Two shapes share the magic and differ by version: v10 carries its own string
// tables so a cold shard resolves a first search from one fetch, v11 carries
// only IDs into the global string store. Store IDs are append-only, so an index
// shard's bytes depend on nothing outside itself.

export const BANG_BINARY_MAGIC = 0x31424246;
export const BANG_BINARY_VERSION_SELF = 10;
export const BANG_BINARY_VERSION_INDEX = 11;
export const BANG_BINARY_HEADER_WORDS = 16;

export const BANG_STRINGS_MAGIC = 0x31534246;
export const BANG_STRINGS_VERSION = 1;
export const BANG_STRINGS_HEADER_WORDS = 12;

// Checkpoint stride for the packed string tables: a lookup jumps to
// checkpoints[id >> CHECKPOINT_SHIFT] and sums at most CHECKPOINT_SIZE - 1
// lengths. Store chunks are cut on this boundary so each block lies in one
// chunk and offsets can be absolute.
export const CHECKPOINT_SHIFT = 4;
export const CHECKPOINT_SIZE = 1 << CHECKPOINT_SHIFT;

export function checkpointCount(length: number): number {
  return Math.ceil(length / CHECKPOINT_SIZE);
}

/** Prefix length word: 13-bit byte length, 3-bit scheme/www head code. */
export const PREFIX_LENGTH_MASK = 0x1fff;
export const PREFIX_WWW_FLAG = 0x2000;
export const PREFIX_SCHEME_SHIFT = 14;
export const PREFIX_HEAD_SHIFT = 13;

export const PREFIX_HEADS = [
  "",
  "www.",
  "https://",
  "https://www.",
  "http://",
  "http://www.",
  "",
  "",
] as const;

/** Strip the scheme/www head from a prefix and return the encoded head code. */
export function splitPrefixHead(prefix: string): {
  head: number;
  payload: string;
} {
  let payload = prefix;
  let scheme = 0;
  if (payload.startsWith("https://")) {
    payload = payload.substring(8);
    scheme = 1;
  } else if (payload.startsWith("http://")) {
    payload = payload.substring(7);
    scheme = 2;
  }
  let www = 0;
  if (payload.startsWith("www.")) {
    payload = payload.substring(4);
    www = 1;
  }
  return { head: (scheme << 1) | www, payload };
}

export const align2 = (offset: number): number => (offset + 1) & ~1;
export const align4 = (offset: number): number => (offset + 3) & ~3;
