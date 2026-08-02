import { mkdir, rm } from "node:fs/promises";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { $ } from "bun";
import {
  BANG_SHARD_COUNT,
  BANG_SHARD_ROUTER_SIZE,
  bangShardCell,
} from "../src/shared/bang-shards";
import {
  CAPTURE_ENCODE_PERCENT,
  CAPTURE_ENCODE_PLUS,
  CAPTURE_ENCODE_RAW,
  parseCaptureTemplate,
  validateCaptureBang,
  validateSimpleBangUrl,
} from "../src/shared/capture-template";
import {
  SITE_SUGGESTION_SHAPE,
  type SiteSuggestionShape,
} from "../src/shared/constants";
import { hashFNV1a } from "../src/shared/hash";
import {
  compileSnapTarget,
  type SnapTargetParts,
} from "../src/shared/snap-target";
import { type BuildNode, buildRadixTrie } from "../src/shared/trie";

interface Bang {
  captureEncoding?: number;
  domain: string;
  name: string;
  regex?: string;
  relevance: number;
  snap?: string;
  trigger: string;
  url: string;
}

export interface CuratedSuggestionSite {
  shape: SiteSuggestionShape;
  url: string;
}

export interface SuggestionSiteRegistry {
  curated: Readonly<Record<string, CuratedSuggestionSite>>;
  mediawiki: Readonly<Record<string, "/" | "/w/">>;
}

interface RawDdgEntry {
  d: string;
  r?: number;
  s: string;
  t: string;
  ts?: string[];
  u: string;
}

interface RawKagiEntry {
  ad?: string;
  d: string;
  fmt?: string[];
  s: string;
  t: string;
  ts?: string[];
  u: string;
  x?: string;
}

export const GENERATED_BANG_DATA_FILES = [
  "src/generated/bangs.bin",
  "src/generated/bangs-sparse.js",
  "src/generated/bangs-meta.bin",
  "src/generated/bangs-trie-loader.js",
  "src/generated/bangs-hot.js",
  "src/generated/bangs-trie.bin",
] as const;

const DATA_DIR = "data";
const DDG_BANGS_PATH = `${DATA_DIR}/ddg.json`;
const KAGI_BANGS_PATH = `${DATA_DIR}/kagi.json`;
const CUSTOM_BANGS_PATH = `${DATA_DIR}/custom-bangs.json`;
const MERGED_BANGS_PATH = `${DATA_DIR}/bangs.json`;
const SUGGEST_SITES_PATH = `${DATA_DIR}/suggest-sites.json`;
const GENERATED_OUT_DIR = "src/generated";
const HOT_BANG_LIMIT = 24;
const BANG_BINARY_MAGIC = 0x31424246;
const BANG_BINARY_VERSION = 9;

const DDG_SOURCE_URL = "https://duckduckgo.com/bang.js";
const KAGI_SOURCE_URL =
  "https://raw.githubusercontent.com/kagisearch/bangs/main/data/bangs.json";

async function generatedBangDataIsCurrent(): Promise<boolean> {
  const header = await Bun.file(GENERATED_BANG_DATA_FILES[0])
    .slice(0, 8)
    .arrayBuffer();
  if (header.byteLength !== 8) {
    return false;
  }
  const words = new Uint32Array(header);
  if (words[0] !== BANG_BINARY_MAGIC || words[1] !== BANG_BINARY_VERSION) {
    return false;
  }
  const trie = Bun.file("src/generated/bangs-trie-loader.js");
  const tail = await trie
    .slice(Math.max(0, trie.size - 2048), trie.size)
    .text();
  return tail.includes("export const TRIE_SCHEMA=4;");
}

export async function ensureGeneratedBangData(
  fromMerged = true
): Promise<void> {
  const missing: string[] = [];
  for (const file of GENERATED_BANG_DATA_FILES) {
    if (!(await Bun.file(file).exists())) {
      missing.push(file);
    }
  }

  if (missing.length === 0 && (await generatedBangDataIsCurrent())) {
    return;
  }

  const mode = fromMerged ? " --from-merged" : "";
  const reason = missing.length
    ? `missing (${missing.join(", ")})`
    : "uses an outdated generated-data schema";
  console.warn(`Generated bang data ${reason}. Running codegen${mode}...`);

  if (fromMerged) {
    await $`bun run codegen --from-merged`;
  } else {
    await $`bun run codegen`;
  }

  for (const file of GENERATED_BANG_DATA_FILES) {
    if (!(await Bun.file(file).exists())) {
      throw new Error(
        `Missing generated bang data after codegen: ${GENERATED_BANG_DATA_FILES.join(", ")}`
      );
    }
  }
  if (!(await generatedBangDataIsCurrent())) {
    throw new Error("Generated bang data schema is outdated");
  }
}

function normalizeUrl(u: string, base: string): string {
  let url = u.replaceAll("{{{s}}}", "{}");
  if (!url.startsWith("http")) {
    url = `${base}${url.startsWith("/") ? "" : "/"}${url}`;
  }
  return url;
}

interface NamedBangSource {
  bangs: Bang[];
  name: string;
}

type CustomBangMap = Record<
  string,
  { name: string; url: string; domain: string; snap?: string }
>;

function appendBangWithAliases(
  out: Bang[],
  entry: {
    aliases?: readonly string[];
    captureEncoding?: number;
    domain: string;
    name: string;
    relevance: number;
    regex?: string;
    snap?: string;
    trigger: string;
    url: string;
  }
): void {
  out.push({
    trigger: entry.trigger.toLowerCase(),
    name: entry.name,
    domain: entry.domain,
    url: entry.url,
    relevance: entry.relevance,
    ...(entry.regex
      ? { regex: entry.regex, captureEncoding: entry.captureEncoding }
      : {}),
    ...(entry.snap ? { snap: entry.snap } : {}),
  });
  if (!entry.aliases) {
    return;
  }
  for (const alias of entry.aliases) {
    out.push({
      trigger: alias.toLowerCase(),
      name: entry.name,
      domain: entry.domain,
      url: entry.url,
      relevance: entry.relevance,
      ...(entry.regex
        ? { regex: entry.regex, captureEncoding: entry.captureEncoding }
        : {}),
      ...(entry.snap ? { snap: entry.snap } : {}),
    });
  }
}

export function parseDdg(raw: string): Bang[] {
  const entries: RawDdgEntry[] = JSON.parse(raw);
  const bangs: Bang[] = [];
  for (const entry of entries) {
    appendBangWithAliases(bangs, {
      trigger: entry.t,
      aliases: entry.ts,
      name: entry.s,
      domain: entry.d,
      url: normalizeUrl(entry.u, "https://duckduckgo.com"),
      relevance: entry.r ?? 0,
    });
  }
  return bangs;
}

export function parseKagi(raw: string): Bang[] {
  const entries: RawKagiEntry[] = JSON.parse(raw);
  const bangs: Bang[] = [];
  for (const entry of entries) {
    let captureEncoding: number | undefined;
    if (entry.x) {
      const fmt = entry.fmt;
      const encode =
        fmt === undefined || fmt.includes("url_encode_placeholder");
      const plus =
        fmt === undefined || fmt.includes("url_encode_space_to_plus");
      if (encode) {
        captureEncoding = plus ? CAPTURE_ENCODE_PLUS : CAPTURE_ENCODE_PERCENT;
      } else {
        captureEncoding = CAPTURE_ENCODE_RAW;
      }
    }
    appendBangWithAliases(bangs, {
      trigger: entry.t,
      aliases: entry.ts,
      name: entry.s,
      domain: entry.d,
      url: normalizeUrl(entry.u, "https://kagi.com"),
      relevance: 0,
      regex: entry.x,
      captureEncoding,
      snap: entry.ad,
    });
  }
  return bangs;
}

export function parseCustom(data: CustomBangMap): Bang[] {
  return Object.entries(data).map(([trigger, b]) => ({
    trigger: trigger.toLowerCase(),
    name: b.name,
    domain: b.domain,
    url: b.url,
    relevance: 0,
    ...(b.snap ? { snap: b.snap } : {}),
  }));
}

export function mergeSources(sources: readonly NamedBangSource[]): Bang[] {
  const map = new Map<string, Bang>();

  for (const { bangs, name } of sources) {
    for (const bang of bangs) {
      const existing = map.get(bang.trigger);
      if (existing) {
        const merged = {
          ...bang,
          relevance: Math.max(existing.relevance, bang.relevance),
        };
        if (name === "custom" && !merged.snap && existing.snap) {
          merged.snap = existing.snap;
        }
        map.set(bang.trigger, merged);
      } else {
        map.set(bang.trigger, bang);
      }
    }
  }

  return [...map.values()].sort((a, b) => a.trigger.localeCompare(b.trigger));
}

export function validateBangs(bangs: Bang[]): Bang[] {
  return bangs.filter((b) => {
    if (!b.trigger) {
      return false;
    }
    let error: string | null = null;
    if (b.regex) {
      error = validateCaptureBang(b.url, b.regex);
    } else if (b.url !== "/settings") {
      error = validateSimpleBangUrl(b.url);
    }
    if (error) {
      console.error(`Warning: bang !${b.trigger} is invalid: ${error}`);
      return false;
    }
    return true;
  });
}

