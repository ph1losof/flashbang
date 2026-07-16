import { mkdir } from "node:fs/promises";
import { cpus } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { compileCaptureUrl } from "../src/shared/capture-template";
import { readPathname } from "../src/shared/raw-url";
import { compileSnapTarget } from "../src/shared/snap-target";
import {
  EDGE_CHILD_INDEX,
  EDGE_STRIDE,
  NODE_EDGE_COUNT,
  NODE_EDGE_START,
  NODE_MAX_RELEVANCE,
  NODE_STRIDE,
  NODE_TERMINAL_INDEX,
} from "../src/suggest-bang";
import type { RedirectSettings } from "../src/sw/redirect";
import { ensureGeneratedBangData, GENERATED_BANG_DATA_FILES } from "./codegen";

const [binaryPath, sparsePath, metaPath, triePath] = GENERATED_BANG_DATA_FILES;

interface ProfileOptions {
  quick: boolean;
  runs?: number;
  save?: string;
  compare?: string;
  thresholdPct: number;
  failOnRegression: boolean;
}

type MetricCategory =
  | "Cold start"
  | "Per redirect"
  | "Per suggest"
  | "Per request"
  | "Per message";

interface ProfileMetric {
  id: string;
  label: string;
  category: MetricCategory;
  unit: "ns";
  p50: number;
  p90?: number;
  p99?: number;
  min?: number;
  max?: number;
  mean?: number;
  cvPct?: number;
}

interface ProfileReport {
  schemaVersion: 1;
  generatedAt: string;
  environment: {
    bun: string;
    platform: string;
    arch: string;
    cpu: string;
    gitCommit: string | null;
    gitDirty: boolean | null;
  };
  config: {
    quick: boolean;
    runs: number;
    coldRuns: number;
  };
  metrics: ProfileMetric[];
}

function printHelp(): void {
  console.log(`
Usage: bun run profile [options]

Options:
  --quick                  Run roughly 10% of the normal iterations
  --runs <count>           Override the number of measured runs
  --save <name|path>       Save a structured JSON report
  --compare <name|path>    Compare against a saved JSON report
  --threshold <percent>    Regression threshold (default: 5)
  --fail-on-regression     Exit non-zero for stable regressions
  -h, --help               Show this help

Bare report names resolve to profiles/baselines/<name>.json.

Examples:
  bun run profile --quick
  bun run profile --save main
  bun run profile --compare main --fail-on-regression
`);
}

function parsePositiveNumber(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!(value && Number.isFinite(parsed)) || parsed <= 0) {
    throw new Error(`${flag} requires a positive number`);
  }
  return parsed;
}

