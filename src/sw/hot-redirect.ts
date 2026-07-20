import {
  HOT_BANG_COUNT,
  HOT_PREFIXES,
  HOT_SUFFIXES,
  HOT_TRIGGERS,
  lookupHotBang,
} from "../generated/bangs-hot.js";
import { validateCustomTrigger } from "../shared/custom-trigger";
import { HOT_BOOT_SENTINEL, HOT_BOOT_VERSION } from "../shared/hot-boot";
import {
  type CustomUrlParts,
  compileTriggerSyntax,
  type RedirectSettings,
  type UrlParts,
} from "./redirect";
import type { RedirectSettingsSnapshot } from "./redirect-settings";

const MASK_BASE = 2 ** HOT_BANG_COUNT;
const MAX_PACKED_STATE = 256 * MASK_BASE - 1;
export const MAX_HOT_BOOT_RECORD_LENGTH = 96 * 1024;

export { HOT_BOOT_SENTINEL };
export const NO_HOT_BOOT = -1;

let resolvedHotId = -1;
let bootSettings: RedirectSettings | null = null;
let bootDefaultBang = "";
let bootPayloadComplete = false;

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

function parseBase36(raw: string, start: number, end = raw.length): number {
  let value = 0;
  if (start >= end) {
    return -1;
  }
  for (let i = start; i < end; i++) {
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

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeBase64Url(value: string): string | null {
  try {
    const padding = (4 - (value.length & 3)) & 3;
    const binary = atob(
      `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat(padding)}`
    );
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function isUrlParts(value: unknown): value is UrlParts {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    (value[1] === null || typeof value[1] === "string")
  );
}

function isSnapTarget(value: unknown): value is readonly [string, string] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    typeof value[1] === "string"
  );
}

function isSimpleCustom(value: unknown): value is CustomUrlParts {
  return (
    isUrlParts(value) ||
    (Array.isArray(value) &&
      value.length === 3 &&
      typeof value[0] === "string" &&
      (value[1] === null || typeof value[1] === "string") &&
      isSnapTarget(value[2]))
  );
}

function decodeBootSettings(encoded: string): {
  defaultBang: string;
  settings: RedirectSettings;
} | null {
  const decoded = decodeBase64Url(encoded);
  if (decoded === null) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length !== 5) {
    return null;
  }
  const [defaultBang, defaultUrl, luckyUrl, markers, entries] = value;
  if (
    typeof defaultBang !== "string" ||
    !defaultBang ||
    defaultBang.length > 64 ||
    !isUrlParts(defaultUrl) ||
    !(luckyUrl === null || isUrlParts(luckyUrl)) ||
    !Array.isArray(markers) ||
    markers.length !== 2 ||
    !markers.every(
      (marker) => Number.isInteger(marker) && isBangMarker(marker)
    ) ||
    markers[0] === markers[1] ||
    !Array.isArray(entries)
  ) {
    return null;
  }

  const custom = Object.create(null) as Record<string, CustomUrlParts>;
  for (const item of entries) {
    if (
      !Array.isArray(item) ||
      item.length !== 2 ||
      typeof item[0] !== "string" ||
      validateCustomTrigger(item[0]) !== null ||
      Object.hasOwn(custom, item[0]) ||
      !isSimpleCustom(item[1])
    ) {
      return null;
    }
    custom[item[0]] = item[1];
  }

  const syntax = compileTriggerSyntax(
    String.fromCharCode(markers[0]) as Parameters<
      typeof compileTriggerSyntax
    >[0],
    String.fromCharCode(markers[1]) as Parameters<
      typeof compileTriggerSyntax
    >[1]
  );
  return {
    defaultBang,
    settings: {
      custom,
      defaultUrl,
      luckyUrl,
      ...(syntax ? { syntax } : {}),
    },
  };
}

function encodeBootSettings(
  snapshot: RedirectSettingsSnapshot,
  settings: RedirectSettings
): string {
  const custom = Object.keys(snapshot.custom)
    .sort()
    .flatMap((trigger) => {
      const entry = snapshot.custom[trigger];
      return entry.length === 2 || entry.length === 3 ? [[trigger, entry]] : [];
    });
  const markers = settings.syntax
    ? [settings.syntax[0] & 0xff, settings.syntax[1] & 0xff]
    : [33, 64];
  return encodeBase64Url(
    JSON.stringify([
      snapshot.defaultBang,
      settings.defaultUrl,
      settings.luckyUrl,
      markers,
      custom,
    ])
  );
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

export function encodeHotBootRecord(
  cacheName: string,
  state: number,
  snapshot?: RedirectSettingsSnapshot,
  settings?: RedirectSettings
): string {
  const compact = `${HOT_BOOT_VERSION}|${cacheName}|${state.toString(36)}`;
  if (!(snapshot && settings)) {
    return compact;
  }
  const record = `${compact}|${encodeBootSettings(snapshot, settings)}`;
  return record.length <= MAX_HOT_BOOT_RECORD_LENGTH ? record : `${compact}|-`;
}

export function parseHotBootRecord(raw: string, cacheName: string): number {
  bootSettings = null;
  bootDefaultBang = "";
  bootPayloadComplete = false;
  const prefix = `${HOT_BOOT_VERSION}|${cacheName}|`;
  if (!raw.startsWith(prefix)) {
    return NO_HOT_BOOT;
  }
  const payloadStart = raw.indexOf("|", prefix.length);
  const packed = parseBase36(
    raw,
    prefix.length,
    payloadStart === -1 ? raw.length : payloadStart
  );
  if (packed < 0 || !isBangMarker(Math.floor(packed / MASK_BASE))) {
    return NO_HOT_BOOT;
  }
  if (payloadStart !== -1) {
    bootPayloadComplete = true;
    const encoded = raw.substring(payloadStart + 1);
    if (encoded !== "-") {
      const decoded = decodeBootSettings(encoded);
      if (!decoded) {
        bootPayloadComplete = false;
        return NO_HOT_BOOT;
      }
      bootDefaultBang = decoded.defaultBang;
      bootSettings = decoded.settings;
    }
  }
  return packed;
}

export function getHotBootDefaultBang(): string {
  return bootDefaultBang;
}

export function getHotBootSettings(): RedirectSettings | null {
  return bootSettings;
}

export function hotBootSettingsNeedPublish(): boolean {
  return !bootPayloadComplete;
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
