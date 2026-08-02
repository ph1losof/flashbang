// The measured size/latency knee for the current packed catalog. This is
// deliberately data-specific and need not be a power of two.
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
