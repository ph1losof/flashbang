import {
  align4,
  BANG_STRINGS_HEADER_WORDS,
  BANG_STRINGS_MAGIC,
  BANG_STRINGS_VERSION,
  CHECKPOINT_SHIFT,
  checkpointCount,
  PREFIX_HEAD_SHIFT,
  PREFIX_HEADS,
  PREFIX_LENGTH_MASK,
} from "../shared/bang-binary-format";

// Prefix and suffix text shared by every index shard, addressed by stable IDs.
// Decoded strings are cached here, not per shard: a common prefix is referenced
// from ~25 shards and would otherwise be decoded and retained once each.
export interface BangStrings {
  epoch: number;
  prefix: (id: number) => string;
  prefixCount: number;
  suffix: (id: number) => string;
  suffixCount: number;
}

interface Chunk {
  checkpoints: Uint32Array;
  count: number;
  first: number;
  lengths: Uint16Array;
  plane: Uint8Array;
  planeBase: number;
}

interface DecodedChunk {
  epoch: number;
  prefix: Chunk;
  suffix: Chunk;
}

function decodeChunk(buffer: ArrayBuffer): DecodedChunk {
  const header = new Uint32Array(buffer, 0, BANG_STRINGS_HEADER_WORDS);
  if (header[0] !== BANG_STRINGS_MAGIC || header[1] !== BANG_STRINGS_VERSION) {
    throw new Error("Unsupported bang string store");
  }
  if (header[11] !== buffer.byteLength) {
    throw new Error("Truncated bang string store");
  }
  const epoch = header[2];
  const prefixFirst = header[3];
  const prefixCount = header[4];
  const prefixByteBase = header[5];
  const prefixByteCount = header[6];
  const suffixFirst = header[7];
  const suffixCount = header[8];
  const suffixByteBase = header[9];
  const suffixByteCount = header[10];

  let offset = BANG_STRINGS_HEADER_WORDS * 4;
  const lengths = new Uint16Array(buffer, offset, prefixCount + suffixCount);
  offset += lengths.byteLength;
  offset = align4(offset);
  const checkpoints = new Uint32Array(
    buffer,
    offset,
    checkpointCount(prefixCount) + checkpointCount(suffixCount)
  );
  offset += checkpoints.byteLength;
  if (offset + prefixByteCount + suffixByteCount !== buffer.byteLength) {
    throw new Error("Invalid bang string store layout");
  }
  const prefixPlane = new Uint8Array(buffer, offset, prefixByteCount);
  const suffixPlane = new Uint8Array(
    buffer,
    offset + prefixByteCount,
    suffixByteCount
  );
  const prefixCheckpointCount = checkpointCount(prefixCount);
  return {
    epoch,
    prefix: {
      checkpoints: checkpoints.subarray(0, prefixCheckpointCount),
      count: prefixCount,
      first: prefixFirst,
      lengths: lengths.subarray(0, prefixCount),
      plane: prefixPlane,
      planeBase: prefixByteBase,
    },
    suffix: {
      checkpoints: checkpoints.subarray(prefixCheckpointCount),
      count: suffixCount,
      first: suffixFirst,
      lengths: lengths.subarray(prefixCount),
      plane: suffixPlane,
      planeBase: suffixByteBase,
    },
  };
}

function readFrom(
  chunk: Chunk,
  id: number,
  decoder: TextDecoder,
  lengthMask: number
): string {
  const local = id - chunk.first;
  // Checkpoints hold absolute plane offsets; planeBase rebases them per chunk.
  let start = chunk.checkpoints[local >> CHECKPOINT_SHIFT];
  for (
    let i = (local >> CHECKPOINT_SHIFT) << CHECKPOINT_SHIFT;
    i < local;
    i++
  ) {
    start += chunk.lengths[i] & lengthMask;
  }
  const length = chunk.lengths[local] & lengthMask;
  const from = start - chunk.planeBase;
  return decoder.decode(chunk.plane.subarray(from, from + length));
}

// Chunks are disjoint and checkpoint-aligned, so a lookup picks one by ID range
// and reads it in place; the byte planes are never reassembled.
export function createBangStrings(chunks: readonly ArrayBuffer[]): BangStrings {
  const decoded = chunks.map(decodeChunk);
  if (decoded.length === 0) {
    throw new Error("Empty bang string store");
  }
  const epoch = decoded[0].epoch;
  for (const chunk of decoded) {
    if (chunk.epoch !== epoch) {
      throw new Error("Mismatched bang string store epoch");
    }
  }
  const prefixChunks = decoded
    .map((chunk) => chunk.prefix)
    .sort((a, b) => a.first - b.first);
  const suffixChunks = decoded
    .map((chunk) => chunk.suffix)
    .sort((a, b) => a.first - b.first);

  const contiguous = (parts: readonly Chunk[]): number => {
    let next = 0;
    for (const part of parts) {
      if (part.first !== next) {
        throw new Error("Bang string store has a gap");
      }
      next += part.count;
    }
    return next;
  };
  const prefixCount = contiguous(prefixChunks);
  const suffixCount = contiguous(suffixChunks);

  const decoder = new TextDecoder();
  const prefixCache = new Array<string | undefined>(prefixCount);
  const suffixCache = new Array<string | undefined>(suffixCount);

  const locate = (parts: readonly Chunk[], id: number): Chunk => {
    for (let i = parts.length - 1; i >= 0; i--) {
      if (id >= parts[i].first) {
        return parts[i];
      }
    }
    throw new Error(`Bang string id out of range: ${id}`);
  };

  return {
    epoch,
    prefix(id) {
      let value = prefixCache[id];
      if (value === undefined) {
        const chunk = locate(prefixChunks, id);
        const head = chunk.lengths[id - chunk.first] >>> PREFIX_HEAD_SHIFT;
        value =
          PREFIX_HEADS[head] + readFrom(chunk, id, decoder, PREFIX_LENGTH_MASK);
        prefixCache[id] = value;
      }
      return value;
    },
    prefixCount,
    suffix(id) {
      let value = suffixCache[id];
      if (value === undefined) {
        value = readFrom(locate(suffixChunks, id), id, decoder, 0xffff);
        suffixCache[id] = value;
      }
      return value;
    },
    suffixCount,
  };
}
