import { bangShardEndpointPath } from "../src/shared/bang-shard-pack";
import { BANG_SHARD_COUNT } from "../src/shared/bang-shards";

interface Sample {
  cache: string;
  encoding: string;
  milliseconds: number;
  transferredBytes: number | null;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
  ];
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got ${value}`);
  }
  return parsed;
}

async function measure(url: string): Promise<Sample> {
  const started = performance.now();
  const response = await fetch(url, {
    headers: { "Accept-Encoding": "br, gzip" },
  });
  const body = await response.arrayBuffer();
  const milliseconds = performance.now() - started;
  if (!response.ok) {
    throw new Error(
      `${response.status} from ${url}: ${new TextDecoder().decode(body)}`
    );
  }
  if (response.headers.get("Content-Type") !== "application/octet-stream") {
    throw new Error(`Unexpected content type from ${url}`);
  }
  const contentLength = response.headers.get("Content-Length");
  return {
    cache:
      response.headers.get("X-Flashbang-Shard-Cache") ??
      response.headers.get("CF-Cache-Status") ??
      "unknown",
    encoding: response.headers.get("Content-Encoding") ?? "identity",
    milliseconds,
    transferredBytes: contentLength === null ? null : Number(contentLength),
  };
}

function summarize(label: string, samples: readonly Sample[]): void {
  const durations = samples.map(({ milliseconds }) => milliseconds);
  const transferred = samples
    .map(({ transferredBytes }) => transferredBytes)
    .filter((value): value is number => value !== null);
  const cacheCounts = new Map<string, number>();
  const encodingCounts = new Map<string, number>();
  for (const { cache } of samples) {
    cacheCounts.set(cache, (cacheCounts.get(cache) ?? 0) + 1);
  }
  for (const { encoding } of samples) {
    encodingCounts.set(encoding, (encodingCounts.get(encoding) ?? 0) + 1);
  }
  const cache = [...cacheCounts]
    .map(([status, count]) => `${status}=${count}`)
    .join(", ");
  const encodings = [...encodingCounts]
    .map(([encoding, count]) => `${encoding}=${count}`)
    .join(", ");
  const bytes = transferred.length
    ? `${Math.round(transferred.reduce((sum, value) => sum + value, 0) / transferred.length)} B avg`
    : "transfer size unavailable";
  console.log(
    `${label}: p50=${percentile(durations, 0.5).toFixed(2)} ms, p95=${percentile(durations, 0.95).toFixed(2)} ms, ${bytes}, encoding ${encodings}, cache ${cache}`
  );
}

async function main(): Promise<void> {
  const [rawOrigin, version, rawRounds] = process.argv.slice(2);
  if (!(rawOrigin && /^[a-f0-9]{12}$/.test(version ?? ""))) {
    console.error(
      "Usage: bun run benchmark:shards -- <origin> <12-hex-version> [rounds]"
    );
    process.exit(1);
  }
  const origin = new URL(rawOrigin).origin;
  const rounds = parsePositiveInteger(rawRounds, 5);
  const urls = Array.from(
    { length: BANG_SHARD_COUNT },
    (_, shard) => `${origin}${bangShardEndpointPath(version, shard)}`
  );

  console.log(`Benchmarking ${urls.length} shards at ${origin}`);
  const firstPass: Sample[] = [];
  for (const url of urls) {
    firstPass.push(await measure(url));
  }
  summarize("First pass", firstPass);

  const cached: Sample[] = [];
  for (let round = 0; round < rounds; round++) {
    for (const url of urls) {
      cached.push(await measure(url));
    }
  }
  summarize(`${rounds} cached passes`, cached);
}

if (import.meta.main) {
  await main();
}
