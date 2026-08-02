import {
  EDGE_CHILDREN,
  EDGE_LABEL_LENGTHS,
  EDGE_LABEL_STARTS,
  ENDPOINT_P_BLOB,
  ENDPOINT_P_CP,
  ENDPOINT_P_LEN,
  ENDPOINT_S_BLOB,
  ENDPOINT_S_CP,
  ENDPOINT_S_LEN,
  ENDPOINT_SHAPE,
  LABELS,
  NODE_EDGE_COUNTS,
  NODE_EDGE_STARTS,
  NODE_MAX_RELEVANCE,
  NODE_TERMINALS,
  ROOT,
  TERM_D_BLOB,
  TERM_D_CP,
  TERM_D_ID,
  TERM_D_LEN,
  TERM_E_KIND,
  TERM_K_BLOB,
  TERM_K_CP,
  TERM_K_LEN,
  TERM_R,
  TERM_S_BLOB,
  TERM_S_CP,
  TERM_S_ID,
  TERM_S_LEN,
} from "./generated/bangs-trie.js";
import {
  FRECENCY_BOOST_CAP,
  FRECENCY_BOOST_MULTIPLIER,
  JSON_HEADERS,
  SITE_SUGGESTION_SHAPE,
  TOP_K,
} from "./shared/constants";

interface Candidate {
  terminalIndex: number;
  trigger: string;
  score: number;
}

const JSON_HEADERS_INIT = { headers: JSON_HEADERS };
const EMPTY_CANDIDATES: Candidate[] = [];

const TERM_K_CACHE = new Array<string | undefined>(TERM_R.length);
const EMPTY_DETAIL: Record<string, string> = {};
export interface BangSuggestionMeta {
  detail: Record<string, string>;
  label: string;
  url: string;
}

const TERM_META_CACHE = new Array<BangSuggestionMeta | undefined>(
  TERM_R.length
);
const DOMAIN_CACHE = new Array<string | undefined>(TERM_D_LEN.length);
const ENDPOINT_PREFIX_CACHE = new Array<string | undefined>(
  ENDPOINT_SHAPE.length
);
const ENDPOINT_SUFFIX_CACHE = new Array<string | undefined>(
  ENDPOINT_SHAPE.length
);
type PackedLengths = Uint8Array | Uint16Array | Uint32Array;
const PACKED_STRING_CHECKPOINT_SHIFT = 5;

function readPackedStringCached(
  blob: string,
  lengths: PackedLengths,
  checkpoints: PackedLengths,
  cache: (string | undefined)[],
  index: number
): string {
  const cached = cache[index];
  if (cached !== undefined) {
    return cached;
  }
  const block = index >> PACKED_STRING_CHECKPOINT_SHIFT;
  let start = checkpoints[block];
  const blockStart = block << PACKED_STRING_CHECKPOINT_SHIFT;
  for (let i = blockStart; i < index; i++) {
    start += lengths[i];
  }
  const value = blob.slice(start, start + lengths[index]);
  cache[index] = value;
  return value;
}

function readPackedString(
  blob: string,
  lengths: PackedLengths,
  checkpoints: PackedLengths,
  index: number
): string {
  const block = index >> PACKED_STRING_CHECKPOINT_SHIFT;
  let start = checkpoints[block];
  const blockStart = block << PACKED_STRING_CHECKPOINT_SHIFT;
  for (let i = blockStart; i < index; i++) {
    start += lengths[i];
  }
  return blob.slice(start, start + lengths[index]);
}

function readTerminalTrigger(index: number): string {
  return readPackedStringCached(
    TERM_K_BLOB,
    TERM_K_LEN,
    TERM_K_CP,
    TERM_K_CACHE,
    index
  );
}

function readTerminalDomain(index: number): string {
  const domainId = TERM_D_ID[index];
  return readPackedStringCached(
    TERM_D_BLOB,
    TERM_D_LEN,
    TERM_D_CP,
    DOMAIN_CACHE,
    domainId
  );
}

