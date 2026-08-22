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
import {
  DEFAULT_LUCKY_URL,
  DEFAULT_URL,
  LUCKY_TRIGGER_PROVIDERS,
  LUCKY_URLS,
  TOP_FRECENCY_ENTRIES,
} from "../shared/constants";
import { validateCustomTrigger } from "../shared/custom-trigger";
import { hashFNV1a } from "../shared/hash";
import { HOT_BOOT_SENTINEL, HOT_BOOT_VERSION } from "../shared/hot-boot";
import { normalizeLocaleSetting } from "../shared/locale-table";
import { withPathSeparator } from "../shared/raw-url";
import { lookupBang } from "./bang-data";
import { onLocaleChange, substituteLocale } from "./locale";
import {
  type CustomUrlParts,
  compileTriggerMarker,
  compileTriggerSyntax,
  type HotBangLookup,
  type RedirectSettings,
  type TriggerSyntax,
  type UrlParts,
} from "./redirect";
import type { RedirectSettingsSnapshot } from "./redirect-settings";

const MASK_BASE = 2 ** HOT_BANG_COUNT;
const MAX_PACKED_STATE = 256 * MASK_BASE - 1;

export { HOT_BOOT_SENTINEL };
export const NO_HOT_BOOT = -1;

export type HotFrecencyEntry = readonly [string, UrlParts];

export interface HotBootRecord {
  baseComplete: boolean;
  locale: string | null;
  compactSettings: RedirectSettings | null;
  defaultBang: string;
  frecency: Readonly<Record<string, UrlParts>> | null;
  hotBangLookup: HotBangLookup;
  payloadComplete: boolean;
  settings: RedirectSettings | null;
  state: number;
}

const hotBangUrlCache: Array<UrlParts | undefined> = [];

// Substituted lazily, per id. Resolving a locale means negotiating against
// `navigator.languages` and walking the locale table, and only six of the hot
// prefixes carry a `{lang}` placeholder at all. Doing it eagerly put that work
// in front of every worker start, so a restarted worker answering `!gh` paid to
// resolve a Wikipedia language it never used.
const hotPrefixCache: Array<string | undefined> = [];

function hotPrefix(id: number): string {
  let prefix = hotPrefixCache[id];
  if (prefix === undefined) {
    const raw = HOT_PREFIXES[id];
    prefix = raw.indexOf("{") === -1 ? raw : substituteLocale(raw);
    hotPrefixCache[id] = prefix;
  }
  return prefix;
}

export function refreshHotLocalePrefixes(): void {
  hotPrefixCache.length = 0;
  hotBangUrlCache.length = 0;
}

onLocaleChange(refreshHotLocalePrefixes);

function hotBangParts(id: number): UrlParts {
  let parts = hotBangUrlCache[id];
  if (!parts) {
    parts = [hotPrefix(id), HOT_SUFFIXES[id]];
    hotBangUrlCache[id] = parts;
  }
  return parts;
}

function generatedHotBangParts(trigger: string): UrlParts | null {
  const id = lookupHotBang(trigger);
  return id === -1 ? null : hotBangParts(id);
}

/**
 * The single source location for every hot-bang lookup handed to the redirect
 * core.
 *
 * V8 keys a call site's inline cache on the callee's closure identity, which is
 * derived from where the closure was created. Three separate factories made the
 * core's two lookup sites polymorphic as soon as a worker moved from compact to
 * full hot-boot settings within one lifetime. One factory keeps them
 * monomorphic; `frecency === null` and `overrides === 0` are the fast defaults.
 *
 * Term bounds activate direct filling for generated query-safe hot bangs.
 * Frecency hits deliberately return parts instead: they are arbitrary catalog
 * URLs, so the core still owns their encoding.
 */
