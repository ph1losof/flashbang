export const BANG_SHARD_CACHE_CONTROL = "public, max-age=31536000, immutable";

export type BangShardContentEncoding = "br";

function contentEncodingQuality(
  header: string | null,
  target: BangShardContentEncoding
): number {
  if (!header) {
    return 0;
  }
  let explicitQuality: number | undefined;
  let wildcardQuality: number | undefined;
  for (const item of header.split(",")) {
    const [rawCoding, ...parameters] = item.split(";");
    const coding = rawCoding.trim().toLowerCase();
    let quality = 1;
    for (const parameter of parameters) {
      const [rawName, rawValue] = parameter.split("=", 2);
      if (rawName.trim().toLowerCase() === "q") {
        const parsed = Number(rawValue?.trim());
        quality =
          Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
      }
    }
    if (coding === target) {
      explicitQuality = Math.max(explicitQuality ?? 0, quality);
    } else if (coding === "*") {
      wildcardQuality = Math.max(wildcardQuality ?? 0, quality);
    }
  }
  return explicitQuality ?? wildcardQuality ?? 0;
}

export function acceptsBangShardContentEncoding(
  header: string | null,
  target: BangShardContentEncoding
): boolean {
  return contentEncodingQuality(header, target) > 0;
}

export function createBangShardResponse(
  bytes: Uint8Array,
  encoding: BangShardContentEncoding | null = null,
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
  if (encoding) {
    headers.set("Content-Encoding", encoding);
  }
  const body = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  return new Response(body, { headers });
}