function readTerminalMeta(index: number): BangSuggestionMeta {
  const cached = TERM_META_CACHE[index];
  if (cached !== undefined) {
    return cached;
  }
  const nameId = TERM_S_ID[index];
  const domain = readTerminalDomain(index);
  const name = readPackedString(TERM_S_BLOB, TERM_S_LEN, TERM_S_CP, nameId);
  const label = `${name} \u2014 ${domain}`;
  const url = `https://${domain}`;
  const meta = {
    label,
    url,
    detail: { a: label, i: `${url}/favicon.ico` },
  };
  TERM_META_CACHE[index] = meta;
  return meta;
}

function findTerminalIndex(trigger: string): number {
  let node = ROOT;
  let pos = 0;

  while (pos < trigger.length) {
    const edgeStart = NODE_EDGE_STARTS[node];
    const edgeCount = NODE_EDGE_COUNTS[node];
    let child = -1;

    for (let i = 0; i < edgeCount; i++) {
      const edge = edgeStart + i;
      const labelStart = EDGE_LABEL_STARTS[edge];
      const labelLength = EDGE_LABEL_LENGTHS[edge];
      if (
        LABELS.charCodeAt(labelStart) !== trigger.charCodeAt(pos) ||
        pos + labelLength > trigger.length
      ) {
        continue;
      }
      let match = 1;
      while (
        match < labelLength &&
        LABELS.charCodeAt(labelStart + match) ===
          trigger.charCodeAt(pos + match)
      ) {
        match++;
      }
      if (match !== labelLength) {
        return -1;
      }
      child = EDGE_CHILDREN[edge];
      pos += labelLength;
      break;
    }

    if (child < 0) {
      return -1;
    }
    node = child;
  }

  return NODE_TERMINALS[node] - 1;
}

export function findBangSuggestionMeta(
  trigger: string
): BangSuggestionMeta | null {
  const terminalIndex = findTerminalIndex(trigger);
  return terminalIndex < 0 ? null : readTerminalMeta(terminalIndex);
}

export function findBangSuggestionTerminal(trigger: string): number {
  return findTerminalIndex(trigger);
}

export function resolveSiteSuggestionUrl(
  terminalIndex: number,
  encodedQuery: string
): string | null {
  const kind = TERM_E_KIND[terminalIndex];
  if (kind === 0) {
    return null;
  }
  if (kind < 3) {
    const path = kind === 1 ? "/" : "/w/";
    return `https://${readTerminalDomain(terminalIndex)}${path}api.php?action=opensearch&search=${encodedQuery}&format=json&limit=8`;
  }

  const index = kind - 3;
  const prefix = readPackedStringCached(
    ENDPOINT_P_BLOB,
    ENDPOINT_P_LEN,
    ENDPOINT_P_CP,
    ENDPOINT_PREFIX_CACHE,
    index
  );
  const suffix = readPackedStringCached(
    ENDPOINT_S_BLOB,
    ENDPOINT_S_LEN,
    ENDPOINT_S_CP,
    ENDPOINT_SUFFIX_CACHE,
    index
  );
  return prefix + encodedQuery + suffix;
}

export function siteSuggestionShape(terminalIndex: number): number {
  const kind = TERM_E_KIND[terminalIndex];
  return kind < 3 ? SITE_SUGGESTION_SHAPE.opensearch : ENDPOINT_SHAPE[kind - 3];
}

export function addBangSuggestionMetaForTerminal(
  payload: unknown[],
  completionCount: number,
  terminalIndex: number
): void {
  addBangSuggestionMeta(
    payload,
    completionCount,
    readTerminalMeta(terminalIndex)
  );
}

function writeBangSuggestionMeta(
  descriptions: string[],
  urls: string[],
  details: unknown[],
  index: number,
  meta: BangSuggestionMeta
): void {
  if (descriptions[index] === undefined) {
    descriptions[index] = meta.label;
  }
  if (urls[index] === undefined) {
    urls[index] = meta.url;
  }
  const detail = details[index];
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const record = detail as Record<string, unknown>;
    record.a = meta.detail.a;
    record.i = meta.detail.i;
  } else {
    details[index] = meta.detail;
  }
}

