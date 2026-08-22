import { CH_0, CH_2, CH_f, CH_PERCENT, CH_PLUS } from "../shared/chars";
import { localeGeneration, substituteLocale } from "./locale";

export type UrlParts = readonly [string, string | null];
type UrlEntry = readonly [string, string | null, ...unknown[]];

export interface TriggerHashResult {
  hash: number;
  trigger: string;
}

export type PrefixBangParse =
  | { kind: "home" }
  | { kind: "lucky"; termStart: number }
  | {
      hash: number;
      kind: "bang";
      termStart: number | null;
      trigger: string;
    };

function hexCode(nibble: number): number {
  return nibble < 10 ? 48 + nibble : 87 + nibble;
}

export function compileTriggerMarker(code: number): number {
  return code | (hexCode(code >> 4) << 8) | (hexCode(code & 0xf) << 16);
}

export const DEFAULT_BANG_MARKER = compileTriggerMarker(33);

export function trimRawStart(rawQuery: string): number {
  const len = rawQuery.length;
  let start = 0;
  while (start < len) {
    const c = rawQuery.charCodeAt(start);
    if (c === CH_PLUS) {
      start++;
      continue;
    }
    if (
      c === CH_PERCENT &&
      rawQuery.charCodeAt(start + 1) === CH_2 &&
      rawQuery.charCodeAt(start + 2) === CH_0
    ) {
      start += 3;
      continue;
    }
    break;
  }

  return start;
}

export function trimRawEnd(rawQuery: string, start: number): number {
  const len = rawQuery.length;
  let end = len;
  while (end > start) {
    const tail = rawQuery.charCodeAt(end - 1);
    if (tail === CH_PLUS) {
      end--;
      continue;
    }
    if (
      tail === CH_0 &&
      end >= start + 3 &&
      rawQuery.charCodeAt(end - 3) === CH_PERCENT &&
      rawQuery.charCodeAt(end - 2) === CH_2
    ) {
      end -= 3;
      continue;
    }
    break;
  }
  return end;
}

export function markerWidthAt(
  value: string,
  position: number,
  end: number,
  marker: number
): number {
  const c = value.charCodeAt(position);
  if (c === (marker & 0xff)) {
    return 1;
  }
  if (end - position < 3 || c !== CH_PERCENT) {
    return 0;
  }
  const encoded =
    value.charCodeAt(position + 1) |
    ((value.charCodeAt(position + 2) | 32) << 8);
  return encoded === marker >> 8 ? 3 : 0;
}

export function findSpace(s: string, from: number, end: number): number {
  for (let i = from; i < end; i++) {
    const c = s.charCodeAt(i);
    if (c === CH_PLUS) {
      return (i << 2) | 1;
    }
    if (
      c === CH_PERCENT &&
      s.charCodeAt(i + 1) === CH_2 &&
      s.charCodeAt(i + 2) === CH_0
    ) {
      return (i << 2) | 3;
    }
  }
  return -1;
}

export function extractTriggerWithHash(
  value: string,
  from: number,
  to: number,
  result: TriggerHashResult
): void {
  let hash = 2166136261 >>> 0;
  let hasUpper = false;
  for (let i = from; i < to; i++) {
    const c = value.charCodeAt(i);
    if (c >= 65 && c <= 90) {
      hasUpper = true;
      hash ^= c | 32;
    } else {
      hash ^= c;
    }
    hash = Math.imul(hash, 16777619);
  }
  if (hasUpper) {
    result.trigger = value.slice(from, to).toLowerCase();
  } else {
    result.trigger =
      from === 0 && to === value.length ? value : value.substring(from, to);
  }
  result.hash = hash >>> 0;
}

export function parsePrefixBang(
  rawQuery: string,
  afterMarker: number,
  end: number
): PrefixBangParse {
  if (afterMarker >= end) {
    return { kind: "home" };
  }

  const c = rawQuery.charCodeAt(afterMarker);
  let spaceWidth = 0;
  if (c === CH_PLUS) {
    spaceWidth = 1;
  } else if (
    c === CH_PERCENT &&
    rawQuery.charCodeAt(afterMarker + 1) === CH_2 &&
    rawQuery.charCodeAt(afterMarker + 2) === CH_0
  ) {
    spaceWidth = 3;
  }
  if (spaceWidth) {
    const termStart = afterMarker + spaceWidth;
    return termStart >= end ? { kind: "home" } : { kind: "lucky", termStart };
  }

  const spPacked = findSpace(rawQuery, afterMarker, end);
  const sp = spPacked === -1 ? -1 : spPacked >> 2;
  const spLen = spPacked === -1 ? 0 : spPacked & 0b11;
  const triggerEnd = sp === -1 ? end : sp;
  const result: Extract<PrefixBangParse, { kind: "bang" }> = {
    hash: 0,
    kind: "bang",
    termStart: sp === -1 || sp + spLen >= end ? null : sp + spLen,
    trigger: "",
  };
  extractTriggerWithHash(rawQuery, afterMarker, triggerEnd, result);
  return result;
}

const ENTRY_QUERY_SAFE = 1;
const ENTRY_REPEATED_PLACEHOLDER = 2;
const ENTRY_LOCALE = 4;
const ENTRY_SLOW = ENTRY_REPEATED_PLACEHOLDER | ENTRY_LOCALE;
const entryFlagsCache = new WeakMap<object, number>();

interface LocalizedEntry {
  lg?: number;
  lp?: string;
}

