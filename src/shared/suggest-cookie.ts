import {
  parseFrecencyCompact,
  serializeFrecencyCompact,
} from "./frecency-serial";
import {
  DEFAULT_BANG_PREFIX,
  DEFAULT_SNAP_PREFIX,
  decodeTriggerPrefixes,
  encodeTriggerPrefixes,
  type TriggerPrefix,
} from "./trigger-prefix";

const SECTION_SEPARATOR = "|";
const FREQUENCY_PREFIX = "f:";
const CUSTOM_PREFIX = "c:";

interface ParsedSuggestCookieCore {
  bangPrefix: TriggerPrefix;
  provider: string;
  snapPrefix: TriggerPrefix;
  trigger: string;
  customUrl: string | null;
}

interface ParsedSuggestCookieContext {
  custom: string[];
  frecent: Record<string, number>;
}

export interface ParsedSuggestCookie
  extends ParsedSuggestCookieCore,
    ParsedSuggestCookieContext {}

const DEFAULT_PROVIDER = "default";
const DEFAULT_TRIGGER = "g";

interface ParsedSuggestCookieWithValidation {
  settings: ParsedSuggestCookie;
  hasInvalidContext: boolean;
}

export interface ParsedSuggestCookieContextWithValidation
  extends ParsedSuggestCookieContext {
  hasInvalidContext: boolean;
}

