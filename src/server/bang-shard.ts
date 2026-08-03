export const BANG_SHARD_CACHE_CONTROL = "public, max-age=31536000, immutable";

export function createBangShardResponse(
  bytes: Uint8Array,
  brotli = false,
  extraHeaders: readonly (readonly [string, string])[] = []
): Response {
  const headers = new Headers();
  for (const [key, value] of extraHeaders) {
    headers.set(key, value);
  }
  headers.set("Cache-Control", BANG_SHARD_CACHE_CONTROL);
  headers.set("Content-Type", "application/octet-stream");
  headers.set("Vary", "Accept-Encoding");
  headers.set("X-Content-Type-Options", "nosniff");
  if (brotli) {
    headers.set("Content-Encoding", "br");
  }
  const body = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  return new Response(body, { headers });
}
