import {
  HOT_BANG_COUNT,
  HOT_PREFIXES,
  HOT_SUFFIXES,
  HOT_TRIGGERS,
  lookupHotBang,
} from "../generated/bangs-hot.js";
import {
  type CaptureUrlParts,
  compileCaptureUrl,
} from "../shared/capture-template";
import { TOP_FRECENCY_ENTRIES } from "../shared/constants";
import { validateCustomTrigger } from "../shared/custom-trigger";
import { hashFNV1a } from "../shared/hash";
import { HOT_BOOT_SENTINEL, HOT_BOOT_VERSION } from "../shared/hot-boot";
import { lookupBang } from "./bang-data";
import {
  type CustomUrlParts,
  compileTriggerSyntax,
  type RedirectSettings,
  type UrlParts,
} from "./redirect";
import type { RedirectSettingsSnapshot } from "./redirect-settings";

const MASK_BASE = 2 ** HOT_BANG_COUNT;
const MAX_PACKED_STATE = 256 * MASK_BASE - 1;

export { HOT_BOOT_SENTINEL };
export const NO_HOT_BOOT = -1;

let resolvedHotId = -1;
let resolvedFrecencyTrigger = "";

export type HotFrecencyEntry = readonly [string, UrlParts];

export interface HotBootRecord {
  defaultBang: string;
  frecency: Readonly<Record<string, UrlParts>> | null;
  payloadComplete: boolean;
  settings: RedirectSettings | null;
  state: number;
}

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

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function isUrlParts(value: unknown): value is UrlParts {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    isHttpUrl(value[0]) &&
    (value[1] === null || typeof value[1] === "string")
  );
}

function isSnapTarget(value: unknown): value is readonly [string, string] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "string" ||
    typeof value[1] !== "string"
  ) {
    return false;
  }
  try {
    const url = new URL(value[1]);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return false;
    }
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
    const host = url.host.startsWith("www.") ? url.host.substring(4) : url.host;
    return (
      value[0] === `+site:${host}${path}` &&
      value[1] === `${url.protocol}//${url.host}${path}`
    );
  } catch {
    return false;
  }
}

function isSimpleCustom(value: unknown): value is CustomUrlParts {
  return (
    isUrlParts(value) ||
    (Array.isArray(value) &&
      value.length === 3 &&
      typeof value[0] === "string" &&
      isHttpUrl(value[0]) &&
      (value[1] === null || typeof value[1] === "string") &&
      isSnapTarget(value[2]))
  );
}

// Compile wire-format capture sources once so redirects receive the same
// precompiled tuple shape as IndexedDB-loaded settings.
function decodeCustomEntry(value: unknown): CustomUrlParts | null {
  if (isSimpleCustom(value)) {
    return value;
  }
  if (
    !Array.isArray(value) ||
    (value.length !== 3 && value.length !== 4) ||
    typeof value[0] !== "string" ||
    typeof value[1] !== "string" ||
    (value[2] !== 0 && value[2] !== 1 && value[2] !== 2) ||
    (value.length === 4 && !isSnapTarget(value[3]))
  ) {
    return null;
  }
  let encoding: "percent" | "plus" | "raw" = "percent";
  if (value[2] === 0) {
    encoding = "raw";
  } else if (value[2] === 2) {
    encoding = "plus";
  }
  const capture = compileCaptureUrl(value[0], value[1], encoding);
  if (!capture) {
    return null;
  }
  return value.length === 4
    ? ([...capture, value[3]] as CustomUrlParts)
    : capture;
}

function decodeBootSettings(encoded: string): {
  defaultBang: string;
  frecency: Readonly<Record<string, UrlParts>>;
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
  if (!Array.isArray(value) || value.length !== 6) {
    return null;
  }
  const [defaultBang, defaultUrl, luckyUrl, markers, entries, frecencyEntries] =
    value;
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
    !Array.isArray(entries) ||
    !Array.isArray(frecencyEntries) ||
    frecencyEntries.length > TOP_FRECENCY_ENTRIES
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
      Object.hasOwn(custom, item[0])
    ) {
      return null;
    }
    const entry = decodeCustomEntry(item[1]);
    if (!entry) {
      return null;
    }
    custom[item[0]] = entry;
  }

  const frecency = Object.create(null) as Record<string, UrlParts>;
  for (const item of frecencyEntries) {
    if (
      !Array.isArray(item) ||
      item.length !== 2 ||
      typeof item[0] !== "string" ||
      validateCustomTrigger(item[0]) !== null ||
      Object.hasOwn(custom, item[0]) ||
      Object.hasOwn(frecency, item[0]) ||
      lookupHotBang(item[0], 0, item[0].length) !== -1 ||
      !isUrlParts(item[1])
    ) {
      return null;
    }
    frecency[item[0]] = item[1];
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
    frecency,
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
  settings: RedirectSettings,
  frecency: readonly HotFrecencyEntry[]
): string {
  const triggers = Object.keys(snapshot.custom).sort();
  const custom = new Array<readonly [string, unknown]>(triggers.length);
  for (let i = 0; i < triggers.length; i++) {
    const trigger = triggers[i];
    const entry = snapshot.custom[trigger];
    if (entry.length < 5) {
      custom[i] = [trigger, entry];
      continue;
    }
    const capture = entry as CaptureUrlParts;
    let template = capture[0];
    for (let j = 0; j < capture[2].length; j++) {
      template += `$${capture[2][j]}${capture[1][j]}`;
    }
    custom[i] = [
      trigger,
      entry.length === 6
        ? [template, capture[3].source, capture[4], entry[5]]
        : [template, capture[3].source, capture[4]],
    ];
  }
  const markers = settings.syntax
    ? [settings.syntax[0] & 0xff, settings.syntax[1] & 0xff]
    : [33, 64];
  return encodeBase64Url(
    JSON.stringify([
      snapshot.defaultBang,
      [settings.defaultUrl[0], settings.defaultUrl[1]],
      settings.luckyUrl,
      markers,
      custom,
      frecency.slice(0, TOP_FRECENCY_ENTRIES),
    ])
  );
}

