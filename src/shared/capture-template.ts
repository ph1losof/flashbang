export const CAPTURE_ENCODE_RAW = 0;
export const CAPTURE_ENCODE_PERCENT = 1;
export const CAPTURE_ENCODE_PLUS = 2;

export type CaptureEncoding = "percent" | "plus" | "raw";

export type CaptureUrlParts = readonly [
  prefix: string,
  suffixes: readonly string[],
  captureIndexes: readonly number[],
  pattern: RegExp,
  encoding: number,
];

export interface CustomBangRecord {
  trigger: string;
  name: string;
  url: string;
  regex?: string;
  snap?: string;
  encoding?: CaptureEncoding;
}

export const MAX_CAPTURE_INPUT_LENGTH = 2048;
export const MAX_CAPTURE_PATTERN_LENGTH = 512;
export const MAX_CAPTURE_TEMPLATE_LENGTH = 4096;
const MAX_CAPTURE_GROUPS = 32;
const CAPTURE_PLACEHOLDER = /\$([1-9]\d*)/g;
const LOCALE_MARKER = /\{(?!\})/;

export function captureEncodingCode(
  encoding: CaptureEncoding | undefined
): number {
  switch (encoding) {
    case "raw":
      return CAPTURE_ENCODE_RAW;
    case "plus":
      return CAPTURE_ENCODE_PLUS;
    default:
      return CAPTURE_ENCODE_PERCENT;
  }
}

export function isCaptureEncoding(value: unknown): value is CaptureEncoding {
  return value === "percent" || value === "plus" || value === "raw";
}

export function parseCaptureTemplate(
  template: string
): readonly [string, string[], number[]] | null {
  CAPTURE_PLACEHOLDER.lastIndex = 0;
  const suffixes: string[] = [];
  const captureIndexes: number[] = [];
  let prefix = "";
  let end = 0;
  let match = CAPTURE_PLACEHOLDER.exec(template);
  while (match !== null) {
    const index = Number(match[1]);
    if (index > MAX_CAPTURE_GROUPS) {
      return null;
    }
    if (captureIndexes.length === 0) {
      prefix = template.substring(0, match.index);
    } else {
      suffixes.push(template.substring(end, match.index));
    }
    captureIndexes.push(index);
    end = match.index + match[0].length;
    match = CAPTURE_PLACEHOLDER.exec(template);
  }
  if (captureIndexes.length === 0) {
    return null;
  }
  suffixes.push(template.substring(end));
  return [prefix, suffixes, captureIndexes];
}

interface PatternGroup {
  hasAlternation: boolean;
  hasQuantifier: boolean;
}

function inspectPatternSafety(
  pattern: string
): readonly [error: string | null, captureCount: number] {
  const groups: PatternGroup[] = [];
  let captureCount = 0;
  let inClass = false;

  for (let i = 0; i < pattern.length; i++) {
    const c = pattern.charCodeAt(i);
    if (c === 0x5c) {
      const next = pattern.charCodeAt(++i);
      if (!inClass && ((next >= 0x31 && next <= 0x39) || next === 0x6b)) {
        return ["Backreferences are not supported", captureCount];
      }
      continue;
    }
    if (c === 0x5b) {
      inClass = true;
      continue;
    }
    if (c === 0x5d && inClass) {
      inClass = false;
      continue;
    }
    if (inClass) {
      continue;
    }
    if (c === 0x28) {
      const next = pattern.charCodeAt(i + 1);
      if (next !== 0x3f || pattern.charCodeAt(i + 2) === 0x3c) {
        if (
          !(
            next === 0x3f &&
            (pattern.charCodeAt(i + 3) === 0x3d ||
              pattern.charCodeAt(i + 3) === 0x21)
          )
        ) {
          captureCount++;
        }
      }
      groups.push({ hasAlternation: false, hasQuantifier: false });
      continue;
    }
    if (c === 0x7c && groups.length > 0) {
      groups[groups.length - 1].hasAlternation = true;
      continue;
    }
    if (c === 0x29) {
      const group = groups.pop();
      if (!group) {
        continue;
      }
      const next = pattern.charCodeAt(i + 1);
      if (
        (next === 0x2a || next === 0x2b || next === 0x3f || next === 0x7b) &&
        (group.hasQuantifier || group.hasAlternation)
      ) {
        return [
          "Nested or ambiguous quantified groups are not supported",
          captureCount,
        ];
      }
      if (groups.length > 0) {
        const parent = groups[groups.length - 1];
        parent.hasQuantifier ||= group.hasQuantifier;
        parent.hasAlternation ||= group.hasAlternation;
      }
      continue;
    }
    if (c === 0x2a || c === 0x2b || c === 0x3f || c === 0x7b) {
      if (groups.length > 0) {
        groups[groups.length - 1].hasQuantifier = true;
      }
      if (c === 0x7b) {
        const close = pattern.indexOf("}", i + 1);
        if (close !== -1) {
          const bounds = pattern.substring(i + 1, close).split(",");
          for (const bound of bounds) {
            if (bound && Number(bound) > 1000) {
              return [
                "Regex repetition limits must not exceed 1000",
                captureCount,
              ];
            }
          }
        }
      }
    }
  }

  if (captureCount === 0) {
    return ["Regex must contain at least one capture group", captureCount];
  }
  if (captureCount > MAX_CAPTURE_GROUPS) {
    return [
      `Regex supports at most ${MAX_CAPTURE_GROUPS} capture groups`,
      captureCount,
    ];
  }
  return [null, captureCount];
}

