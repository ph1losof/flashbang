import {
  CH_AT,
  CH_CR,
  CH_EXCL,
  CH_FF,
  CH_NL,
  CH_SPACE,
  CH_TAB,
  CH_VTAB,
} from "./shared/chars";
import {
  JSON_HEADERS,
  SUGGEST_TRIGGER_PROVIDERS,
  SUGGEST_URLS,
} from "./shared/constants";
import { readQueryParam } from "./shared/raw-query";
import {
  encodeSuggestCookieValue,
  parseSuggestCookieValue,
  parseSuggestCookieValueWithValidation,
} from "./shared/suggest-cookie";
import { resolveTemplateParts } from "./shared/template";
import { bangSuggestions } from "./suggest-bang";

export interface SuggestCoreSettings {
  customUrl: string | null;
  provider: string;
  trigger: string;
}

export interface SuggestBangContext {
  frecent: Record<string, number>;
  custom: string[];
}

export interface SuggestSettings
  extends SuggestCoreSettings,
    SuggestBangContext {}

export interface PartialBang {
  partial: string;
  prefix: string;
  isSnap?: boolean;
}

function isTrimWs(code: number): boolean {
  return (
    code === CH_SPACE ||
    code === CH_TAB ||
    code === CH_NL ||
    code === CH_VTAB ||
    code === CH_FF ||
    code === CH_CR
  );
}

function fillTemplate(url: string, encodedQuery: string): string {
  const parts = resolveTemplateParts(url);
  if (!parts) {
    return url;
  }
  return parts[0] + encodedQuery + parts[1];
}

function empty(query: string): Response {
  return new Response(JSON.stringify([query, []]), { headers: JSON_HEADERS });
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isSuggestionPayload(value: unknown): value is unknown[] {
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    value.length > 5 ||
    typeof value[0] !== "string" ||
    !isStringArray(value[1])
  ) {
    return false;
  }

  if (value.length > 2 && !isStringArray(value[2])) {
    return false;
  }
  if (value.length > 3 && !isStringArray(value[3])) {
    return false;
  }
  return (
    value.length < 5 ||
    (value[4] !== null &&
      typeof value[4] === "object" &&
      !Array.isArray(value[4]))
  );
}

export function parsePartialBang(q: string): PartialBang | null {
  let start = 0;
  let end = q.length;

  while (start < end && isTrimWs(q.charCodeAt(start))) {
    start++;
  }
  while (end > start && isTrimWs(q.charCodeAt(end - 1))) {
    end--;
  }
  if (start === end) {
    return null;
  }

  const c0 = q.charCodeAt(start);

  if (c0 === CH_EXCL || c0 === CH_AT) {
    for (let i = start + 1; i < end; i++) {
      if (q.charCodeAt(i) === CH_SPACE) {
        return null;
      }
    }
    return {
      prefix: "",
      partial: q.substring(start + 1, end).toLowerCase(),
      isSnap: c0 === CH_AT || undefined,
    };
  }

  for (let i = end - 2; i >= start; i--) {
    const ci = q.charCodeAt(i);
    const ci1 = q.charCodeAt(i + 1);
    if (ci !== CH_SPACE || (ci1 !== CH_EXCL && ci1 !== CH_AT)) {
      continue;
    }
    const triggerStart = i + 2;
    for (let j = triggerStart; j < end; j++) {
      if (q.charCodeAt(j) === CH_SPACE) {
        return null;
      }
    }
    return {
      prefix: q.substring(start, i + 1),
      partial: q.substring(triggerStart, end).toLowerCase(),
      isSnap: ci1 === CH_AT || undefined,
    };
  }

  return null;
}

function resolveEndpoint(provider: string, trigger: string): string | null {
  return (
    SUGGEST_URLS[provider] ??
    (provider === "none"
      ? null
      : (SUGGEST_URLS[SUGGEST_TRIGGER_PROVIDERS[trigger]] ?? null))
  );
}

export function parseCookie(request: Request): SuggestSettings {
  const header = request.headers.get("Cookie") || "";
  return parseCookieInternalWithRewrite(header, true, false).settings;
}

interface SuggestSettingsParseResult {
  settings: SuggestSettings;
  rewrittenSuggestCookie: string | null;
}

