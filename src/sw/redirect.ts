import {
  lookupAdvancedBang,
  lookupSnapOverride,
} from "../generated/bangs-sparse.js";
import {
  CAPTURE_ENCODE_PLUS,
  CAPTURE_ENCODE_RAW,
  type CaptureUrlParts,
  MAX_CAPTURE_INPUT_LENGTH,
} from "../shared/capture-template";
import {
  CH_0,
  CH_1,
  CH_2,
  CH_4,
  CH_AT,
  CH_BSLASH,
  CH_EXCL,
  CH_F,
  CH_f,
  CH_PERCENT,
  CH_PLUS,
} from "../shared/chars";
import type { SnapTargetParts } from "../shared/snap-target";
import { lookupBang } from "./bang-data";

// NOTE: pos + char-width packed into one int to skip tuple alloc:
//   findExcl/findSpace:         (pos << 2) | width        → >> 2 for pos, & 0b11 for width
//   findLastSpaceExcl/SpaceAt:  (pos << 4) | (sw << 2) | tw   → >> 4 pos, >> 2 & 0b11 sw, & 0b11 tw
// width is 1 for literal char, 3 for percent-encoded (%21, %40, etc.)

export type UrlParts = readonly [string, string | null];
type UrlPartsWithSnap = readonly [string, string | null, SnapTargetParts];
type CaptureUrlPartsWithSnap = readonly [...CaptureUrlParts, SnapTargetParts];
type SimpleEntry = UrlParts | UrlPartsWithSnap;
type CaptureEntry = CaptureUrlParts | CaptureUrlPartsWithSnap;
export type CustomUrlParts = SimpleEntry | CaptureEntry;

export interface RedirectSettings {
  custom: Record<string, CustomUrlParts>;
  defaultUrl: UrlParts;
  luckyUrl: UrlParts | null;
}

function isEncodedExclAt(s: string, i: number): boolean {
  return (
    s.charCodeAt(i) === CH_PERCENT &&
    s.charCodeAt(i + 1) === CH_2 &&
    s.charCodeAt(i + 2) === CH_1
  );
}

function isEncodedAtAt(s: string, i: number): boolean {
  return (
    s.charCodeAt(i) === CH_PERCENT &&
    s.charCodeAt(i + 1) === CH_4 &&
    s.charCodeAt(i + 2) === CH_0
  );
}

let _sawAt = false;

function findExcl(s: string, start: number, end: number): number {
  let sawAt = false;
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i);
    if (c === CH_EXCL) {
      _sawAt = sawAt;
      return (i << 2) | 1;
    }
    if (c === CH_AT) {
      sawAt = true;
    } else if (c === CH_PERCENT && i + 2 < end) {
      const c1 = s.charCodeAt(i + 1);
      const c2 = s.charCodeAt(i + 2);
      if (c1 === CH_2 && c2 === CH_1) {
        _sawAt = sawAt;
        return (i << 2) | 3;
      }
      if (c1 === CH_4 && c2 === CH_0) {
        sawAt = true;
      }
    }
  }
  _sawAt = sawAt;
  return -1;
}