export function addBangSuggestionMeta(
  payload: unknown[],
  completionCount: number,
  meta: BangSuggestionMeta
): void {
  const descriptions = (payload[2] ?? []) as string[];
  const urls = (payload[3] ?? []) as string[];
  const extra = (payload[4] ?? {}) as Record<string, unknown>;
  const existing = extra["google:suggestdetail"];
  const details = Array.isArray(existing) ? existing : [];
  for (let i = 0; i < completionCount; i++) {
    writeBangSuggestionMeta(descriptions, urls, details, i, meta);
  }
  extra["google:suggestdetail"] = details;
  payload[2] = descriptions;
  payload[3] = urls;
  payload[4] = extra;
}

function effectiveScore(
  relevance: number,
  frecent: Record<string, number>,
  trigger: string
): number {
  const count = frecent[trigger];
  if (!count) {
    return relevance;
  }
  return (
    relevance + Math.min(count * FRECENCY_BOOST_MULTIPLIER, FRECENCY_BOOST_CAP)
  );
}

function includesTrigger(
  triggers: readonly string[] | null,
  trigger: string
): boolean {
  if (!triggers) {
    return false;
  }
  let i = 0;
  while (i < triggers.length) {
    if (triggers[i++] === trigger) {
      return true;
    }
  }
  return false;
}

function walkPrefix(partial: string): [number, string] | null {
  let node = ROOT;
  let pos = 0;

  while (pos < partial.length) {
    let found = false;
    const edgeStart = NODE_EDGE_STARTS[node];
    const edgeCount = NODE_EDGE_COUNTS[node];

    for (let i = 0; i < edgeCount; i++) {
      const edge = edgeStart + i;
      const edgeLabelStart = EDGE_LABEL_STARTS[edge];
      const edgeLabelLen = EDGE_LABEL_LENGTHS[edge];
      const child = EDGE_CHILDREN[edge];
      const limit = Math.min(partial.length - pos, edgeLabelLen);
      let match = 0;
      while (
        match < limit &&
        partial.charCodeAt(pos + match) ===
          LABELS.charCodeAt(edgeLabelStart + match)
      ) {
        match++;
      }

      if (match === 0) {
        continue;
      }

      if (match < edgeLabelLen) {
        if (match < partial.length - pos) {
          return null;
        }
        return [
          child,
          LABELS.substring(
            edgeLabelStart + match,
            edgeLabelStart + edgeLabelLen
          ),
        ];
      }

      node = child;
      pos += match;
      found = true;
      break;
    }

    if (!found) {
      return null;
    }
  }

  return [node, ""];
}

const dfsStack: number[] = [];

const RESULT_IDX = new Int32Array(TOP_K);
const RESULT_SCORE = new Float64Array(TOP_K);
const RESULT_ORDER = new Int32Array(TOP_K);