// Custom escape functions produce smaller generated modules than
// JSON.stringify, which emits \uXXXX for characters that do not need it.

function escapeString(
  s: string,
  quoteCode: number,
  escapedQuote: string
): string {
  let out = "";
  let chunkStart = 0;
  for (let i = 0; i < s.length; i++) {
    let escaped: string;
    switch (s.charCodeAt(i)) {
      case quoteCode:
        escaped = escapedQuote;
        break;
      case 0x5c:
        escaped = "\\\\";
        break;
      case 0x0a:
        escaped = "\\n";
        break;
      case 0x0d:
        escaped = "\\r";
        break;
      default:
        continue;
    }
    out += s.substring(chunkStart, i) + escaped;
    chunkStart = i + 1;
  }
  return chunkStart === 0 ? s : out + s.substring(chunkStart);
}

/** Escape for embedding in a single-quoted JS string literal. */
export function jsEscape(s: string): string {
  return escapeString(s, 0x27, "\\'");
}

/** Escape for embedding in a double-quoted JSON string. */
export function jsonEscape(s: string): string {
  return escapeString(s, 0x22, '\\"');
}

function splitTemplate(url: string): [string, string | null] {
  const idx = url.indexOf("{}");
  if (idx === -1) {
    return [url, null];
  }
  return [url.substring(0, idx), url.substring(idx + 2)];
}

interface PackedBlob {
  blob: string;
  lengths: number[];
}

function packBlob(values: readonly string[]): PackedBlob {
  let blob = "";
  const lengths = new Array<number>(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    blob += v;
    lengths[i] = v.length;
  }
  return { blob, lengths };
}

function dedupeStrings(values: readonly string[]): {
  ids: number[];
  unique: string[];
} {
  const unique: string[] = [];
  const ids = new Array<number>(values.length);
  const map = new Map<string, number>();

  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    const existing = map.get(value);
    if (existing !== undefined) {
      ids[i] = existing;
      continue;
    }
    const id = unique.length;
    unique.push(value);
    map.set(value, id);
    ids[i] = id;
  }

  return { ids, unique };
}

function orderStringsByLength(values: readonly string[]): {
  ordered: string[];
  remap: number[];
} {
  const indexes = values.map((_, index) => index);
  indexes.sort((a, b) => {
    const lengthDifference = values[a].length - values[b].length;
    if (lengthDifference !== 0) {
      return lengthDifference;
    }
    if (values[a] < values[b]) {
      return -1;
    }
    return values[a] > values[b] ? 1 : 0;
  });

  const ordered = new Array<string>(values.length);
  const remap = new Array<number>(values.length);
  for (let id = 0; id < indexes.length; id++) {
    const oldId = indexes[id];
    ordered[id] = values[oldId];
    remap[oldId] = id;
  }
  return { ordered, remap };
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) {
    p <<= 1;
  }
  return p;
}

const MPH_SLOT_MULTIPLIER = 0x85ebca6b;
const MPH_BUCKET_MULTIPLIER = 0x7feb352d;
const MPH_MAX_DISPLACEMENT = 1_000_000;

function mphBucket(hash: number, mask: number): number {
  let mixed = hash ^ (hash >>> 16);
  mixed = Math.imul(mixed, MPH_BUCKET_MULTIPLIER);
  mixed ^= mixed >>> 15;
  return mixed & mask;
}

function mphSlot(hash: number, displacement: number, size: number): number {
  return (
    (Math.imul(hash ^ (displacement + 1), MPH_SLOT_MULTIPLIER) >>> 0) % size
  );
}

interface MinimalPerfectHash {
  displacements: Int16Array | Int32Array;
  slotToEntry: Uint16Array;
}

function buildMinimalPerfectHash(
  triggers: readonly string[],
  entriesPerBucket: number
): MinimalPerfectHash {
  const entryCount = triggers.length;
  if (entryCount === 0) {
    throw new Error("Binary bang format requires at least one regular entry");
  }
  const bucketCount = nextPow2(
    Math.max(2, Math.ceil(entryCount / entriesPerBucket))
  );
  const bucketMask = bucketCount - 1;
  const hashes = Uint32Array.from(triggers, hashFNV1a);
  const knownHashes = new Map<number, string>();
  for (let i = 0; i < entryCount; i++) {
    const hash = hashes[i];
    const collision = knownHashes.get(hash);
    if (collision !== undefined) {
      throw new Error(
        `Binary bang MPHF requires collision-free hashes: ${collision}, ${triggers[i]}`
      );
    }
    knownHashes.set(hash, triggers[i]);
  }

  const buckets = Array.from({ length: bucketCount }, () => [] as number[]);
  for (let i = 0; i < entryCount; i++) {
    buckets[mphBucket(hashes[i], bucketMask)].push(i);
  }
  const orderedBuckets = buckets
    .map((entries, id) => ({ entries, id }))
    .filter((bucket) => bucket.entries.length > 1)
    .sort((a, b) => b.entries.length - a.entries.length || a.id - b.id);
  const occupied = new Uint8Array(entryCount);
  const seen = new Uint32Array(entryCount);
  const slotToEntry = new Uint16Array(entryCount);
  const wideDisplacements = new Int32Array(bucketCount);
  wideDisplacements.fill(-1);
  let stamp = 0;
  let maxDisplacement = 0;

  for (const bucket of orderedBuckets) {
    let displacement = 0;
    for (; displacement <= MPH_MAX_DISPLACEMENT; displacement++) {
      stamp++;
      let available = true;
      for (const entry of bucket.entries) {
        const slot = mphSlot(hashes[entry], displacement, entryCount);
        if (occupied[slot] || seen[slot] === stamp) {
          available = false;
          break;
        }
        seen[slot] = stamp;
      }
      if (available) {
        break;
      }
    }
    if (displacement > MPH_MAX_DISPLACEMENT) {
      throw new Error(`Unable to build binary bang MPHF bucket ${bucket.id}`);
    }
    wideDisplacements[bucket.id] = displacement;
    maxDisplacement = Math.max(maxDisplacement, displacement);
    for (const entry of bucket.entries) {
      const slot = mphSlot(hashes[entry], displacement, entryCount);
      occupied[slot] = 1;
      slotToEntry[slot] = entry;
    }
  }

  const freeSlots: number[] = [];
  for (let slot = 0; slot < entryCount; slot++) {
    if (!occupied[slot]) {
      freeSlots.push(slot);
    }
  }
  let freeOffset = 0;
  for (let bucketId = 0; bucketId < buckets.length; bucketId++) {
    const entries = buckets[bucketId];
    if (entries.length !== 1) {
      continue;
    }
    const slot = freeSlots[freeOffset++];
    wideDisplacements[bucketId] = -(slot + 1);
    slotToEntry[slot] = entries[0];
  }
  if (freeOffset !== freeSlots.length) {
    throw new Error("Binary bang MPHF did not assign every slot");
  }

  const displacements =
    entryCount <= 0x7fff && maxDisplacement <= 0x7fff
      ? Int16Array.from(wideDisplacements)
      : wideDisplacements;
  return { displacements, slotToEntry };
}

const COMPRESSION_LAYOUT_CANDIDATES = 6;
const COMPRESSION_LAYOUT_DISPLACEMENT_WEIGHT = 1.9401936793041696;
const COMPRESSION_LAYOUT_LOCALITY_WEIGHT = 0.28722706580560353;
const COMPRESSION_LAYOUT_RANK_WEIGHT = 1.0623352371655768;
const COMPRESSION_LAYOUT_NOISE = 0.0034072484835989424;
const COMPRESSION_LAYOUT_SEED = 200770045;
const COMPRESSION_LAYOUT_NEIGHBORS = [-8, -4, -2, -1, 1, 2, 4, 8];

