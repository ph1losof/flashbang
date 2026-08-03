import {
  bangShardPackAssetPath,
  binaryShardPackShardCount,
  materializeBinaryShard,
  parseBangShardPath,
} from "../shared/bang-shard-pack";
import { createBangShardResponse } from "./bang-shard";

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

export async function handleCloudflareBangShard({
  env,
  request,
  waitUntil,
}: CloudflareBangShardContext): Promise<Response> {
  const requested = parseBangShardPath(new URL(request.url).pathname);
  if (!requested) {
    return textResponse("Not found", 404);
  }

  const cache = defaultEdgeCache();
  const cacheKey = new Request(request.url);
  const cached = await cache?.match(cacheKey);
  if (cached) {
    const response = new Response(cached.body, cached);
    response.headers.set("X-Flashbang-Shard-Cache", "hit");
    return response;
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
      materializeBinaryShard(pack, requested.shardId),
      false,
      [["X-Flashbang-Shard-Cache", "miss"]]
    );
    if (cache) {
      waitUntil(cache.put(cacheKey, response.clone()));
    }
    return response;
  } catch (error) {
    console.error("Unable to materialize bang shard", error);
    return textResponse("Invalid bang shard pack", 500);
  }
}