function parseOptions(args: string[]): ProfileOptions {
  const options: ProfileOptions = {
    quick: false,
    thresholdPct: 5,
    failOnRegression: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i++];
    if (arg === "--quick") {
      options.quick = true;
    } else if (arg === "--runs") {
      options.runs = Math.floor(parsePositiveNumber(args[i++], arg));
    } else if (arg === "--save") {
      options.save = args[i++];
      if (!options.save) {
        throw new Error(`${arg} requires a report name or path`);
      }
    } else if (arg === "--compare") {
      options.compare = args[i++];
      if (!options.compare) {
        throw new Error(`${arg} requires a report name or path`);
      }
    } else if (arg === "--threshold") {
      options.thresholdPct = parsePositiveNumber(args[i++], arg);
    } else if (arg === "--fail-on-regression") {
      options.failOnRegression = true;
    } else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown profile option: ${arg}`);
    }
  }

  if (options.runs !== undefined && options.runs < 3) {
    throw new Error("--runs must be at least 3");
  }
  if (options.failOnRegression && !options.compare) {
    throw new Error("--fail-on-regression requires --compare");
  }
  return options;
}

function resolveReportPath(value: string): string {
  if (isAbsolute(value) || value.includes("/") || value.includes("\\")) {
    return resolve(value);
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error(`Invalid report name: ${value}`);
  }
  const fileName = value.endsWith(".json") ? value : `${value}.json`;
  return join(process.cwd(), "profiles", "baselines", fileName);
}

function isProfileReport(value: unknown): value is ProfileReport {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<ProfileReport>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.environment === "object" &&
    candidate.environment !== null &&
    typeof candidate.config === "object" &&
    candidate.config !== null &&
    Array.isArray(candidate.metrics) &&
    candidate.metrics.every(
      (metric) =>
        typeof metric?.id === "string" &&
        typeof metric.label === "string" &&
        Number.isFinite(metric.p50)
    )
  );
}

async function readProfileReport(path: string): Promise<ProfileReport> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`Profile report not found: ${path}`);
  }
  const report: unknown = await file.json();
  if (!isProfileReport(report)) {
    throw new Error(`Unsupported profile report: ${path}`);
  }
  return report;
}

const profileOptions = parseOptions(process.argv.slice(2));
const baselinePath = profileOptions.compare
  ? resolveReportPath(profileOptions.compare)
  : undefined;
const baselineReport = baselinePath
  ? await readProfileReport(baselinePath)
  : undefined;

function mean(arr: number[]): number {
  if (arr.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const n of arr) {
    sum += n;
  }
  return sum / arr.length;
}

function pct(sorted: number[], p: number): number {
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) {
    return sorted[lo];
  }
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

interface RunStats {
  p50: number;
  p90: number;
  p99: number;
  min: number;
  max: number;
  mean: number;
  cvPct: number;
}

function summarizeRuns(arr: number[]): RunStats {
  const avg = mean(arr);
  let variance = 0;
  for (const n of arr) {
    const d = n - avg;
    variance += d * d;
  }
  const stdev = arr.length > 0 ? Math.sqrt(variance / arr.length) : 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  return {
    p50: pct(sorted, 0.5),
    p90: pct(sorted, 0.9),
    p99: pct(sorted, 0.99),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    mean: avg,
    cvPct: avg > 0 ? (stdev / avg) * 100 : 0,
  };
}

function fmt(ns: number): string {
  if (ns < 1_000) {
    return `${ns.toFixed(0)}ns`;
  }
  if (ns < 1_000_000) {
    return `${(ns / 1_000).toFixed(2)}µs`;
  }
  return `${(ns / 1_000_000).toFixed(2)}ms`;
}

function fmtBytes(b: number): string {
  if (b < 1024) {
    return `${b}B`;
  }
  if (b < 1024 * 1024) {
    return `${(b / 1024).toFixed(1)}KB`;
  }
  return `${(b / (1024 * 1024)).toFixed(2)}MB`;
}

function fmtBytesExact(b: number): string {
  return `${fmtBytes(b)} (${b.toLocaleString()}B)`;
}

const useColor = Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
const terminalWidth = Math.min(96, Math.max(72, process.stdout.columns ?? 80));

function ansi(code: number, value: string): string {
  return useColor ? `\u001B[${code}m${value}\u001B[0m` : value;
}

const color = {
  bold: (value: string) => ansi(1, value),
  dim: (value: string) => ansi(2, value),
  cyan: (value: string) => ansi(36, value),
  green: (value: string) => ansi(32, value),
  yellow: (value: string) => ansi(33, value),
  magenta: (value: string) => ansi(35, value),
  red: (value: string) => ansi(31, value),
};

function colorCv(value: number): string {
  const formatted = `${value.toFixed(1)}%`;
  if (value <= 5) {
    return color.green(formatted);
  }
  if (value <= 10) {
    return color.yellow(formatted);
  }
  return color.red(formatted);
}

function printBanner(): void {
  const title = "FLASHBANG PERFORMANCE LAB";
  const mode = profileOptions.quick ? "  •  quick mode" : "";
  const detail = `Bun ${Bun.version}  •  ${process.platform}/${process.arch}  •  ${RUNS} measured runs${mode}`;
  const rule = "─".repeat(terminalWidth - 2);
  console.log(color.cyan(`\n╭${rule}╮`));
  console.log(
    `${color.cyan("│")} ${color.bold(title.padEnd(terminalWidth - 4))} ${color.cyan("│")}`
  );
  console.log(
    `${color.cyan("│")} ${color.dim(detail.padEnd(terminalWidth - 4))} ${color.cyan("│")}`
  );
  console.log(color.cyan(`╰${rule}╯`));
}

function separator(title: string) {
  const label = ` ${title} `;
  const rule = "─".repeat(Math.max(1, terminalWidth - label.length - 2));
  console.log(color.cyan(`\n┌─${color.bold(label)}${rule}`));
}

const RUNS = profileOptions.runs ?? (profileOptions.quick ? 4 : 12);
const COLD_RUNS = profileOptions.quick ? 3 : 5;

function iterations(normal: number): number {
  return profileOptions.quick
    ? Math.max(1_000, Math.ceil(normal / 10))
    : normal;
}

function bench(
  iters: number,
  fn: (i: number, run: number) => void,
  warmup = 10_000
): RunStats {
  const warmupIterations = profileOptions.quick
    ? Math.min(warmup, 2_000)
    : warmup;
  for (let i = 0; i < warmupIterations; i++) {
    fn(i, -1);
  }
  const times: number[] = [];
  for (let run = 0; run < RUNS; run++) {
    const t0 = Bun.nanoseconds();
    for (let i = 0; i < iters; i++) {
      fn(i, run);
    }
    times.push((Bun.nanoseconds() - t0) / iters);
  }
  return summarizeRuns(times);
}

function benchTable<T extends { label: string }>(
  items: T[],
  iters: number,
  fn: (item: T, i: number, run: number) => void,
  labelWidth = 24
): Map<string, RunStats> {
  const results = new Map<string, RunStats>();
  for (const item of items) {
    const stats = bench(iters, (i, run) => fn(item, i, run));
    results.set(item.label, stats);
    console.log(
      `  ${item.label.padEnd(labelWidth)} ${color.green(fmt(stats.p50).padStart(10))} ${fmt(stats.p90).padStart(10)} ${fmt(stats.p99).padStart(10)} ${colorCv(stats.cvPct).padStart(useColor ? 17 : 8)}`
    );
  }
  return results;
}

function benchTableHeader(label: string, labelWidth: number): void {
  console.log(
    color.dim(
      `  ${label.padEnd(labelWidth)} ${"p50".padStart(10)} ${"p90".padStart(10)} ${"p99".padStart(10)} ${"CV".padStart(8)}`
    )
  );
  console.log(color.dim(`  ${"─".repeat(labelWidth + 42)}`));
}

let sink = 0;

import { hashFNV1a as fnvHash } from "../src/shared/hash";

await ensureGeneratedBangData(true);
const { initializeBangData, lookupBang } = await import("../src/sw/bang-data");
initializeBangData(await Bun.file("src/generated/bangs.bin").arrayBuffer());

const [
  { BANG_COUNT },
  { EDGES, NODES, ROOT, TERM_K_BLOB, TERM_K_OFF },
  { handleSuggestRequest },
  {
    bangSuggestions,
    profileTopKCount,
    profileWalkPrefix,
    responseFromCandidates,
  },
  { parseCookie, parseSettingsFromRawUrl },
  { buildTopFrecency, updateTopFrecencyOnIncrement },
  { readQueryParam, readTwoQueryParams },
  { BANGS },
] = await Promise.all([
  import("../src/generated/bangs-sparse.js"),
  import("../src/generated/bangs-trie.js"),
  import("../src/server/handlers"),
  import("../src/suggest-bang"),
  import("../src/suggest"),
  import("../src/sw/frecency"),
  import("../src/shared/raw-query"),
  import("../src/generated/bangs-meta.js"),
]);

function terminalIndexFor(trigger: string): number {
  for (let i = 0; i < TERM_K_OFF.length - 1; i++) {
    if (TERM_K_BLOB.slice(TERM_K_OFF[i], TERM_K_OFF[i + 1]) === trigger) {
      return i;
    }
  }
  throw new Error(`Missing terminal index in profile data for !${trigger}`);
}

function countTerminals(node: number): number {
  const nodeOff = node * NODE_STRIDE;
  let c = NODES[nodeOff + NODE_TERMINAL_INDEX] >= 0 ? 1 : 0;
  const edgeStart = NODES[nodeOff + NODE_EDGE_START];
  const edgeCount = NODES[nodeOff + NODE_EDGE_COUNT];
  for (let i = 0; i < edgeCount; i++) {
    const edgeOff = (edgeStart + i) * EDGE_STRIDE;
    c += countTerminals(EDGES[edgeOff + EDGE_CHILD_INDEX]);
  }
  return c;
}

printBanner();
console.log(
  color.dim(
    "  Method: per-iteration means; percentiles and CV are run-level. Low single-digit ns results are directional."
  )
);

separator("1. DATA SIZE & STRUCTURE ANALYSIS");

const metaBytes = Bun.file(metaPath).size;
const trieBytes = Bun.file(triePath).size;
const binaryBytes = Bun.file(binaryPath).size;
const sparseBytes = Bun.file(sparsePath).size;
const totalGeneratedBytes = binaryBytes + sparseBytes + metaBytes + trieBytes;

console.log(`\nBang count: ${BANG_COUNT.toLocaleString()}`);
console.log(
  `bangs.bin:       ${fmtBytesExact(binaryBytes)}  (trigger→URL parts, used by SW)`
);
console.log(
  `bangs-sparse.js: ${fmtBytesExact(sparseBytes)}  (advanced bangs + snap overrides, used by SW)`
);
console.log(
  `bangs-meta.js: ${fmtBytesExact(metaBytes)}  (packed catalog metadata, used by UI)`
);

const trieFile = await Bun.file(triePath).text();
console.log(
  `bangs-trie.js: ${fmtBytesExact(trieBytes)}  (radix trie, used by suggest)`
);
console.log(`Production generated: ${fmtBytesExact(totalGeneratedBytes)}`);
console.log(
  `Avg bytes per bang: ${Math.round(totalGeneratedBytes / BANG_COUNT).toLocaleString()}B`
);

separator("2. TRIE STRUCTURE ANALYSIS");

function trieStats(root: number): {
  nodes: number;
  terminals: number;
  edges: number;
  maxDepth: number;
} {
  const nodeCount = Math.floor(NODES.length / NODE_STRIDE);
  let terminals = 0;
  let maxDepth = 0;

  for (let i = 0; i < nodeCount; i++) {
    if (NODES[i * NODE_STRIDE + NODE_TERMINAL_INDEX] >= 0) {
      terminals++;
    }
  }

  function walkDepth(node: number, depth: number) {
    if (depth > maxDepth) {
      maxDepth = depth;
    }
    const nodeOff = node * NODE_STRIDE;
    const edgeStart = NODES[nodeOff + NODE_EDGE_START];
    const edgeCount = NODES[nodeOff + NODE_EDGE_COUNT];
    for (let i = 0; i < edgeCount; i++) {
      const edgeOff = (edgeStart + i) * EDGE_STRIDE;
      walkDepth(EDGES[edgeOff + EDGE_CHILD_INDEX], depth + 1);
    }
  }

  walkDepth(root, 0);

  return {
    nodes: nodeCount,
    terminals,
    edges: Math.floor(EDGES.length / EDGE_STRIDE),
    maxDepth,
  };
}

const ts = trieStats(ROOT);
console.log("\nFlat radix trie structure:");
console.log(`  Nodes:     ${ts.nodes.toLocaleString()}`);
console.log(`  Terminals: ${ts.terminals.toLocaleString()}`);
console.log(`  Edges:     ${ts.edges.toLocaleString()}`);
console.log(`  Max depth: ${ts.maxDepth}`);
console.log(`  Root children: ${NODES[ROOT * NODE_STRIDE + NODE_EDGE_COUNT]}`);
console.log(
  `  Max relevance: ${NODES[ROOT * NODE_STRIDE + NODE_MAX_RELEVANCE]}`
);

separator("3. BANG LOOKUP PERFORMANCE");

const sampleHits = ["g", "gh", "yt", "w", "a", "ddg", "so", "mdn", "npm"];
const sampleMisses = [
  "zzzzz",
  "notabang",
  "xyz123",
  "fakebang",
  "qqqq",
  "!!!!!",
];
const allSamples = [...sampleHits, ...sampleMisses];

const LOOKUP_ITERS = iterations(1_000_000);

const lookupBaselineStats = bench(LOOKUP_ITERS, (i, run) => {
  const offset = run === -1 ? 0 : run;
  sink += allSamples[(i + offset) % allSamples.length].length;
});

const lookupStats = bench(LOOKUP_ITERS, (i, run) => {
  const offset = run === -1 ? 0 : run;
  const t = allSamples[(i + offset) % allSamples.length];
  if (lookupBang(t, fnvHash(t))) {
    sink++;
  }
});

const lookupNetMedian = Math.max(0, lookupStats.p50 - lookupBaselineStats.p50);

console.log("\nPacked lookup (lookupBang):");
console.log(`  ${LOOKUP_ITERS.toLocaleString()} iterations × ${RUNS} runs`);
console.log(`  Median (raw):      ${fmt(lookupStats.p50)}/lookup`);
console.log(`  p90 (run):         ${fmt(lookupStats.p90)}/lookup`);
console.log(`  Loop baseline:     ${fmt(lookupBaselineStats.p50)}/iter`);
console.log(`  Estimated lookup:  ${fmt(lookupNetMedian)}/lookup`);
console.log(
  `  Run spread:        ${fmt(lookupStats.min)}..${fmt(lookupStats.max)} (cv ${lookupStats.cvPct.toFixed(1)}%)`
);

separator("3b. BANG LOOKUP — COLD VS WARM PATH");

const allTriggers = new Array<string>(BANGS.length / 3);
for (let i = 0, triggerIndex = 0; i < BANGS.length; i += 3, triggerIndex++) {
  allTriggers[triggerIndex] = BANGS[i];
}

const coldT0 = Bun.nanoseconds();
for (const tr of allTriggers) {
  lookupBang(tr, fnvHash(tr));
}
const coldNsPerLookup = (Bun.nanoseconds() - coldT0) / allTriggers.length;

const warmTimes: number[] = [];
for (let run = 0; run < RUNS; run++) {
  const t0 = Bun.nanoseconds();
  for (const tr of allTriggers) {
    lookupBang(tr, fnvHash(tr));
  }
  warmTimes.push((Bun.nanoseconds() - t0) / allTriggers.length);
}
const warmRunStats = summarizeRuns(warmTimes);

console.log(
  `\nAll-triggers cold/warm (${allTriggers.length.toLocaleString()} triggers):`
);
console.log(`  Cold pass (1×):    ${fmt(coldNsPerLookup)}/lookup`);
console.log(`  Warm p50 (${RUNS}×):  ${fmt(warmRunStats.p50)}/lookup`);
console.log(`  Warm p90:          ${fmt(warmRunStats.p90)}/lookup`);
console.log(
  `  Cold/warm ratio:   ${(coldNsPerLookup / warmRunStats.p50).toFixed(1)}×`
);
console.log(
  `  Run spread:        ${fmt(warmRunStats.min)}..${fmt(warmRunStats.max)} (cv ${warmRunStats.cvPct.toFixed(1)}%)`
);

separator("4. TRIE-BASED SUGGESTION PERFORMANCE");

const suggestPartials = ["g", "gh", "gi", "yt", "a", "s"];
const SUGGEST_ITERS = iterations(100_000);
const SUGGEST_PREFIX_ITERS = iterations(20_000);
const emptyFrecency: Record<string, number> = Object.create(null);
const emptyCustom: string[] = [];

const trieSuggestRunStats = bench(
  SUGGEST_ITERS,
  (i) => {
    const p = suggestPartials[i % suggestPartials.length];
    void bangSuggestions(`!${p}`, "", p, emptyFrecency, emptyCustom);
  },
  1_000
);

console.log("\nbangSuggestions() pipeline (production function):");
console.log(`  ${SUGGEST_ITERS.toLocaleString()} iterations × ${RUNS} runs`);
console.log(`  Median: ${fmt(trieSuggestRunStats.p50)}/suggest`);
console.log(`  p90:    ${fmt(trieSuggestRunStats.p90)}/suggest`);
console.log(`  p99:    ${fmt(trieSuggestRunStats.p99)}/suggest`);
console.log(
  `  Spread: ${fmt(trieSuggestRunStats.min)}..${fmt(trieSuggestRunStats.max)} (cv ${trieSuggestRunStats.cvPct.toFixed(1)}%)`
);

const WALK_PREFIX_ITERS = iterations(500_000);
const TOPK_ONLY_ITERS = iterations(500_000);

const walkPrefixStats = bench(
  WALK_PREFIX_ITERS,
  (i, run) => {
    const offset = run === -1 ? 0 : run;
    const p = suggestPartials[(i + offset) % suggestPartials.length];
    const walked = profileWalkPrefix(p);
    sink += walked ? walked[0] + walked[1].length : -1;
  },
  20_000
);

const topKSubtrees = suggestPartials
  .map((p) => profileWalkPrefix(p))
  .filter((v): v is [number, string] => v !== null)
  .map((v) => v[0]);

const topKOnlyStats = bench(
  TOPK_ONLY_ITERS,
  (i, run) => {
    const offset = run === -1 ? 0 : run;
    const subtree = topKSubtrees[(i + offset) % topKSubtrees.length];
    sink += profileTopKCount(subtree, emptyFrecency, false);
  },
  20_000
);

console.log("\n  Breakdown (isolated):");
console.log(
  `    walkPrefix only: ${fmt(walkPrefixStats.p50)} median, ${fmt(walkPrefixStats.p90)} p90, ${fmt(walkPrefixStats.p99)} p99`
);
console.log(
  `    topK only:       ${fmt(topKOnlyStats.p50)} median, ${fmt(topKOnlyStats.p90)} p90, ${fmt(topKOnlyStats.p99)} p99`
);

console.log("\n  Per-prefix timings:");
for (const p of suggestPartials) {
  const prefixStats = bench(
    SUGGEST_PREFIX_ITERS,
    () => {
      void bangSuggestions(`!${p}`, "", p, emptyFrecency, emptyCustom);
    },
    1_000
  );

  const result = profileWalkPrefix(p);
  const matchCount = result ? countTerminals(result[0]) : 0;
  const payloadBytes = (
    await bangSuggestions(`!${p}`, "", p, emptyFrecency, emptyCustom).text()
  ).length;
  console.log(
    `    "${p}": ${fmt(prefixStats.p50)} median, ${fmt(prefixStats.p90)} p90 (${matchCount} subtree matches, ${payloadBytes}B payload)`
  );
}

separator("4b. SUGGEST JSON SERIALIZATION ONLY");

const serializeCandidates = [
  { trigger: "", terminalIndex: terminalIndexFor("g"), score: 1000 },
  { trigger: "", terminalIndex: terminalIndexFor("gh"), score: 500 },
  { trigger: "", terminalIndex: terminalIndexFor("yt"), score: 700 },
  { trigger: "local", terminalIndex: -1, score: 0 },
];

const SERIALIZE_ITERS = iterations(1_000_000);

const serializeStats = bench(
  SERIALIZE_ITERS,
  () => {
    sink += responseFromCandidates("cats", "", serializeCandidates).status;
  },
  20_000
);

console.log(
  `\nresponseFromCandidates() — ${SERIALIZE_ITERS.toLocaleString()} iterations × ${RUNS} runs:`
);
console.log(`  Median: ${fmt(serializeStats.p50)}/call`);
console.log(`  p90:    ${fmt(serializeStats.p90)}/call`);
console.log(`  p99:    ${fmt(serializeStats.p99)}/call`);
console.log(
  `  Spread: ${fmt(serializeStats.min)}..${fmt(serializeStats.max)} (cv ${serializeStats.cvPct.toFixed(1)}%)`
);

const derivedRest = Math.max(
  0,
  trieSuggestRunStats.p50 -
    walkPrefixStats.p50 -
    topKOnlyStats.p50 -
    serializeStats.p50
);
console.log(
  `\nDerived bangSuggestions rest: ${fmt(derivedRest)} (aggregate - walkPrefix - topK - responseFromCandidates)`
);

separator("5. FULL REDIRECT PIPELINE");

const { redirectRaw, redirectUrl } = await import("../src/sw/redirect");

const profileCaptureUrl = compileCaptureUrl(
  "https://translate.example/$1/$2",
  "(\\w+)\\s+(.*)",
  "percent"
)!;
const profileSnapTarget = compileSnapTarget("docs.example.com/reference")!;
const settings = {
  defaultUrl: ["https://www.google.com/search?q=", ""] as const,
  luckyUrl: ["https://duckduckgo.com/?q=\\", ""] as const,
  custom: {
    tw: ["https://twitter.com/", ""] as readonly [string, string | null],
    tr: profileCaptureUrl,
    docs: ["https://search.example.com?q=", "", profileSnapTarget] as const,
  },
} satisfies RedirectSettings;

const queries = [
  { label: "Prefix bang", raw: "!g+kittens" },
  { label: "Suffix bang", raw: "kittens+g!" },
  { label: "Trailing !bang", raw: "kittens+!g" },
  { label: "Prefix suffix-bang", raw: "g!+kittens" },
  { label: "No bang (default)", raw: "kittens" },
  { label: "Feeling lucky (\\)", raw: "\\kittens" },
  { label: "Bang only", raw: "!g" },
  { label: "Lucky bare (! q)", raw: "!+kittens" },
  { label: "Unknown bang", raw: "!zzzzz+cats" },
  { label: "Long query", raw: `!g+${"a".repeat(200)}` },
  { label: "Encoded spaces", raw: "!g%20kittens%20are%20cute" },
  { label: "Prefix snap", raw: "@g+kittens" },
  { label: "Suffix snap", raw: "kittens+@g" },
  { label: "Snap only", raw: "@g" },
  { label: "Unknown snap", raw: "@zzzzz+cats" },
  {
    label: "Built-in capture",
    raw: "!ktr+japanese+https%3A%2F%2Fexample.com%2Farticle",
  },
  { label: "Custom capture", raw: "!tr+japanese+hello+world" },
  { label: "Built-in ad snap", raw: "@hn+kittens" },
  { label: "Custom target snap", raw: "@docs+kittens" },
];

const REDIRECT_ITERS = iterations(500_000);

console.log(
  `\nredirectRaw() — ${REDIRECT_ITERS.toLocaleString()} iterations × ${RUNS} runs:`
);
benchTableHeader("Query type", 22);

const redirectStats = benchTable(
  queries,
  REDIRECT_ITERS,
  (q) => {
    redirectRaw(q.raw, settings);
  },
  22
);

const bangRedirect = redirectStats.get("Prefix bang");
const nonBangRedirect = redirectStats.get("No bang (default)");
const prefixSnapRedirect = redirectStats.get("Prefix snap");
const suffixSnapRedirect = redirectStats.get("Suffix snap");
const builtInCaptureRedirect = redirectStats.get("Built-in capture");
const customCaptureRedirect = redirectStats.get("Custom capture");
const builtInAdSnapRedirect = redirectStats.get("Built-in ad snap");
const customTargetSnapRedirect = redirectStats.get("Custom target snap");
if (
  !(
    bangRedirect &&
    nonBangRedirect &&
    prefixSnapRedirect &&
    suffixSnapRedirect &&
    builtInCaptureRedirect &&
    customCaptureRedirect &&
    builtInAdSnapRedirect &&
    customTargetSnapRedirect
  )
) {
  throw new Error("redirect profile samples missing expected labels");
}

const regularQueries = queries.slice(0, 15);
const redirectMixedStats = bench(REDIRECT_ITERS, (i, run) => {
  const offset = run === -1 ? 0 : run;
  redirectRaw(
    regularQueries[(i + offset) % regularQueries.length].raw,
    settings
  );
});

console.log(
  `\nMixed regular workload (${regularQueries.length} query shapes): ${fmt(redirectMixedStats.p50)} median, ${fmt(redirectMixedStats.p90)} p90`
);

const messageQueries = [
  "!g kittens",
  "kittens",
  "\\kittens",
  "cats g!",
  "!zzzzz cats",
  "@g headphones",
  "headphones @g",
];
const MESSAGE_ITERS = iterations(500_000);

const messageStats = bench(
  MESSAGE_ITERS,
  (i, run) => {
    const offset = run === -1 ? 0 : run;
    sink += redirectUrl(
      messageQueries[(i + offset) % messageQueries.length],
      settings
    ).length;
  },
  20_000
);

console.log(
  `SW message redirect path (redirectUrl): ${fmt(messageStats.p50)} median, ${fmt(messageStats.p90)} p90`
);

separator("5b. REDIRECT FIXUP ISOLATION");

const fixupQueries = [
  { label: "Query-safe: single word", raw: "!g+kittens" },
  { label: "Query-safe: 3 spaces", raw: "!g+kittens+are+very+cute" },
  { label: "Query-safe: 10 spaces", raw: "!g+a+b+c+d+e+f+g+h+i+j+k" },
  { label: "Query-safe: %2F in term", raw: "!g+a%2Fb%2Fc" },
  { label: "Query-safe: mixed +/%2F", raw: "!g+hello+a%2Fb+world" },
  { label: "Path-based: single word", raw: "!tw+username" },
  { label: "Path-based: 3 spaces", raw: "!tw+hello+beautiful+world" },
  { label: "Path-based: %2F in term", raw: "!tw+a%2Fb%2Fc" },
  { label: "Path-based: mixed +/%2F", raw: "!tw+hello+a%2Fb+world" },
];

const FIXUP_ITERS = iterations(500_000);

console.log(
  `\nFixup isolation — ${FIXUP_ITERS.toLocaleString()} iterations × ${RUNS} runs:`
);
benchTableHeader("Query type", 30);

benchTable(
  fixupQueries,
  FIXUP_ITERS,
  (q) => {
    redirectRaw(q.raw, settings);
  },
  30
);

separator("6. SERVER ROUTE PATH PARSE PERFORMANCE");

const RAW_URL = "https://flashbang.local/suggest?q=%21g&sp=none#x";
const PATH_ITERS = iterations(500_000);

const pathViaRawStats = bench(PATH_ITERS, () => {
  void readPathname(RAW_URL);
});

console.log(
  `\nPath parse benchmark — ${PATH_ITERS.toLocaleString()} iterations × ${RUNS} runs:`
);
console.log(
  `  readPathname(url): ${fmt(pathViaRawStats.p50)} median, ${fmt(pathViaRawStats.p90)} p90`
);

separator("7. QUERY & COOKIE PARSING PERFORMANCE");

const PARAM_URL =
  "https://flashbang.local/suggest?x=1&q=%21g%20kittens%20and%20cats&sp=none&src=prof#x";
const PARAM_ITERS = iterations(500_000);

const queryParamStats = bench(
  PARAM_ITERS,
  () => {
    const [q, sp] = readTwoQueryParams(PARAM_URL, "q", "sp");
    sink += (q?.length ?? 0) + (sp?.length ?? 0);
  },
  20_000
);

console.log(
  `\nQuery param extraction — ${PARAM_ITERS.toLocaleString()} iterations × ${RUNS} runs:`
);
console.log(
  `  readTwoQueryParams(q,sp): ${fmt(queryParamStats.p50)} median, ${fmt(queryParamStats.p90)} p90`
);

separator("7b. QUERY DECODER ISOLATION");

const decoderInputs = [
  { label: "plus only", raw: "cat+dog" },
  { label: "%20 only", raw: "cat%20dog" },
  { label: "utf8 mixed", raw: "caf%C3%A9+%F0%9F%8D%95" },
];
const DECODER_ITERS = iterations(500_000);

console.log(
  `\nreadQueryParam decoder-ish workload — ${DECODER_ITERS.toLocaleString()} iterations × ${RUNS} runs:`
);
benchTableHeader("Input", 12);

benchTable(
  decoderInputs,
  DECODER_ITERS,
  (input) => {
    const url = `https://flashbang.local/suggest?q=${input.raw}`;
    sink += readQueryParam(url, "q")?.length ?? 0;
  },
  12
);

const reqNoCookie = new Request("http://localhost/suggest?q=x");
const reqLightCookie = new Request("http://localhost/suggest?q=x", {
  headers: {
    Cookie: "suggest=default,g,|meta|gh.mdn; sf=g:10.yt:4",
  },
});
const reqHeavyCookie = new Request("http://localhost/suggest?q=x", {
  headers: {
    Cookie:
      "session=abc123; theme=dark; lang=en-US; exp=beta-on; tracking=xyz;" +
      " suggest=custom,g,https%3A%2F%2Fexample.com%2Fsearch%3Fq%3D%7B%7D,|meta|gh.mdn.npm.rs.w;" +
      " sf=g:50.yt:30.w:20.ddg:10.gh:8.npm:6.rs:4;" +
      " misc1=1; misc2=2; misc3=3; misc4=4",
  },
});
const SETTINGS_PARSE_URL = "http://localhost/suggest?q=flashbang";
const COOKIE_ITERS = iterations(300_000);

const cookieNoneStats = bench(COOKIE_ITERS, () => {
  const s = parseCookie(reqNoCookie);
  sink += s.provider.length + s.trigger.length + s.custom.length;
});
const cookieLightStats = bench(COOKIE_ITERS, () => {
  const s = parseCookie(reqLightCookie);
  sink += s.provider.length + s.trigger.length + s.custom.length;
});
const cookieHeavyStats = bench(COOKIE_ITERS, () => {
  const s = parseCookie(reqHeavyCookie);
  sink += s.provider.length + s.trigger.length + s.custom.length;
});
const settingsFullContextStats = bench(COOKIE_ITERS, () => {
  const s = parseSettingsFromRawUrl(
    SETTINGS_PARSE_URL,
    reqHeavyCookie,
    "none",
    true
  );
  sink += s.provider.length + s.trigger.length + s.custom.length;
});
const settingsPlainContextStats = bench(COOKIE_ITERS, () => {
  const s = parseSettingsFromRawUrl(
    SETTINGS_PARSE_URL,
    reqHeavyCookie,
    "none",
    false
  );
  sink += s.provider.length + s.trigger.length + s.custom.length;
});

console.log(
  `\nCookie parsing — ${COOKIE_ITERS.toLocaleString()} iterations × ${RUNS} runs:`
);
console.log(
  `  No cookie:    ${fmt(cookieNoneStats.p50)} median, ${fmt(cookieNoneStats.p90)} p90`
);
console.log(
  `  Light cookie: ${fmt(cookieLightStats.p50)} median, ${fmt(cookieLightStats.p90)} p90`
);
console.log(
  `  Heavy cookie: ${fmt(cookieHeavyStats.p50)} median, ${fmt(cookieHeavyStats.p90)} p90`
);
console.log(
  `  parseSettings heavy (full bang context):  ${fmt(settingsFullContextStats.p50)} median, ${fmt(settingsFullContextStats.p90)} p90`
);
console.log(
  `  parseSettings heavy (plain only context): ${fmt(settingsPlainContextStats.p50)} median, ${fmt(settingsPlainContextStats.p90)} p90`
);

separator("8. FRECENCY HOT-PATH PERFORMANCE");

const FRECENCY_ITERS = iterations(200_000);
const FREQUENCY_TRIGGERS = [
  "g",
  "yt",
  "ddg",
  "gh",
  "w",
  "mdn",
  "npm",
  "rs",
  "so",
];
const FRECENCY_LIMIT = 8;

const incrementalFrecencyTimes: number[] = [];
for (let run = 0; run < RUNS; run++) {
  const incrementalCounts: Record<string, number> = {};
  for (let i = 0; i < 64; i++) {
    incrementalCounts[`seed-${i}`] = ((i * 17) % 23) + 1;
  }
  const top = buildTopFrecency(incrementalCounts, FRECENCY_LIMIT);
  const t0 = Bun.nanoseconds();
  for (let i = 0; i < FRECENCY_ITERS; i++) {
    const trigger = FREQUENCY_TRIGGERS[(i + run) % FREQUENCY_TRIGGERS.length];
    const next = (incrementalCounts[trigger] || 0) + 1;
    incrementalCounts[trigger] = next;
    updateTopFrecencyOnIncrement(top, trigger, next, FRECENCY_LIMIT);
    sink += JSON.stringify(top).length;
  }
  incrementalFrecencyTimes.push((Bun.nanoseconds() - t0) / FRECENCY_ITERS);
}

const incrementalFrecencyStats = summarizeRuns(incrementalFrecencyTimes);

console.log(
  `\nFrecency update benchmark — ${FRECENCY_ITERS.toLocaleString()} iterations × ${RUNS} runs:`
);
console.log(
  `  Incremental top-k update: ${fmt(incrementalFrecencyStats.p50)} median, ${fmt(incrementalFrecencyStats.p90)} p90`
);

separator("9. SUGGEST HANDLER PERFORMANCE");

const reqBang = new Request("http://localhost/suggest?q=!gh", {
  headers: { Cookie: "suggest=default,g," },
});
const reqPlain = new Request("http://localhost/suggest?q=flashbang&sp=none", {
  headers: { Cookie: "suggest=none,g," },
});
const reqPlainHeavy = new Request(
  "http://localhost/suggest?q=flashbang&sp=none",
  {
    headers: {
      Cookie:
        "session=abc123; theme=dark; lang=en-US; exp=beta-on; tracking=xyz;" +
        " suggest=custom,g,https%3A%2F%2Fexample.com%2Fsearch%3Fq%3D%7B%7D,|meta|gh.mdn.npm.rs.w;" +
        " sf=g:50.yt:30.w:20.ddg:10.gh:8.npm:6.rs:4;" +
        " misc1=1; misc2=2; misc3=3; misc4=4",
    },
  }
);

const HANDLER_ITERS = iterations(60_000);
for (let i = 0; i < 1_000; i++) {
  await handleSuggestRequest(reqBang);
  await handleSuggestRequest(reqPlain);
  await handleSuggestRequest(reqPlainHeavy);
}

const handlerBangTimes: number[] = [];
const handlerPlainTimes: number[] = [];
const handlerPlainHeavyTimes: number[] = [];
for (let run = 0; run < RUNS; run++) {
  let t0 = Bun.nanoseconds();
  for (let i = 0; i < HANDLER_ITERS; i++) {
    await handleSuggestRequest(reqBang);
  }
  handlerBangTimes.push((Bun.nanoseconds() - t0) / HANDLER_ITERS);

  t0 = Bun.nanoseconds();
  for (let i = 0; i < HANDLER_ITERS; i++) {
    await handleSuggestRequest(reqPlain);
  }
  handlerPlainTimes.push((Bun.nanoseconds() - t0) / HANDLER_ITERS);

  t0 = Bun.nanoseconds();
  for (let i = 0; i < HANDLER_ITERS; i++) {
    await handleSuggestRequest(reqPlainHeavy);
  }
  handlerPlainHeavyTimes.push((Bun.nanoseconds() - t0) / HANDLER_ITERS);
}

const handlerBangStats = summarizeRuns(handlerBangTimes);
const handlerPlainStats = summarizeRuns(handlerPlainTimes);
const handlerPlainHeavyStats = summarizeRuns(handlerPlainHeavyTimes);

console.log(
  `\nhandleSuggestRequest() — ${HANDLER_ITERS.toLocaleString()} iterations × ${RUNS} runs:`
);
console.log(
  `  Bang query path:      ${fmt(handlerBangStats.p50)} median, ${fmt(handlerBangStats.p90)} p90, ${fmt(handlerBangStats.p99)} p99`
);
console.log(
  `  Plain query path:     ${fmt(handlerPlainStats.p50)} median, ${fmt(handlerPlainStats.p90)} p90, ${fmt(handlerPlainStats.p99)} p99`
);
console.log(
  `  Plain heavy-cookie:   ${fmt(handlerPlainHeavyStats.p50)} median, ${fmt(handlerPlainHeavyStats.p90)} p90, ${fmt(handlerPlainHeavyStats.p99)} p99`
);

separator("10. FIRST-HIT SUGGEST (ISOLATED PROCESS)");

function runIsolatedNs(script: string, label: string): number {
  const proc = Bun.spawnSync({
    cmd: ["bun", "-e", script],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    const err = new TextDecoder().decode(proc.stderr).trim();
    throw new Error(`${label} failed: ${err}`);
  }
  return Number(new TextDecoder().decode(proc.stdout).trim());
}

function isolatedFirstHitNs(url: string, cookie: string): number {
  const script = `
import { handleSuggestRequest } from "./src/server/handlers";
const req = new Request(${JSON.stringify(url)}, {
  headers: { Cookie: ${JSON.stringify(cookie)} }
});
const t0 = Bun.nanoseconds();
await handleSuggestRequest(req);
console.log(Bun.nanoseconds() - t0);
`;
  return runIsolatedNs(script, "isolatedFirstHitNs");
}

function isolatedWarmThenBangNs(): number {
  const script = `
import { handleSuggestRequest } from "./src/server/handlers";
await handleSuggestRequest(new Request("http://localhost/suggest?q=flashbang&sp=none", {
  headers: { Cookie: "suggest=none,g," }
}));
await new Promise((resolve) => setTimeout(resolve, 5));
const t0 = Bun.nanoseconds();
await handleSuggestRequest(new Request("http://localhost/suggest?q=!gh", {
  headers: { Cookie: "suggest=default,g," }
}));
console.log(Bun.nanoseconds() - t0);
`;
  return runIsolatedNs(script, "isolatedWarmThenBangNs");
}

const coldPlainSamples: number[] = [];
const coldBangSamples: number[] = [];
const warmThenBangSamples: number[] = [];
for (let i = 0; i < COLD_RUNS; i++) {
  coldPlainSamples.push(
    isolatedFirstHitNs(
      "http://localhost/suggest?q=flashbang&sp=none",
      "suggest=none,g,"
    )
  );
  coldBangSamples.push(
    isolatedFirstHitNs("http://localhost/suggest?q=!gh", "suggest=default,g,")
  );
  warmThenBangSamples.push(isolatedWarmThenBangNs());
}

const coldPlainStats = summarizeRuns(coldPlainSamples);
const coldBangStats = summarizeRuns(coldBangSamples);
const warmThenBangStats = summarizeRuns(warmThenBangSamples);

const coldPlainNs = coldPlainStats.p50;
const coldBangNs = coldBangStats.p50;
const warmThenBangNs = warmThenBangStats.p50;

console.log(`\nFirst plain suggest request: ${fmt(coldPlainNs)} median`);
console.log(
  `  spread ${fmt(coldPlainStats.min)}..${fmt(coldPlainStats.max)} (${COLD_RUNS} isolated runs)`
);
console.log(`First bang suggest request:  ${fmt(coldBangNs)} median`);
console.log(
  `  spread ${fmt(coldBangStats.min)}..${fmt(coldBangStats.max)} (${COLD_RUNS} isolated runs)`
);
console.log(`Warm plain-then-bang request: ${fmt(warmThenBangNs)} median`);
console.log(
  `  spread ${fmt(warmThenBangStats.min)}..${fmt(warmThenBangStats.max)} (${COLD_RUNS} isolated runs)`
);

separator("11. MODULE PARSE/EVAL TIME");

const fullFile = await Bun.file(metaPath).text();
const fullEvalCode = fullFile.replaceAll("export const ", "const ");
const trieEvalCode = trieFile.replace(/export const /g, "var ");

const EVAL_RUNS = profileOptions.quick ? 8 : 20;

const evalFullTimes: number[] = [];
for (let i = 0; i < EVAL_RUNS; i++) {
  const t0 = Bun.nanoseconds();
  new Function(`${fullEvalCode};${i}`)();
  evalFullTimes.push(Bun.nanoseconds() - t0);
}
const evalFullStats = summarizeRuns(evalFullTimes);

console.log(`\nbangs-meta.js eval time (${fmtBytesExact(metaBytes)}):`);
console.log(`  Median: ${fmt(evalFullStats.p50)}`);
console.log(`  p90:    ${fmt(evalFullStats.p90)}`);
console.log(`  p99:    ${fmt(evalFullStats.p99)}`);
console.log(
  `  Spread: ${fmt(evalFullStats.min)}..${fmt(evalFullStats.max)} (cv ${evalFullStats.cvPct.toFixed(1)}%)`
);

const evalTrieTimes: number[] = [];
for (let i = 0; i < EVAL_RUNS; i++) {
  const t0 = Bun.nanoseconds();
  new Function(`${trieEvalCode};${i}`)();
  evalTrieTimes.push(Bun.nanoseconds() - t0);
}
const evalTrieStats = summarizeRuns(evalTrieTimes);

console.log(`\nbangs-trie.js eval time (${fmtBytesExact(trieBytes)}):`);
console.log(`  Median: ${fmt(evalTrieStats.p50)}`);
console.log(`  p90:    ${fmt(evalTrieStats.p90)}`);
console.log(`  p99:    ${fmt(evalTrieStats.p99)}`);
console.log(
  `  Spread: ${fmt(evalTrieStats.min)}..${fmt(evalTrieStats.max)} (cv ${evalTrieStats.cvPct.toFixed(1)}%)`
);

separator("SUMMARY");

if (sink === -Infinity) {
  console.log("");
}

function metric(
  id: string,
  label: string,
  category: MetricCategory,
  stats: RunStats,
  p50 = stats.p50
): ProfileMetric {
  return { id, label, category, unit: "ns", ...stats, p50 };
}

function pointMetric(
  id: string,
  label: string,
  category: MetricCategory,
  p50: number,
  cvPct?: number
): ProfileMetric {
  return { id, label, category, unit: "ns", p50, cvPct };
}

const summaryRows: ProfileMetric[] = [
  metric(
    "module-eval.meta",
    "Module eval (bangs-meta.js)",
    "Cold start",
    evalFullStats
  ),
  metric(
    "module-eval.trie",
    "Module eval (bangs-trie.js)",
    "Cold start",
    evalTrieStats
  ),
  metric(
    "first-hit.plain",
    "First-hit suggest (plain)",
    "Cold start",
    coldPlainStats
  ),
  metric(
    "first-hit.bang",
    "First-hit suggest (bang)",
    "Cold start",
    coldBangStats
  ),
  metric(
    "first-hit.warm-bang",
    "Warm plain-then-bang",
    "Cold start",
    warmThenBangStats
  ),
  pointMetric(
    "lookup.packed-net",
    "Packed lookup (est. net)",
    "Per redirect",
    lookupNetMedian,
    lookupStats.cvPct
  ),
  metric(
    "frecency.incremental",
    "Frecency update (incremental)",
    "Per redirect",
    incrementalFrecencyStats
  ),
  metric(
    "redirect.bang",
    "Full redirect (bang query)",
    "Per redirect",
    bangRedirect
  ),
  metric(
    "redirect.default",
    "Full redirect (non-bang query)",
    "Per redirect",
    nonBangRedirect
  ),
  metric(
    "redirect.prefix-snap",
    "Full redirect (prefix snap)",
    "Per redirect",
    prefixSnapRedirect
  ),
  metric(
    "redirect.suffix-snap",
    "Full redirect (suffix snap)",
    "Per redirect",
    suffixSnapRedirect
  ),
  metric(
    "redirect.capture-built-in",
    "Built-in capture redirect",
    "Per redirect",
    builtInCaptureRedirect
  ),
  metric(
    "redirect.capture-custom",
    "Custom capture redirect",
    "Per redirect",
    customCaptureRedirect
  ),
  metric(
    "redirect.snap-ad",
    "Built-in ad snap redirect",
    "Per redirect",
    builtInAdSnapRedirect
  ),
  metric(
    "redirect.snap-custom-target",
    "Custom target snap redirect",
    "Per redirect",
    customTargetSnapRedirect
  ),
  metric(
    "suggest.pipeline",
    "bangSuggestions pipeline",
    "Per suggest",
    trieSuggestRunStats
  ),
  metric(
    "suggest.handler-bang",
    "Suggest handler (bang)",
    "Per suggest",
    handlerBangStats
  ),
  metric(
    "suggest.handler-plain-heavy",
    "Suggest handler (plain heavy)",
    "Per suggest",
    handlerPlainHeavyStats
  ),
  metric(
    "request.pathname",
    "Route parse (raw pathname)",
    "Per request",
    pathViaRawStats
  ),
  metric(
    "request.query-params",
    "Query parse (two params, 1 scan)",
    "Per request",
    queryParamStats
  ),
  metric(
    "request.cookie-heavy",
    "Cookie parse (heavy header)",
    "Per request",
    cookieHeavyStats
  ),
  metric(
    "message.redirect-url",
    "SW message redirect (redirectUrl)",
    "Per message",
    messageStats
  ),
];

const componentWidth = 35;
const timeWidth = 10;
const barWidth = 14;
const categoryWidth = 12;
const summaryRule =
  `├${"─".repeat(componentWidth + 2)}` +
  `┼${"─".repeat(timeWidth + 2)}` +
  `┼${"─".repeat(barWidth + 2)}` +
  `┼${"─".repeat(categoryWidth + 2)}┤`;
const categoryMax = new Map<string, number>();
for (const row of summaryRows) {
  categoryMax.set(
    row.category,
    Math.max(categoryMax.get(row.category) ?? 0, row.p50)
  );
}

function categoryColor(category: MetricCategory, value: string): string {
  if (category === "Cold start") {
    return color.magenta(value);
  }
  if (category === "Per redirect") {
    return color.cyan(value);
  }
  if (category === "Per suggest") {
    return color.green(value);
  }
  return color.yellow(value);
}

console.log(
  `\n┌${"─".repeat(componentWidth + 2)}┬${"─".repeat(timeWidth + 2)}┬${"─".repeat(barWidth + 2)}┬${"─".repeat(categoryWidth + 2)}┐`
);
console.log(
  `│ ${color.bold("Component".padEnd(componentWidth))} │ ${color.bold("p50".padStart(timeWidth))} │ ${color.bold("relative".padEnd(barWidth))} │ ${color.bold("Scope".padEnd(categoryWidth))} │`
);
console.log(summaryRule);

let previousCategory: MetricCategory | undefined;
for (const row of summaryRows) {
  if (previousCategory && previousCategory !== row.category) {
    console.log(summaryRule);
  }
  previousCategory = row.category;
  const max = categoryMax.get(row.category) ?? row.p50;
  const filled =
    row.p50 > 0 ? Math.max(1, Math.round((row.p50 / max) * barWidth)) : 0;
  const bar = categoryColor(
    row.category,
    `${"█".repeat(filled)}${color.dim("░".repeat(barWidth - filled))}`
  );
  console.log(
    `│ ${row.label.padEnd(componentWidth)} │ ${categoryColor(row.category, fmt(row.p50).padStart(timeWidth))} │ ${bar} │ ${row.category.padEnd(categoryWidth)} │`
  );
}

console.log(
  `└${"─".repeat(componentWidth + 2)}┴${"─".repeat(timeWidth + 2)}┴${"─".repeat(barWidth + 2)}┴${"─".repeat(categoryWidth + 2)}┘`
);
console.log(
  color.dim(
    "  Bars are normalized within each scope. Run `bun run profile:cpu` for call-stack profiles.\n"
  )
);

type ComparisonStatus =
  | "regression"
  | "improvement"
  | "stable"
  | "noisy"
  | "new";

interface MetricComparison {
  current: ProfileMetric;
  baseline?: ProfileMetric;
  deltaPct?: number;
  status: ComparisonStatus;
}

function compareMetrics(
  current: ProfileMetric[],
  baseline: ProfileMetric[],
  thresholdPct: number
): MetricComparison[] {
  const baselineById = new Map(baseline.map((item) => [item.id, item]));
  return current
    .map((item): MetricComparison => {
      const previous = baselineById.get(item.id);
      if (!previous || previous.p50 <= 0) {
        return { current: item, status: "new" };
      }
      const deltaPct = ((item.p50 - previous.p50) / previous.p50) * 100;
      const noisy = (item.cvPct ?? 0) > 10 || (previous.cvPct ?? 0) > 10;
      let status: ComparisonStatus = "stable";
      if (noisy) {
        status = "noisy";
      } else if (deltaPct >= thresholdPct) {
        status = "regression";
      } else if (deltaPct <= -thresholdPct) {
        status = "improvement";
      }
      return { current: item, baseline: previous, deltaPct, status };
    })
    .sort((a, b) => (b.deltaPct ?? -Infinity) - (a.deltaPct ?? -Infinity));
}

function comparisonStatus(status: ComparisonStatus): string {
  if (status === "regression") {
    return color.red(status);
  }
  if (status === "improvement") {
    return color.green(status);
  }
  if (status === "noisy") {
    return color.yellow(status);
  }
  if (status === "new") {
    return color.cyan(status);
  }
  return color.dim(status);
}

function comparisonDelta(status: ComparisonStatus, delta: string): string {
  if (status === "regression") {
    return color.red(delta);
  }
  if (status === "improvement") {
    return color.green(delta);
  }
  if (status === "noisy") {
    return color.yellow(delta);
  }
  return delta;
}

function printComparisons(
  comparisons: MetricComparison[],
  baseline: ProfileReport,
  current: ProfileReport,
  path: string
): void {
  separator(`BASELINE COMPARISON — ${profileOptions.thresholdPct}% threshold`);
  console.log(
    color.dim(
      `  ${path}  •  ${baseline.generatedAt}  •  Bun ${baseline.environment.bun}`
    )
  );
  if (
    baseline.config.quick !== profileOptions.quick ||
    baseline.config.runs !== RUNS
  ) {
    console.log(
      color.yellow(
        `  Warning: baseline used ${baseline.config.runs} runs (${baseline.config.quick ? "quick" : "full"}), current run used ${RUNS} (${profileOptions.quick ? "quick" : "full"}).`
      )
    );
  }
  const sameMachine =
    baseline.environment.platform === current.environment.platform &&
    baseline.environment.arch === current.environment.arch &&
    baseline.environment.cpu === current.environment.cpu;
  if (!sameMachine || baseline.environment.bun !== current.environment.bun) {
    console.log(
      color.yellow(
        `  Warning: runtime or machine differs from baseline (${baseline.environment.bun}, ${baseline.environment.cpu}).`
      )
    );
  }

  const labelWidth = 35;
  console.log(
    color.dim(
      `\n  ${"Component".padEnd(labelWidth)} ${"Baseline".padStart(10)} ${"Current".padStart(10)} ${"Delta".padStart(9)}  Status`
    )
  );
  console.log(color.dim(`  ${"─".repeat(labelWidth + 44)}`));
  for (const comparison of comparisons) {
    const baselineValue = comparison.baseline
      ? fmt(comparison.baseline.p50)
      : "—";
    const delta =
      comparison.deltaPct === undefined
        ? "—"
        : `${comparison.deltaPct >= 0 ? "+" : ""}${comparison.deltaPct.toFixed(1)}%`;
    const coloredDelta = comparisonDelta(comparison.status, delta);
    console.log(
      `  ${comparison.current.label.padEnd(labelWidth)} ${baselineValue.padStart(10)} ${fmt(comparison.current.p50).padStart(10)} ${coloredDelta.padStart(useColor ? 18 : 9)}  ${comparisonStatus(comparison.status)}`
    );
  }
}

function gitOutput(args: string[]): string | null {
  const proc = Bun.spawnSync({
    cmd: ["git", ...args],
    stdout: "pipe",
    stderr: "ignore",
  });
  if (proc.exitCode !== 0) {
    return null;
  }
  return new TextDecoder().decode(proc.stdout).trim();
}

const gitCommit = gitOutput(["rev-parse", "--short", "HEAD"]);
const gitStatus = gitOutput(["status", "--porcelain"]);
const profileReport: ProfileReport = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  environment: {
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model ?? "unknown",
    gitCommit,
    gitDirty: gitStatus === null ? null : gitStatus.length > 0,
  },
  config: {
    quick: profileOptions.quick,
    runs: RUNS,
    coldRuns: COLD_RUNS,
  },
  metrics: summaryRows,
};

let stableRegressions = 0;
if (baselineReport && baselinePath) {
  const comparisons = compareMetrics(
    profileReport.metrics,
    baselineReport.metrics,
    profileOptions.thresholdPct
  );
  stableRegressions = comparisons.filter(
    (item) => item.status === "regression"
  ).length;
  printComparisons(comparisons, baselineReport, profileReport, baselinePath);
  const improvements = comparisons.filter(
    (item) => item.status === "improvement"
  ).length;
  const noisy = comparisons.filter((item) => item.status === "noisy").length;
  console.log(
    `\n  ${color.red(`${stableRegressions} regressions`)}  •  ${color.green(`${improvements} improvements`)}  •  ${color.yellow(`${noisy} noisy measurements`)}`
  );
}

if (profileOptions.save) {
  const savePath = resolveReportPath(profileOptions.save);
  await mkdir(dirname(savePath), { recursive: true });
  await Bun.write(savePath, `${JSON.stringify(profileReport, null, 2)}\n`);
  console.log(`\n${color.green("Saved profile report:")} ${savePath}`);
}

if (profileOptions.failOnRegression && stableRegressions > 0) {
  console.error(
    color.red(
      `\nProfile failed: ${stableRegressions} stable benchmark regression${stableRegressions === 1 ? "" : "s"} exceeded ${profileOptions.thresholdPct}%.`
    )
  );
  process.exitCode = 1;
}