// The full catalog has many valid MPHFs. Score a small deterministic sample of
// placements per bucket so related URL tuples tend to land near one another,
// improving whole-file compression without changing the runtime data format.
function buildCompressionAwareMinimalPerfectHash(
  triggers: readonly string[],
  prefixIds: readonly number[],
  suffixIds: readonly number[],
  entriesPerBucket: number
): MinimalPerfectHash | null {
  const entryCount = triggers.length;
  if (entryCount > 0x7fff) {
    return null;
  }
  const bucketCount = nextPow2(
    Math.max(2, Math.ceil(entryCount / entriesPerBucket))
  );
  const bucketMask = bucketCount - 1;
  const hashes = Uint32Array.from(triggers, hashFNV1a);
  const desiredSlot = new Uint16Array(entryCount);
  const entriesByTuple = Array.from(
    { length: entryCount },
    (_, entry) => entry
  ).sort(
    (left, right) =>
      prefixIds[left] - prefixIds[right] ||
      suffixIds[left] - suffixIds[right] ||
      hashes[left] - hashes[right]
  );
  for (let slot = 0; slot < entryCount; slot++) {
    desiredSlot[entriesByTuple[slot]] = slot;
  }

  const buckets = Array.from({ length: bucketCount }, () => [] as number[]);
  for (let entry = 0; entry < entryCount; entry++) {
    buckets[mphBucket(hashes[entry], bucketMask)].push(entry);
  }
  const orderedBuckets = buckets
    .map((entries, id) => ({ entries, id }))
    .filter((bucket) => bucket.entries.length > 1)
    .sort(
      (left, right) =>
        right.entries.length - left.entries.length || left.id - right.id
    );
  const occupied = new Uint8Array(entryCount);
  const slotToEntry = new Uint16Array(entryCount);
  const displacements = new Int16Array(bucketCount);
  displacements.fill(-1);
  let randomState = COMPRESSION_LAYOUT_SEED;
  const random = () => {
    randomState ^= randomState << 13;
    randomState ^= randomState >>> 17;
    randomState ^= randomState << 5;
    return (randomState >>> 0) / 0x1_0000_0000;
  };

  for (const bucket of orderedBuckets) {
    let best:
      | { displacement: number; score: number; slots: number[] }
      | undefined;
    let candidates = 0;
    for (
      let displacement = 0;
      displacement <= 0x7fff && candidates < COMPRESSION_LAYOUT_CANDIDATES;
      displacement++
    ) {
      const slots = bucket.entries.map((entry) =>
        mphSlot(hashes[entry], displacement, entryCount)
      );
      if (
        new Set(slots).size !== slots.length ||
        slots.some((slot) => occupied[slot])
      ) {
        continue;
      }
      candidates++;
      let locality = 0;
      let rankDistance = 0;
      for (let index = 0; index < slots.length; index++) {
        const slot = slots[index];
        const entry = bucket.entries[index];
        rankDistance += Math.abs(slot - desiredSlot[entry]) / entryCount;
        for (const delta of COMPRESSION_LAYOUT_NEIGHBORS) {
          const neighbor = slot + delta;
          if (neighbor < 0 || neighbor >= entryCount || !occupied[neighbor]) {
            continue;
          }
          const other = slotToEntry[neighbor];
          if (
            prefixIds[entry] === prefixIds[other] &&
            suffixIds[entry] === suffixIds[other]
          ) {
            locality += 12 / Math.abs(delta);
          } else {
            if (prefixIds[entry] === prefixIds[other]) {
              locality += 4 / Math.abs(delta);
            }
            if (suffixIds[entry] === suffixIds[other]) {
              locality += 2 / Math.abs(delta);
            }
          }
        }
      }
      const score =
        COMPRESSION_LAYOUT_RANK_WEIGHT * rankDistance -
        COMPRESSION_LAYOUT_LOCALITY_WEIGHT * locality +
        COMPRESSION_LAYOUT_DISPLACEMENT_WEIGHT * Math.log2(displacement + 2) +
        COMPRESSION_LAYOUT_NOISE * random();
      if (!best || score < best.score) {
        best = { displacement, score, slots };
      }
    }
    if (!best) {
      return null;
    }
    displacements[bucket.id] = best.displacement;
    best.slots.forEach((slot, index) => {
      occupied[slot] = 1;
      slotToEntry[slot] = bucket.entries[index];
    });
  }

  const freeSlots: number[] = [];
  for (let slot = 0; slot < entryCount; slot++) {
    if (!occupied[slot]) {
      freeSlots.push(slot);
    }
  }
  let freeOffset = 0;
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    if (buckets[bucket].length !== 1) {
      continue;
    }
    const slot = freeSlots[freeOffset++];
    displacements[bucket] = -(slot + 1);
    slotToEntry[slot] = buckets[bucket][0];
  }
  return freeOffset === freeSlots.length
    ? { displacements, slotToEntry }
    : null;
}

function align2(value: number): number {
  return (value + 1) & ~1;
}

function align4(value: number): number {
  return (value + 3) & ~3;
}

const BANG_CHECKPOINT_SIZE = 16;
const PREFIX_LENGTH_MASK = 0x1fff;
const PREFIX_WWW_FLAG = 0x2000;
const PREFIX_SCHEME_SHIFT = 14;

function buildCheckpoints(
  lengths: Uint8Array | Uint16Array,
  lengthMask = 0xffff
): Uint32Array {
  const checkpoints = new Uint32Array(
    Math.ceil(lengths.length / BANG_CHECKPOINT_SIZE)
  );
  let position = 0;
  for (let i = 0; i < lengths.length; i++) {
    if (i % BANG_CHECKPOINT_SIZE === 0) {
      checkpoints[i / BANG_CHECKPOINT_SIZE] = position;
    }
    position += lengths[i] & lengthMask;
  }
  return checkpoints;
}

interface PackedBangData {
  entryCount: number;
  prefixIds: number[];
  suffixIdsPlusOne: number[];
  triggers: string[];
  uniquePrefixes: string[];
  uniqueSuffixes: string[];
  suffixBlob: ReturnType<typeof packBlob>;
}

function packBangData(bangs: Bang[]): PackedBangData {
  const entryCount = bangs.length;
  if (entryCount > 0xffff) {
    throw new Error(
      `Binary bang format requires <= 65535 entries, got ${entryCount}`
    );
  }

  const triggers = new Array<string>(entryCount);
  const prefixes = new Array<string>(entryCount);
  const rawSuffixes = new Array<string | null>(entryCount);

  for (let i = 0; i < entryCount; i++) {
    const bang = bangs[i];
    const [prefix, suffix] = splitTemplate(bang.url);
    triggers[i] = bang.trigger;
    prefixes[i] = prefix;
    rawSuffixes[i] = suffix;
  }

  let { ids: prefixIds, unique: uniquePrefixes } = dedupeStrings(prefixes);
  if (uniquePrefixes.length > 0xffff) {
    throw new Error(
      `Binary bang format requires <= 65535 unique prefixes, got ${uniquePrefixes.length}`
    );
  }

  let uniqueSuffixes: string[] = [];
  const suffixIdsPlusOne = new Array<number>(entryCount);
  const suffixMap = new Map<string, number>();
  for (let i = 0; i < entryCount; i++) {
    const suffix = rawSuffixes[i];
    if (suffix === null) {
      suffixIdsPlusOne[i] = 0;
      continue;
    }
    const existing = suffixMap.get(suffix);
    if (existing !== undefined) {
      suffixIdsPlusOne[i] = existing + 1;
      continue;
    }
    const id = uniqueSuffixes.length;
    if (id >= 0xffff) {
      throw new Error(
        `Binary bang format requires <= 65535 unique suffixes, got ${id + 1}`
      );
    }
    uniqueSuffixes.push(suffix);
    suffixMap.set(suffix, id);
    suffixIdsPlusOne[i] = id + 1;
  }

  const orderedPrefixes = orderStringsByLength(uniquePrefixes);
  uniquePrefixes = orderedPrefixes.ordered;
  prefixIds = prefixIds.map((id) => orderedPrefixes.remap[id]);

  const orderedSuffixes = orderStringsByLength(uniqueSuffixes);
  uniqueSuffixes = orderedSuffixes.ordered;
  for (let i = 0; i < suffixIdsPlusOne.length; i++) {
    const id = suffixIdsPlusOne[i];
    if (id !== 0) {
      suffixIdsPlusOne[i] = orderedSuffixes.remap[id - 1] + 1;
    }
  }

  const suffixBlob = packBlob(uniqueSuffixes);
  for (const len of suffixBlob.lengths) {
    if (len > 0xffff) {
      throw new Error(
        `Binary bang format requires suffix length <= 65535, got ${len}`
      );
    }
  }

  return {
    entryCount,
    suffixBlob,
    prefixIds,
    suffixIdsPlusOne,
    uniquePrefixes,
    uniqueSuffixes,
    triggers,
  };
}

function copyTypedArray(
  output: Uint8Array,
  offset: number,
  values: Uint8Array | Uint16Array | Uint32Array | Int16Array | Int32Array
): number {
  output.set(
    new Uint8Array(values.buffer, values.byteOffset, values.byteLength),
    offset
  );
  return offset + values.byteLength;
}

function compressionPrefixPayload(value: string): string {
  let payload = value;
  if (payload.startsWith("https://")) {
    payload = payload.substring(8);
  } else if (payload.startsWith("http://")) {
    payload = payload.substring(7);
  }
  return payload.startsWith("www.") ? payload.substring(4) : payload;
}

function orderPrefixesForCompression(values: readonly string[]): {
  ordered: string[];
  remap: Uint16Array;
} {
  const encoder = new TextEncoder();
  const payloads = values.map(compressionPrefixPayload);
  const lengths = payloads.map((payload) => encoder.encode(payload).byteLength);
  const reversed = payloads.map((payload) => [...payload].reverse().join(""));
  const order = values.map((_, index) => index);
  order.sort((left, right) => {
    const lengthDifference = lengths[left] - lengths[right];
    if (lengthDifference !== 0) {
      return lengthDifference;
    }
    if (reversed[left] < reversed[right]) {
      return -1;
    }
    return reversed[left] > reversed[right] ? 1 : left - right;
  });
  const remap = new Uint16Array(values.length);
  const ordered = order.map((oldId, newId) => {
    remap[oldId] = newId;
    return values[oldId];
  });
  return { ordered, remap };
}