function authorityHasBrace(prefix: string): boolean {
  let brace = prefix.indexOf("{");
  if (brace === -1) {
    return false;
  }
  const protocolEnd = prefix.indexOf("://");
  if (protocolEnd === -1) {
    return false;
  }
  const start = protocolEnd + 3;
  if (brace < start) {
    brace = prefix.indexOf("{", start);
    if (brace === -1) {
      return false;
    }
  }
  let end = prefix.length;
  const slash = prefix.indexOf("/", start);
  if (slash !== -1) {
    end = slash;
  }
  const query = prefix.indexOf("?", start);
  if (query !== -1 && query < end) {
    end = query;
  }
  const fragment = prefix.indexOf("#", start);
  if (fragment !== -1 && fragment < end) {
    end = fragment;
  }
  return brace < end;
}

export function compileUrlMode(prefix: string, suffix: string | null): number {
  const query = prefix.indexOf("?");
  let flags = 0;
  if (query !== -1) {
    const fragment = prefix.indexOf("#");
    if (fragment === -1 || query < fragment) {
      flags |= ENTRY_QUERY_SAFE;
    }
  }
  if (suffix?.includes("{}")) {
    flags |= ENTRY_REPEATED_PLACEHOLDER;
  }
  if (authorityHasBrace(prefix)) {
    flags |= ENTRY_LOCALE;
  }
  return flags;
}

function entryFlags(entry: UrlEntry): number {
  const cached = entryFlagsCache.get(entry);
  if (cached !== undefined) {
    return cached;
  }
  const flags = compileUrlMode(entry[0], entry[1]);
  entryFlagsCache.set(entry, flags);
  return flags;
}

function localizedPrefix(entry: UrlEntry): string {
  const stamped = entry as LocalizedEntry;
  const generation = localeGeneration();
  if (stamped.lg === generation) {
    return stamped.lp as string;
  }
  const value = substituteLocale(entry[0]);
  stamped.lp = value;
  stamped.lg = generation;
  return value;
}

function fixupForPath(raw: string): string {
  const hasPlus = raw.indexOf("+") !== -1;
  const hasSlash = raw.indexOf("%2F") !== -1 || raw.indexOf("%2f") !== -1;
  if (!(hasPlus || hasSlash)) {
    return raw;
  }
  if (hasPlus && !hasSlash) {
    return raw.replaceAll("+", "%20");
  }
  let result = "";
  let segment = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === CH_PLUS) {
      result += `${raw.substring(segment, i)}%20`;
      segment = i + 1;
    } else if (
      c === CH_PERCENT &&
      i + 2 < raw.length &&
      raw.charCodeAt(i + 1) === CH_2 &&
      (raw.charCodeAt(i + 2) | 32) === CH_f
    ) {
      result += `${raw.substring(segment, i)}/`;
      segment = i + 3;
      i += 2;
    }
  }
  return result + raw.substring(segment);
}

export function buildUrl(
  entry: UrlEntry,
  value: string,
  termStart: number,
  termEnd: number,
  mode?: number
): string {
  const suffix = entry[1];
  if (suffix === null) {
    return ((mode ?? entryFlags(entry)) & ENTRY_LOCALE) === 0
      ? entry[0]
      : localizedPrefix(entry);
  }
  let prefix = entry[0];
  const raw =
    termStart === 0 && termEnd === value.length
      ? value
      : value.substring(termStart, termEnd);
  const flags = mode ?? entryFlags(entry);
  const querySafe = (flags & ENTRY_QUERY_SAFE) !== 0;
  const encoded = querySafe ? raw : fixupForPath(raw);
  if ((flags & ENTRY_SLOW) === 0) {
    return prefix + encoded + suffix;
  }
  if ((flags & ENTRY_LOCALE) !== 0) {
    prefix = localizedPrefix(entry);
    if ((flags & ENTRY_REPEATED_PLACEHOLDER) === 0) {
      return prefix + encoded + suffix;
    }
  }

  const pathEncoded = querySafe ? null : encoded;
  let result = prefix + encoded;
  let offset = 0;
  let inQuery = querySafe;
  while (offset < suffix.length) {
    const placeholder = suffix.indexOf("{}", offset);
    if (placeholder === -1) {
      return result + suffix.substring(offset);
    }
    const literal = suffix.substring(offset, placeholder);
    const queryStart = literal.lastIndexOf("?");
    const fragmentStart = literal.lastIndexOf("#");
    if (queryStart !== -1 || fragmentStart !== -1) {
      inQuery = queryStart > fragmentStart;
    }
    result += literal + (inQuery ? raw : (pathEncoded ?? fixupForPath(raw)));
    offset = placeholder + 2;
  }
  return result;
}

export function originOfPrefix(prefix: string): string {
  const protocolEnd = prefix.indexOf("://");
  if (protocolEnd === -1) {
    return prefix;
  }
  const hostStart = protocolEnd + 3;
  let tailStart = prefix.length;
  for (const marker of ["/", "?", "#"]) {
    const position = prefix.indexOf(marker, hostStart);
    if (position !== -1 && position < tailStart) {
      tailStart = position;
    }
  }
  // Origins are path-less by construction, so they always take the "/" a
  // spec-compliant serializer would add. Callers cache this result per bang.
  return `${prefix.substring(0, tailStart)}/`;
}

export function encodeForRedirect(query: string): string {
  for (let i = 0; i < query.length; i++) {
    const c = query.charCodeAt(i);
    if (
      c === 0x20 ||
      c === 0x40 ||
      c === 0x5c ||
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a) ||
      (c >= 0x30 && c <= 0x39) ||
      c === 0x21 ||
      c === 0x27 ||
      c === 0x28 ||
      c === 0x29 ||
      c === 0x2a ||
      c === 0x2d ||
      c === 0x2e ||
      c === 0x5f ||
      c === 0x7e
    ) {
      continue;
    }
    return encodeURIComponent(query)
      .replaceAll("%5C", "\\")
      .replaceAll("%20", "+");
  }
  return query.replaceAll(" ", "+");
}