function topK(
  subtree: number,
  frecent: Record<string, number>,
  customMatches: Candidate[],
  hasFrecent: boolean,
  excluded: readonly string[] | null
): number {
  let minIdx = -1;
  let threshold = -1;
  let resultLen = 0;

  const boostCap = hasFrecent ? FRECENCY_BOOST_CAP : 0;

  for (let k = 0; k < customMatches.length; k++) {
    const score = customMatches[k].score;
    if (resultLen < TOP_K) {
      RESULT_IDX[resultLen] = -k - 1;
      RESULT_SCORE[resultLen] = score;
      resultLen++;
      if (resultLen === TOP_K) {
        minIdx = 0;
        for (let i = 1; i < TOP_K; i++) {
          if (RESULT_SCORE[i] < RESULT_SCORE[minIdx]) {
            minIdx = i;
          }
        }
        threshold = RESULT_SCORE[minIdx];
      }
    } else if (score > threshold) {
      RESULT_IDX[minIdx] = -k - 1;
      RESULT_SCORE[minIdx] = score;
      minIdx = 0;
      for (let i = 1; i < TOP_K; i++) {
        if (RESULT_SCORE[i] < RESULT_SCORE[minIdx]) {
          minIdx = i;
        }
      }
      threshold = RESULT_SCORE[minIdx];
    }
  }

  let stackLen = 0;
  dfsStack[stackLen++] = subtree;

  while (stackLen > 0) {
    const node = dfsStack[--stackLen];
    const terminalIndex = NODE_TERMINALS[node] - 1;

    if (terminalIndex >= 0) {
      let trigger: string | undefined;
      let isExcluded = false;
      if (excluded) {
        trigger = readTerminalTrigger(terminalIndex);
        isExcluded = includesTrigger(excluded, trigger);
      }
      if (!isExcluded) {
        const score = hasFrecent
          ? effectiveScore(
              TERM_R[terminalIndex],
              frecent,
              trigger ?? readTerminalTrigger(terminalIndex)
            )
          : TERM_R[terminalIndex];
        if (resultLen < TOP_K || score > threshold) {
          if (resultLen < TOP_K) {
            RESULT_IDX[resultLen] = terminalIndex;
            RESULT_SCORE[resultLen] = score;
            resultLen++;
            if (resultLen === TOP_K) {
              minIdx = 0;
              for (let i = 1; i < TOP_K; i++) {
                if (RESULT_SCORE[i] < RESULT_SCORE[minIdx]) {
                  minIdx = i;
                }
              }
              threshold = RESULT_SCORE[minIdx];
            }
          } else {
            RESULT_IDX[minIdx] = terminalIndex;
            RESULT_SCORE[minIdx] = score;
            minIdx = 0;
            for (let i = 1; i < TOP_K; i++) {
              if (RESULT_SCORE[i] < RESULT_SCORE[minIdx]) {
                minIdx = i;
              }
            }
            threshold = RESULT_SCORE[minIdx];
          }
        }
      }
    }

    const edgeStart = NODE_EDGE_STARTS[node];
    const edgeCount = NODE_EDGE_COUNTS[node];

    for (let i = edgeCount - 1; i >= 0; i--) {
      const child = EDGE_CHILDREN[edgeStart + i];
      const childMaxRelevance = NODE_MAX_RELEVANCE[child];
      if (resultLen >= TOP_K && childMaxRelevance + boostCap <= threshold) {
        break;
      }
      dfsStack[stackLen++] = child;
    }
  }

  for (let i = 0; i < resultLen; i++) {
    RESULT_ORDER[i] = i;
  }
  for (let i = 1; i < resultLen; i++) {
    const pos = RESULT_ORDER[i];
    const score = RESULT_SCORE[pos];
    let j = i - 1;
    while (j >= 0 && RESULT_SCORE[RESULT_ORDER[j]] < score) {
      RESULT_ORDER[j + 1] = RESULT_ORDER[j];
      j--;
    }
    RESULT_ORDER[j + 1] = pos;
  }

  return resultLen;
}

export function profileWalkPrefix(partial: string): [number, string] | null {
  return walkPrefix(partial);
}

export function profileTopKCount(
  subtree: number,
  frecent: Record<string, number>,
  hasFrecent: boolean
): number {
  return topK(subtree, frecent, [], hasFrecent, null);
}