function generateBinaryWithBucketLoad(
  bangs: readonly Bang[],
  entriesPerBucket: number,
  compressionAware = false
): Uint8Array {
  const packed = packBangData(bangs.filter((bang) => !bang.regex));
  let bucketLoad = entriesPerBucket;
  let mph: MinimalPerfectHash;
  for (;;) {
    try {
      mph =
        (compressionAware &&
          buildCompressionAwareMinimalPerfectHash(
            packed.triggers,
            packed.prefixIds,
            packed.suffixIdsPlusOne,
            bucketLoad
          )) ||
        buildMinimalPerfectHash(packed.triggers, bucketLoad);
      break;
    } catch (error) {
      const placementFailed =
        error instanceof Error &&
        error.message.startsWith("Unable to build binary bang MPHF bucket ");
      if (!placementFailed || bucketLoad <= 0.25) {
        throw error;
      }
      // A denser bucket assignment can occasionally produce a key group that
      // this displacement family cannot place. Only expand the affected table.
      bucketLoad /= 2;
    }
  }
  const triggers = Array.from(
    mph.slotToEntry,
    (entry) => packed.triggers[entry]
  );
  let reorderedPrefixIds = Array.from(
    mph.slotToEntry,
    (entry) => packed.prefixIds[entry]
  );
  const reorderedSuffixIds = Array.from(
    mph.slotToEntry,
    (entry) => packed.suffixIdsPlusOne[entry]
  );
  const encoder = new TextEncoder();
  let uniquePrefixes = packed.uniquePrefixes;
  if (compressionAware) {
    const orderedPrefixes = orderPrefixesForCompression(uniquePrefixes);
    uniquePrefixes = orderedPrefixes.ordered;
    reorderedPrefixIds = reorderedPrefixIds.map(
      (id) => orderedPrefixes.remap[id]
    );
  }
  const suffixBytes = encoder.encode(packed.suffixBlob.blob);
  const fingerprints = Uint16Array.from(
    triggers,
    (trigger) => hashFNV1a(trigger) >>> 16
  );
  // URL blobs stay byte-backed in the worker and are decoded one entry at a time.
  const prefixPayloads = new Array<string>(uniquePrefixes.length);
  const prefixLengths = Uint16Array.from(uniquePrefixes, (value, index) => {
    let payload = value;
    let scheme = 0;
    if (payload.startsWith("https://")) {
      scheme = 1;
      payload = payload.substring(8);
    } else if (payload.startsWith("http://")) {
      scheme = 2;
      payload = payload.substring(7);
    }
    let flags = scheme << PREFIX_SCHEME_SHIFT;
    if (payload.startsWith("www.")) {
      flags |= PREFIX_WWW_FLAG;
      payload = payload.substring(4);
    }
    const length = encoder.encode(payload).byteLength;
    if (length > PREFIX_LENGTH_MASK) {
      throw new Error(
        `Binary bang format requires encoded prefix payload length <= ${PREFIX_LENGTH_MASK}, got ${length}`
      );
    }
    prefixPayloads[index] = payload;
    return length | flags;
  });
  const prefixBytes = encoder.encode(prefixPayloads.join(""));
  const suffixLengths = Uint16Array.from(packed.uniqueSuffixes, (value) => {
    const length = encoder.encode(value).byteLength;
    if (length > 0xffff) {
      throw new Error(
        `Binary bang format requires encoded suffix length <= 65535, got ${length}`
      );
    }
    return length;
  });
  const prefixIds = Uint16Array.from(reorderedPrefixIds);
  const suffixIds = Uint16Array.from(reorderedSuffixIds);
  const prefixCheckpoints = buildCheckpoints(prefixLengths, PREFIX_LENGTH_MASK);
  const suffixCheckpoints = buildCheckpoints(suffixLengths);

  const headerWords = 13;
  const headerBytes = headerWords * Uint32Array.BYTES_PER_ELEMENT;
  let numericEnd = headerBytes + mph.displacements.byteLength;
  numericEnd += fingerprints.byteLength;
  numericEnd = align2(numericEnd);
  numericEnd +=
    prefixLengths.byteLength +
    suffixLengths.byteLength +
    prefixIds.byteLength +
    suffixIds.byteLength;
  numericEnd = align4(numericEnd);
  numericEnd += prefixCheckpoints.byteLength + suffixCheckpoints.byteLength;
  const totalBytes =
    numericEnd + prefixBytes.byteLength + suffixBytes.byteLength;
  const output = new Uint8Array(new ArrayBuffer(totalBytes));
  new Uint32Array(output.buffer, 0, headerWords).set([
    BANG_BINARY_MAGIC,
    BANG_BINARY_VERSION,
    packed.entryCount,
    mph.displacements.length,
    fingerprints.BYTES_PER_ELEMENT,
    packed.uniquePrefixes.length,
    packed.uniqueSuffixes.length,
    0,
    prefixBytes.byteLength,
    suffixBytes.byteLength,
    numericEnd,
    totalBytes,
    mph.displacements.BYTES_PER_ELEMENT,
  ]);

  let offset = headerBytes;
  offset = copyTypedArray(output, offset, mph.displacements);
  offset = copyTypedArray(output, offset, fingerprints);
  offset = align2(offset);
  offset = copyTypedArray(output, offset, prefixLengths);
  offset = copyTypedArray(output, offset, suffixLengths);
  offset = copyTypedArray(output, offset, prefixIds);
  offset = copyTypedArray(output, offset, suffixIds);
  offset = align4(offset);
  offset = copyTypedArray(output, offset, prefixCheckpoints);
  offset = copyTypedArray(output, offset, suffixCheckpoints);
  output.set(prefixBytes, offset);
  offset += prefixBytes.byteLength;
  output.set(suffixBytes, offset);
  return output;
}

export function generateBinary(bangs: readonly Bang[]): Uint8Array {
  const baseline = generateBinaryWithBucketLoad(bangs, 4);
  const optimized = generateBinaryWithBucketLoad(bangs, 4, true);
  const compressedLength = (binary: Uint8Array) =>
    brotliCompressSync(binary, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: binary.byteLength,
      },
    }).byteLength;
  // Catalog updates can change which layout compresses best. Keep the normal
  // builder as a guardrail instead of assuming the tuned layout always wins.
  return compressedLength(optimized) < compressedLength(baseline)
    ? optimized
    : baseline;
}

export interface GeneratedBinaryShards {
  router: Uint8Array;
  shards: Uint8Array[];
}

function estimateBangBinaryByteLength(bangs: readonly Bang[]): number {
  const packed = packBangData(bangs.filter((bang) => !bang.regex));
  const encoder = new TextEncoder();
  let prefixBytes = 0;
  for (const prefix of packed.uniquePrefixes) {
    let payload = prefix;
    if (payload.startsWith("https://")) {
      payload = payload.substring(8);
    } else if (payload.startsWith("http://")) {
      payload = payload.substring(7);
    }
    if (payload.startsWith("www.")) {
      payload = payload.substring(4);
    }
    prefixBytes += encoder.encode(payload).byteLength;
  }
  const suffixBytes = encoder.encode(packed.uniqueSuffixes.join("")).byteLength;
  const bucketCount = nextPow2(Math.max(2, Math.ceil(packed.entryCount / 4)));
  let numericEnd = 13 * Uint32Array.BYTES_PER_ELEMENT;
  numericEnd += bucketCount * Int16Array.BYTES_PER_ELEMENT;
  numericEnd += packed.entryCount * Uint16Array.BYTES_PER_ELEMENT;
  numericEnd = align2(numericEnd);
  numericEnd +=
    (packed.uniquePrefixes.length +
      packed.uniqueSuffixes.length +
      2 * packed.entryCount) *
    Uint16Array.BYTES_PER_ELEMENT;
  numericEnd = align4(numericEnd);
  numericEnd +=
    (Math.ceil(packed.uniquePrefixes.length / BANG_CHECKPOINT_SIZE) +
      Math.ceil(packed.uniqueSuffixes.length / BANG_CHECKPOINT_SIZE)) *
    Uint32Array.BYTES_PER_ELEMENT;
  return numericEnd + prefixBytes + suffixBytes;
}

export function generateBinaryShards(
  bangs: readonly Bang[]
): GeneratedBinaryShards {
  const cells = Array.from({ length: BANG_SHARD_ROUTER_SIZE }, (_, id) => ({
    bangs: [] as Bang[],
    byteWeight: 0,
    id,
  }));
  for (const bang of bangs) {
    if (!bang.regex) {
      const cell = cells[bangShardCell(hashFNV1a(bang.trigger))];
      cell.bangs.push(bang);
    }
  }
  // Weight cells with Flashbang's actual packed representation. Trigger text is
  // deliberately absent from that format, so a generic source-text estimate
  // would optimize bytes that are never transferred.
  for (const cell of cells) {
    cell.byteWeight = estimateBangBinaryByteLength(cell.bangs);
  }
  const bins = Array.from({ length: BANG_SHARD_COUNT }, () => ({
    bangs: [] as Bang[],
    byteWeight: 0,
    cells: [] as number[],
  }));
  for (const cell of cells.sort(
    (left, right) => right.byteWeight - left.byteWeight || left.id - right.id
  )) {
    let target = bins[0];
    for (let i = 1; i < bins.length; i++) {
      if (bins[i].byteWeight < target.byteWeight) {
        target = bins[i];
      }
    }
    target.bangs.push(...cell.bangs);
    target.byteWeight += cell.byteWeight;
    target.cells.push(cell.id);
  }
  const router = new Uint8Array(BANG_SHARD_ROUTER_SIZE);
  for (let shard = 0; shard < bins.length; shard++) {
    for (const cell of bins[shard].cells) {
      router[cell] = shard;
    }
  }
  return {
    router,
    shards: bins.map(({ bangs: shard }) =>
      generateBinaryWithBucketLoad(shard, 4)
    ),
  };
}

