export const BANG_SHARD_COUNT = 16;

export function bangShardIndex(hash: number): number {
  return (hash >>> 8) & (BANG_SHARD_COUNT - 1);
}
