import {
  ensureGeneratedBangData,
  generateBinaryShards,
} from "../../scripts/codegen";

// Several suites read `src/generated/` straight from disk while the rest build
// their fixtures from `data/bangs.json`. When the two disagree — after a pull
// that updated the bang data, say — those suites fail on catalog contents
// rather than on anything the change touched, so regenerate first.
await ensureGeneratedBangData();

const bangs: Parameters<typeof generateBinaryShards>[0] =
  await Bun.file("data/bangs.json").json();
const generated = generateBinaryShards(bangs);

export const TEST_BANG_SHARDS = generated.shards;

const globals = globalThis as unknown as Record<string, unknown>;
globals.__BANG_SHARD_ROUTER__ = Array.from(generated.router);
globals.__BANG_SHARD_ASSETS__ = generated.shards.map(
  (_, shard) => `/bangs-s${shard.toString(36)}-test.bin`
);