function findSpace(s: string, from: number, end: number): number {
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

function findLastSpaceExcl(s: string, start: number, end: number): number {
  for (let i = end - 1; i >= start; i--) {
    const c = s.charCodeAt(i);
    let exclWidth = 0;
    if (c === CH_EXCL) {
      exclWidth = 1;
    } else if (
      c === CH_PERCENT &&
      i + 2 < end &&
      s.charCodeAt(i + 1) === CH_2 &&
      s.charCodeAt(i + 2) === CH_1
    ) {
      exclWidth = 3;
    }
    if (!exclWidth) {
      continue;
    }
    if (i >= start + 1 && s.charCodeAt(i - 1) === CH_PLUS) {
      return ((i - 1) << 4) | (1 << 2) | exclWidth;
    }
    if (
      i >= start + 3 &&
      s.charCodeAt(i - 3) === CH_PERCENT &&
      s.charCodeAt(i - 2) === CH_2 &&
      s.charCodeAt(i - 1) === CH_0
    ) {
      return ((i - 3) << 4) | (3 << 2) | exclWidth;
    }
  }
  return -1;
}

function findLastSpaceAt(s: string, start: number, end: number): number {
  for (let i = end - 1; i >= start; i--) {
    const c = s.charCodeAt(i);
    let atWidth = 0;
    if (c === CH_AT) {
      atWidth = 1;
    } else if (
      c === CH_PERCENT &&
      i + 2 < end &&
      s.charCodeAt(i + 1) === CH_4 &&
      s.charCodeAt(i + 2) === CH_0
    ) {
      atWidth = 3;
    }
    if (!atWidth) {
      continue;
    }
    if (i >= start + 1 && s.charCodeAt(i - 1) === CH_PLUS) {
      return ((i - 1) << 4) | (1 << 2) | atWidth;
    }
    if (
      i >= start + 3 &&
      s.charCodeAt(i - 3) === CH_PERCENT &&
      s.charCodeAt(i - 2) === CH_2 &&
      s.charCodeAt(i - 1) === CH_0
    ) {
      return ((i - 3) << 4) | (3 << 2) | atWidth;
    }
  }
  return -1;
}

function findLastSpace(s: string, start: number, before: number): number {
  for (let i = before; i >= start; i--) {
    const c = s.charCodeAt(i);
    if (c === CH_PLUS) {
      return (i << 2) | 1;
    }
    if (
      c === CH_PERCENT &&
      i + 2 <= before &&
      s.charCodeAt(i + 1) === CH_2 &&
      s.charCodeAt(i + 2) === CH_0
    ) {
      return (i << 2) | 3;
    }
  }
  return -1;
}

const ENTRY_QUERY_SAFE = 1;
const ENTRY_REPEATED_PLACEHOLDER = 2;
const _entryFlagsCache = new WeakMap<SimpleEntry, number>();

function entryFlags(entry: SimpleEntry): number {
  const cached = _entryFlagsCache.get(entry);
  if (cached !== undefined) {
    return cached;
  }
  const prefix = entry[0];
  const q = prefix.indexOf("?");
  let flags = 0;
  if (q !== -1) {
    const h = prefix.indexOf("#");
    if (h === -1 || q < h) {
      flags |= ENTRY_QUERY_SAFE;
    }
  }
  if (entry[1]?.includes("{}")) {
    flags |= ENTRY_REPEATED_PLACEHOLDER;
  }
  _entryFlagsCache.set(entry, flags);
  return flags;
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
  if (!hasPlus) {
    let result = "";
    let seg = 0;
    for (let i = 0; i < raw.length; i++) {
      if (
        raw.charCodeAt(i) === CH_PERCENT &&
        i + 2 < raw.length &&
        raw.charCodeAt(i + 1) === CH_2
      ) {
        const c2 = raw.charCodeAt(i + 2);
        if (c2 === CH_F || c2 === CH_f) {
          result += `${raw.substring(seg, i)}/`;
          seg = i + 3;
          i += 2;
        }
      }
    }
    return result + raw.substring(seg);
  }
  let result = "";
  let seg = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === CH_PLUS) {
      result += `${raw.substring(seg, i)}%20`;
      seg = i + 1;
    } else if (
      c === CH_PERCENT &&
      i + 2 < raw.length &&
      raw.charCodeAt(i + 1) === CH_2
    ) {
      const c2 = raw.charCodeAt(i + 2);
      if (c2 === CH_F || c2 === CH_f) {
        result += `${raw.substring(seg, i)}/`;
        seg = i + 3;
        i += 2;
      }
    }
  }
  return result + raw.substring(seg);
}

