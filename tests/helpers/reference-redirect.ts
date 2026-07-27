import {
  lookupAdvancedBang,
  lookupSnapOverride,
} from "../../src/generated/bangs-sparse.js";
import {
  CAPTURE_ENCODE_PLUS,
  CAPTURE_ENCODE_RAW,
  type CaptureUrlParts,
  MAX_CAPTURE_INPUT_LENGTH,
} from "../../src/shared/capture-template";
import { hashFNV1a } from "../../src/shared/hash";
import { MAX_SNAP_CHAIN_TARGETS } from "../../src/shared/snap-chain";
import type { SnapTargetParts } from "../../src/shared/snap-target";
import { lookupBang } from "../../src/sw/bang-data";
import type {
  CustomUrlParts,
  RedirectSettings,
  UrlParts,
} from "../../src/sw/redirect";

type SimpleEntry = UrlParts | readonly [string, string | null, SnapTargetParts];
type CaptureEntry = readonly [...CaptureUrlParts, SnapTargetParts?];
type UnitKind = "bang" | "char" | "comma" | "snap" | "space";

interface Unit {
  end: number;
  kind: UnitKind;
  start: number;
}

interface Syntax {
  bang: string;
  snap: string;
}

function syntaxFor(settings: RedirectSettings): Syntax {
  return settings.syntax
    ? {
        bang: String.fromCharCode(settings.syntax[0] & 0xff),
        snap: String.fromCharCode(settings.syntax[1] & 0xff),
      }
    : { bang: "!", snap: "@" };
}

function encodedAt(raw: string, index: number, value: string): boolean {
  return (
    raw.charCodeAt(index) === 37 &&
    raw.substring(index + 1, index + 3).toLowerCase() ===
      value.charCodeAt(0).toString(16).padStart(2, "0")
  );
}

function tokenize(raw: string, syntax: Syntax): Unit[] {
  const units: Unit[] = [];
  for (let index = 0; index < raw.length; ) {
    let kind: UnitKind = "char";
    let width = 1;
    const char = raw[index];
    if (char === "+" || raw.substring(index, index + 3) === "%20") {
      kind = "space";
      width = char === "+" ? 1 : 3;
    } else if (char === syntax.bang || encodedAt(raw, index, syntax.bang)) {
      kind = "bang";
      width = char === syntax.bang ? 1 : 3;
    } else if (char === syntax.snap || encodedAt(raw, index, syntax.snap)) {
      kind = "snap";
      width = char === syntax.snap ? 1 : 3;
    } else if (char === "," || encodedAt(raw, index, ",")) {
      kind = "comma";
      width = char === "," ? 1 : 3;
    }
    units.push({ end: index + width, kind, start: index });
    index += width;
  }
  return units;
}

function rawSlice(
  raw: string,
  units: readonly Unit[],
  from: number,
  to: number
): string {
  if (from >= to) {
    return "";
  }
  return raw.substring(units[from].start, units[to - 1].end);
}

function normalizedTrigger(raw: string): string {
  return /[A-Z]/.test(raw) ? raw.toLowerCase() : raw;
}

function pathValue(raw: string): string {
  return raw.replaceAll("+", "%20").replace(/%2f/gi, "/");
}

function buildUrl(entry: SimpleEntry, rawTerm: string): string {
  if (entry[1] === null) {
    return entry[0];
  }
  const template = `${entry[0]}{}${entry[1]}`;
  let result = "";
  let offset = 0;
  while (offset < template.length) {
    const placeholder = template.indexOf("{}", offset);
    if (placeholder === -1) {
      return result + template.substring(offset);
    }
    result += template.substring(offset, placeholder);
    const before = template.substring(0, placeholder);
    const query = before.lastIndexOf("?");
    const fragment = before.lastIndexOf("#");
    result += query > fragment ? rawTerm : pathValue(rawTerm);
    offset = placeholder + 2;
  }
  return result;
}

