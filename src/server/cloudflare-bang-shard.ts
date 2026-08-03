import {
  bangShardPackAssetPath,
  binaryShardPackShardCount,
  materializeBinaryShard,
  parseBangShardPath,
} from "../shared/bang-shard-pack";
import {
  type BangShardContentEncoding,
  createBangShardResponse,
  preferredBangShardContentEncoding,
} from "./bang-shard";

interface AssetFetcher {
  fetch(input: Request): Promise<Response>;
}

interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface CloudflareBangShardContext {
  env: { ASSETS: AssetFetcher };
  request: Request;
  waitUntil(promise: Promise<unknown>): void;
}

function defaultEdgeCache(): EdgeCache | undefined {
  return (
    globalThis as typeof globalThis & {
      caches?: { default?: EdgeCache };
    }
  ).caches?.default;
}

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "Cache-Control": "no-store", "Content-Type": "text/plain" },
  });
}

interface WorkersResponseInit extends ResponseInit {
  encodeBody: "automatic" | "manual";
}

function encodeForClient(
  response: Response,
  encoding: BangShardContentEncoding | null,
  cacheStatus: "hit" | "miss"
): Response {
  const headers = new Headers(response.headers);
  headers.delete("Content-Length");
  headers.set("X-Flashbang-Shard-Cache", cacheStatus);
  if (encoding) {
    headers.set("Content-Encoding", encoding);
  } else {
    headers.delete("Content-Encoding");
  }
  const body =
    encoding === "gzip" && response.body
      ? response.body.pipeThrough(new CompressionStream("gzip"))
      : response.body;
  return new Response(body, {
    headers,
    encodeBody: encoding === "gzip" ? "manual" : "automatic",
  } as WorkersResponseInit);
}

export async function handleCloudflareBangShard({
  env,
  request,
  waitUntil,
}: CloudflareBangShardContext): Promise<Response> {
  const requested = parseBangShardPath(new URL(request.url).pathname);
  if (!requested) {
    return textResponse("Not found", 404);
  }
  const encoding = preferredBangShardContentEncoding(
    request.headers.get("Accept-Encoding")
  );

  const cache = defaultEdgeCache();
  const cacheKey = new Request(request.url);
  const cached = await cache?.match(cacheKey);
  if (cached) {
    return encodeForClient(cached, encoding, "hit");
  }

  const packUrl = new URL(
    bangShardPackAssetPath(requested.version),
    request.url
  );
  const packResponse = await env.ASSETS.fetch(
    new Request(packUrl, { headers: { "Accept-Encoding": "identity" } })
  );
  if (!packResponse.ok) {
    return textResponse("Not found", 404);
  }

  try {
    const pack = new Uint8Array(await packResponse.arrayBuffer());
    if (requested.shardId >= binaryShardPackShardCount(pack)) {
      return textResponse("Not found", 404);
    }
    const response = createBangShardResponse(
      materializeBinaryShard(pack, requested.shardId)
    );
    if (cache) {
      waitUntil(cache.put(cacheKey, response.clone()));
    }
    return encodeForClient(response, encoding, "miss");
  } catch (error) {
    console.error("Unable to materialize bang shard", error);
    return textResponse("Invalid bang shard pack", 500);
  }
}
