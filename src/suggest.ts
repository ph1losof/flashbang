import { CH_CR, CH_FF, CH_NL, CH_SPACE, CH_TAB, CH_VTAB } from "./shared/chars";
import {
  JSON_HEADERS,
  SUGGEST_TRIGGER_PROVIDERS,
  SUGGEST_URLS,
} from "./shared/constants";
import { readQueryParam } from "./shared/raw-query";
import {
  encodeSuggestCookieValue,
  parseSuggestCookieContextValueWithValidation,
  parseSuggestCookieValue,
  parseSuggestCookieValueWithValidation,
} from "./shared/suggest-cookie";
import { resolveTemplateParts } from "./shared/template";
import {
  DEFAULT_BANG_PREFIX,
  DEFAULT_SNAP_PREFIX,
  isTriggerPrefix,
  type TriggerPrefix,
} from "./shared/trigger-prefix";
import { bangSuggestions } from "./suggest-bang";

export interface SuggestCoreSettings {
  bangPrefix: TriggerPrefix;
  customUrl: string | null;
  provider: string;
  snapPrefix: TriggerPrefix;
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
  triggerPrefix: TriggerPrefix;
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

export function parsePartialBang(
  q: string,
  bangPrefix: TriggerPrefix = DEFAULT_BANG_PREFIX,
  snapPrefix: TriggerPrefix = DEFAULT_SNAP_PREFIX
): PartialBang | null {
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
  const bangCode = bangPrefix.charCodeAt(0);
  const snapCode = snapPrefix.charCodeAt(0);

  if (c0 === bangCode || c0 === snapCode) {
    for (let i = start + 1; i < end; i++) {
      if (q.charCodeAt(i) === CH_SPACE) {
        return null;
      }
    }
    return {
      prefix: "",
      partial: q.substring(start + 1, end).toLowerCase(),
      isSnap: c0 === snapCode || undefined,
      triggerPrefix: c0 === snapCode ? snapPrefix : bangPrefix,
    };
  }

  for (let i = end - 2; i >= start; i--) {
    const ci = q.charCodeAt(i);
    const ci1 = q.charCodeAt(i + 1);
    if (ci !== CH_SPACE || (ci1 !== bangCode && ci1 !== snapCode)) {
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
      isSnap: ci1 === snapCode || undefined,
      triggerPrefix: ci1 === snapCode ? snapPrefix : bangPrefix,
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
    {},
    settings.bangPrefix,
    settings.snapPrefix
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

export function parseBangSettingsFromRequestWithCleanup(
  request: Request,
  settings: SuggestSettings
): SuggestSettingsWithCleanup {
  const suggestRaw = readCookieValue(
    request.headers.get("Cookie") || "",
    "suggest"
  );
  if (suggestRaw === null) {
    return { settings, rewrittenSuggestCookie: null };
  }

  const { custom, frecent, hasInvalidContext } =
    parseSuggestCookieContextValueWithValidation(suggestRaw, true);
  settings.custom = custom;
  settings.frecent = frecent;
  if (!hasInvalidContext) {
    return { settings, rewrittenSuggestCookie: null };
  }

  const cookieSettings = parseSuggestCookieValue(suggestRaw, false);
  settings.custom = [];
  settings.frecent = {};
  return {
    settings,
    rewrittenSuggestCookie: encodeSuggestCookieValue(
      cookieSettings.provider,
      cookieSettings.trigger,
      cookieSettings.customUrl || "",
      [],
      {},
      cookieSettings.bangPrefix,
      cookieSettings.snapPrefix
    ),
  };
}

export function parseSettingsFromRawUrlWithCleanup(
  rawUrl: string,
  request: Request,
  spOverride?: string | null,
  includeBangContext = true,
  bangPrefixOverride?: string | null,
  snapPrefixOverride?: string | null
): SuggestSettingsWithCleanup {
  const { settings, rewrittenSuggestCookie } = parseCookieInternalWithRewrite(
    request.headers.get("Cookie") || "",
    includeBangContext,
    true
  );

  const sp =
    spOverride === undefined ? readQueryParam(rawUrl, "sp") : spOverride;
  if (sp) {
    settings.provider = sp;
  }
  applyTriggerPrefixOverrides(
    rawUrl,
    settings,
    bangPrefixOverride,
    snapPrefixOverride
  );

  return {
    settings,
    rewrittenSuggestCookie,
  };
}

export function parseSettingsFromRawUrl(
  rawUrl: string,
  request: Request,
  spOverride?: string | null,
  includeBangContext = true,
  bangPrefixOverride?: string | null,
  snapPrefixOverride?: string | null
): SuggestSettings {
  const settings = parseCookieInternalWithRewrite(
    request.headers.get("Cookie") || "",
    includeBangContext,
    false
  ).settings;

  const sp =
    spOverride === undefined ? readQueryParam(rawUrl, "sp") : spOverride;
  if (sp) {
    settings.provider = sp;
  }
  applyTriggerPrefixOverrides(
    rawUrl,
    settings,
    bangPrefixOverride,
    snapPrefixOverride
  );

  return settings;
}

export function parseSettings(url: URL, request: Request): SuggestSettings {
  return parseSettingsFromRawUrl(url.href, request);
}

function defaultSettings(): SuggestSettings {
  return {
    bangPrefix: DEFAULT_BANG_PREFIX,
    provider: "default",
    snapPrefix: DEFAULT_SNAP_PREFIX,
    trigger: "g",
    customUrl: null,
    frecent: {},
    custom: [],
  };
}

function applyTriggerPrefixOverrides(
  rawUrl: string,
  settings: SuggestSettings,
  bangPrefixOverride?: string | null,
  snapPrefixOverride?: string | null
): void {
  if (
    bangPrefixOverride === undefined &&
    snapPrefixOverride === undefined &&
    !(rawUrl.includes("bp=") || rawUrl.includes("np="))
  ) {
    return;
  }
  const bangPrefix =
    bangPrefixOverride === undefined
      ? readQueryParam(rawUrl, "bp")
      : bangPrefixOverride;
  const snapPrefix =
    snapPrefixOverride === undefined
      ? readQueryParam(rawUrl, "np")
      : snapPrefixOverride;
  if (
    isTriggerPrefix(bangPrefix) &&
    isTriggerPrefix(snapPrefix) &&
    bangPrefix !== snapPrefix
  ) {
    settings.bangPrefix = bangPrefix;
    settings.snapPrefix = snapPrefix;
  }
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
  const bang =
    bangOverride === undefined
      ? parsePartialBang(query, settings.bangPrefix, settings.snapPrefix)
      : bangOverride;
  if (bang) {
    return bangSuggestions(
      query,
      bang.prefix,
      bang.partial,
      settings.frecent,
      settings.custom,
      bang.triggerPrefix
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