export function renderAdvancedLookup(bangs: readonly Bang[]): string {
  if (bangs.length === 0) {
    return "export function lookupAdvancedBang(){return null}";
  }

  const definitions: string[] = [];
  const definitionByKey = new Map<string, number>();
  const definitionIds = new Array<number>(bangs.length);
  for (let i = 0; i < bangs.length; i++) {
    const bang = bangs[i];
    const encoding = bang.captureEncoding ?? CAPTURE_ENCODE_PERCENT;
    const key = `${bang.url}\0${bang.regex}\0${encoding}`;
    let id = definitionByKey.get(key);
    if (id === undefined) {
      id = definitions.length;
      definitionByKey.set(key, id);
      const parsed = parseCaptureTemplate(bang.url);
      if (!(parsed && bang.regex)) {
        throw new Error(`Invalid advanced bang !${bang.trigger}`);
      }
      definitions.push(
        `const _A${id}=['${jsEscape(parsed[0])}',${JSON.stringify(parsed[1])},${JSON.stringify(parsed[2])},new RegExp('${jsEscape(bang.regex)}'),${encoding}];`
      );
    }
    definitionIds[i] = id;
  }

  let lookup = "export function lookupAdvancedBang(trigger){switch(trigger){";
  for (let i = 0; i < bangs.length; i++) {
    lookup += `case'${jsEscape(bangs[i].trigger)}':return _A${definitionIds[i]};`;
  }
  lookup += "default:return null}}";
  return definitions.join("") + lookup;
}

interface GeneratedSnapOverride {
  parts: SnapTargetParts;
  trigger: string;
}

function derivedSnapTarget(url: string): SnapTargetParts | null {
  try {
    const sample = url.replace("{}", "test").replace(/\$[1-9]\d*/g, "test");
    const parsed = new URL(sample);
    const host = parsed.host.startsWith("www.")
      ? parsed.host.substring(4)
      : parsed.host;
    return [`+site:${host}`, parsed.origin];
  } catch {
    return null;
  }
}

function collectSnapOverrides(bangs: readonly Bang[]): GeneratedSnapOverride[] {
  const overrides: GeneratedSnapOverride[] = [];
  for (const bang of bangs) {
    if (!bang.snap) {
      continue;
    }
    const parts = compileSnapTarget(bang.snap);
    if (!parts) {
      console.error(
        `Warning: bang !${bang.trigger} has invalid ad: ${bang.snap}`
      );
      continue;
    }
    const derived = derivedSnapTarget(bang.url);
    if (
      derived &&
      derived[0] === parts[0] &&
      derived[1].replace("://www.", "://") ===
        parts[1].replace("://www.", "://")
    ) {
      continue;
    }
    overrides.push({ trigger: bang.trigger, parts });
  }
  return overrides;
}

export function renderSnapLookup(
  overrides: readonly GeneratedSnapOverride[]
): string {
  if (overrides.length === 0) {
    return "export function lookupSnapOverride(){return null}";
  }

  const definitions: string[] = [];
  const definitionByKey = new Map<string, number>();
  const byHash = new Map<number, Array<{ trigger: string; id: number }>>();
  for (const override of overrides) {
    const key = `${override.parts[0]}\0${override.parts[1]}`;
    let id = definitionByKey.get(key);
    if (id === undefined) {
      id = definitions.length;
      definitionByKey.set(key, id);
      definitions.push(
        `'${jsEscape(override.parts[0])}','${jsEscape(override.parts[1])}'`
      );
    }
    const hash = hashFNV1a(override.trigger);
    const entries = byHash.get(hash);
    const item = { trigger: override.trigger, id };
    if (entries) {
      entries.push(item);
    } else {
      byHash.set(hash, [item]);
    }
  }

  const triggers: string[] = [];
  const definitionIds: number[] = [];
  const indexes: string[] = [];
  const collisions: string[] = [];
  for (const [hash, entries] of byHash) {
    if (entries.length === 1) {
      const entry = entries[0];
      indexes.push(`${hash}:${triggers.length}`);
      triggers.push(`'${jsEscape(entry.trigger)}'`);
      definitionIds.push(entry.id);
      continue;
    }

    let collision = `case ${hash}:`;
    for (const entry of entries) {
      collision += `if(t==='${jsEscape(entry.trigger)}')return _ST[${entry.id * 2}+(o?1:0)];`;
    }
    collisions.push(`${collision}return null;`);
  }

  const collisionLookup = collisions.length
    ? `switch(h>>>0){${collisions.join("")}default:return null}`
    : "return null";
  return (
    `const _ST=[${definitions.join(",")}],` +
    `_SK=[${triggers.join(",")}],` +
    `_SD=[${definitionIds.join(",")}],` +
    `_SI={${indexes.join(",")}};` +
    "export function lookupSnapOverride(t,h,o){" +
    "const i=_SI[h>>>0];" +
    "if(i!==undefined&&_SK[i]===t)return _ST[_SD[i]*2+(o?1:0)];" +
    `${collisionLookup}}`
  );
}

export function generateSparse(bangs: readonly Bang[]): string {
  const snapOverrides = collectSnapOverrides(bangs);
  console.log(`  Snap overrides: ${snapOverrides.length} generated`);
  return (
    `export const BANG_COUNT=${bangs.length};` +
    renderAdvancedLookup(bangs.filter((bang) => bang.regex)) +
    renderSnapLookup(snapOverrides)
  );
}

export function generateMeta(bangs: Bang[]): Uint8Array {
  const fields: string[] = [];
  const captureIndexes: number[] = [];
  for (let i = 0; i < bangs.length; i++) {
    const b = bangs[i];
    for (const value of [b.trigger, b.name, b.domain]) {
      if (value.includes("\0")) {
        throw new Error(`Bang metadata contains NUL: ${b.trigger}`);
      }
      fields.push(value);
    }
    if (b.regex) {
      captureIndexes.push(i);
    }
  }

  const payload = new TextEncoder().encode(
    fields.length === 0 ? "" : `${fields.join("\0")}\0`
  );
  const headerWords = 6;
  const payloadOffset =
    headerWords * Uint32Array.BYTES_PER_ELEMENT +
    captureIndexes.length * Uint32Array.BYTES_PER_ELEMENT;
  const output = new Uint8Array(payloadOffset + payload.byteLength);
  new Uint32Array(output.buffer, 0, headerWords).set([
    0x314d4246,
    1,
    bangs.length,
    captureIndexes.length,
    payloadOffset,
    output.byteLength,
  ]);
  new Uint32Array(
    output.buffer,
    headerWords * Uint32Array.BYTES_PER_ELEMENT,
    captureIndexes.length
  ).set(captureIndexes);
  output.set(payload, payloadOffset);
  return output;
}

type TrieNode = BuildNode<Bang>;

const NODE_EDGE_START = 0;
const NODE_EDGE_COUNT = 1;
const NODE_TERMINAL_INDEX = 2;
const NODE_MAX_RELEVANCE = 3;
const NODE_STRIDE = 4;

const EDGE_CHILD_INDEX = 2;
const EDGE_LABEL_LENGTH = 1;
const EDGE_LABEL_START = 0;
const EDGE_STRIDE = 3;

interface FlatTrieData {
  edges: number[];
  labels: string;
  nodes: number[];
  termD: string[];
  termE: number[];
  termK: string[];
  termR: number[];
  termS: string[];
  endpointPrefixes: string[];
  endpointShapes: number[];
  endpointSuffixes: string[];
}

interface PackedStringData {
  blob: string;
  lengths: number[];
}

interface PackedStringDictionary extends PackedStringData {
  ids: number[];
}

interface PackedUnsignedSection {
  length: number;
  offset: number;
  reader: "_u8" | "_u16" | "_u32";
}

interface PackedUnsignedData {
  bytes: Uint8Array;
  sections: PackedUnsignedSection[];
}