function buildUrl(
  entry: SimpleEntry,
  s: string,
  termStart: number,
  termEnd: number
): string {
  const suffix = entry[1];
  if (suffix === null) {
    return entry[0];
  }
  const prefix = entry[0];
  const raw =
    termStart === 0 && termEnd === s.length
      ? s
      : s.substring(termStart, termEnd);
  const flags = entryFlags(entry);
  const querySafe = (flags & ENTRY_QUERY_SAFE) !== 0;
  const encoded = querySafe ? raw : fixupForPath(raw);
  if ((flags & ENTRY_REPEATED_PLACEHOLDER) === 0) {
    return prefix + encoded + suffix;
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

function decodeCaptureInput(raw: string): string | null {
  // A percent-encoded astral character uses at most six raw characters per
  // UTF-16 code unit. Reject larger inputs before decodeURIComponent allocates.
  if (raw.length > MAX_CAPTURE_INPUT_LENGTH * 6) {
    return null;
  }
  const hasPlus = raw.indexOf("+") !== -1;
  const hasPercent = raw.indexOf("%") !== -1;
  if (!(hasPlus || hasPercent)) {
    return raw.length <= MAX_CAPTURE_INPUT_LENGTH ? raw : null;
  }
  const normalized = hasPlus ? raw.replaceAll("+", " ") : raw;
  try {
    const decoded = hasPercent ? decodeURIComponent(normalized) : normalized;
    return decoded.length <= MAX_CAPTURE_INPUT_LENGTH ? decoded : null;
  } catch {
    return null;
  }
}

function encodeCapture(value: string, encoding: number): string {
  if (encoding === CAPTURE_ENCODE_RAW) {
    return value;
  }
  const encoded = encodeURIComponent(value);
  return encoding === CAPTURE_ENCODE_PLUS
    ? encoded.replaceAll("%20", "+")
    : encoded;
}

function buildCaptureUrl(
  entry: CaptureEntry,
  s: string,
  termStart: number,
  termEnd: number
): string | null {
  const raw =
    termStart === 0 && termEnd === s.length
      ? s
      : s.substring(termStart, termEnd);
  const decoded = decodeCaptureInput(raw);
  if (decoded === null) {
    return null;
  }
  const match = entry[3].exec(decoded);
  if (!match) {
    return null;
  }
  const suffixes = entry[1];
  const indexes = entry[2];
  const encoding = entry[4];
  let url = entry[0];
  for (let i = 0; i < indexes.length; i++) {
    url += encodeCapture(match[indexes[i]] ?? "", encoding) + suffixes[i];
  }
  return url;
}

function luckyOrDefault(
  luckyUrl: UrlParts | null,
  defaultUrl: UrlParts,
  rawQuery: string,
  termStart: number,
  termEnd: number
): string {
  return buildUrl(luckyUrl ?? defaultUrl, rawQuery, termStart, termEnd);
}

function findUrlTail(prefix: string, start: number): number {
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
  return end;
}

function originOfPrefix(prefix: string): string {
  const protoEnd = prefix.indexOf("://");
  if (protoEnd === -1) {
    return prefix;
  }
  const tailStart = findUrlTail(prefix, protoEnd + 3);
  return tailStart === prefix.length ? prefix : prefix.substring(0, tailStart);
}

const builtInBangOriginCache: Record<string, string> = Object.create(null);
const builtInSnapOriginCache: Record<string, string> = Object.create(null);
const customBangOriginCache = new WeakMap<
  Record<string, CustomUrlParts>,
  Record<string, string>
>();

function getCustomOriginCache(
  custom: Record<string, CustomUrlParts>
): Record<string, string> {
  const existing = customBangOriginCache.get(custom);
  if (existing !== undefined) {
    return existing;
  }
  const fresh: Record<string, string> = Object.create(null);
  customBangOriginCache.set(custom, fresh);
  return fresh;
}

function redir(url: string): Response {
  // NOTE: Response.redirect(url, 302) benchmarks faster than constructing
  // new Response(null, { status: 302, headers: { Location: url } }) here.
  return Response.redirect(url, 302);
}

function resolveBangFill(
  bang: string,
  custom: Record<string, CustomUrlParts>,
  rawQuery: string,
  termStart: number,
  termEnd: number,
  hash: number
): string | null {
  const customEntry = custom[bang];
  if (customEntry) {
    return customEntry.length < 5
      ? buildUrl(customEntry as SimpleEntry, rawQuery, termStart, termEnd)
      : buildCaptureUrl(
          customEntry as CaptureEntry,
          rawQuery,
          termStart,
          termEnd
        );
  }
  const entry = lookupBang(bang, hash);
  if (entry) {
    return buildUrl(entry, rawQuery, termStart, termEnd);
  }
  const advanced = lookupAdvancedBang(bang);
  return advanced
    ? buildCaptureUrl(advanced, rawQuery, termStart, termEnd)
    : null;
}

function customSnapTarget(entry: CustomUrlParts): SnapTargetParts | null {
  if (entry.length === 3) {
    return entry[2];
  }
  return entry.length === 6 ? entry[5] : null;
}

function resolveSnapOrigin(
  bang: string,
  custom: Record<string, CustomUrlParts>,
  hash: number
): string | null {
  const customEntry = custom[bang];
  if (customEntry) {
    const snap = customSnapTarget(customEntry);
    return snap ? snap[1] : resolveBangOrigin(bang, custom, hash);
  }
  const cached = builtInSnapOriginCache[bang];
  if (cached !== undefined) {
    return cached;
  }
  const snap = lookupSnapOverride(bang, hash, true);
  if (snap) {
    builtInSnapOriginCache[bang] = snap;
    return snap;
  }
  const origin = resolveBangOrigin(bang, custom, hash);
  if (origin) {
    builtInSnapOriginCache[bang] = origin;
  }
  return origin;
}

function resolveBangOrigin(
  bang: string,
  custom: Record<string, CustomUrlParts>,
  hash: number
): string | null {
  const customEntry = custom[bang];
  if (customEntry) {
    const cached = getCustomOriginCache(custom);
    const origin = cached[bang];
    if (origin !== undefined) {
      return origin;
    }
    const computed = originOfPrefix(customEntry[0]);
    cached[bang] = computed;
    return computed;
  }

  const builtIn = builtInBangOriginCache[bang];
  if (builtIn !== undefined) {
    return builtIn;
  }
  const entry = lookupBang(bang, hash);
  const resolved = entry || lookupAdvancedBang(bang);
  if (!resolved) {
    return null;
  }
  const origin = originOfPrefix(resolved[0]);
  builtInBangOriginCache[bang] = origin;
  return origin;
}

function domainOfPrefix(prefix: string): string | null {
  const protoEnd = prefix.indexOf("://");
  if (protoEnd === -1) {
    return null;
  }
  const hostStart = protoEnd + 3;
  const tailStart = findUrlTail(prefix, hostStart);
  const host = prefix.substring(hostStart, tailStart);
  return host.startsWith("www.") ? host.substring(4) : host;
}

const builtInSnapSiteFilterCache: Record<string, string> = Object.create(null);
const customSnapDomainCache = new WeakMap<
  Record<string, CustomUrlParts>,
  Record<string, string>
>();

function getCustomDomainCache(
  custom: Record<string, CustomUrlParts>
): Record<string, string> {
  const existing = customSnapDomainCache.get(custom);
  if (existing !== undefined) {
    return existing;
  }
  const fresh: Record<string, string> = Object.create(null);
  customSnapDomainCache.set(custom, fresh);
  return fresh;
}

function resolveSnapSiteFilter(
  bang: string,
  custom: Record<string, CustomUrlParts>,
  hash: number
): string | null {
  const customEntry = custom[bang];
  if (customEntry) {
    const snap = customSnapTarget(customEntry);
    if (snap) {
      return snap[0];
    }
    const cached = getCustomDomainCache(custom);
    let domain = cached[bang];
    if (domain === undefined) {
      const computed = domainOfPrefix(customEntry[0]);
      if (!computed) {
        return null;
      }
      cached[bang] = computed;
      domain = computed;
    }
    return `+site:${domain}`;
  }

  const cached = builtInSnapSiteFilterCache[bang];
  if (cached !== undefined) {
    return cached;
  }
  const snap = lookupSnapOverride(bang, hash, false);
  if (snap) {
    builtInSnapSiteFilterCache[bang] = snap;
    return snap;
  }
  const entry = lookupBang(bang, hash);
  const resolved = entry || lookupAdvancedBang(bang);
  if (!resolved) {
    return null;
  }
  const domain = domainOfPrefix(resolved[0]);
  if (!domain) {
    return null;
  }
  const sf = `+site:${domain}`;
  builtInSnapSiteFilterCache[bang] = sf;
  return sf;
}

function buildSnapUrl(
  defaultUrl: UrlParts,
  siteFilter: string,
  rawQuery: string,
  termStart: number,
  termEnd: number
): string {
  const prefix = defaultUrl[0];
  const suffix = defaultUrl[1];
  if (suffix === null) {
    return prefix;
  }
  const raw =
    termStart === 0 && termEnd === rawQuery.length
      ? rawQuery
      : rawQuery.substring(termStart, termEnd);
  return prefix + raw + siteFilter + suffix;
}

function findTrailingBareBang(
  s: string,
  start: number,
  end: number,
  lastChar: number
): number {
  if (lastChar === CH_EXCL) {
    // "query+!"
    if (s.charCodeAt(end - 2) === CH_PLUS) {
      return end - 2;
    }
    // "query%20!"
    if (
      end - start >= 4 &&
      s.charCodeAt(end - 4) === CH_PERCENT &&
      s.charCodeAt(end - 3) === CH_2 &&
      s.charCodeAt(end - 2) === CH_0
    ) {
      return end - 4;
    }
  }
  // "query+%21" / "query%20%21"
  if (end - start >= 3 && isEncodedExclAt(s, end - 3)) {
    const beforeExcl = end - 3;
    if (s.charCodeAt(beforeExcl - 1) === CH_PLUS) {
      return beforeExcl - 1;
    }
    if (
      beforeExcl >= start + 3 &&
      s.charCodeAt(beforeExcl - 3) === CH_PERCENT &&
      s.charCodeAt(beforeExcl - 2) === CH_2 &&
      s.charCodeAt(beforeExcl - 1) === CH_0
    ) {
      return beforeExcl - 3;
    }
  }
  return -1;
}

let _lastHash = 0;

function extractTrigger(s: string, from: number, to: number): string {
  let h = 2166136261 >>> 0;
  let hasUpper = false;
  for (let i = from; i < to; i++) {
    const c = s.charCodeAt(i);
    if (c >= 65 && c <= 90) {
      hasUpper = true;
      h ^= c | 32;
    } else {
      h ^= c;
    }
    h = Math.imul(h, 16777619);
  }
  _lastHash = h >>> 0;
  if (hasUpper) {
    return s.slice(from, to).toLowerCase();
  }
  return from === 0 && to === s.length ? s : s.substring(from, to);
}

function resolveRaw(
  rawQuery: string,
  { defaultUrl, custom, luckyUrl }: RedirectSettings
): [string, string | null] {
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

  if (start >= end) {
    return ["/", null];
  }

  const c0 = rawQuery.charCodeAt(start);

  // "\" — feeling lucky
  if (c0 === CH_BSLASH && end - start > 1) {
    return [
      luckyOrDefault(luckyUrl, defaultUrl, rawQuery, start + 1, end),
      null,
    ];
  }

  let exclStart = -1;
  let exclWidth = 0;
  if (c0 === CH_EXCL) {
    exclStart = start;
    exclWidth = 1;
  } else if (end - start >= 3 && isEncodedExclAt(rawQuery, start)) {
    exclStart = start;
    exclWidth = 3;
  }

  let atStart = -1;
  let atWidth = 0;
  if (exclStart === -1) {
    if (c0 === CH_AT) {
      atStart = start;
      atWidth = 1;
    } else if (end - start >= 3 && isEncodedAtAt(rawQuery, start)) {
      atStart = start;
      atWidth = 3;
    }
  }

  if (exclStart !== -1) {
    const afterExcl = exclStart + exclWidth;

    if (afterExcl >= end) {
      return ["/", null];
    }

    // "!+query" / "!%20query" — bare bang lucky
    const c = rawQuery.charCodeAt(afterExcl);
    let spaceWidth = 0;
    if (c === CH_PLUS) {
      spaceWidth = 1;
    } else if (
      c === CH_PERCENT &&
      rawQuery.charCodeAt(afterExcl + 1) === CH_2 &&
      rawQuery.charCodeAt(afterExcl + 2) === CH_0
    ) {
      spaceWidth = 3;
    }
    if (spaceWidth) {
      const termStart = afterExcl + spaceWidth;
      if (termStart >= end) {
        return ["/", null];
      }
      return [
        luckyOrDefault(luckyUrl, defaultUrl, rawQuery, termStart, end),
        null,
      ];
    }

    // "!g+cats" or "!g" — prefix bang
    const spPacked = findSpace(rawQuery, afterExcl, end);
    const sp = spPacked === -1 ? -1 : spPacked >> 2;
    const spLen = spPacked === -1 ? 0 : spPacked & 0b11;
    const bangEnd = sp === -1 ? end : sp;
    const bang = extractTrigger(rawQuery, afterExcl, bangEnd);

    if (sp === -1 || sp + spLen >= end) {
      const origin = resolveBangOrigin(bang, custom, _lastHash);
      if (!origin) {
        return [buildUrl(defaultUrl, rawQuery, start, end), null];
      }
      return [origin, bang];
    }

    const filled = resolveBangFill(
      bang,
      custom,
      rawQuery,
      sp + spLen,
      end,
      _lastHash
    );
    if (filled === null) {
      return [buildUrl(defaultUrl, rawQuery, start, end), null];
    }
    return [filled, bang];
  }

  // "@trigger+query" or "@trigger" — prefix snap
  if (atStart !== -1) {
    const afterAt = atStart + atWidth;
    if (afterAt >= end) {
      return ["/", null];
    }

    const cAfterAt = rawQuery.charCodeAt(afterAt);
    let atSpaceWidth = 0;
    if (cAfterAt === CH_PLUS) {
      atSpaceWidth = 1;
    } else if (
      cAfterAt === CH_PERCENT &&
      rawQuery.charCodeAt(afterAt + 1) === CH_2 &&
      rawQuery.charCodeAt(afterAt + 2) === CH_0
    ) {
      atSpaceWidth = 3;
    }
    if (atSpaceWidth) {
      return [buildUrl(defaultUrl, rawQuery, start, end), null];
    }

    const spPacked = findSpace(rawQuery, afterAt, end);
    const sp = spPacked === -1 ? -1 : spPacked >> 2;
    const spLen = spPacked === -1 ? 0 : spPacked & 0b11;
    const triggerEnd = sp === -1 ? end : sp;
    const trigger = extractTrigger(rawQuery, afterAt, triggerEnd);

    if (sp === -1 || sp + spLen >= end) {
      const origin = resolveSnapOrigin(trigger, custom, _lastHash);
      if (!origin) {
        return [buildUrl(defaultUrl, rawQuery, start, end), null];
      }
      return [origin, trigger];
    }

    const siteFilter = resolveSnapSiteFilter(trigger, custom, _lastHash);
    if (!siteFilter) {
      return [buildUrl(defaultUrl, rawQuery, start, end), null];
    }
    return [
      buildSnapUrl(defaultUrl, siteFilter, rawQuery, sp + spLen, end),
      trigger,
    ];
  }

  // "query+!" / "query%20!" / "query+%21" / "query%20%21" — trailing bare bang lucky
  const lastChar = rawQuery.charCodeAt(end - 1);
  const trailingTermEnd = findTrailingBareBang(rawQuery, start, end, lastChar);
  if (trailingTermEnd !== -1) {
    if (trailingTermEnd <= start) {
      return ["/", null];
    }
    return [
      luckyOrDefault(luckyUrl, defaultUrl, rawQuery, start, trailingTermEnd),
      null,
    ];
  }

  const exclPacked = findExcl(rawQuery, start, end);
  if (exclPacked === -1) {
    if (_sawAt) {
      const snapPacked = findLastSpaceAt(rawQuery, start, end);
      if (snapPacked !== -1) {
        const spaceBeforeAtPos = snapPacked >> 4;
        const spaceBeforeAtWidth = (snapPacked >> 2) & 0b11;
        const suffixAtWidth = snapPacked & 0b11;
        const triggerStart =
          spaceBeforeAtPos + spaceBeforeAtWidth + suffixAtWidth;
        if (
          triggerStart < end &&
          findSpace(rawQuery, triggerStart, end) === -1
        ) {
          const trigger = extractTrigger(rawQuery, triggerStart, end);
          const siteFilter = resolveSnapSiteFilter(trigger, custom, _lastHash);
          if (siteFilter) {
            return [
              buildSnapUrl(
                defaultUrl,
                siteFilter,
                rawQuery,
                start,
                spaceBeforeAtPos
              ),
              trigger,
            ];
          }
        }
      }
    }
    return [buildUrl(defaultUrl, rawQuery, start, end), null];
  }
  const exclPos = exclPacked >> 2;
  const exclCharWidth = exclPacked & 0b11;

  // "g!+cats"
  const afterExcl = exclPos + exclCharWidth;
  if (afterExcl < end) {
    const c = rawQuery.charCodeAt(afterExcl);
    let spAfter = 0;
    if (c === CH_PLUS) {
      spAfter = 1;
    } else if (
      c === CH_PERCENT &&
      rawQuery.charCodeAt(afterExcl + 1) === CH_2 &&
      rawQuery.charCodeAt(afterExcl + 2) === CH_0
    ) {
      spAfter = 3;
    }
    if (spAfter) {
      const bang = extractTrigger(rawQuery, start, exclPos);
      const termStart = afterExcl + spAfter;
      if (termStart >= end) {
        const origin = resolveBangOrigin(bang, custom, _lastHash);
        if (origin) {
          return [origin, bang];
        }
      } else {
        const filled = resolveBangFill(
          bang,
          custom,
          rawQuery,
          termStart,
          end,
          _lastHash
        );
        if (filled !== null) {
          return [filled, bang];
        }
      }
      return [buildUrl(defaultUrl, rawQuery, start, end), null];
    }
  }

  // "g!"
  if (afterExcl >= end) {
    if (findSpace(rawQuery, start, end) === -1) {
      const bang = extractTrigger(rawQuery, start, exclPos);
      const origin = resolveBangOrigin(bang, custom, _lastHash);
      if (origin) {
        return [origin, bang];
      }
      return [buildUrl(defaultUrl, rawQuery, start, end), null];
    }
  }

  // "cats+!g"
  const suffixPacked = findLastSpaceExcl(rawQuery, start, end);
  if (suffixPacked !== -1) {
    const spaceBeforeBangPos = suffixPacked >> 4;
    const spaceBeforeBangWidth = (suffixPacked >> 2) & 0b11;
    const suffixExclWidth = suffixPacked & 0b11;
    const bangStart =
      spaceBeforeBangPos + spaceBeforeBangWidth + suffixExclWidth;
    if (bangStart < end) {
      if (findSpace(rawQuery, bangStart, end) === -1) {
        const bang = extractTrigger(rawQuery, bangStart, end);
        const filled = resolveBangFill(
          bang,
          custom,
          rawQuery,
          start,
          spaceBeforeBangPos,
          _lastHash
        );
        if (filled !== null) {
          return [filled, bang];
        }
        return [buildUrl(defaultUrl, rawQuery, start, end), null];
      }
    }
  }

  // "cats+g!"
  if (
    lastChar === CH_EXCL ||
    (end >= 3 && isEncodedExclAt(rawQuery, end - exclCharWidth))
  ) {
    const bangExclEnd = lastChar === CH_EXCL ? end - 1 : end - 3;
    const lastSpPacked = findLastSpace(rawQuery, start, bangExclEnd - 1);
    if (lastSpPacked !== -1) {
      const lastSpPos = lastSpPacked >> 2;
      const lastSpLen = lastSpPacked & 0b11;
      const suffixBangStart = lastSpPos + lastSpLen;
      if (suffixBangStart < bangExclEnd) {
        const bang = extractTrigger(rawQuery, suffixBangStart, bangExclEnd);
        const filled = resolveBangFill(
          bang,
          custom,
          rawQuery,
          start,
          lastSpPos,
          _lastHash
        );
        if (filled !== null) {
          return [filled, bang];
        }
        return [buildUrl(defaultUrl, rawQuery, start, end), null];
      }
    }
  }

  return [buildUrl(defaultUrl, rawQuery, start, end), null];
}

export function redirectRaw(
  rawQuery: string,
  settings: RedirectSettings
): [Response, string | null] {
  const [url, trigger] = resolveRaw(rawQuery, settings);
  return [redir(url), trigger];
}

function encodeForRedirect(query: string): string {
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

export function redirectUrl(query: string, settings: RedirectSettings): string {
  return resolveRaw(encodeForRedirect(query), settings)[0];
}

export function redirect(query: string, settings: RedirectSettings): Response {
  return redir(redirectUrl(query, settings));
}