export function materializeHotFrecency(
  counts: Readonly<Record<string, number>>,
  snapshot: RedirectSettingsSnapshot
): HotFrecencyEntry[] {
  const entries: HotFrecencyEntry[] = [];
  for (const trigger of Object.keys(counts)) {
    if (
      entries.length >= TOP_FRECENCY_ENTRIES ||
      Object.hasOwn(snapshot.custom, trigger) ||
      lookupHotBang(trigger, 0, trigger.length) !== -1
    ) {
      continue;
    }
    const parts = lookupBang(trigger, hashFNV1a(trigger));
    if (parts && isUrlParts(parts)) {
      entries.push([trigger, [parts[0], parts[1]]]);
    }
  }
  return entries;
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
  settings?: RedirectSettings,
  frecency: readonly HotFrecencyEntry[] = []
): string {
  const compact = `${HOT_BOOT_VERSION}|${cacheName}|${state.toString(36)}`;
  if (!(snapshot && settings)) {
    return compact;
  }
  return `${compact}|${encodeBootSettings(snapshot, settings, frecency)}`;
}

export function parseHotBootRecord(raw: string, cacheName: string): number {
  return decodeHotBootRecord(raw, cacheName)?.state ?? NO_HOT_BOOT;
}

export function decodeHotBootRecord(
  raw: string,
  cacheName: string
): HotBootRecord | null {
  const prefix = `${HOT_BOOT_VERSION}|${cacheName}|`;
  if (!raw.startsWith(prefix)) {
    return null;
  }
  const payloadStart = raw.indexOf("|", prefix.length);
  const packed = parseBase36(
    raw,
    prefix.length,
    payloadStart === -1 ? raw.length : payloadStart
  );
  if (packed < 0 || !isBangMarker(Math.floor(packed / MASK_BASE))) {
    return null;
  }
  if (payloadStart === -1) {
    return {
      defaultBang: "",
      frecency: null,
      payloadComplete: false,
      settings: null,
      state: packed,
    };
  }
  const decoded = decodeBootSettings(raw.substring(payloadStart + 1));
  if (!decoded) {
    return null;
  }
  return {
    defaultBang: decoded.defaultBang,
    frecency: decoded.frecency,
    payloadComplete: true,
    settings: decoded.settings,
    state: packed,
  };
}

export function hotBootSettingsNeedPublish(
  record: HotBootRecord | null
): boolean {
  return !record?.payloadComplete;
}

export function getResolvedHotTrigger(): string {
  return resolvedHotId === -1
    ? resolvedFrecencyTrigger
    : HOT_TRIGGERS[resolvedHotId];
}

export function resolveHotRedirect(
  rawQuery: string,
  state: number,
  frecency?: Readonly<Record<string, UrlParts>> | null
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
  }
  if (separatorWidth === 0) {
    return null;
  }

  const id = lookupHotBang(rawQuery, triggerStart, separator);
  let prefix: string;
  let suffix: string | null;
  if (id >= 0) {
    if ((state & (1 << id)) !== 0) {
      return null;
    }
    resolvedHotId = id;
    prefix = HOT_PREFIXES[id];
    suffix = HOT_SUFFIXES[id];
  } else {
    const trigger = rawQuery.substring(triggerStart, separator);
    const parts = frecency?.[trigger];
    if (!parts) {
      return null;
    }
    resolvedFrecencyTrigger = trigger;
    prefix = parts[0];
    suffix = parts[1];
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

  return suffix === null
    ? prefix
    : prefix + rawQuery.substring(termStart, termEnd) + suffix;
}
