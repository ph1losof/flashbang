import {
  EDGES,
  LABELS,
  NODES,
  ROOT,
  TERM_D_BLOB,
  TERM_D_ID,
  TERM_D_OFF,
  TERM_K_BLOB,
  TERM_K_OFF,
  TERM_R,
  TERM_S_BLOB,
  TERM_S_ID,
  TERM_S_OFF,
} from "./generated/bangs-trie.js";
import {
  FRECENCY_BOOST_CAP,
  FRECENCY_BOOST_MULTIPLIER,
  JSON_HEADERS,
  TOP_K,
} from "./shared/constants";

interface Candidate {
  terminalIndex: number;
  trigger: string;
  score: number;
}

const JSON_HEADERS_INIT = { headers: JSON_HEADERS };
const EMPTY_CANDIDATES: Candidate[] = [];

export const NODE_EDGE_START = 0;
export const NODE_EDGE_COUNT = 1;
export const NODE_TERMINAL_INDEX = 2;
export const NODE_MAX_RELEVANCE = 3;
export const NODE_STRIDE = 4;

export const EDGE_LABEL_START = 0;
export const EDGE_LABEL_LENGTH = 1;
export const EDGE_CHILD_INDEX = 2;
export const EDGE_STRIDE = 3;

const TERM_K_CACHE = new Array<string | undefined>(TERM_R.length);
const EMPTY_DETAIL: Record<string, string> = {};
interface TerminalMeta {
  detail: Record<string, string>;
  label: string;
  url: string;
}
const TERM_META_CACHE = new Array<TerminalMeta | undefined>(TERM_R.length);

function readPackedStringCached(
  blob: string,
  offsets: Int32Array,
  cache: (string | undefined)[],
  index: number
): string {
  const cached = cache[index];
  if (cached !== undefined) {
    return cached;
  }
  const value = blob.slice(offsets[index], offsets[index + 1]);
  cache[index] = value;
  return value;
}

function readTerminalTrigger(index: number): string {
  return readPackedStringCached(TERM_K_BLOB, TERM_K_OFF, TERM_K_CACHE, index);
}

function readTerminalMeta(index: number): TerminalMeta {
  const cached = TERM_META_CACHE[index];
  if (cached !== undefined) {
    return cached;
  }
  const domainId = TERM_D_ID[index];
  const nameId = TERM_S_ID[index];
  const domain = TERM_D_BLOB.slice(
    TERM_D_OFF[domainId],
    TERM_D_OFF[domainId + 1]
  );
  const name = TERM_S_BLOB.slice(TERM_S_OFF[nameId], TERM_S_OFF[nameId + 1]);
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

function walkPrefix(partial: string): [number, string] | null {
  let node = ROOT;
  let pos = 0;

  while (pos < partial.length) {
    let found = false;
    const nodeOff = node * NODE_STRIDE;
    const edgeStart = NODES[nodeOff + NODE_EDGE_START];
    const edgeCount = NODES[nodeOff + NODE_EDGE_COUNT];

    for (let i = 0; i < edgeCount; i++) {
      const edgeOff = (edgeStart + i) * EDGE_STRIDE;
      const edgeLabelStart = EDGES[edgeOff + EDGE_LABEL_START];
      const edgeLabelLen = EDGES[edgeOff + EDGE_LABEL_LENGTH];
      const child = EDGES[edgeOff + EDGE_CHILD_INDEX];
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
  excluded: ReadonlySet<string> | null
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
    const nodeOff = node * NODE_STRIDE;
    const terminalIndex = NODES[nodeOff + NODE_TERMINAL_INDEX];

    if (terminalIndex >= 0) {
      const trigger = readTerminalTrigger(terminalIndex);
      if (!excluded?.has(trigger)) {
        const score = hasFrecent
          ? effectiveScore(TERM_R[terminalIndex], frecent, trigger)
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

    const edgeStart = NODES[nodeOff + NODE_EDGE_START];
    const edgeCount = NODES[nodeOff + NODE_EDGE_COUNT];

    for (let i = edgeCount - 1; i >= 0; i--) {
      const edgeOff = (edgeStart + i) * EDGE_STRIDE;
      const child = EDGES[edgeOff + EDGE_CHILD_INDEX];
      const childMaxRelevance = NODES[child * NODE_STRIDE + NODE_MAX_RELEVANCE];
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
      descriptions[i] = meta.label;
      urls[i] = meta.url;
      details[i] = meta.detail;
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
    descriptions[i] = meta.label;
    urls[i] = meta.url;
    details[i] = meta.detail;
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
  const excluded =
    selectedTriggers.length > 0 ? new Set(selectedTriggers) : null;
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
      if (excluded?.has(trigger)) {
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