function decodeCaptureInput(raw: string): string | null {
  if (raw.length > MAX_CAPTURE_INPUT_LENGTH * 6) {
    return null;
  }
  try {
    const decoded = decodeURIComponent(raw.replaceAll("+", " "));
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

function buildCaptureUrl(entry: CaptureEntry, rawTerm: string): string | null {
  const decoded = decodeCaptureInput(rawTerm);
  if (decoded === null) {
    return null;
  }
  const pattern = new RegExp(entry[3].source, entry[3].flags);
  const match = pattern.exec(decoded);
  if (!match) {
    return null;
  }
  let result = entry[0];
  for (let index = 0; index < entry[2].length; index++) {
    result +=
      encodeCapture(match[entry[2][index]] ?? "", entry[4]) + entry[1][index];
  }
  return result;
}

function customSnap(entry: CustomUrlParts): SnapTargetParts | null {
  if (entry.length === 3) {
    return entry[2] as SnapTargetParts;
  }
  return entry.length === 6 ? (entry[5] as SnapTargetParts) : null;
}

function catalogEntry(
  trigger: string,
  custom: Record<string, CustomUrlParts>
): CustomUrlParts | null {
  return (
    custom[trigger] ??
    lookupBang(trigger, hashFNV1a(trigger)) ??
    lookupAdvancedBang(trigger)
  );
}

function originOf(prefix: string): string {
  try {
    return new URL(prefix).origin;
  } catch {
    return prefix;
  }
}

function domainOf(prefix: string): string | null {
  try {
    const host = new URL(prefix).host;
    return (host.startsWith("www.") ? host.substring(4) : host).toLowerCase();
  } catch {
    return null;
  }
}

function bangOrigin(
  trigger: string,
  custom: Record<string, CustomUrlParts>
): string | null {
  const entry = catalogEntry(trigger, custom);
  return entry ? originOf(entry[0]) : null;
}

function bangFill(
  trigger: string,
  rawTerm: string,
  custom: Record<string, CustomUrlParts>
): string | null {
  const entry = catalogEntry(trigger, custom);
  if (!entry) {
    return null;
  }
  return entry.length < 5
    ? buildUrl(entry as SimpleEntry, rawTerm)
    : buildCaptureUrl(entry as CaptureEntry, rawTerm);
}

function snapOrigin(
  trigger: string,
  custom: Record<string, CustomUrlParts>
): string | null {
  const customEntry = custom[trigger];
  if (customEntry) {
    return customSnap(customEntry)?.[1] ?? originOf(customEntry[0]);
  }
  return (
    lookupSnapOverride(trigger, hashFNV1a(trigger), true) ??
    bangOrigin(trigger, custom)
  );
}

function snapFilter(
  trigger: string,
  custom: Record<string, CustomUrlParts>
): string | null {
  const customEntry = custom[trigger];
  if (customEntry) {
    const explicit = customSnap(customEntry);
    if (explicit) {
      return explicit[0];
    }
    const domain = domainOf(customEntry[0]);
    return domain ? `+site:${domain}` : null;
  }
  const hash = hashFNV1a(trigger);
  const explicit = lookupSnapOverride(trigger, hash, false);
  if (explicit) {
    return explicit;
  }
  const entry =
    lookupBang(trigger, hash) ?? lookupAdvancedBang(trigger) ?? null;
  const domain = entry ? domainOf(entry[0]) : null;
  return domain ? `+site:${domain}` : null;
}

function resolveSnapList(
  raw: string,
  units: readonly Unit[],
  from: number,
  to: number,
  custom: Record<string, CustomUrlParts>
): { chain: boolean; filter: string; first: string } | null {
  const ranges: Array<readonly [number, number]> = [];
  let segmentStart = from;
  for (let index = from; index < to; index++) {
    if (units[index].kind === "comma") {
      ranges.push([segmentStart, index]);
      segmentStart = index + 1;
    }
  }
  ranges.push([segmentStart, to]);
  if (
    ranges.length > MAX_SNAP_CHAIN_TARGETS ||
    ranges.some(([start, end]) => start === end)
  ) {
    return null;
  }

  const filters: string[] = [];
  let first = "";
  for (const [start, end] of ranges) {
    const trigger = normalizedTrigger(rawSlice(raw, units, start, end));
    first ||= trigger;
    const filter = snapFilter(trigger, custom);
    if (!filter) {
      return null;
    }
    if (!filters.includes(filter)) {
      filters.push(filter);
    }
  }
  const filter =
    filters.length === 1
      ? filters[0]
      : `+(${filters.map((value) => value.substring(1)).join("+OR+")})`;
  return { chain: ranges.length > 1, filter, first };
}

function buildSnapUrl(
  defaultUrl: UrlParts,
  rawTerm: string,
  filter: string
): string {
  if (defaultUrl[1] === null) {
    return defaultUrl[0];
  }
  const normalizedFilter =
    rawTerm || filter[0] !== "+" ? filter : filter.slice(1);
  return defaultUrl[0] + rawTerm + normalizedFilter + defaultUrl[1];
}

function fallback(settings: RedirectSettings, raw: string): string {
  return buildUrl(settings.defaultUrl, raw);
}

function lucky(settings: RedirectSettings, raw: string): string {
  return buildUrl(settings.luckyUrl ?? settings.defaultUrl, raw);
}

function firstSpace(units: readonly Unit[], from: number, to: number): number {
  for (let index = from; index < to; index++) {
    if (units[index].kind === "space") {
      return index;
    }
  }
  return -1;
}

function resolvePrefixSnap(
  raw: string,
  units: readonly Unit[],
  start: number,
  end: number,
  settings: RedirectSettings
): string {
  const triggerStart = start + 1;
  if (triggerStart >= end) {
    return "/";
  }
  if (units[triggerStart].kind === "space") {
    return fallback(settings, rawSlice(raw, units, start, end));
  }
  const space = firstSpace(units, triggerStart, end);
  const triggerEnd = space === -1 ? end : space;
  const resolved = resolveSnapList(
    raw,
    units,
    triggerStart,
    triggerEnd,
    settings.custom
  );
  if (!resolved) {
    return fallback(settings, rawSlice(raw, units, start, end));
  }
  if (!resolved.chain && space === -1) {
    return (
      snapOrigin(resolved.first, settings.custom) ??
      fallback(settings, rawSlice(raw, units, start, end))
    );
  }
  const term = space === -1 ? "" : rawSlice(raw, units, space + 1, end);
  return buildSnapUrl(settings.defaultUrl, term, resolved.filter);
}

export function referenceRedirectRawUrl(
  raw: string,
  settings: RedirectSettings
): string {
  const units = tokenize(raw, syntaxFor(settings));
  let start = 0;
  while (start < units.length && units[start].kind === "space") {
    start++;
  }
  let end = units.length;
  while (end > start && units[end - 1].kind === "space") {
    end--;
  }
  if (start === end) {
    return "/";
  }

  const whole = () => rawSlice(raw, units, start, end);
  if (
    raw[units[start].start] === "\\" &&
    units[start].end - units[start].start === 1
  ) {
    if (start + 1 < end) {
      return lucky(settings, rawSlice(raw, units, start + 1, end));
    }
  }

  if (units[start].kind === "bang") {
    const after = start + 1;
    if (after === end) {
      return "/";
    }
    if (units[after].kind === "space") {
      return after + 1 === end
        ? "/"
        : lucky(settings, rawSlice(raw, units, after + 1, end));
    }
    const space = firstSpace(units, after, end);
    const triggerEnd = space === -1 ? end : space;
    const trigger = normalizedTrigger(rawSlice(raw, units, after, triggerEnd));
    if (space === -1 || space + 1 === end) {
      return (
        bangOrigin(trigger, settings.custom) ?? fallback(settings, whole())
      );
    }
    return (
      bangFill(
        trigger,
        rawSlice(raw, units, space + 1, end),
        settings.custom
      ) ?? fallback(settings, whole())
    );
  }

  if (units[start].kind === "snap") {
    return resolvePrefixSnap(raw, units, start, end, settings);
  }

  if (
    units[end - 1].kind === "bang" &&
    end - start >= 2 &&
    units[end - 2].kind === "space"
  ) {
    return end - 2 === start
      ? "/"
      : lucky(settings, rawSlice(raw, units, start, end - 2));
  }

  let firstBang = -1;
  for (let index = start; index < end; index++) {
    if (units[index].kind === "bang") {
      firstBang = index;
      break;
    }
  }

  if (firstBang === -1) {
    for (let marker = end - 1; marker > start; marker--) {
      if (units[marker].kind !== "snap" || units[marker - 1].kind !== "space") {
        continue;
      }
      if (firstSpace(units, marker + 1, end) !== -1 || marker + 1 === end) {
        break;
      }
      const resolved = resolveSnapList(
        raw,
        units,
        marker + 1,
        end,
        settings.custom
      );
      if (resolved) {
        return buildSnapUrl(
          settings.defaultUrl,
          rawSlice(raw, units, start, marker - 1),
          resolved.filter
        );
      }
      break;
    }
    return fallback(settings, whole());
  }

  if (firstBang + 1 < end && units[firstBang + 1].kind === "space") {
    const trigger = normalizedTrigger(rawSlice(raw, units, start, firstBang));
    if (firstBang + 2 === end) {
      return (
        bangOrigin(trigger, settings.custom) ?? fallback(settings, whole())
      );
    }
    return (
      bangFill(
        trigger,
        rawSlice(raw, units, firstBang + 2, end),
        settings.custom
      ) ?? fallback(settings, whole())
    );
  }

  if (firstBang + 1 === end && firstSpace(units, start, end) === -1) {
    const trigger = normalizedTrigger(rawSlice(raw, units, start, firstBang));
    return bangOrigin(trigger, settings.custom) ?? fallback(settings, whole());
  }

  for (let marker = end - 1; marker > start; marker--) {
    if (units[marker].kind !== "bang" || units[marker - 1].kind !== "space") {
      continue;
    }
    if (marker + 1 < end && firstSpace(units, marker + 1, end) === -1) {
      const trigger = normalizedTrigger(rawSlice(raw, units, marker + 1, end));
      return (
        bangFill(
          trigger,
          rawSlice(raw, units, start, marker - 1),
          settings.custom
        ) ?? fallback(settings, whole())
      );
    }
    break;
  }

  if (units[end - 1].kind === "bang") {
    for (let space = end - 2; space >= start; space--) {
      if (units[space].kind !== "space") {
        continue;
      }
      if (space + 1 < end - 1) {
        const trigger = normalizedTrigger(
          rawSlice(raw, units, space + 1, end - 1)
        );
        return (
          bangFill(
            trigger,
            rawSlice(raw, units, start, space),
            settings.custom
          ) ?? fallback(settings, whole())
        );
      }
      break;
    }
  }

  return fallback(settings, whole());
}

function encodeForRedirect(query: string): string {
  for (let index = 0; index < query.length; index++) {
    const code = query.charCodeAt(index);
    if (
      code === 0x20 ||
      code === 0x40 ||
      code === 0x5c ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x21 ||
      code === 0x27 ||
      code === 0x28 ||
      code === 0x29 ||
      code === 0x2a ||
      code === 0x2d ||
      code === 0x2e ||
      code === 0x5f ||
      code === 0x7e
    ) {
      continue;
    }
    return encodeURIComponent(query)
      .replaceAll("%5C", "\\")
      .replaceAll("%20", "+");
  }
  return query.replaceAll(" ", "+");
}

export function referenceRedirectUrl(
  query: string,
  settings: RedirectSettings
): string {
  return referenceRedirectRawUrl(encodeForRedirect(query), settings);
}
