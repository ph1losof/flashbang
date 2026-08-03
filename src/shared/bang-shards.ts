// The measured size/latency knee for the current packed catalog. Data-specific;
// need not be a power of two. 64 would cut the cold shard ~30% and a daily delta
// ~33% at no cost in index bytes, but every shard is fetched after the first
// redirect for offline coverage, so 43 buys 21 fewer requests instead.
export const BANG_SHARD_COUNT = 43;
export const BANG_SHARD_ROUTER_SIZE = 256;

export function bangShardCell(hash: number): number {
  return (hash >>> 8) & (BANG_SHARD_ROUTER_SIZE - 1);
}

export function bangShardIndex(
  hash: number,
  router: ArrayLike<number>
): number {
  return router[bangShardCell(hash)];
}

export function extractBangShardTriggers(
  query: string,
  bangMarker = "!",
  snapMarker = "@"
): string[] {
  const tokens = query.trim().toLowerCase().split(/\s+/);
  const bangTriggers: string[] = [];
  const snapTriggers: string[] = [];
  const endpoints =
    tokens.length === 1 ? [tokens[0]] : [tokens[0], tokens.at(-1)];
  for (const token of endpoints) {
    if (!token) {
      continue;
    }
    if (token.startsWith(bangMarker)) {
      const trigger = token.substring(bangMarker.length);
      if (trigger) {
        bangTriggers.push(trigger);
      }
    } else if (token.endsWith(bangMarker)) {
      const trigger = token.substring(0, token.length - bangMarker.length);
      if (trigger) {
        bangTriggers.push(trigger);
      }
    } else if (token.startsWith(snapMarker)) {
      for (const trigger of token.substring(snapMarker.length).split(",")) {
        if (trigger) {
          snapTriggers.push(trigger);
        }
      }
    }
  }
  return [...new Set(bangTriggers.length > 0 ? bangTriggers : snapTriggers)];
}