const TRIE_RUNTIME_HELPERS_SOURCE = `
function _u8(b: Uint8Array, offset: number, length: number): Uint8Array {
  return new Uint8Array(b.buffer, b.byteOffset + offset, length);
}

function _u16(b: Uint8Array, offset: number, length: number): Uint16Array {
  const byteOffset = b.byteOffset + offset;
  if ((byteOffset & 1) === 0) {
    return new Uint16Array(b.buffer, byteOffset, length);
  }
  const copy = new Uint8Array(length * 2);
  copy.set(b.subarray(offset, offset + copy.byteLength));
  return new Uint16Array(copy.buffer);
}

function _u32(b: Uint8Array, offset: number, length: number): Uint32Array {
  const byteOffset = b.byteOffset + offset;
  if ((byteOffset & 3) === 0) {
    return new Uint32Array(b.buffer, byteOffset, length);
  }
  const copy = new Uint8Array(length * 4);
  copy.set(b.subarray(offset, offset + copy.byteLength));
  return new Uint32Array(copy.buffer);
}

`;

function flattenTrie(
  root: TrieNode,
  suggestionSites: SuggestionSiteRegistry
): FlatTrieData {
  const nodes: number[] = [];
  const edges: number[] = [];
  let labels = "";
  const termK: string[] = [];
  const termS: string[] = [];
  const termD: string[] = [];
  const termE: number[] = [];
  const termR: number[] = [];
  const endpointPrefixes: string[] = [];
  const endpointSuffixes: string[] = [];
  const endpointShapes: number[] = [];
  const curatedKinds = new Map<string, number>();

  for (const domain of Object.keys(suggestionSites.curated).sort()) {
    const endpoint = suggestionSites.curated[domain];
    const [prefix, suffix] = splitTemplate(endpoint.url);
    if (suffix === null) {
      throw new Error(`Suggestion endpoint for ${domain} has no placeholder`);
    }
    const shapeId = SITE_SUGGESTION_SHAPE[endpoint.shape];
    if (shapeId === undefined) {
      throw new Error(
        `Unknown suggestion response shape for ${domain}: ${endpoint.shape}`
      );
    }
    const id = endpointPrefixes.length;
    curatedKinds.set(domain, id + 3);
    endpointPrefixes.push(prefix);
    endpointSuffixes.push(suffix);
    endpointShapes.push(shapeId);
  }

  function endpointKind(domain: string): number {
    const curated = curatedKinds.get(domain);
    if (curated !== undefined) {
      return curated;
    }
    const mediawikiPath = suggestionSites.mediawiki[domain];
    if (mediawikiPath === "/") {
      return 1;
    }
    return mediawikiPath === "/w/" ? 2 : 0;
  }

  function allocNode(): number {
    const idx = nodes.length / NODE_STRIDE;
    nodes.push(0, 0, -1, 0);
    return idx;
  }

  function visit(node: TrieNode): number {
    const idx = allocNode();
    const sortedChildren = [...node.children.entries()].sort(
      (a, b) => b[1].maxRelevance - a[1].maxRelevance
    );
    const edgeStart = edges.length / EDGE_STRIDE;
    const edgeCount = sortedChildren.length;

    // Reserve this node's edge block contiguously.
    for (const [label] of sortedChildren) {
      const labelStart = labels.length;
      labels += label;
      edges.push(labelStart, label.length, -1);
    }

    for (let i = 0; i < sortedChildren.length; i++) {
      const [, child] = sortedChildren[i];
      const childIdx = visit(child);
      edges[(edgeStart + i) * EDGE_STRIDE + EDGE_CHILD_INDEX] = childIdx;
    }

    let terminalIndex = -1;
    if (node.terminal) {
      const t = node.terminal;
      terminalIndex = termR.length;
      termK.push(t.trigger);
      termS.push(t.name);
      termD.push(t.domain);
      termE.push(endpointKind(t.domain));
      termR.push(t.relevance);
    }

    const nodeOff = idx * NODE_STRIDE;
    nodes[nodeOff + NODE_EDGE_START] = edgeStart;
    nodes[nodeOff + NODE_EDGE_COUNT] = edgeCount;
    nodes[nodeOff + NODE_TERMINAL_INDEX] = terminalIndex;
    nodes[nodeOff + NODE_MAX_RELEVANCE] = node.maxRelevance;

    return idx;
  }

  const rootIdx = visit(root);
  if (rootIdx !== 0) {
    throw new Error(`Unexpected root index ${rootIdx} (expected 0)`);
  }

  return {
    labels,
    nodes,
    edges,
    termK,
    termS,
    termD,
    termE,
    termR,
    endpointPrefixes,
    endpointShapes,
    endpointSuffixes,
  };
}

function packStrings(items: string[]): PackedStringData {
  const lengths = new Array<number>(items.length);
  for (let i = 0; i < items.length; i++) {
    lengths[i] = items[i].length;
  }
  return { blob: items.join(""), lengths };
}

const PACKED_STRING_CHECKPOINT_SHIFT = 5;

function buildPackedStringCheckpoints(lengths: readonly number[]): number[] {
  const checkpoints: number[] = [];
  let offset = 0;
  for (let i = 0; i < lengths.length; i++) {
    if ((i & ((1 << PACKED_STRING_CHECKPOINT_SHIFT) - 1)) === 0) {
      checkpoints.push(offset);
    }
    offset += lengths[i];
  }
  return checkpoints;
}

function packStringDictionary(items: string[]): PackedStringDictionary {
  const dictionary = new Map<string, number>();
  const unique: string[] = [];
  const ids = new Array<number>(items.length);
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let id = dictionary.get(item);
    if (id === undefined) {
      id = unique.length;
      dictionary.set(item, id);
      unique.push(item);
    }
    ids[i] = id;
  }
  return { ...packStrings(unique), ids };
}

function narrowUnsigned(values: readonly number[]): {
  data: Uint8Array | Uint16Array | Uint32Array;
  reader: PackedUnsignedSection["reader"];
} {
  let max = 0;
  for (const value of values) {
    if (!(Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff)) {
      throw new Error(`Cannot pack unsigned integer: ${value}`);
    }
    if (value > max) {
      max = value;
    }
  }
  if (max <= 0xff) {
    return { data: Uint8Array.from(values), reader: "_u8" };
  }
  if (max <= 0xffff) {
    return { data: Uint16Array.from(values), reader: "_u16" };
  }
  return { data: Uint32Array.from(values), reader: "_u32" };
}

function packUnsignedSections(
  sections: readonly number[][]
): PackedUnsignedData {
  const packed = sections.map(narrowUnsigned);
  const metadata: PackedUnsignedSection[] = [];
  let byteLength = 0;
  for (const section of packed) {
    const width = section.data.BYTES_PER_ELEMENT;
    byteLength = (byteLength + width - 1) & ~(width - 1);
    metadata.push({
      length: section.data.length,
      offset: byteLength,
      reader: section.reader,
    });
    byteLength += section.data.byteLength;
  }

  const output = new Uint8Array(byteLength);
  for (let i = 0; i < packed.length; i++) {
    const data = packed[i].data;
    output.set(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      metadata[i].offset
    );
  }
  return {
    bytes: output,
    sections: metadata,
  };
}

function buildMinifiedTrieRuntimeHelpers(): string {
  // Keep this path in-memory for Docker/CI and Bun 1.2.x compatibility.
  const transpiler = new Bun.Transpiler({
    loader: "ts",
    target: "browser",
    minifyWhitespace: true,
  });
  const minified = transpiler.transformSync(TRIE_RUNTIME_HELPERS_SOURCE).trim();
  if (!minified.includes("function _u8(")) {
    throw new Error("Failed to build trie runtime helpers");
  }
  return minified;
}

interface GeneratedTrie {
  binary: Uint8Array;
  js: string;
}