function makeHotBangLookup(
  frecency: Readonly<Record<string, UrlParts>> | null,
  overrides: number
): HotBangLookup {
  return ((
    trigger: string,
    rawQuery?: string,
    termStart?: number,
    termEnd?: number
  ): UrlParts | string | false | null => {
    if (frecency !== null) {
      const hit = frecency[trigger];
      if (hit !== undefined) {
        return hit;
      }
    }
    const id = lookupHotBang(trigger);
    if (id === -1) {
      return null;
    }
    if (overrides !== 0 && (overrides & (1 << id)) !== 0) {
      return false;
    }
    return rawQuery === undefined
      ? hotBangParts(id)
      : hotPrefix(id) +
          rawQuery.substring(termStart as number, termEnd) +
          HOT_SUFFIXES[id];
  }) as HotBangLookup;
}

export const lookupGeneratedHotBang: HotBangLookup = makeHotBangLookup(null, 0);

// Nothing to specialize means the shared instance: one less closure per
// hot-boot decode, and callers can still compare against it by identity.
function createHotBangLookup(
  frecency: Readonly<Record<string, UrlParts>> | null,
  overrides: number
): HotBangLookup {
  return frecency === null && overrides === 0
    ? lookupGeneratedHotBang
    : makeHotBangLookup(frecency, overrides);
}

function createFrecencyHotBangLookup(
  frecency: Readonly<Record<string, UrlParts>>
): HotBangLookup {
  return createHotBangLookup(
    Object.keys(frecency).length === 0 ? null : frecency,
    0
  );
}

function createCompactHotBangLookup(state: number): HotBangLookup {
  return createHotBangLookup(null, state & (MASK_BASE - 1));
}

function createCompactSettings(state: number): RedirectSettings {
  const marker = Math.floor(state / MASK_BASE);
  return {
    custom: Object.create(null),
    defaultUrl: ["https://flashbang.invalid/", null],
    luckyUrl: null,
    syntax: [compileTriggerMarker(marker), 0] as TriggerSyntax,
  };
}

function splitUrl(raw: string): UrlParts {
  const value = withPathSeparator(raw);
  const placeholder = value.indexOf("{}");
  return placeholder === -1
    ? [value, null]
    : [value.substring(0, placeholder), value.substring(placeholder + 2)];
}

function baseSettings(
  defaultUrl: UrlParts,
  luckyUrl: UrlParts | null,
  syntax?: TriggerSyntax
): RedirectSettings {
  return {
    custom: Object.create(null),
    defaultUrl: [defaultUrl[0], defaultUrl[1]],
    luckyUrl: luckyUrl ? [luckyUrl[0], luckyUrl[1]] : null,
    ...(syntax ? { syntax } : {}),
  };
}

export function materializeCompactBaseSettings(
  snapshot: RedirectSettingsSnapshot,
  prepared?: RedirectSettings | null
): RedirectSettings | null {
  if (prepared) {
    return baseSettings(
      prepared.defaultUrl,
      prepared.luckyUrl,
      prepared.syntax
    );
  }

  const customDefault = snapshot.custom[snapshot.defaultBang];
  let defaultUrl: UrlParts;
  let effectiveDefaultBang = snapshot.defaultBang;
  if (customDefault) {
    if (customDefault.length < 5) {
      const defaultEntry = customDefault as UrlParts;
      defaultUrl = [defaultEntry[0], defaultEntry[1]];
    } else {
      defaultUrl = splitUrl(DEFAULT_URL);
      effectiveDefaultBang = "g";
    }
  } else {
    const generatedDefault = generatedHotBangParts(snapshot.defaultBang);
    if (!generatedDefault) {
      return null;
    }
    defaultUrl = generatedDefault;
  }

  let luckyUrl: UrlParts | null;
  switch (snapshot.luckyProvider) {
    case "none":
      luckyUrl = null;
      break;
    case "google":
    case "ddg":
    case "kagi":
      luckyUrl = splitUrl(LUCKY_URLS[snapshot.luckyProvider]);
      break;
    case "custom":
      luckyUrl = snapshot.luckyUrl;
      break;
    default:
      luckyUrl = splitUrl(
        LUCKY_URLS[LUCKY_TRIGGER_PROVIDERS[effectiveDefaultBang]] ||
          DEFAULT_LUCKY_URL
      );
      break;
  }
  return baseSettings(defaultUrl, luckyUrl, snapshot.syntax);
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
  locale: string | null;
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
  if (!Array.isArray(value) || value.length !== 7) {
    return null;
  }
  const [
    defaultBang,
    defaultUrl,
    luckyUrl,
    markers,
    entries,
    frecencyEntries,
    rawLocale,
  ] = value;
  if (!(rawLocale === null || typeof rawLocale === "string")) {
    return null;
  }
  const locale = rawLocale === null ? null : normalizeLocaleSetting(rawLocale);
  if (rawLocale !== null && locale === null) {
    return null;
  }
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
      lookupHotBang(item[0]) !== -1 ||
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
    locale,
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
      snapshot.locale ?? null,
    ])
  );
}