function parseCookieInternalWithRewrite(
  header: string,
  includeBangContext: boolean,
  includeRewrite: boolean
): SuggestSettingsParseResult {
  const suggestRaw = readCookieValue(header, "suggest");
  if (suggestRaw === null) {
    return {
      settings: defaultSettings(),
      rewrittenSuggestCookie: null,
    };
  }

  if (!(includeRewrite && includeBangContext)) {
    return {
      settings: parseSuggestCookieValue(suggestRaw, includeBangContext),
      rewrittenSuggestCookie: null,
    };
  }

  const { settings, hasInvalidContext } = parseSuggestCookieValueWithValidation(
    suggestRaw,
    includeBangContext,
    true
  );
  if (!hasInvalidContext) {
    return { settings, rewrittenSuggestCookie: null };
  }

  const rewritten = encodeSuggestCookieValue(
    settings.provider,
    settings.trigger,
    settings.customUrl || "",
    [],
    {}
  );

  return {
    settings: { ...settings, frecent: {}, custom: [] },
    rewrittenSuggestCookie: rewritten,
  };
}

export interface SuggestSettingsWithCleanup {
  settings: SuggestSettings;
  rewrittenSuggestCookie: string | null;
}

export function parseSettingsFromRawUrlWithCleanup(
  rawUrl: string,
  request: Request,
  spOverride?: string | null,
  includeBangContext = true
): SuggestSettingsWithCleanup {
  const { settings, rewrittenSuggestCookie } = parseCookieInternalWithRewrite(
    request.headers.get("Cookie") || "",
    includeBangContext,
    true
  );

  const sp = spOverride ?? readQueryParam(rawUrl, "sp");
  if (sp) {
    settings.provider = sp;
  }

  return {
    settings,
    rewrittenSuggestCookie,
  };
}

export function parseSettingsFromRawUrl(
  rawUrl: string,
  request: Request,
  spOverride?: string | null,
  includeBangContext = true
): SuggestSettings {
  const settings = parseCookieInternalWithRewrite(
    request.headers.get("Cookie") || "",
    includeBangContext,
    false
  ).settings;

  const sp = spOverride ?? readQueryParam(rawUrl, "sp");
  if (sp) {
    settings.provider = sp;
  }

  return settings;
}

export function parseSettings(url: URL, request: Request): SuggestSettings {
  return parseSettingsFromRawUrl(url.href, request);
}

function defaultSettings(): SuggestSettings {
  return {
    provider: "default",
    trigger: "g",
    customUrl: null,
    frecent: {},
    custom: [],
  };
}

function readCookieValue(header: string, name: string): string | null {
  const prefix = `${name}=`;
  const pLen = prefix.length;
  let i = header.indexOf(prefix);
  while (i !== -1) {
    if (
      i === 0 ||
      (header.charCodeAt(i - 2) === 59 && header.charCodeAt(i - 1) === 32)
    ) {
      // preceded by '; ' (59=';', 32=' ')
      const end = header.indexOf(";", i + pLen);
      return end === -1
        ? header.substring(i + pLen)
        : header.substring(i + pLen, end);
    }
    i = header.indexOf(prefix, i + 1);
  }
  return null;
}

export async function suggest(
  query: string,
  settings: SuggestSettings,
  bangOverride?: PartialBang | null,
  allowUnsafeCustomUrls = false
): Promise<Response> {
  const bang = bangOverride ?? parsePartialBang(query);
  if (bang) {
    return bangSuggestions(
      query,
      bang.prefix,
      bang.partial,
      settings.frecent,
      settings.custom,
      bang.isSnap
    );
  }

  const { provider, trigger, customUrl } = settings;
  let endpoint: string | null;
  if (provider === "custom") {
    endpoint = allowUnsafeCustomUrls ? customUrl : null;
  } else {
    endpoint = resolveEndpoint(provider, trigger);
  }

  if (!endpoint) {
    return empty(query);
  }

  try {
    const res = await fetch(fillTemplate(endpoint, encodeURIComponent(query)));
    if (!res.ok) {
      return empty(query);
    }
    const body = await res.text();
    const payload: unknown = JSON.parse(body);
    if (!isSuggestionPayload(payload)) {
      return empty(query);
    }
    return new Response(body, { headers: JSON_HEADERS });
  } catch {
    return empty(query);
  }
}