function generateTrie(
  data: FlatTrieData,
  trieRuntimeHelpers: string
): GeneratedTrie {
  const termK = packStrings(data.termK);
  const termS = packStringDictionary(data.termS);
  const termD = packStringDictionary(data.termD);
  const endpointPrefixes = packStrings(data.endpointPrefixes);
  const endpointSuffixes = packStrings(data.endpointSuffixes);
  const nodeCount = data.nodes.length / NODE_STRIDE;
  const edgeCount = data.edges.length / EDGE_STRIDE;
  const nodeEdgeStarts = new Array<number>(nodeCount);
  const nodeEdgeCounts = new Array<number>(nodeCount);
  const nodeTerminalIds = new Array<number>(nodeCount);
  const nodeMaxRelevance = new Array<number>(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    const offset = i * NODE_STRIDE;
    nodeEdgeStarts[i] = data.nodes[offset + NODE_EDGE_START];
    nodeEdgeCounts[i] = data.nodes[offset + NODE_EDGE_COUNT];
    nodeTerminalIds[i] = data.nodes[offset + NODE_TERMINAL_INDEX] + 1;
    nodeMaxRelevance[i] = data.nodes[offset + NODE_MAX_RELEVANCE];
  }

  const edgeLabelStarts = new Array<number>(edgeCount);
  const edgeLabelLengths = new Array<number>(edgeCount);
  const edgeChildren = new Array<number>(edgeCount);
  for (let i = 0; i < edgeCount; i++) {
    const offset = i * EDGE_STRIDE;
    edgeLabelStarts[i] = data.edges[offset + EDGE_LABEL_START];
    edgeLabelLengths[i] = data.edges[offset + EDGE_LABEL_LENGTH];
    edgeChildren[i] = data.edges[offset + EDGE_CHILD_INDEX];
  }

  const packed = packUnsignedSections([
    nodeEdgeStarts,
    nodeEdgeCounts,
    nodeTerminalIds,
    nodeMaxRelevance,
    edgeLabelStarts,
    edgeLabelLengths,
    edgeChildren,
    data.termR,
    termK.lengths,
    buildPackedStringCheckpoints(termK.lengths),
    termS.lengths,
    buildPackedStringCheckpoints(termS.lengths),
    termS.ids,
    termD.lengths,
    buildPackedStringCheckpoints(termD.lengths),
    termD.ids,
    data.termE,
    endpointPrefixes.lengths,
    buildPackedStringCheckpoints(endpointPrefixes.lengths),
    endpointSuffixes.lengths,
    buildPackedStringCheckpoints(endpointSuffixes.lengths),
    data.endpointShapes,
  ]);
  const views = packed.sections.map(
    (section, index) =>
      `const _V${index}=${section.reader}(_B,${section.offset},${section.length});`
  );

  const encoder = new TextEncoder();
  const encodedStrings = [
    data.labels,
    termK.blob,
    termS.blob,
    termD.blob,
    endpointPrefixes.blob,
    endpointSuffixes.blob,
  ].map((value) => encoder.encode(value));
  const stringOffsets: number[] = [];
  let binaryLength = packed.bytes.byteLength;
  for (const value of encodedStrings) {
    stringOffsets.push(binaryLength);
    binaryLength += value.byteLength;
  }
  const binary = new Uint8Array(binaryLength);
  binary.set(packed.bytes);
  for (let i = 0; i < encodedStrings.length; i++) {
    binary.set(encodedStrings[i], stringOffsets[i]);
  }
  const stringExpression = (index: number) =>
    `_s(${stringOffsets[index]},${encodedStrings[index].byteLength})`;

  return {
    binary,
    js:
      "const _F=typeof Bun==='undefined'||typeof __BUNDLED_BANG_TRIE__!=='undefined'?(await import('./bangs-trie.bin')).default:new URL('./bangs-trie.bin',import.meta.url)," +
      `_A=typeof _F==='string'||_F instanceof URL?await Bun.file(typeof _F==='string'?new URL(_F,import.meta.url):_F).arrayBuffer():_F,_B=_A instanceof Uint8Array?_A:new Uint8Array(_A);if(_B.byteLength!==${binary.byteLength})throw new Error('Invalid generated trie data');` +
      trieRuntimeHelpers +
      views.join("") +
      "const _T=new TextDecoder(),_s=(o,l)=>_T.decode(_B.subarray(o,o+l));" +
      "export const NODE_EDGE_STARTS=_V0;" +
      "export const NODE_EDGE_COUNTS=_V1;" +
      "export const NODE_TERMINALS=_V2;" +
      "export const NODE_MAX_RELEVANCE=_V3;" +
      "export const EDGE_LABEL_STARTS=_V4;" +
      "export const EDGE_LABEL_LENGTHS=_V5;" +
      "export const EDGE_CHILDREN=_V6;" +
      "export const TERM_R=_V7;" +
      `export const LABELS=${stringExpression(0)};` +
      `export const TERM_K_BLOB=${stringExpression(1)};` +
      "export const TERM_K_LEN=_V8;" +
      "export const TERM_K_CP=_V9;" +
      `export const TERM_S_BLOB=${stringExpression(2)};` +
      "export const TERM_S_LEN=_V10;" +
      "export const TERM_S_CP=_V11;" +
      "export const TERM_S_ID=_V12;" +
      `export const TERM_D_BLOB=${stringExpression(3)};` +
      "export const TERM_D_LEN=_V13;" +
      "export const TERM_D_CP=_V14;" +
      "export const TERM_D_ID=_V15;" +
      "export const TERM_E_KIND=_V16;" +
      `export const ENDPOINT_P_BLOB=${stringExpression(4)};` +
      "export const ENDPOINT_P_LEN=_V17;" +
      "export const ENDPOINT_P_CP=_V18;" +
      `export const ENDPOINT_S_BLOB=${stringExpression(5)};` +
      "export const ENDPOINT_S_LEN=_V19;" +
      "export const ENDPOINT_S_CP=_V20;" +
      "export const ENDPOINT_SHAPE=_V21;" +
      "export const ROOT=0;" +
      "export const TRIE_SCHEMA=4;",
  };
}

interface CodegenOptions {
  fromMerged?: boolean;
  noFetch?: boolean;
}

async function fetchBangSources(): Promise<void> {
  console.log("=== Fetch bang sources ===");
  await mkdir(DATA_DIR, { recursive: true });
  const [kagiRes, ddgRes] = await Promise.all([
    fetch(KAGI_SOURCE_URL),
    fetch(DDG_SOURCE_URL),
  ]);
  await Promise.all([
    Bun.write(KAGI_BANGS_PATH, kagiRes),
    Bun.write(DDG_BANGS_PATH, ddgRes),
  ]);
}

async function parseBangSourcesFromDisk(): Promise<NamedBangSource[]> {
  console.log("=== Parse sources ===");
  const [ddgRaw, kagiRaw, customData] = await Promise.all([
    Bun.file(DDG_BANGS_PATH).text(),
    Bun.file(KAGI_BANGS_PATH).text(),
    Bun.file(CUSTOM_BANGS_PATH).json(),
  ]);

  const sources: NamedBangSource[] = [
    { name: "ddg", bangs: parseDdg(ddgRaw) },
    { name: "kagi", bangs: parseKagi(kagiRaw) },
    { name: "custom", bangs: parseCustom(customData as CustomBangMap) },
  ];

  for (const source of sources) {
    console.log(
      `${source.name.toUpperCase()}: ${source.bangs.length} bangs parsed`
    );
  }
  return sources;
}

function mergeAndValidateSources(sources: readonly NamedBangSource[]): Bang[] {
  console.log("=== Merge + validate ===");
  const merged = mergeSources(sources);
  console.log(`Merged: ${merged.length} unique bangs`);
  const valid = validateBangs(merged);
  console.log(`Valid: ${valid.length} bangs after validation`);
  return valid;
}

async function saveMergedBangs(bangs: readonly Bang[]): Promise<void> {
  console.log("=== Save merged bangs ===");
  await Bun.write(MERGED_BANGS_PATH, JSON.stringify(bangs));
  console.log(`  ${MERGED_BANGS_PATH}: ${bangs.length} bangs`);
}

async function loadBangs(options: CodegenOptions): Promise<Bang[]> {
  const { fromMerged = false, noFetch = false } = options;
  if (fromMerged) {
    console.log("=== Read merged bangs ===");
    const merged = await Bun.file(MERGED_BANGS_PATH).json();
    const bangs = validateBangs(merged as Bang[]);
    console.log(`Loaded ${bangs.length} bangs from ${MERGED_BANGS_PATH}`);
    return bangs;
  }

  if (!noFetch) {
    await fetchBangSources();
  }
  const parsedSources = await parseBangSourcesFromDisk();
  const valid = mergeAndValidateSources(parsedSources);
  await saveMergedBangs(valid);
  return valid;
}

interface GeneratedArtifacts {
  binary: Uint8Array;
  hotJs: string;
  meta: Uint8Array;
  sparseJs: string;
  trieBinary: Uint8Array;
  trieLoaderJs: string;
}

function generateHotBangs(bangs: readonly Bang[]): string {
  const hot = bangs
    .filter((bang) => {
      if (bang.regex) {
        return false;
      }
      const placeholder = bang.url.indexOf("{}");
      if (
        placeholder === -1 ||
        bang.url.indexOf("{}", placeholder + 2) !== -1
      ) {
        return false;
      }
      const prefix = bang.url.substring(0, placeholder);
      const query = prefix.indexOf("?");
      const fragment = prefix.indexOf("#");
      return query !== -1 && fragment === -1;
    })
    .sort(
      (a, b) => b.relevance - a.relevance || a.trigger.localeCompare(b.trigger)
    )
    .slice(0, HOT_BANG_LIMIT);

  const prefixes: string[] = [];
  const suffixes: string[] = [];
  const lookupGroups = new Map<
    number,
    Map<number, Array<{ id: number; trigger: string }>>
  >();
  for (let i = 0; i < hot.length; i++) {
    const bang = hot[i];
    const placeholder = bang.url.indexOf("{}");
    prefixes.push(bang.url.substring(0, placeholder));
    suffixes.push(bang.url.substring(placeholder + 2));
    let byFirst = lookupGroups.get(bang.trigger.length);
    if (!byFirst) {
      byFirst = new Map();
      lookupGroups.set(bang.trigger.length, byFirst);
    }
    const first = bang.trigger.charCodeAt(0);
    const entries = byFirst.get(first) ?? [];
    entries.push({ id: i, trigger: bang.trigger });
    byFirst.set(first, entries);
  }

  const lookupCases = [...lookupGroups]
    .sort(([left], [right]) => left - right)
    .map(([length, byFirst]) => {
      if (length === 1) {
        const cases = [...byFirst].map(
          ([first, entries]) => `case ${first}:return ${entries[0].id};`
        );
        return `case 1:switch(q.charCodeAt(s)){${cases.join("")}default:return -1}`;
      }
      if (length === 2) {
        const cases = [...byFirst]
          .flatMap(([, entries]) => entries)
          .map(
            ({ id, trigger }) =>
              `case ${trigger.charCodeAt(0) * 65536 + trigger.charCodeAt(1)}:return ${id};`
          );
        return `case 2:switch(q.charCodeAt(s)*65536+q.charCodeAt(s+1)){${cases.join("")}default:return -1}`;
      }
      const cases = [...byFirst].map(([first, entries]) => {
        const checks = entries
          .map(
            ({ id, trigger }) =>
              `if(q.startsWith(${JSON.stringify(trigger)},s))return ${id};`
          )
          .join("");
        return `case ${first}:${checks}return -1;`;
      });
      return `case ${length}:switch(q.charCodeAt(s)){${cases.join("")}default:return -1}`;
    });

  return (
    `export const HOT_BANG_COUNT=${hot.length};` +
    `export const HOT_TRIGGERS=${JSON.stringify(hot.map((bang) => bang.trigger))};` +
    `export const HOT_PREFIXES=${JSON.stringify(prefixes)};` +
    `export const HOT_SUFFIXES=${JSON.stringify(suffixes)};` +
    `export function lookupHotBang(q,s,e){switch(e-s){${lookupCases.join("")}default:return -1}}`
  );
}

