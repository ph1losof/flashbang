const MAGIC = 0x314d4246;
const VERSION = 1;
const HEADER_WORDS = 6;
const HEADER_BYTES = HEADER_WORDS * Uint32Array.BYTES_PER_ELEMENT;

export type BangMetaVisitor = (
  trigger: string,
  name: string,
  domain: string,
  capture: boolean,
  index: number
) => void;

export function readBangMeta(
  buffer: ArrayBuffer,
  visit: BangMetaVisitor
): void {
  if (buffer.byteLength < HEADER_BYTES) {
    throw new Error("Truncated bang metadata");
  }
  const header = new Uint32Array(buffer, 0, HEADER_WORDS);
  if (header[0] !== MAGIC || header[1] !== VERSION) {
    throw new Error("Unsupported bang metadata");
  }
  if (header[5] !== buffer.byteLength) {
    throw new Error("Truncated bang metadata");
  }

  const entryCount = header[2];
  const captureCount = header[3];
  const payloadOffset = header[4];
  const expectedPayloadOffset =
    HEADER_BYTES + captureCount * Uint32Array.BYTES_PER_ELEMENT;
  if (
    payloadOffset !== expectedPayloadOffset ||
    payloadOffset > buffer.byteLength
  ) {
    throw new Error("Invalid bang metadata layout");
  }

  const captureIndexes = new Uint32Array(buffer, HEADER_BYTES, captureCount);
  let previousCapture = -1;
  for (const index of captureIndexes) {
    if (index <= previousCapture || index >= entryCount) {
      throw new Error("Invalid bang metadata capture indexes");
    }
    previousCapture = index;
  }

  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    new Uint8Array(buffer, payloadOffset)
  );
  let cursor = 0;
  let captureOffset = 0;

  function readField(): string {
    const end = text.indexOf("\0", cursor);
    if (end === -1) {
      throw new Error("Invalid bang metadata fields");
    }
    const value = text.substring(cursor, end);
    cursor = end + 1;
    return value;
  }

  for (let index = 0; index < entryCount; index++) {
    const capture = captureIndexes[captureOffset] === index;
    if (capture) {
      captureOffset++;
    }
    visit(readField(), readField(), readField(), capture, index);
  }
  if (cursor !== text.length || captureOffset !== captureIndexes.length) {
    throw new Error("Invalid bang metadata fields");
  }
}
