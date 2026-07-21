import { Buffer } from "node:buffer";
import { mkdir, rm } from "node:fs/promises";
import { $ } from "bun";
import {
  CAPTURE_ENCODE_PERCENT,
  CAPTURE_ENCODE_PLUS,
  CAPTURE_ENCODE_RAW,
  parseCaptureTemplate,
  validateCaptureBang,
  validateSimpleBangUrl,
} from "../src/shared/capture-template";
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
  "src/generated/bangs-trie.js",
  "src/generated/bangs-hot.js",
] as const;

const DATA_DIR = "data";
const DDG_BANGS_PATH = `${DATA_DIR}/ddg.json`;
const KAGI_BANGS_PATH = `${DATA_DIR}/kagi.json`;
const CUSTOM_BANGS_PATH = `${DATA_DIR}/custom-bangs.json`;
const MERGED_BANGS_PATH = `${DATA_DIR}/bangs.json`;
const GENERATED_OUT_DIR = "src/generated";
const HOT_BANG_LIMIT = 24;

const DDG_SOURCE_URL = "https://duckduckgo.com/bang.js";
const KAGI_SOURCE_URL =
  "https://raw.githubusercontent.com/kagisearch/bangs/main/data/bangs.json";

export async function ensureGeneratedBangData(
  fromMerged = true
): Promise<void> {
  const missing: string[] = [];
  for (const file of GENERATED_BANG_DATA_FILES) {
    if (!(await Bun.file(file).exists())) {
      missing.push(file);
    }
  }

  if (missing.length === 0) {
    return;
  }

  const mode = fromMerged ? " --from-merged" : "";
  console.warn(
    `Generated bang data missing (${missing.join(", ")}). Running codegen${mode}...`
  );

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

function parseDdg(raw: string): Bang[] {
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

function parseKagi(raw: string): Bang[] {
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

function parseCustom(data: CustomBangMap): Bang[] {
  return Object.entries(data).map(([trigger, b]) => ({
    trigger: trigger.toLowerCase(),
    name: b.name,
    domain: b.domain,
    url: b.url,
    relevance: 0,
    ...(b.snap ? { snap: b.snap } : {}),
  }));
}

function mergeSources(sources: readonly NamedBangSource[]): Bang[] {
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
const MPH_MAX_DISPLACEMENT = 1_000_000;

function mphBucket(hash: number, mask: number): number {
  return hash & mask;
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
  triggers: readonly string[]
): MinimalPerfectHash {
  const entryCount = triggers.length;
  if (entryCount === 0) {
    throw new Error("Binary bang format requires at least one regular entry");
  }
  const bucketCount = nextPow2(Math.max(2, Math.ceil(entryCount / 4)));
  const bucketMask = bucketCount - 1;
  const hashes = Uint32Array.from(triggers, hashFNV1a);
  const knownHashes = new Map<number, string>();
  const buckets = Array.from({ length: bucketCount }, () => [] as number[]);
  for (let i = 0; i < entryCount; i++) {
    const hash = hashes[i];
    const collision = knownHashes.get(hash);
    if (collision !== undefined) {
      throw new Error(
        `Binary bang MPHF requires collision-free hashes: ${collision}, ${triggers[i]}`
      );
    }
    knownHashes.set(hash, triggers[i]);
    buckets[mphBucket(hash, bucketMask)].push(i);
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

function align2(value: number): number {
  return (value + 1) & ~1;
}

interface PackedBangData {
  entryCount: number;
  prefixIds: number[];
  suffixIdsPlusOne: number[];
  triggers: string[];
  uniquePrefixes: string[];
  uniqueSuffixes: string[];
  prefixBlob: ReturnType<typeof packBlob>;
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

  const prefixBlob = packBlob(uniquePrefixes);
  const suffixBlob = packBlob(uniqueSuffixes);
  for (const len of prefixBlob.lengths) {
    if (len > 0xffff) {
      throw new Error(
        `Binary bang format requires prefix length <= 65535, got ${len}`
      );
    }
  }
  for (const len of suffixBlob.lengths) {
    if (len > 0xffff) {
      throw new Error(
        `Binary bang format requires suffix length <= 65535, got ${len}`
      );
    }
  }

  return {
    entryCount,
    prefixBlob,
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
  values: Uint8Array | Uint16Array | Int16Array | Int32Array
): number {
  output.set(
    new Uint8Array(values.buffer, values.byteOffset, values.byteLength),
    offset
  );
  return offset + values.byteLength;
}

function generateBinary(bangs: readonly Bang[]): Uint8Array {
  const packed = packBangData(bangs.filter((bang) => !bang.regex));
  const mph = buildMinimalPerfectHash(packed.triggers);
  const triggers = Array.from(
    mph.slotToEntry,
    (entry) => packed.triggers[entry]
  );
  const reorderedPrefixIds = Array.from(
    mph.slotToEntry,
    (entry) => packed.prefixIds[entry]
  );
  const reorderedSuffixIds = Array.from(
    mph.slotToEntry,
    (entry) => packed.suffixIdsPlusOne[entry]
  );
  const triggerBlob = packBlob(triggers);
  const encoder = new TextEncoder();
  const triggerBytes = encoder.encode(triggerBlob.blob);
  const prefixBytes = encoder.encode(packed.prefixBlob.blob);
  const suffixBytes = encoder.encode(packed.suffixBlob.blob);
  const triggerByteLengths = triggers.map(
    (trigger) => encoder.encode(trigger).byteLength
  );
  const triggerMaxLength = Math.max(...triggerByteLengths);
  if (triggerMaxLength > 0x7fff) {
    throw new Error(
      `Binary bang format requires encoded trigger length <= 32767, got ${triggerMaxLength}`
    );
  }
  const triggerLengthWidth = triggerMaxLength <= 0x7f ? 1 : 2;
  const nonAsciiFlag = triggerLengthWidth === 1 ? 0x80 : 0x8000;
  const triggerLengths =
    triggerLengthWidth === 1
      ? Uint8Array.from(triggerByteLengths, (length, index) =>
          length === triggers[index].length ? length : length | nonAsciiFlag
        )
      : Uint16Array.from(triggerByteLengths, (length, index) =>
          length === triggers[index].length ? length : length | nonAsciiFlag
        );
  // URL blobs stay byte-backed in the worker and are decoded one entry at a time.
  const prefixLengths = Uint16Array.from(packed.uniquePrefixes, (value) => {
    const length = encoder.encode(value).byteLength;
    if (length > 0xffff) {
      throw new Error(
        `Binary bang format requires encoded prefix length <= 65535, got ${length}`
      );
    }
    return length;
  });
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

  const headerWords = 13;
  const headerBytes = headerWords * Uint32Array.BYTES_PER_ELEMENT;
  let numericEnd = headerBytes + mph.displacements.byteLength;
  numericEnd += triggerLengths.byteLength;
  numericEnd = align2(numericEnd);
  numericEnd +=
    prefixLengths.byteLength +
    suffixLengths.byteLength +
    prefixIds.byteLength +
    suffixIds.byteLength;
  const totalBytes =
    numericEnd +
    triggerBytes.byteLength +
    prefixBytes.byteLength +
    suffixBytes.byteLength;
  const output = new Uint8Array(new ArrayBuffer(totalBytes));
  new Uint32Array(output.buffer, 0, headerWords).set([
    0x31424246,
    4,
    packed.entryCount,
    mph.displacements.length,
    triggerLengths.BYTES_PER_ELEMENT,
    packed.uniquePrefixes.length,
    packed.uniqueSuffixes.length,
    triggerBytes.byteLength,
    prefixBytes.byteLength,
    suffixBytes.byteLength,
    numericEnd,
    totalBytes,
    mph.displacements.BYTES_PER_ELEMENT,
  ]);

  let offset = headerBytes;
  offset = copyTypedArray(output, offset, mph.displacements);
  offset = copyTypedArray(output, offset, triggerLengths);
  offset = align2(offset);
  offset = copyTypedArray(output, offset, prefixLengths);
  offset = copyTypedArray(output, offset, suffixLengths);
  offset = copyTypedArray(output, offset, prefixIds);
  offset = copyTypedArray(output, offset, suffixIds);
  output.set(triggerBytes, offset);
  offset += triggerBytes.byteLength;
  output.set(prefixBytes, offset);
  offset += prefixBytes.byteLength;
  output.set(suffixBytes, offset);
  return output;
}

function renderAdvancedLookup(bangs: readonly Bang[]): string {
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

function renderSnapLookup(overrides: readonly GeneratedSnapOverride[]): string {
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

function generateSparse(bangs: readonly Bang[]): string {
  const snapOverrides = collectSnapOverrides(bangs);
  console.log(`  Snap overrides: ${snapOverrides.length} generated`);
  return (
    `export const BANG_COUNT=${bangs.length};` +
    renderAdvancedLookup(bangs.filter((bang) => bang.regex)) +
    renderSnapLookup(snapOverrides)
  );
}

function generateMeta(bangs: Bang[]): Uint8Array {
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
  termK: string[];
  termR: number[];
  termS: string[];
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
  base64: string;
  sections: PackedUnsignedSection[];
}

const TRIE_RUNTIME_HELPERS_SOURCE = `
function _b64bytes(s: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(s);
    const len = bin.length;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  }
  if (typeof Buffer !== "undefined") {
    const b = Buffer.from(s, "base64");
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  }
  throw new Error("No base64 decoder available");
}

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

function _offsets(lengths: Uint8Array | Uint16Array | Uint32Array): Int32Array {
  const out = new Int32Array(lengths.length + 1);
  for (let i = 0; i < lengths.length; i++) {
    out[i + 1] = out[i] + lengths[i];
  }
  return out;
}
`;

function flattenTrie(root: TrieNode): FlatTrieData {
  const nodes: number[] = [];
  const edges: number[] = [];
  let labels = "";
  const termK: string[] = [];
  const termS: string[] = [];
  const termD: string[] = [];
  const termR: number[] = [];

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

  return { labels, nodes, edges, termK, termS, termD, termR };
}

function packStrings(items: string[]): PackedStringData {
  const lengths = new Array<number>(items.length);
  for (let i = 0; i < items.length; i++) {
    lengths[i] = items[i].length;
  }
  return { blob: items.join(""), lengths };
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
    base64: Buffer.from(output).toString("base64"),
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
  if (!minified.includes("function _b64bytes(")) {
    throw new Error("Failed to build trie runtime helpers");
  }
  return minified;
}

function generateTrie(data: FlatTrieData, trieRuntimeHelpers: string): string {
  const termK = packStrings(data.termK);
  const termS = packStringDictionary(data.termS);
  const termD = packStringDictionary(data.termD);
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
    termS.lengths,
    termS.ids,
    termD.lengths,
    termD.ids,
  ]);
  const views = packed.sections.map(
    (section, index) =>
      `const _V${index}=${section.reader}(_B,${section.offset},${section.length});`
  );

  return (
    trieRuntimeHelpers +
    `const _B=_b64bytes('${packed.base64}');` +
    views.join("") +
    `export const NODES=new Int32Array(${data.nodes.length});` +
    `for(let i=0;i<${nodeCount};i++){const o=i*${NODE_STRIDE};NODES[o]=_V0[i];NODES[o+1]=_V1[i];NODES[o+2]=_V2[i]-1;NODES[o+3]=_V3[i]}` +
    `export const EDGES=new Int32Array(${data.edges.length});` +
    `for(let i=0;i<${edgeCount};i++){const o=i*${EDGE_STRIDE};EDGES[o]=_V4[i];EDGES[o+1]=_V5[i];EDGES[o+2]=_V6[i]}` +
    "export const TERM_R=Int32Array.from(_V7);" +
    `export const LABELS='${jsEscape(data.labels)}';` +
    `export const TERM_K_BLOB='${jsEscape(termK.blob)}';` +
    "export const TERM_K_OFF=_offsets(_V8);" +
    `export const TERM_S_BLOB='${jsEscape(termS.blob)}';` +
    "export const TERM_S_OFF=_offsets(_V9);" +
    "export const TERM_S_ID=_V10;" +
    `export const TERM_D_BLOB='${jsEscape(termD.blob)}';` +
    "export const TERM_D_OFF=_offsets(_V11);" +
    "export const TERM_D_ID=_V12;" +
    "export const ROOT=0;"
  );
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
  trieJs: string;
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

function buildGeneratedArtifacts(bangs: Bang[]): GeneratedArtifacts {
  const trieRoot = buildRadixTrie(
    bangs,
    (b) => b.trigger,
    (b) => b.relevance
  );
  const trieData = flattenTrie(trieRoot);
  const trieRuntimeHelpers = buildMinifiedTrieRuntimeHelpers();
  return {
    binary: generateBinary(bangs),
    hotJs: generateHotBangs(bangs),
    meta: generateMeta(bangs),
    sparseJs: generateSparse(bangs),
    trieJs: generateTrie(trieData, trieRuntimeHelpers),
  };
}

async function writeGeneratedArtifacts(
  outDir: string,
  artifacts: GeneratedArtifacts
): Promise<void> {
  await Promise.all([
    rm(`${outDir}/bangs-meta.js`, { force: true }),
    rm(`${outDir}/bangs-meta.d.ts`, { force: true }),
    Bun.write(`${outDir}/bangs.bin`, artifacts.binary),
    Bun.write(`${outDir}/bangs-hot.js`, artifacts.hotJs),
    Bun.write(`${outDir}/bangs-meta.bin`, artifacts.meta),
    Bun.write(`${outDir}/bangs-sparse.js`, artifacts.sparseJs),
    Bun.write(`${outDir}/bangs-trie.js`, artifacts.trieJs),
  ]);
  console.log(`  bangs.bin: ${artifacts.binary.byteLength} bytes`);
  console.log(`  bangs-hot.js: ${artifacts.hotJs.length} bytes`);
  console.log(`  bangs-meta.bin: ${artifacts.meta.byteLength} bytes`);
  console.log(`  bangs-sparse.js: ${artifacts.sparseJs.length} bytes`);
  console.log(`  bangs-trie.js: ${artifacts.trieJs.length} bytes`);
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
      `${outDir}/bangs-trie.d.ts`,
      [
        "export declare const LABELS: string;",
        "export declare const NODES: Int32Array;",
        "export declare const EDGES: Int32Array;",
        "export declare const TERM_R: Int32Array;",
        "export declare const TERM_K_BLOB: string;",
        "export declare const TERM_K_OFF: Int32Array;",
        "export declare const TERM_S_BLOB: string;",
        "export declare const TERM_S_OFF: Int32Array;",
        "export declare const TERM_S_ID: Uint8Array | Uint16Array | Uint32Array;",
        "export declare const TERM_D_BLOB: string;",
        "export declare const TERM_D_OFF: Int32Array;",
        "export declare const TERM_D_ID: Uint8Array | Uint16Array | Uint32Array;",
        "export declare const ROOT: number;",
        "",
      ].join("\n")
    ),
  ]);
}

export async function runCodegen(options: CodegenOptions = {}): Promise<void> {
  const bangs = await loadBangs(options);

  console.log("=== Generate ===");
  await mkdir(GENERATED_OUT_DIR, { recursive: true });
  const artifacts = buildGeneratedArtifacts(bangs);
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
