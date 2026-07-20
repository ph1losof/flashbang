import {
  HOT_BANG_COUNT,
  HOT_PREFIXES,
  HOT_SUFFIXES,
  HOT_TRIGGERS,
  lookupHotBang,
} from "../generated/bangs-hot.js";
import { HOT_BOOT_SENTINEL, HOT_BOOT_VERSION } from "../shared/hot-boot";
import type { RedirectSettingsSnapshot } from "./redirect-settings";

const MASK_BASE = 2 ** HOT_BANG_COUNT;
const MAX_PACKED_STATE = 256 * MASK_BASE - 1;

export { HOT_BOOT_SENTINEL };
export const NO_HOT_BOOT = -1;

let resolvedHotId = -1;

function isBangMarker(code: number): boolean {
  return (
    code === 33 ||
    code === 36 ||
    code === 58 ||
    code === 59 ||
    code === 64 ||
    code === 126
  );
}

function parseBase36(raw: string, start: number): number {
  let value = 0;
  if (start >= raw.length) {
    return -1;
  }
  for (let i = start; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    let digit = -1;
    if (code >= 48 && code <= 57) {
      digit = code - 48;
    } else if (code >= 97 && code <= 122) {
      digit = code - 87;
    }
    if (digit < 0) {
      return -1;
    }
    value = value * 36 + digit;
    if (value > MAX_PACKED_STATE) {
      return -1;
    }
  }
  return value;
}

export function createHotBootState(snapshot: RedirectSettingsSnapshot): number {
  let overrides = 0;
  for (let i = 0; i < HOT_BANG_COUNT; i++) {
    if (Object.hasOwn(snapshot.custom, HOT_TRIGGERS[i])) {
      overrides |= 1 << i;
    }
  }
  const marker = snapshot.syntax ? snapshot.syntax[0] & 0xff : 33;
  return marker * MASK_BASE + overrides;
}

export function encodeHotBootRecord(cacheName: string, state: number): string {
  return `${HOT_BOOT_VERSION}|${cacheName}|${state.toString(36)}`;
}

export function parseHotBootRecord(raw: string, cacheName: string): number {
  const prefix = `${HOT_BOOT_VERSION}|${cacheName}|`;
  if (!raw.startsWith(prefix)) {
    return NO_HOT_BOOT;
  }
  const packed = parseBase36(raw, prefix.length);
  if (packed < 0 || !isBangMarker(Math.floor(packed / MASK_BASE))) {
    return NO_HOT_BOOT;
  }
  return packed;
}

export function getResolvedHotTrigger(): string {
  return HOT_TRIGGERS[resolvedHotId];
}

export function resolveHotRedirect(
  rawQuery: string,
  state: number
): string | null {
  resolvedHotId = -1;
  if (state < 0) {
    return null;
  }

  const marker = Math.floor(state / MASK_BASE);
  const length = rawQuery.length;
  let triggerStart = 0;
  if (rawQuery.charCodeAt(0) === marker) {
    triggerStart = 1;
  } else if (
    length >= 3 &&
    rawQuery.charCodeAt(0) === 37 &&
    rawQuery.charCodeAt(1) === (marker >> 4) + 48 &&
    (rawQuery.charCodeAt(2) | 32) ===
      ((marker & 15) < 10 ? (marker & 15) + 48 : (marker & 15) + 87)
  ) {
    triggerStart = 3;
  } else {
    return null;
  }

  let hash = 2166136261 >>> 0;
  let separator = triggerStart;
  let separatorWidth = 0;
  for (; separator < length; separator++) {
    const code = rawQuery.charCodeAt(separator);
    if (code === 43) {
      separatorWidth = 1;
      break;
    }
    if (
      code === 37 &&
      rawQuery.charCodeAt(separator + 1) === 50 &&
      rawQuery.charCodeAt(separator + 2) === 48
    ) {
      separatorWidth = 3;
      break;
    }
    if (code >= 65 && code <= 90) {
      return null;
    }
    hash ^= code;
    hash = Math.imul(hash, 16777619);
  }
  if (separatorWidth === 0) {
    return null;
  }

  const id = lookupHotBang(rawQuery, triggerStart, separator, hash >>> 0);
  if (id < 0 || (state & (1 << id)) !== 0) {
    return null;
  }

  const termStart = separator + separatorWidth;
  let termEnd = length;
  while (termEnd > termStart) {
    if (rawQuery.charCodeAt(termEnd - 1) === 43) {
      termEnd--;
      continue;
    }
    if (
      termEnd >= termStart + 3 &&
      rawQuery.charCodeAt(termEnd - 3) === 37 &&
      rawQuery.charCodeAt(termEnd - 2) === 50 &&
      rawQuery.charCodeAt(termEnd - 1) === 48
    ) {
      termEnd -= 3;
      continue;
    }
    break;
  }
  if (termStart >= termEnd) {
    return null;
  }

  resolvedHotId = id;
  return (
    HOT_PREFIXES[id] + rawQuery.substring(termStart, termEnd) + HOT_SUFFIXES[id]
  );
}