export function buildGeneratedArtifacts(
  bangs: Bang[],
  suggestionSites: SuggestionSiteRegistry = { curated: {}, mediawiki: {} }
): GeneratedArtifacts {
  const trieRoot = buildRadixTrie(
    bangs,
    (b) => b.trigger,
    (b) => b.relevance
  );
  const trieData = flattenTrie(trieRoot, suggestionSites);
  const trieRuntimeHelpers = buildMinifiedTrieRuntimeHelpers();
  const trie = generateTrie(trieData, trieRuntimeHelpers);
  return {
    binary: generateBinary(bangs),
    hotJs: generateHotBangs(bangs),
    meta: generateMeta(bangs),
    sparseJs: generateSparse(bangs),
    trieBinary: trie.binary,
    trieLoaderJs: trie.js,
  };
}

async function writeGeneratedArtifacts(
  outDir: string,
  artifacts: GeneratedArtifacts
): Promise<void> {
  await Promise.all([
    rm(`${outDir}/bangs-meta.js`, { force: true }),
    rm(`${outDir}/bangs-meta.d.ts`, { force: true }),
    rm(`${outDir}/bangs-trie.js`, { force: true }),
    rm(`${outDir}/bangs-trie.d.ts`, { force: true }),
    Bun.write(`${outDir}/bangs.bin`, artifacts.binary),
    Bun.write(`${outDir}/bangs-hot.js`, artifacts.hotJs),
    Bun.write(`${outDir}/bangs-meta.bin`, artifacts.meta),
    Bun.write(`${outDir}/bangs-sparse.js`, artifacts.sparseJs),
    Bun.write(`${outDir}/bangs-trie.bin`, artifacts.trieBinary),
    Bun.write(`${outDir}/bangs-trie-loader.js`, artifacts.trieLoaderJs),
  ]);
  console.log(`  bangs.bin: ${artifacts.binary.byteLength} bytes`);
  console.log(`  bangs-hot.js: ${artifacts.hotJs.length} bytes`);
  console.log(`  bangs-meta.bin: ${artifacts.meta.byteLength} bytes`);
  console.log(`  bangs-sparse.js: ${artifacts.sparseJs.length} bytes`);
  console.log(`  bangs-trie.bin: ${artifacts.trieBinary.byteLength} bytes`);
  console.log(`  bangs-trie-loader.js: ${artifacts.trieLoaderJs.length} bytes`);
}

async function writeGeneratedDeclarations(outDir: string): Promise<void> {
  await Promise.all([
    Bun.write(
      `${outDir}/bangs-hot.d.ts`,
      [
        "export declare const HOT_BANG_COUNT: number;",
        "export declare const HOT_TRIGGERS: readonly string[];",
        "export declare const HOT_PREFIXES: readonly string[];",
        "export declare const HOT_SUFFIXES: readonly string[];",
        "export declare function lookupHotBang(rawQuery: string, start: number, end: number): number;",
        "",
      ].join("\n")
    ),
    Bun.write(
      `${outDir}/bangs-sparse.d.ts`,
      [
        "export declare const BANG_COUNT: number;",
        "export declare function lookupAdvancedBang(trigger: string): readonly [string, readonly string[], readonly number[], RegExp, number] | null;",
        "export declare function lookupSnapOverride(trigger: string, hash: number, origin: boolean): string | null;",
        "",
      ].join("\n")
    ),
    Bun.write(
      `${outDir}/bangs-trie-loader.d.ts`,
      [
        "export declare const LABELS: string;",
        "export declare const NODE_EDGE_STARTS: Uint8Array | Uint16Array | Uint32Array;",
        "export declare const NODE_EDGE_COUNTS: Uint8Array | Uint16Array | Uint32Array;",
        "export declare const NODE_TERMINALS: Uint8Array | Uint16Array | Uint32Array;",
        "export declare const NODE_MAX_RELEVANCE: Uint8Array | Uint16Array | Uint32Array;",
        "export declare const EDGE_LABEL_STARTS: Uint8Array | Uint16Array | Uint32Array;",
        "export declare const EDGE_LABEL_LENGTHS: Uint8Array | Uint16Array | Uint32Array;",
        "export declare const EDGE_CHILDREN: Uint8Array | Uint16Array | Uint32Array;",
        "export declare const TERM_R: Uint8Array | Uint16Array | Uint32Array;",
        "export declare const TERM_K_BLOB: string;",
        "export declare const TERM_K_LEN: Uint8Array | Uint16Array | Uint32Array;",
        "export declare const TERM_K_CP: Uint8Array | Uint16Array | Uint32Array;",
        "export declare const TERM_S_BLOB: string;",
        "export declare const TERM_S_LEN: Uint8Array | Uint16Array | Uint32Array;",
        "export declare const TERM_S_CP: Uint8Array | Uint16Array | Uint32Array;",
        "export declare const TERM_S_ID: Uint8Array | Uint16Array | Uint32Array;",
        "export declare const TERM_D_BLOB: string;",
        "export declare const TERM_D_LEN: Uint8Array | Uint16Array | Uint32Array;",
        "export declare const TERM_D_CP: Uint8Array | Uint16Array | Uint32Array;",
        "export declare const TERM_D_ID: Uint8Array | Uint16Array | Uint32Array;",
        "export declare const TERM_E_KIND: Uint8Array | Uint16Array | Uint32Array;",
        "export declare const ENDPOINT_P_BLOB: string;",
        "export declare const ENDPOINT_P_LEN: Uint8Array | Uint16Array | Uint32Array;",
        "export declare const ENDPOINT_P_CP: Uint8Array | Uint16Array | Uint32Array;",
        "export declare const ENDPOINT_S_BLOB: string;",
        "export declare const ENDPOINT_S_LEN: Uint8Array | Uint16Array | Uint32Array;",
        "export declare const ENDPOINT_S_CP: Uint8Array | Uint16Array | Uint32Array;",
        "export declare const ENDPOINT_SHAPE: Uint8Array | Uint16Array | Uint32Array;",
        "export declare const ROOT: number;",
        "export declare const TRIE_SCHEMA: 4;",
        "",
      ].join("\n")
    ),
  ]);
}

export async function runCodegen(options: CodegenOptions = {}): Promise<void> {
  const bangs = await loadBangs(options);
  const suggestionSites: SuggestionSiteRegistry =
    await Bun.file(SUGGEST_SITES_PATH).json();
  for (const [domain, suggestionSite] of Object.entries(
    suggestionSites.curated
  )) {
    const error = validateSimpleBangUrl(suggestionSite.url);
    if (error) {
      throw new Error(`Invalid suggestion endpoint for ${domain}: ${error}`);
    }
  }
  for (const [domain, path] of Object.entries(suggestionSites.mediawiki)) {
    if (path !== "/" && path !== "/w/") {
      throw new Error(`Invalid MediaWiki API path for ${domain}: ${path}`);
    }
    if (suggestionSites.curated[domain]) {
      throw new Error(`Duplicate suggestion capability for ${domain}`);
    }
  }

  console.log("=== Generate ===");
  await mkdir(GENERATED_OUT_DIR, { recursive: true });
  const artifacts = buildGeneratedArtifacts(bangs, suggestionSites);
  await writeGeneratedArtifacts(GENERATED_OUT_DIR, artifacts);
  await writeGeneratedDeclarations(GENERATED_OUT_DIR);
  console.log(`Generated ${bangs.length} bangs in ${GENERATED_OUT_DIR}/`);
}

async function main(): Promise<void> {
  const noFetch = process.argv.includes("--no-fetch");
  const fromMerged = process.argv.includes("--from-merged");
  await runCodegen({ fromMerged, noFetch });
}

if (import.meta.main) {
  await main();
}