function safeDecodeURIComponent(value: string): string | null {
  if (value.indexOf("%") === -1) {
    return value;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function parseFrecencyCompactSection(
  raw: string,
  forCleanup: boolean
): { value: Record<string, number>; valid: boolean } {
  const value = parseFrecencyCompact(raw);
  const valid = Object.keys(value).length > 0 || !forCleanup;
  return { value, valid };
}

function parseCustom(
  raw: string,
  forCleanup: boolean
): { value: string[]; valid: boolean } {
  const decoded = safeDecodeURIComponent(raw);
  if (!decoded) {
    return { value: [], valid: !forCleanup };
  }

  try {
    const parsed = JSON.parse(decoded);
    if (!Array.isArray(parsed)) {
      return { value: [], valid: false };
    }

    const out: string[] = [];
    for (const item of parsed) {
      if (typeof item === "string") {
        out.push(item);
        continue;
      }
      if (forCleanup) {
        return { value: out, valid: false };
      }
    }

    return { value: out.sort(), valid: true };
  } catch {
    return { value: [], valid: false };
  }
}

function parseSuggestCookieContext(
  raw: string,
  firstPipe: number,
  forCleanup: boolean,
  target: ParsedSuggestCookieContext
): boolean {
  let hasInvalidContext = false;

  if (firstPipe !== -1) {
    let sectionStart = firstPipe + 1;

    while (sectionStart <= raw.length) {
      let sectionEnd = raw.indexOf(SECTION_SEPARATOR, sectionStart);
      if (sectionEnd === -1) {
        sectionEnd = raw.length;
      }

      if (sectionEnd > sectionStart) {
        const section = raw.substring(sectionStart, sectionEnd);
        if (section.startsWith(FREQUENCY_PREFIX)) {
          const sectionVal = section.substring(2);
          const result = parseFrecencyCompactSection(sectionVal, forCleanup);
          target.frecent = result.value;
          if (forCleanup && !result.valid) {
            hasInvalidContext = true;
            break;
          }
        } else if (section.startsWith(CUSTOM_PREFIX)) {
          const result = parseCustom(section.substring(2), forCleanup);
          target.custom = result.value;
          if (forCleanup && !result.valid) {
            hasInvalidContext = true;
            break;
          }
        } else if (forCleanup) {
          hasInvalidContext = true;
          break;
        }
      }

      if (sectionEnd === raw.length) {
        break;
      }

      sectionStart = sectionEnd + 1;
    }
  }

  return hasInvalidContext;
}

export function parseSuggestCookieContextValueWithValidation(
  raw: string,
  forCleanup: boolean
): ParsedSuggestCookieContextWithValidation {
  const context: ParsedSuggestCookieContextWithValidation = {
    custom: [],
    frecent: {},
    hasInvalidContext: false,
  };
  context.hasInvalidContext = parseSuggestCookieContext(
    raw,
    raw.indexOf(SECTION_SEPARATOR),
    forCleanup,
    context
  );
  return context;
}

export function parseSuggestCookieValue(
  raw: string,
  includeBangContext: boolean
): ParsedSuggestCookie {
  return parseSuggestCookieValueWithValidation(raw, includeBangContext, false)
    .settings;
}

export function parseSuggestCookieValueWithValidation(
  raw: string,
  includeBangContext: boolean,
  forCleanup: boolean
): ParsedSuggestCookieWithValidation {
  const firstPipe = raw.indexOf(SECTION_SEPARATOR);
  const firstSection = firstPipe === -1 ? raw : raw.substring(0, firstPipe);

  let provider = "";
  let trigger = "";
  let customUrl = "";
  let syntax = "";

  const comma1 = firstSection.indexOf(",");
  if (comma1 === -1) {
    provider = firstSection;
  } else {
    provider = firstSection.substring(0, comma1);
    const comma2 = firstSection.indexOf(",", comma1 + 1);
    if (comma2 === -1) {
      trigger = firstSection.substring(comma1 + 1);
    } else {
      trigger = firstSection.substring(comma1 + 1, comma2);
      const customStart = comma2 + 1;
      if (customStart < firstSection.length) {
        const comma3 = firstSection.indexOf(",", customStart);
        if (comma3 === -1) {
          customUrl = firstSection.substring(customStart);
        } else {
          customUrl = firstSection.substring(customStart, comma3);
          syntax = firstSection.substring(comma3 + 1);
        }
      }
    }
  }

  const prefixes = syntax ? decodeTriggerPrefixes(syntax) : null;
  const bangPrefix = prefixes?.[0] ?? DEFAULT_BANG_PREFIX;
  const snapPrefix = prefixes?.[1] ?? DEFAULT_SNAP_PREFIX;

  const settings: ParsedSuggestCookie = {
    bangPrefix,
    provider: provider || DEFAULT_PROVIDER,
    snapPrefix,
    trigger: trigger || DEFAULT_TRIGGER,
    customUrl: customUrl ? safeDecodeURIComponent(customUrl) : null,
    frecent: {},
    custom: [],
  };
  let hasInvalidContext = false;
  if (includeBangContext && firstPipe !== -1) {
    hasInvalidContext = parseSuggestCookieContext(
      raw,
      firstPipe,
      forCleanup,
      settings
    );
  }

  return {
    settings,
    hasInvalidContext,
  };
}

export function encodeSuggestCookieValue(
  provider: string,
  trigger: string,
  customUrl: string,
  custom: string[] = [],
  frecent: Record<string, number> | null = null,
  bangPrefix: TriggerPrefix = DEFAULT_BANG_PREFIX,
  snapPrefix: TriggerPrefix = DEFAULT_SNAP_PREFIX
): string {
  let value = `${provider},${trigger},${encodeURIComponent(customUrl)}`;
  if (
    bangPrefix !== DEFAULT_BANG_PREFIX ||
    snapPrefix !== DEFAULT_SNAP_PREFIX
  ) {
    value += `,${encodeTriggerPrefixes(bangPrefix, snapPrefix)}`;
  }

  const compact = serializeFrecencyCompact(frecent);
  if (compact) {
    value += `${SECTION_SEPARATOR}${FREQUENCY_PREFIX}${compact}`;
  }

  if (custom.length > 0) {
    value += `${SECTION_SEPARATOR}${CUSTOM_PREFIX}${encodeURIComponent(
      JSON.stringify(custom)
    )}`;
  }

  return value;
}