export function validateCaptureBang(
  template: string,
  pattern: string
): string | null {
  if (template.length > MAX_CAPTURE_TEMPLATE_LENGTH) {
    return `URL template must be at most ${MAX_CAPTURE_TEMPLATE_LENGTH} characters`;
  }
  if (pattern.length > MAX_CAPTURE_PATTERN_LENGTH) {
    return `Regex must be at most ${MAX_CAPTURE_PATTERN_LENGTH} characters`;
  }
  if (template.includes("{}")) {
    return "Use either {} or capture placeholders, not both";
  }
  if (LOCALE_MARKER.test(template)) {
    return "URL may only contain capture placeholders such as $1";
  }
  const parsed = parseCaptureTemplate(template);
  if (!parsed) {
    return "Regex URL must contain a capture placeholder such as $1";
  }
  const [safetyError, captureCount] = inspectPatternSafety(pattern);
  if (safetyError) {
    return safetyError;
  }
  for (const captureIndex of parsed[2]) {
    if (captureIndex > captureCount) {
      return `$${captureIndex} does not have a matching capture group`;
    }
  }
  try {
    new RegExp(pattern);
  } catch {
    return "Invalid regular expression";
  }
  try {
    const sample = template.replace(CAPTURE_PLACEHOLDER, "test");
    const parsedUrl = new URL(sample);
    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      return "URL must use http or https";
    }
    const authorityStart = template.indexOf("://") + 3;
    let authorityEnd = template.length;
    for (const delimiter of ["/", "?", "#"]) {
      const index = template.indexOf(delimiter, authorityStart);
      if (index !== -1 && index < authorityEnd) {
        authorityEnd = index;
      }
    }
    if (parsed[0].length <= authorityEnd) {
      return "Capture placeholders cannot change the URL origin";
    }
  } catch {
    return "Invalid URL template";
  }
  return null;
}

export function compileCaptureUrl(
  template: string,
  pattern: string,
  encoding: CaptureEncoding | undefined
): CaptureUrlParts | null {
  if (validateCaptureBang(template, pattern)) {
    return null;
  }
  const parsed = parseCaptureTemplate(template);
  if (!parsed) {
    return null;
  }
  return [
    parsed[0],
    parsed[1],
    parsed[2],
    new RegExp(pattern),
    captureEncodingCode(encoding),
  ];
}

export function validateSimpleBangUrl(
  url: string,
  allowLocale = false
): string | null {
  if (!url.includes("{}")) {
    return "URL must contain {} for the query";
  }
  if (!allowLocale && LOCALE_MARKER.test(url)) {
    return "URL may only contain the {} placeholder";
  }
  try {
    const parsed = new URL(url.replace("{}", "test"));
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return "URL must use http or https";
    }
  } catch {
    return "Invalid URL template";
  }
  return null;
}
