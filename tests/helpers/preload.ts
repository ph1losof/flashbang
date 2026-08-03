import { generateBinaryShards } from "../../scripts/codegen";

const bangs: Parameters<typeof generateBinaryShards>[0] =
  await Bun.file("data/bangs.json").json();
const generated = generateBinaryShards(bangs);

export const TEST_BANG_SHARDS = generated.shards;

const globals = globalThis as unknown as Record<string, unknown>;
globals.__BANG_SHARD_ROUTER__ = Array.from(generated.router);
globals.__BANG_SHARD_VERSION__ = "test";
