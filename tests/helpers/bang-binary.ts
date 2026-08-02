export const BANG_BINARY_MAGIC = 0x31424246;
export const BANG_BINARY_VERSION = 9;
export const BANG_BINARY_HEADER_WORDS = 13;

export const BANG_META_MAGIC = 0x314d4246;
export const BANG_META_VERSION = 1;
export const BANG_META_HEADER_WORDS = 6;

const U32_BYTES = Uint32Array.BYTES_PER_ELEMENT;

function alignTo(offset: number, alignment: number): number {
  return (offset + alignment - 1) & ~(alignment - 1);
}

export function bangBinaryNumericEnd(header: Uint32Array): number {
  return (
    bangBinaryCheckpointOffset(header) +
    (Math.ceil(header[5] / 16) + Math.ceil(header[6] / 16)) * U32_BYTES
  );
}

export function bangBinaryCheckpointOffset(header: Uint32Array): number {
  let offset = BANG_BINARY_HEADER_WORDS * U32_BYTES;
  offset += header[3] * header[12] + header[2] * header[4];
  offset = alignTo(offset, 2);
  offset += (header[5] + header[6] + header[2] * 2) * 2;
  return alignTo(offset, 4);
}

export function bangBinaryFingerprintOffset(header: Uint32Array): number {
  return BANG_BINARY_HEADER_WORDS * U32_BYTES + header[3] * header[12];
}

export function bangBinaryFingerprints(
  binary: ArrayBuffer,
  header: Uint32Array
): Uint16Array {
  return new Uint16Array(
    binary,
    bangBinaryFingerprintOffset(header),
    header[2]
  );
}