function encodeCompactBaseSettings(
  settings: RedirectSettings,
  locale: string | null
): string {
  const markers = settings.syntax
    ? [settings.syntax[0] & 0xff, settings.syntax[1] & 0xff]
    : [33, 64];
  return encodeBase64Url(
    JSON.stringify([settings.defaultUrl, settings.luckyUrl, markers, locale])
  );
}

function decodeCompactBaseSettings(
  encoded: string
): { locale: string | null; settings: RedirectSettings } | null {
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
  if (!Array.isArray(value) || value.length !== 4) {
    return null;
  }
  const [defaultUrl, luckyUrl, markers, rawLocale] = value;
  if (!(rawLocale === null || typeof rawLocale === "string")) {
    return null;
  }
  const locale = rawLocale === null ? null : normalizeLocaleSetting(rawLocale);
  if (rawLocale !== null && locale === null) {
    return null;
  }
  if (!isUrlParts(defaultUrl)) {
    return null;
  }
  if (!(luckyUrl === null || isUrlParts(luckyUrl))) {
    return null;
  }
  if (
    !Array.isArray(markers) ||
    markers.length !== 2 ||
    !markers.every(
      (marker) => Number.isInteger(marker) && isBangMarker(marker)
    ) ||
    markers[0] === markers[1]
  ) {
    return null;
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
    locale,
    settings: baseSettings(defaultUrl, luckyUrl, syntax),
  };
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
      lookupHotBang(trigger) !== -1
    ) {
      continue;
    }
    const parts = lookupBang(trigger, hashFNV1a(trigger));
    if (parts && isUrlParts(parts)) {
      entries.push([trigger, [substituteLocale(parts[0]), parts[1]]]);
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
  frecency: readonly HotFrecencyEntry[] = [],
  locale: string | null = null
): string {
  const compact = `${HOT_BOOT_VERSION}|${cacheName}|${state.toString(36)}`;
  if (!settings) {
    return compact;
  }
  if (!snapshot) {
    return `${compact}|c${encodeCompactBaseSettings(settings, locale)}`;
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
      baseComplete: false,
      compactSettings: createCompactSettings(packed),
      defaultBang: "",
      frecency: null,
      hotBangLookup: createCompactHotBangLookup(packed),
      locale: null,
      payloadComplete: false,
      settings: null,
      state: packed,
    };
  }
  const payload = raw.substring(payloadStart + 1);
  if (payload.charCodeAt(0) === 99) {
    const compact = decodeCompactBaseSettings(payload.substring(1));
    if (!compact) {
      return null;
    }
    return {
      baseComplete: true,
      compactSettings: compact.settings,
      defaultBang: "",
      frecency: null,
      hotBangLookup: createCompactHotBangLookup(packed),
      locale: compact.locale,
      payloadComplete: false,
      settings: null,
      state: packed,
    };
  }
  const decoded = decodeBootSettings(payload);
  if (!decoded) {
    return null;
  }
  return {
    baseComplete: true,
    compactSettings: null,
    defaultBang: decoded.defaultBang,
    frecency: decoded.frecency,
    hotBangLookup: createFrecencyHotBangLookup(decoded.frecency),
    locale: decoded.locale,
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