export function responseFromCandidates(
  query: string,
  prefix: string,
  candidates: Candidate[],
  triggerChar = "!",
  chainPrefix = ""
): Response {
  const len = candidates.length;
  const prefixBang = `${prefix}${triggerChar}${chainPrefix}`;
  const completions = new Array<string>(len);
  const descriptions = new Array<string>(len);
  const urls = new Array<string>(len);
  const details = new Array<Record<string, string>>(len);

  for (let i = 0; i < len; i++) {
    const c = candidates[i];
    if (c.terminalIndex >= 0) {
      const terminalIndex = c.terminalIndex;
      completions[i] = `${prefixBang}${readTerminalTrigger(terminalIndex)}`;
      const meta = readTerminalMeta(terminalIndex);
      writeBangSuggestionMeta(descriptions, urls, details, i, meta);
    } else {
      completions[i] = `${prefixBang}${c.trigger}`;
      descriptions[i] = "";
      urls[i] = "";
      details[i] = EMPTY_DETAIL;
    }
  }

  return new Response(
    JSON.stringify([
      query,
      completions,
      descriptions,
      urls,
      { "google:suggestdetail": details },
    ]),
    JSON_HEADERS_INIT
  );
}

function responseFromRanked(
  query: string,
  prefix: string,
  customMatches: Candidate[],
  resultLen: number,
  triggerChar = "!",
  chainPrefix = ""
): Response {
  const prefixBang = `${prefix}${triggerChar}${chainPrefix}`;
  const completions = new Array<string>(resultLen);
  const descriptions = new Array<string>(resultLen);
  const urls = new Array<string>(resultLen);
  const details = new Array<Record<string, string>>(resultLen);

  for (let i = 0; i < resultLen; i++) {
    const pos = RESULT_ORDER[i];
    const idx = RESULT_IDX[pos];
    if (idx < 0) {
      const custom = customMatches[-idx - 1];
      completions[i] = `${prefixBang}${custom.trigger}`;
      descriptions[i] = "";
      urls[i] = "";
      details[i] = EMPTY_DETAIL;
      continue;
    }

    completions[i] = `${prefixBang}${readTerminalTrigger(idx)}`;
    const meta = readTerminalMeta(idx);
    writeBangSuggestionMeta(descriptions, urls, details, i, meta);
  }

  return new Response(
    JSON.stringify([
      query,
      completions,
      descriptions,
      urls,
      { "google:suggestdetail": details },
    ]),
    JSON_HEADERS_INIT
  );
}

export function bangSuggestions(
  query: string,
  prefix: string,
  partial: string,
  frecent: Record<string, number>,
  custom: string[],
  triggerChar = "!",
  chainPrefix = "",
  selectedTriggers: readonly string[] = []
): Response {
  const result = walkPrefix(partial);
  let excluded: readonly string[] | null = null;
  let selectedIndex = 0;
  while (selectedIndex < selectedTriggers.length) {
    if (selectedTriggers[selectedIndex++].startsWith(partial)) {
      excluded = selectedTriggers;
      break;
    }
  }
  let hasFrecent = false;
  for (const _ in frecent) {
    hasFrecent = true;
    break;
  }

  const customMatches: Candidate[] =
    custom.length === 0 ? EMPTY_CANDIDATES : [];
  if (custom.length > 0) {
    const upperBound = `${partial}\uFFFF`;
    for (const trigger of custom) {
      if (includesTrigger(excluded, trigger)) {
        continue;
      }
      if (!trigger.startsWith(partial)) {
        if (trigger > upperBound) {
          break;
        }
        continue;
      }
      customMatches.push({
        terminalIndex: -1,
        trigger,
        score: hasFrecent ? effectiveScore(0, frecent, trigger) : 0,
      });
    }
  }

  if (!result) {
    if (customMatches.length === 0) {
      return new Response(JSON.stringify([query, []]), JSON_HEADERS_INIT);
    }
    customMatches.sort((a, b) => b.score - a.score);
    if (customMatches.length > TOP_K) {
      customMatches.length = TOP_K;
    }
    return responseFromCandidates(
      query,
      prefix,
      customMatches,
      triggerChar,
      chainPrefix
    );
  }

  const [subtree] = result;
  const resultLen = topK(subtree, frecent, customMatches, hasFrecent, excluded);
  return responseFromRanked(
    query,
    prefix,
    customMatches,
    resultLen,
    triggerChar,
    chainPrefix
  );
}
